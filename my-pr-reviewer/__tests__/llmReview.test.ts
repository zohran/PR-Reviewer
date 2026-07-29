import { jest } from '@jest/globals';
import {
  llmReview,
  buildTruncatedDiff,
  stripMarkdownFences,
  parseAndValidateReview,
  validateReviewResult,
  MAX_DIFF_CHARS,
} from '../src/llmReview';
import type { ChangedFile } from '../src/types';

const validReview = {
  matches_intent: true,
  issues: [
    {
      file: 'src/app.ts',
      line: 10,
      severity: 'minor' as const,
      comment: 'Consider renaming this variable.',
    },
  ],
  summary: 'Looks good overall.',
};

function anthropicOkResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function makePr(overrides?: {
  description?: string | null;
  commitMessages?: string[];
  changedFiles?: ChangedFile[];
}) {
  return {
    description: overrides?.description ?? 'Add feature X',
    commitMessages: overrides?.commitMessages ?? ['feat: add X'],
    changedFiles: overrides?.changedFiles ?? [
      {
        filename: 'src/a.ts',
        status: 'modified',
        patch: '@@ -1 +1 @@\n-old\n+new',
        additions: 1,
        deletions: 1,
      },
    ],
  };
}

describe('buildTruncatedDiff', () => {
  it('concatenates ### filename + patch sections', () => {
    const diff = buildTruncatedDiff([
      { filename: 'a.ts', patch: '+a' },
      { filename: 'b.ts', patch: '+b' },
    ]);
    expect(diff).toContain('### a.ts\n+a');
    expect(diff).toContain('### b.ts\n+b');
  });

  it('omits whole files that would exceed the cap and notes the count', () => {
    const files = [
      { filename: 'small.ts', patch: 'x'.repeat(100) },
      { filename: 'big.ts', patch: 'y'.repeat(MAX_DIFF_CHARS) },
      { filename: 'tail.ts', patch: 'z' },
    ];
    const diff = buildTruncatedDiff(files, 200);
    expect(diff).toContain('### small.ts');
    expect(diff).not.toContain('### big.ts');
    expect(diff).toMatch(/\d+ files omitted for length/);
  });
});

describe('stripMarkdownFences / validate', () => {
  it('strips ```json fences', () => {
    const fenced = '```json\n{"matches_intent":true,"issues":[],"summary":"ok"}\n```';
    expect(stripMarkdownFences(fenced)).toBe(
      '{"matches_intent":true,"issues":[],"summary":"ok"}'
    );
  });

  it('throws on missing fields', () => {
    expect(() => validateReviewResult({ summary: 'x' })).toThrow(
      /matches_intent/
    );
    expect(() =>
      validateReviewResult({
        matches_intent: true,
        issues: [{ file: 1, line: null, severity: 'minor', comment: 'x' }],
        summary: 'x',
      })
    ).toThrow(/file must be a string/);
  });
});

describe('llmReview', () => {
  const fetchMock = jest.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  it('returns a validated review for a valid JSON response', async () => {
    fetchMock.mockResolvedValueOnce(
      anthropicOkResponse(JSON.stringify(validReview))
    );

    const result = await llmReview(makePr(), 'test-key');

    expect(result).toEqual(validReview);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe(
      'test-key'
    );

    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.max_tokens).toBe(2000);
    expect(body.system).toMatch(/strict code reviewer/i);
    expect(body.messages[0].content).toContain('Add feature X');
    expect(body.messages[0].content).toContain('### src/a.ts');
  });

  it('parses a response wrapped in markdown fences', async () => {
    const fenced = '```json\n' + JSON.stringify(validReview) + '\n```';
    fetchMock.mockResolvedValueOnce(anthropicOkResponse(fenced));

    const result = await llmReview(makePr(), 'test-key');
    expect(result.summary).toBe('Looks good overall.');
    expect(result.matches_intent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries once when JSON parsing fails, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(anthropicOkResponse('not-json-at-all'))
      .mockResolvedValueOnce(
        anthropicOkResponse(JSON.stringify(validReview))
      );

    const result = await llmReview(makePr(), 'test-key');
    expect(result).toEqual(validReview);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(retryBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'not-json-at-all' }),
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining("wasn't valid JSON"),
        }),
      ])
    );
  });

  it('throws a descriptive error when the retry also fails', async () => {
    fetchMock
      .mockResolvedValueOnce(anthropicOkResponse('{bad'))
      .mockResolvedValueOnce(anthropicOkResponse('{still-bad'));

    await expect(llmReview(makePr(), 'test-key')).rejects.toThrow(
      /LLM review failed after retry/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries when the API call fails, then throws if retry fails too', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
      )
      .mockResolvedValueOnce(
        new Response('still down', { status: 500, statusText: 'Internal Server Error' })
      );

    await expect(llmReview(makePr(), 'test-key')).rejects.toThrow(
      /LLM review failed after retry[\s\S]*429[\s\S]*500/i
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exposes parseAndValidateReview for direct use', () => {
    expect(
      parseAndValidateReview(JSON.stringify({
        matches_intent: false,
        issues: [],
        summary: 'Intent mismatch',
      }))
    ).toMatchObject({ matches_intent: false, summary: 'Intent mismatch' });
  });
});
