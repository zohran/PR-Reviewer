import type { ChangedFile } from './types';

/** Soft cap on concatenated diff text sent to the LLM. */
export const MAX_DIFF_CHARS = 12_000;

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_VERSION = '2023-06-01';

const RETRY_USER_MESSAGE =
  "Your last response wasn't valid JSON, return only the JSON object.";

const SYSTEM_PROMPT = `You are a strict code reviewer. Compare the pull request's stated intent (description and commit messages) against the actual diff.

Return ONLY valid JSON matching this exact schema — no markdown fences, no prose before or after:
{
  "matches_intent": boolean,
  "issues": [{ "file": string, "line": number | null, "severity": "blocking" | "minor", "comment": string }],
  "summary": string
}

Be precise and actionable. Flag intent mismatches and concrete defects. Prefer fewer, higher-signal issues.`;

/** Input slice of PR context needed for the LLM review. */
export interface LLMReviewInput {
  description: string | null;
  commitMessages: string[];
  changedFiles: ChangedFile[];
}

/** A single issue reported by the LLM reviewer. */
export interface LLMReviewIssue {
  file: string;
  line: number | null;
  severity: 'blocking' | 'minor';
  comment: string;
}

/** Validated LLM review payload. */
export interface LLMReviewResult {
  matches_intent: boolean;
  issues: LLMReviewIssue[];
  summary: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Asks Claude to review a PR's intent vs. its diff and returns structured JSON.
 *
 * Retries once if the API call fails or the response is not valid JSON, with a
 * follow-up instructing the model to return only the JSON object.
 *
 * @param pr - Description, commit messages, and changed files (with patches)
 * @param apiKey - Anthropic API key
 */
export async function llmReview(
  pr: LLMReviewInput,
  apiKey: string
): Promise<LLMReviewResult> {
  const userMessage = buildUserMessage(pr);
  const initialMessages: AnthropicMessage[] = [
    { role: 'user', content: userMessage },
  ];

  let assistantText: string | undefined;

  try {
    assistantText = await callAnthropic(apiKey, initialMessages);
    return parseAndValidateReview(assistantText);
  } catch (firstError) {
    const retryMessages: AnthropicMessage[] = assistantText
      ? [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: assistantText },
          { role: 'user', content: RETRY_USER_MESSAGE },
        ]
      : [
          {
            role: 'user',
            content: `${userMessage}\n\n${RETRY_USER_MESSAGE}`,
          },
        ];

    try {
      const retryText = await callAnthropic(apiKey, retryMessages);
      return parseAndValidateReview(retryText);
    } catch (secondError) {
      const firstMsg =
        firstError instanceof Error ? firstError.message : String(firstError);
      const secondMsg =
        secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(
        `LLM review failed after retry. First attempt: ${firstMsg}. Retry: ${secondMsg}`
      );
    }
  }
}

/**
 * Builds a truncated diff string, keeping whole file sections that fit under
 * `maxChars` and noting how many files were omitted.
 */
export function buildTruncatedDiff(
  changedFiles: ReadonlyArray<Pick<ChangedFile, 'filename' | 'patch'>>,
  maxChars: number = MAX_DIFF_CHARS
): string {
  const sections: string[] = [];
  let used = 0;
  let included = 0;

  for (const file of changedFiles) {
    const patch = file.patch ?? '(no patch available — binary or too large)';
    const section = `### ${file.filename}\n${patch}`;
    const separator = sections.length > 0 ? '\n\n' : '';
    const addition = separator.length + section.length;

    if (used + addition > maxChars && sections.length > 0) {
      break;
    }

    // Single oversized file: include a truncated slice so the model still sees something.
    if (addition > maxChars && sections.length === 0) {
      sections.push(section.slice(0, maxChars));
      included = 1;
      used = maxChars;
      break;
    }

    sections.push(section);
    used += addition;
    included += 1;
  }

  const omitted = changedFiles.length - included;
  if (omitted > 0) {
    sections.push(`${omitted} files omitted for length`);
  }

  return sections.join('\n\n');
}

/** Builds the primary user message for the Anthropic Messages API. */
export function buildUserMessage(pr: LLMReviewInput): string {
  const description = pr.description?.trim() || '(no description provided)';
  const commits =
    pr.commitMessages.length > 0
      ? pr.commitMessages.map((m, i) => `${i + 1}. ${m}`).join('\n')
      : '(no commit messages)';
  const diff = buildTruncatedDiff(pr.changedFiles);

  return [
    '## Pull request description',
    description,
    '',
    '## Commit messages',
    commits,
    '',
    '## Diff',
    diff,
  ].join('\n');
}

/**
 * Strips accidental markdown code fences from a model response before parsing.
 */
export function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  const fenced = /^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i.exec(cleaned);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  // Fallback: remove a leading ```json / trailing ``` if present but not exclusive.
  cleaned = cleaned.replace(/^```(?:json)?\s*\r?\n?/i, '');
  cleaned = cleaned.replace(/\r?\n?```\s*$/i, '');
  return cleaned.trim();
}

/**
 * Parses model text into an {@link LLMReviewResult}, stripping fences and
 * validating the runtime shape.
 */
export function parseAndValidateReview(text: string): LLMReviewResult {
  const cleaned = stripMarkdownFences(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`LLM response is not valid JSON: ${detail}`);
  }
  return validateReviewResult(parsed);
}

/**
 * Runtime shape check for the LLM review schema.
 * @throws If required fields are missing or have the wrong type
 */
export function validateReviewResult(value: unknown): LLMReviewResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LLM review JSON must be an object');
  }

  const obj = value as Record<string, unknown>;

  if (typeof obj.matches_intent !== 'boolean') {
    throw new Error(
      'LLM review JSON missing or invalid "matches_intent" (expected boolean)'
    );
  }

  if (typeof obj.summary !== 'string') {
    throw new Error(
      'LLM review JSON missing or invalid "summary" (expected string)'
    );
  }

  if (!Array.isArray(obj.issues)) {
    throw new Error(
      'LLM review JSON missing or invalid "issues" (expected array)'
    );
  }

  const issues: LLMReviewIssue[] = obj.issues.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`LLM review JSON issues[${index}] must be an object`);
    }
    const issue = item as Record<string, unknown>;

    if (typeof issue.file !== 'string') {
      throw new Error(
        `LLM review JSON issues[${index}].file must be a string`
      );
    }
    if (!(typeof issue.line === 'number' || issue.line === null)) {
      throw new Error(
        `LLM review JSON issues[${index}].line must be a number or null`
      );
    }
    if (issue.severity !== 'blocking' && issue.severity !== 'minor') {
      throw new Error(
        `LLM review JSON issues[${index}].severity must be "blocking" or "minor"`
      );
    }
    if (typeof issue.comment !== 'string') {
      throw new Error(
        `LLM review JSON issues[${index}].comment must be a string`
      );
    }

    return {
      file: issue.file,
      line: issue.line,
      severity: issue.severity,
      comment: issue.comment,
    };
  });

  return {
    matches_intent: obj.matches_intent,
    issues,
    summary: obj.summary,
  };
}

async function callAnthropic(
  apiKey: string,
  messages: AnthropicMessage[]
): Promise<string> {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Anthropic API request failed (${response.status} ${response.statusText}): ${body.slice(0, 500)}`
    );
  }

  const data = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
  };

  const text = data.content
    ?.filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Anthropic API response contained no text content');
  }

  return text;
}
