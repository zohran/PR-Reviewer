import type { Octokit } from '@octokit/rest';
import type { LintIssue } from './lint';
import type { LLMReviewResult, LLMReviewIssue } from './llmReview';
import type { TestResult } from './runTests';
import type { ChangedFile } from './types';

/** PR identity for posting a review. */
export interface PostReviewPrRef {
  owner: string;
  repo: string;
  pull_number: number;
}

/** Review inputs aggregated from lint, tests, and the LLM. */
export interface PostReviewPayload {
  lintIssues: LintIssue[];
  testResult: TestResult;
  llmResult: LLMReviewResult;
  failOnLintErrors: boolean;
  failOnTestFailure: boolean;
  /** Changed files with patches — used to map line numbers to diff positions. */
  changedFiles: ChangedFilesForDiff;
  /** Head commit SHA the review is attached to. */
  commitId: string;
}

type ChangedFilesForDiff = ReadonlyArray<Pick<ChangedFile, 'filename' | 'patch'>>;

/** A GitHub pull-request review comment anchored by diff position. */
export interface ReviewCommentInput {
  path: string;
  position: number;
  body: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

/** Result of composing (and posting) a review — useful for tests. */
export interface ComposedReview {
  event: ReviewEvent;
  body: string;
  comments: ReviewCommentInput[];
  unanchoredIssues: string[];
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Posts a GitHub PR review combining lint, test, and LLM findings.
 *
 * Chooses `REQUEST_CHANGES` vs `APPROVE` from blocking lint errors (when
 * `failOnLintErrors`), failed tests (when `failOnTestFailure`), and blocking
 * LLM issues. Inline comments are anchored via {@link mapLineToDiffPosition};
 * unmappable findings are folded into the review body.
 */
export async function postReview(
  octokit: Octokit,
  pr: PostReviewPrRef,
  payload: PostReviewPayload
): Promise<ComposedReview> {
  const composed = composeReview(payload);

  await octokit.rest.pulls.createReview({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.pull_number,
    commit_id: payload.commitId,
    event: composed.event,
    body: composed.body,
    comments: composed.comments,
  });

  return composed;
}

/**
 * Pure composition of event / body / inline comments (no GitHub API calls).
 */
export function composeReview(payload: PostReviewPayload): ComposedReview {
  const {
    lintIssues,
    testResult,
    llmResult,
    failOnLintErrors,
    failOnTestFailure,
    changedFiles,
  } = payload;

  const blockingLintIssues = failOnLintErrors
    ? lintIssues.filter((issue) => issue.severity === 'error')
    : [];
  const testsFailed =
    failOnTestFailure && testResult.ran && testResult.passed === false;
  const blockingLlmIssues = llmResult.issues.filter(
    (issue) => issue.severity === 'blocking'
  );

  const event: ReviewEvent =
    blockingLintIssues.length > 0 ||
    testsFailed ||
    blockingLlmIssues.length > 0
      ? 'REQUEST_CHANGES'
      : 'APPROVE';

  const patchByFile = buildPatchLookup(changedFiles);
  const comments: ReviewCommentInput[] = [];
  const unanchoredIssues: string[] = [];

  for (const issue of lintIssues) {
    const body = formatLintComment(issue);
    tryAnchorOrFold({
      file: issue.file,
      line: issue.line,
      body,
      patchByFile,
      comments,
      unanchoredIssues,
      label: `Lint (${issue.severity})`,
    });
  }

  for (const issue of llmResult.issues) {
    const body = formatLlmComment(issue);
    tryAnchorOrFold({
      file: issue.file,
      line: issue.line,
      body,
      patchByFile,
      comments,
      unanchoredIssues,
      label: `LLM (${issue.severity})`,
    });
  }

  const body = buildReviewBody({
    testResult,
    testsFailed: testResult.ran && testResult.passed === false,
    llmSummary: llmResult.summary,
    unanchoredIssues,
    matchesIntent: llmResult.matches_intent,
  });

  return { event, body, comments, unanchoredIssues };
}

/**
 * Maps a **new-file** (right-hand / `+` side) line number to the GitHub review
 * `position` for a unified diff patch.
 *
 * Position is 1-based and counts every line after the first `@@` hunk header
 * (including subsequent hunk headers and deletions). Returns `null` when the
 * target line is not present on the new side of the diff.
 */
export function mapLineToDiffPosition(
  patch: string,
  targetLine: number
): number | null {
  if (!patch || targetLine < 1) {
    return null;
  }

  const lines = patch.split('\n');
  let position = 0;
  let newLine = 0;
  let seenFirstHunk = false;
  let newSideRemaining = 0;

  for (const line of lines) {
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      newLine = Number.parseInt(hunk[3]!, 10);
      const newLen =
        hunk[4] !== undefined ? Number.parseInt(hunk[4], 10) : 1;
      newSideRemaining = newLen;

      if (seenFirstHunk) {
        // Subsequent hunk headers are included in the position count.
        position += 1;
      }
      seenFirstHunk = true;
      continue;
    }

    if (!seenFirstHunk) {
      // Skip file headers (`---` / `+++`) before the first hunk.
      continue;
    }

    position += 1;

    if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      continue;
    }

