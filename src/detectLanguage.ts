import type { ChangedFile } from "./types";

/** Languages produced by extension majority voting (plus unknown). */
/** Languages produced by extension majority voting (plus unknown). */
export type ProjectLanguage =
  | "python"
  | "node"
  | "go"
  | "java"
  | "ruby"
  | "rust"
  | "csharp"
  | "unknown";

const EXTENSION_TO_LANGUAGE: Readonly<
  Record<string, Exclude<ProjectLanguage, "unknown">>
> = {
  ".py": "python",
  ".js": "node",
  ".jsx": "node",
  ".ts": "node",
  ".tsx": "node",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".rs": "rust",
  ".cs": "csharp",
};

/** Matches `Language: python` / `lang: go` with flexible whitespace (case-insensitive). */
const LANGUAGE_TAG_RE = /\blang(?:uage)?\s*:\s*([A-Za-z0-9_+#]+)/i;

const IGNORED_DIR_SEGMENTS = new Set(["node_modules", "dist", "vendor"]);

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
export function detectLanguage(
  changedFiles: ReadonlyArray<Pick<ChangedFile, "filename">>,
  prDescription: string | null | undefined,
): string {
  const tagged = extractLanguageTag(prDescription);
  if (tagged !== undefined) {
    return tagged;
  }

  return voteByExtension(changedFiles);
}

/**
 * Parses an explicit language tag from the PR description.
 * Returns the value lowercased, or `undefined` when no tag is present.
 */
export function extractLanguageTag(
  prDescription: string | null | undefined,
): string | undefined {
  if (!prDescription) {
    return undefined;
  }

  const match = prDescription.match(LANGUAGE_TAG_RE);
  if (!match?.[1]) {
    return undefined;
  }

  return match[1].toLowerCase();
}

function voteByExtension(
  changedFiles: ReadonlyArray<Pick<ChangedFile, "filename">>,
): ProjectLanguage {
  const counts = new Map<Exclude<ProjectLanguage, "unknown">, number>();

  for (const file of changedFiles) {
    if (shouldIgnorePath(file.filename)) {
      continue;
    }

    const ext = getExtension(file.filename);
    const language = EXTENSION_TO_LANGUAGE[ext];
    if (!language) {
      continue;
    }

    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  if (counts.size === 0) {
    return "unknown";
  }

  let bestLanguage: Exclude<ProjectLanguage, "unknown"> | undefined;
  let bestCount = 0;
  let tied = false;

  for (const [language, count] of counts) {
    if (count > bestCount) {
      bestLanguage = language;
      bestCount = count;
      tied = false;
    } else if (count === bestCount) {
      tied = true;
    }
  }

  if (tied || bestLanguage === undefined) {
    return "unknown";
  }

  return bestLanguage;
}

/** True for vendor/generated paths and lockfiles that should not vote. */
export function shouldIgnorePath(filename: string): boolean {
  const normalized = filename.replace(/\\/g, "/");
  const segments = normalized.split("/");

  for (const segment of segments.slice(0, -1)) {
    if (IGNORED_DIR_SEGMENTS.has(segment)) {
      return true;
    }
  }

  const basename = segments[segments.length - 1] ?? "";
  if (basename.endsWith(".lock")) {
    return true;
  }

  return false;
}

function getExtension(filename: string): string {
  const basename = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) {
    return "";
  }
  return basename.slice(dot).toLowerCase();
}
