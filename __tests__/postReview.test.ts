import { jest } from '@jest/globals';
import {
  composeReview,
  mapLineToDiffPosition,
  postReview,
} from '../src/postReview';
import type { LintIssue } from '../src/lint';
import type { LLMReviewResult } from '../src/llmReview';
import type { TestResult } from '../src/runTests';
import type { ChangedFile } from '../src/types';

const SAMPLE_PATCH = [
  '@@ -1,4 +1,5 @@',
  ' line1',
  '-line2',
  '+line2changed',
  ' line3',
  '+line4added',
  ' line5',
].join('\n');

/**
 * Multi-hunk patch:
 *   new lines 10-11 in first hunk, 20-21 in second
 */
const MULTI_HUNK_PATCH = [
  '@@ -8,3 +10,2 @@',
  ' contextA',
  '-oldA',
  '+newA',
  '@@ -18,3 +20,3 @@',
  ' contextB',
  '-oldB',
  '+newB',
  ' contextC',
].join('\n');

function lintIssue(partial: Partial<LintIssue> & Pick<LintIssue, 'file' | 'message'>): LintIssue {
  return {
    line: null,
    severity: 'warning',
    ...partial,
  };
}

function basePayload(overrides?: {
  lintIssues?: LintIssue[];
  testResult?: TestResult;
  llmResult?: Partial<LLMReviewResult>;
  failOnLintErrors?: boolean;
  failOnTestFailure?: boolean;
  changedFiles?: ChangedFile[];
}) {
  const llmResult: LLMReviewResult = {
    matches_intent: true,
    issues: [],
    summary: 'Everything looks fine.',
    ...overrides?.llmResult,
  };

  return {
    lintIssues: overrides?.lintIssues ?? [],
    testResult: overrides?.testResult ?? {
      ran: true,
      passed: true,
      output: 'ok',
      exitCode: 0,
    },
    llmResult,
    failOnLintErrors: overrides?.failOnLintErrors ?? true,
    failOnTestFailure: overrides?.failOnTestFailure ?? true,
    changedFiles: overrides?.changedFiles ?? [
      {
        filename: 'src/app.ts',
        status: 'modified',
        patch: SAMPLE_PATCH,
        additions: 2,
        deletions: 1,
      },
    ],
    commitId: 'abc123',
  };
}

describe('mapLineToDiffPosition', () => {
  it('maps a changed (+) line to the correct position', () => {
    // Positions after first @@:
    // 1:  line1, 2: -line2, 3: +line2changed, 4:  line3, 5: +line4added, 6:  line5
    expect(mapLineToDiffPosition(SAMPLE_PATCH, 2)).toBe(3); // +line2changed (new line 2)
    expect(mapLineToDiffPosition(SAMPLE_PATCH, 4)).toBe(5); // +line4added (new line 4)
  });

  it('maps context lines on the new side', () => {
    expect(mapLineToDiffPosition(SAMPLE_PATCH, 1)).toBe(1); //  line1
    expect(mapLineToDiffPosition(SAMPLE_PATCH, 3)).toBe(4); //  line3
    expect(mapLineToDiffPosition(SAMPLE_PATCH, 5)).toBe(6); //  line5
  });

  it('returns null for lines not present in the new side of the diff', () => {
    expect(mapLineToDiffPosition(SAMPLE_PATCH, 99)).toBeNull();
    expect(mapLineToDiffPosition('', 1)).toBeNull();
  });

  it('handles multiple hunks and counts subsequent @@ headers in position', () => {
    // After first @@:
    // 1:  contextA (new 10), 2: -oldA, 3: +newA (new 11),
    // 4: @@ second hunk header,
    // 5:  contextB (new 20), 6: -oldB, 7: +newB (new 21), 8:  contextC (new 22)
    expect(mapLineToDiffPosition(MULTI_HUNK_PATCH, 10)).toBe(1);
    expect(mapLineToDiffPosition(MULTI_HUNK_PATCH, 11)).toBe(3);
    expect(mapLineToDiffPosition(MULTI_HUNK_PATCH, 20)).toBe(5);
    expect(mapLineToDiffPosition(MULTI_HUNK_PATCH, 21)).toBe(7);
  });

  it('handles a pure-addition file hunk starting at line 1', () => {
    const added = [
      '@@ -0,0 +1,3 @@',
      '+one',
      '+two',
      '+three',
    ].join('\n');
    expect(mapLineToDiffPosition(added, 1)).toBe(1);
    expect(mapLineToDiffPosition(added, 3)).toBe(3);
  });
});

