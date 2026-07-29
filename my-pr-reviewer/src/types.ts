/** A single file changed in the pull request. */
export interface ChangedFile {
  /** Path of the file relative to the repository root. */
  filename: string;
  /** Change status (added, modified, removed, renamed, etc.). */
  status: string;
  /**
   * Unified diff patch for the file.
   * Omitted when GitHub does not return one (binary files or very large diffs).
   */
  patch?: string;
  /** Number of lines added. */
  additions: number;
  /** Number of lines deleted. */
  deletions: number;
}

/**
 * Aggregated pull request context used by the rest of the review pipeline.
 */
export interface PRContext {
  /** Pull request title. */
  title: string;
  /** Pull request body / description (null when empty). */
  description: string | null;
  /** Commit messages on the PR, in API order. */
  commitMessages: string[];
  /** Changed files with optional patches. */
  changedFiles: ChangedFile[];
  /** Pull request number. */
  prNumber: number;
  /** Repository owner. */
  owner: string;
  /** Repository name. */
  repo: string;
}

/**
 * Minimal GitHub Actions context shape needed to identify the PR.
 * Compatible with `@actions/github` `context`.
 */
export interface ActionsContext {
  repo: {
    owner: string;
    repo: string;
  };
  payload: {
    pull_request?: {
      number: number;
    } | null;
  };
}
