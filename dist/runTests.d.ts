/** Soft cap on captured test output kept for PR comments / LLM context. */
export declare const MAX_TEST_OUTPUT_CHARS = 5000;
/** Result of attempting to run the project's test suite. */
export interface TestResult {
    /** Whether any test command was actually executed. */
    ran: boolean;
    /** `true` if tests passed, `false` if they failed, `null` if not run. */
    passed: boolean | null;
    /** Combined stdout+stderr (truncated to the last ~5000 characters). */
    output: string;
    /** Exit code of the final test command, or `null` if not run. */
    exitCode: number | null;
}
interface LanguageTestPlan {
    /** Manifest / config files; any one present enables the default plan. */
    configFiles: string[];
    /** Shell commands to run in order (install then test, when applicable). */
    commands: string[];
}
/**
 * Runs the project's test suite for the detected language using `@actions/exec`.
 *
 * When `customTestCommand` is set, that shell command is run instead of the
 * language defaults (and the config-file check is skipped). Otherwise a
 * language-specific plan runs only if a relevant config file exists in
 * `workingDir`.
 *
 * All commands use `ignoreReturnCode: true` so a failing suite does not throw.
 *
 * @param language - Detected language (e.g. `python`, `node`, `go`)
 * @param workingDir - Absolute path to the checked-out repository
 * @param customTestCommand - Optional override from the `custom-test-command` input
 */
export declare function runTests(language: string, workingDir: string, customTestCommand?: string): Promise<TestResult>;
/**
 * Returns true when at least one of the given config filenames exists in `workingDir`.
 */
export declare function hasAnyConfigFile(workingDir: string, configFiles: readonly string[]): boolean;
/**
 * Keeps the last `maxChars` of output so failure details (usually at the end)
 * are preserved for PR comments.
 */
export declare function capOutput(output: string, maxChars?: number): string;
/**
 * Looks up the default command plan for a language, if any.
 */
export declare function getLanguageTestPlan(language: string): LanguageTestPlan | undefined;
export {};
