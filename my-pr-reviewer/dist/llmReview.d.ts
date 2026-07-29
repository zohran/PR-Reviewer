import type { ChangedFile } from './types';
/** Soft cap on concatenated diff text sent to the LLM. */
export declare const MAX_DIFF_CHARS = 12000;
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
/**
 * Asks Claude to review a PR's intent vs. its diff and returns structured JSON.
 *
 * Retries once if the API call fails or the response is not valid JSON, with a
 * follow-up instructing the model to return only the JSON object.
 *
 * @param pr - Description, commit messages, and changed files (with patches)
 * @param apiKey - Anthropic API key
 */
export declare function llmReview(pr: LLMReviewInput, apiKey: string): Promise<LLMReviewResult>;
/**
 * Builds a truncated diff string, keeping whole file sections that fit under
 * `maxChars` and noting how many files were omitted.
 */
export declare function buildTruncatedDiff(changedFiles: ReadonlyArray<Pick<ChangedFile, 'filename' | 'patch'>>, maxChars?: number): string;
/** Builds the primary user message for the Anthropic Messages API. */
export declare function buildUserMessage(pr: LLMReviewInput): string;
/**
 * Strips accidental markdown code fences from a model response before parsing.
 */
export declare function stripMarkdownFences(text: string): string;
/**
 * Parses model text into an {@link LLMReviewResult}, stripping fences and
 * validating the runtime shape.
 */
export declare function parseAndValidateReview(text: string): LLMReviewResult;
/**
 * Runtime shape check for the LLM review schema.
 * @throws If required fields are missing or have the wrong type
 */
export declare function validateReviewResult(value: unknown): LLMReviewResult;