describe('composeReview / postReview', () => {
  it('approves when there are no blocking signals (all-clear)', () => {
    const composed = composeReview(
      basePayload({
        lintIssues: [
          lintIssue({
            file: 'src/app.ts',
            line: 2,
            severity: 'warning',
            message: 'style nit',
          }),
        ],
        llmResult: {
          matches_intent: true,
          summary: 'LGTM',
          issues: [
            {
              file: 'src/app.ts',
              line: 4,
              severity: 'minor',
              comment: 'optional rename',
            },
          ],
        },
      })
    );

    expect(composed.event).toBe('APPROVE');
    expect(composed.body).toContain('LGTM');
    expect(composed.comments.length).toBeGreaterThanOrEqual(2);
    expect(composed.comments.every((c) => c.position > 0)).toBe(true);
  });

  it('requests changes for blocking lint errors when failOnLintErrors is true', () => {
    const composed = composeReview(
      basePayload({
        failOnLintErrors: true,
        lintIssues: [
          lintIssue({
            file: 'src/app.ts',
            line: 2,
            severity: 'error',
            message: 'undefined name',
          }),
        ],
      })
    );

    expect(composed.event).toBe('REQUEST_CHANGES');
    expect(composed.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/app.ts',
          position: 3,
          body: expect.stringContaining('undefined name'),
        }),
      ])
    );
  });

  it('does not treat lint errors as blocking when failOnLintErrors is false', () => {
    const composed = composeReview(
      basePayload({
        failOnLintErrors: false,
        lintIssues: [
          lintIssue({
            file: 'src/app.ts',
            line: 2,
            severity: 'error',
            message: 'undefined name',
          }),
        ],
      })
    );
    expect(composed.event).toBe('APPROVE');
  });

  it('requests changes when tests failed and failOnTestFailure is true', () => {
    const composed = composeReview(
      basePayload({
        failOnTestFailure: true,
        testResult: {
          ran: true,
          passed: false,
          output: 'FAILED tests/test_app.py::test_it - AssertionError',
          exitCode: 1,
        },
      })
    );

    expect(composed.event).toBe('REQUEST_CHANGES');
    expect(composed.body).toContain('<details>');
    expect(composed.body).toContain('Tests failed');
    expect(composed.body).toContain('AssertionError');
  });

  it('requests changes for blocking LLM issues', () => {
    const composed = composeReview(
      basePayload({
        llmResult: {
          matches_intent: false,
          summary: 'Missing the feature described in the PR.',
          issues: [
            {
              file: 'src/app.ts',
              line: 2,
              severity: 'blocking',
              comment: 'This does not implement feature X',
            },
          ],
        },
      })
    );
    expect(composed.event).toBe('REQUEST_CHANGES');
  });

  it('folds issues into the body when the line cannot be mapped', () => {
    const composed = composeReview(
      basePayload({
        llmResult: {
          matches_intent: true,
          summary: 'Mostly fine',
          issues: [
            {
              file: 'src/app.ts',
              line: 999,
              severity: 'minor',
              comment: 'Unrelated note',
            },
            {
              file: 'src/missing.ts',
              line: 1,
              severity: 'minor',
              comment: 'No patch for this file',
            },
          ],
        },
      })
    );

    expect(composed.comments).toHaveLength(0);
    expect(composed.body).toContain('Additional issues');
    expect(composed.body).toContain('Unrelated note');
    expect(composed.body).toContain('No patch for this file');
  });

  it('calls octokit.rest.pulls.createReview with the composed payload', async () => {
    const createReview = jest.fn(async () => ({ data: { id: 1 } }));
    const octokit = {
      rest: { pulls: { createReview } },
    } as unknown as import('@octokit/rest').Octokit;

    const result = await postReview(
      octokit,
      { owner: 'acme', repo: 'widgets', pull_number: 7 },
      basePayload({
        testResult: {
          ran: true,
          passed: false,
          output: 'boom',
          exitCode: 1,
        },
      })
    );

    expect(result.event).toBe('REQUEST_CHANGES');
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        pull_number: 7,
        commit_id: 'abc123',
        event: 'REQUEST_CHANGES',
        body: expect.stringContaining('Tests failed'),
        comments: expect.any(Array),
      })
    );
  });
});
