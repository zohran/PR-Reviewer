import type { Octokit } from '@octokit/rest';
import type { LintIssue } from './lint';
import type { LLMReviewResult } from './llmReview';
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
/**
 * Posts a GitHub PR review combining lint, test, and LLM findings.
 *
 * Chooses `REQUEST_CHANGES` vs `APPROVE` from blocking lint errors (when
 * `failOnLintErrors`), failed tests (when `failOnTestFailure`), and blocking
 * LLM issues. Inline comments are anchored via {@link mapLineToDiffPosition};
 * unmappable findings are folded into the review body.
 */
export declare function postReview(octokit: Octokit, pr: PostReviewPrRef, payload: PostReviewPayload): Promise<ComposedReview>;
/**
 * Pure composition of event / body / inline comments (no GitHub API calls).
 */
export declare function composeReview(payload: PostReviewPayload): ComposedReview;
/**
 * Maps a **new-file** (right-hand / `+` side) line number to the GitHub review
 * `position` for a unified diff patch.
 *
 * Position is 1-based and counts every line after the first `@@` hunk header
 * (including subsequent hunk headers and deletions). Returns `null` when the
 * target line is not present on the new side of the diff.
 */
export declare function mapLineToDiffPosition(patch: string, targetLine: number): number | null;
export {};
