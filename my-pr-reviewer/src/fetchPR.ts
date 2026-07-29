import type { Octokit } from '@octokit/rest';
import type { ActionsContext, ChangedFile, PRContext } from './types';

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
export async function fetchPRContext(
  octokit: Octokit,
  context: ActionsContext
): Promise<PRContext> {
  const { owner, repo } = context.repo;
  const prNumber = context.payload.pull_request?.number;

  if (prNumber === undefined) {
    throw new Error(
      'fetchPRContext requires a pull_request event (payload.pull_request.number is missing)'
    );
  }

  const { data: pullRequest } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const changedFiles: ChangedFile[] = files.map((file) => {
    const changedFile: ChangedFile = {
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    };

    // GitHub omits `patch` for binary files and very large diffs — keep it optional.
    if (typeof file.patch === 'string') {
      changedFile.patch = file.patch;
    }

    return changedFile;
  });

  return {
    title: pullRequest.title,
    description: pullRequest.body,
    commitMessages: commits.map((commit) => commit.commit.message),
    changedFiles,
    prNumber,
    owner,
    repo,
  };
}
