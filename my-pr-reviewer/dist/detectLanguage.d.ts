import type { ChangedFile } from './types';
/** Languages produced by extension majority voting (plus unknown). */
export type ProjectLanguage = 'python' | 'node' | 'go' | 'java' | 'ruby' | 'rust' | 'csharp' | 'unknown';
/**
 * Detects the primary language for a PR.
 *
 * 1. Prefer an explicit description tag (`Language: …` / `lang: …`).
 * 2. Otherwise majority-vote by changed-file extensions (ignoring vendor paths).
 * 3. Ties or no matches → `'unknown'`.
 *
 * @param changedFiles - Files changed in the pull request
 * @param prDescription - PR body / description (may be null/undefined)
 * @returns Detected language string (lowercase), or `'unknown'`
 */
export declare function detectLanguage(changedFiles: ReadonlyArray<Pick<ChangedFile, 'filename'>>, prDescription: string | null | undefined): string;
/**
 * Parses an explicit language tag from the PR description.
 * Returns the value lowercased, or `undefined` when no tag is present.
 */
export declare function extractLanguageTag(prDescription: string | null | undefined): string | undefined;
/** True for vendor/generated paths and lockfiles that should not vote. */
export declare function shouldIgnorePath(filename: string): boolean;
