import nock from 'nock';
import { Octokit } from '@octokit/rest';
import { fetchPRContext } from '../src/fetchPR';
import type { ActionsContext } from '../src/types';

const OWNER = 'acme';
const REPO = 'widgets';
const PR_NUMBER = 42;
const API = 'https://api.github.com';

function makeContext(
  overrides?: Partial<ActionsContext>
): ActionsContext {
  return {
    repo: { owner: OWNER, repo: REPO },
    payload: { pull_request: { number: PR_NUMBER } },
    ...overrides,
  };
}

describe('fetchPRContext', () => {
  let octokit: Octokit;

  beforeEach(() => {
    nock.cleanAll();
    octokit = new Octokit({ auth: 'test-token', request: { fetch } });
  });

  afterEach(() => {
    nock.cleanAll();
  });

  it('returns title, description, commit messages, and changed files', async () => {
    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`)
      .reply(200, {
        title: 'Add widget factory',
        body: 'Implements the widget factory pattern.',
      });

    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`)
      .query(true)
      .reply(200, [
        { commit: { message: 'feat: add factory' } },
        { commit: { message: 'test: cover factory\n\nMore detail' } },
      ]);

    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`)
      .query(true)
      .reply(200, [
        {
          filename: 'src/factory.ts',
          status: 'added',
          patch: '@@ -0,0 +1,3 @@\n+export function create() {}',
          additions: 3,
          deletions: 0,
        },
        {
          filename: 'assets/logo.png',
          status: 'added',
          // binary file — GitHub omits patch
          additions: 0,
          deletions: 0,
        },
      ]);

    const result = await fetchPRContext(octokit, makeContext());

    expect(result).toEqual({
      title: 'Add widget factory',
      description: 'Implements the widget factory pattern.',
      commitMessages: ['feat: add factory', 'test: cover factory\n\nMore detail'],
      changedFiles: [
        {
          filename: 'src/factory.ts',
          status: 'added',
          patch: '@@ -0,0 +1,3 @@\n+export function create() {}',
          additions: 3,
          deletions: 0,
        },
        {
          filename: 'assets/logo.png',
          status: 'added',
          additions: 0,
          deletions: 0,
        },
      ],
      prNumber: PR_NUMBER,
      owner: OWNER,
      repo: REPO,
    });

    // Binary / oversized diffs must not get an explicit undefined patch key crash —
    // patch should simply be absent.
    expect(result.changedFiles[1]).not.toHaveProperty('patch');
    expect(nock.isDone()).toBe(true);
  });

  it('paginates commits when there are more than 100', async () => {
    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}`)
      .reply(200, { title: 'Big PR', body: null });

    const page1 = Array.from({ length: 100 }, (_, i) => ({
      commit: { message: `commit-${i + 1}` },
    }));
    const page2 = [{ commit: { message: 'commit-101' } }];

    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`)
      .query({ per_page: '100' })
      .reply(200, page1, {
        Link: `<${API}/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits?per_page=100&page=2>; rel="next"`,
      });

    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/commits`)
      .query({ per_page: '100', page: '2' })
      .reply(200, page2);

    nock(API)
      .get(`/repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/files`)
      .query(true)
      .reply(200, []);

    const result = await fetchPRContext(octokit, makeContext());

    expect(result.description).toBeNull();
    expect(result.commitMessages).toHaveLength(101);
    expect(result.commitMessages[0]).toBe('commit-1');
    expect(result.commitMessages[100]).toBe('commit-101');
    expect(nock.isDone()).toBe(true);
  });

  it('throws when pull_request is missing from the context payload', async () => {
    await expect(
      fetchPRContext(
        octokit,
        makeContext({ payload: { pull_request: null } })
      )
    ).rejects.toThrow(/pull_request event/);
  });
});