    if (line.startsWith('+') || line.startsWith(' ')) {
      if (newSideRemaining <= 0) {
        continue;
      }
      if (newLine === targetLine) {
        return position;
      }
      newLine += 1;
      newSideRemaining -= 1;
    } else if (line.startsWith('-')) {
      // Old-side only — does not advance the new-file line counter.
      continue;
    }
  }

  return null;
}

function tryAnchorOrFold(args: {
  file: string;
  line: number | null;
  body: string;
  patchByFile: Map<string, string>;
  comments: ReviewCommentInput[];
  unanchoredIssues: string[];
  label: string;
}): void {
  const { file, line, body, patchByFile, comments, unanchoredIssues, label } =
    args;

  if (line == null) {
    unanchoredIssues.push(`**${label}** \`${file}\`: ${body}`);
    return;
  }

  const patch = findPatchForFile(patchByFile, file);
  if (!patch) {
    unanchoredIssues.push(
      `**${label}** \`${file}:${line}\`: ${body} _(no diff patch)_`
    );
    return;
  }

  const position = mapLineToDiffPosition(patch, line);
  if (position == null) {
    unanchoredIssues.push(
      `**${label}** \`${file}:${line}\`: ${body} _(line not in diff)_`
    );
    return;
  }

  comments.push({
    path: normalizePath(file),
    position,
    body,
  });
}

function buildReviewBody(args: {
  testResult: TestResult;
  testsFailed: boolean;
  llmSummary: string;
  unanchoredIssues: string[];
  matchesIntent: boolean;
}): string {
  const sections: string[] = [];

  if (args.testsFailed) {
    const output = args.testResult.output.trim() || '(no test output)';
    sections.push(
      [
        '<details>',
        '<summary>Tests failed</summary>',
        '',
        '```',
        output,
        '```',
        '',
        '</details>',
      ].join('\n')
    );
  }

  sections.push(`## Summary\n\n${args.llmSummary}`);
  sections.push(
    args.matchesIntent
      ? '_LLM assessment: changes appear to match the stated intent._'
      : '_LLM assessment: changes may **not** match the stated intent._'
  );

  if (args.unanchoredIssues.length > 0) {
    sections.push(
      [
        '## Additional issues',
        '',
        ...args.unanchoredIssues.map((item) => `- ${item}`),
      ].join('\n')
    );
  }

  return sections.join('\n\n');
}

function formatLintComment(issue: LintIssue): string {
  return `**Lint ${issue.severity}:** ${issue.message}`;
}

function formatLlmComment(issue: LLMReviewIssue): string {
  return `**${issue.severity === 'blocking' ? 'Blocking' : 'Minor'}:** ${issue.comment}`;
}

function buildPatchLookup(
  changedFiles: ChangedFilesForDiff
): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of changedFiles) {
    if (typeof file.patch === 'string') {
      map.set(normalizePath(file.filename), file.patch);
    }
  }
  return map;
}

function findPatchForFile(
  patchByFile: Map<string, string>,
  file: string
): string | undefined {
  const normalized = normalizePath(file);
  if (patchByFile.has(normalized)) {
    return patchByFile.get(normalized);
  }

  // Linters often emit absolute or nested paths — match by suffix.
  for (const [path, patch] of patchByFile) {
    if (normalized.endsWith(path) || path.endsWith(normalized)) {
      return patch;
    }
  }
  return undefined;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}
