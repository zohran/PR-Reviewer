import type { Octokit } from '@octokit/rest';
import type { ActionsContext, PRContext } from './types';
export type { ActionsContext, ChangedFile, PRContext } from './types';
/**
 * Fetches pull request title, description, commit messages, and changed files
 * from the GitHub API using the Actions context (owner/repo/PR number).
 *
 * Paginates `listCommits` and `listFiles` so PRs with more than 100 commits
 * or files are fully loaded. Files without a `patch` (binary / oversized diffs)
 * are included with `patch` omitted rather than failing.
 *
 * @param octokit - Authenticated Octokit client
 * @param context - GitHub Actions context (`context.repo` + `payload.pull_request`)
 * @returns Typed PR context for downstream lint / test / LLM steps
 * @throws If the workflow is not running on a pull_request event
 */
export declare function fetchPRContext(octokit: Octokit, context: ActionsContext): Promise<PRContext>;
