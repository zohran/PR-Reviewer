/** A single normalized lint finding. */
export interface LintIssue {
    /** File path (as reported by the linter). */
    file: string;
    /** Line number (1-based), or null when unavailable. */
    line: number | null;
    /** Severity mapped to error | warning. */
    severity: 'error' | 'warning';
    /** Human-readable message. */
    message: string;
}
/** Aggregated result of a lint run. */
export interface LintResult {
    /** Normalized lint issues. */
    issues: LintIssue[];
    /** Optional note (unsupported language, skipped, install failure, etc.). */
    note?: string;
}
/**
 * Runs the language-appropriate linter (when configured) and returns
 * normalized issues parsed from JSON output.
 *
 * @param language - Detected language (`python`, `node`, `go`, `java`, …)
 * @param workingDir - Absolute path to the checked-out repository
 */
export declare function runLint(language: string, workingDir: string): Promise<LintResult>;
/** True when a Ruff config file (or `[tool.ruff]` in pyproject) is present. */
export declare function hasRuffConfig(workingDir: string): boolean;
/** True when an `.eslintrc*` file exists in the working directory. */
export declare function hasEslintConfig(workingDir: string): boolean;
/** True when a golangci-lint config file exists. */
export declare function hasGolangciConfig(workingDir: string): boolean;
/**
 * Ensures `binary` is on PATH; if missing, runs `installArgs` via exec and
 * re-checks. Logs a warning and returns false when still unavailable.
 */
export declare function ensureBinary(binary: string, workingDir: string, installArgs: readonly string[]): Promise<boolean>;
/** Parses Ruff `--output-format=json` output into normalized issues. */
export declare function parseRuffJson(raw: string): LintIssue[];
/** Parses Pylint `--output-format=json` output into normalized issues. */
export declare function parsePylintJson(raw: string): LintIssue[];
/** Parses ESLint `--format json` output into normalized issues. */
export declare function parseEslintJson(raw: string): LintIssue[];
/** Parses golangci-lint `--out-format json` output into normalized issues. */
export declare function parseGolangciJson(raw: string): LintIssue[];
