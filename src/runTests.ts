import * as fs from 'node:fs';
import * as path from 'node:path';
import * as exec from '@actions/exec';

/** Soft cap on captured test output kept for PR comments / LLM context. */
export const MAX_TEST_OUTPUT_CHARS = 5000;

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

const LANGUAGE_PLANS: Readonly<Record<string, LanguageTestPlan>> = {
  python: {
    configFiles: ['requirements.txt', 'pyproject.toml'],
    commands: [
      'pip install -r requirements.txt --break-system-packages || true',
      'pytest --tb=short -q',
    ],
  },
  node: {
    configFiles: ['package.json'],
    commands: ['npm ci || npm install', 'npm test --if-present'],
  },
  go: {
    configFiles: ['go.mod'],
    commands: ['go test ./...'],
  },
  java: {
    configFiles: ['pom.xml'],
    commands: ['mvn -q -B test'],
  },
  ruby: {
    configFiles: ['Gemfile'],
    commands: ['bundle install', 'bundle exec rspec'],
  },
};

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
export async function runTests(
  language: string,
  workingDir: string,
  customTestCommand?: string
): Promise<TestResult> {
  const trimmedCustom = customTestCommand?.trim();

  if (trimmedCustom) {
    return runCommandSequence([trimmedCustom], workingDir);
  }

  const plan = LANGUAGE_PLANS[language.toLowerCase()];
  if (!plan || !hasAnyConfigFile(workingDir, plan.configFiles)) {
    return {
      ran: false,
      passed: null,
      output: 'No test config found',
      exitCode: null,
    };
  }

  return runCommandSequence(plan.commands, workingDir);
}

/**
 * Returns true when at least one of the given config filenames exists in `workingDir`.
 */
export function hasAnyConfigFile(
  workingDir: string,
  configFiles: readonly string[]
): boolean {
  return configFiles.some((file) =>
    fs.existsSync(path.join(workingDir, file))
  );
}

/**
 * Keeps the last `maxChars` of output so failure details (usually at the end)
 * are preserved for PR comments.
 */
export function capOutput(
  output: string,
  maxChars: number = MAX_TEST_OUTPUT_CHARS
): string {
  if (output.length <= maxChars) {
    return output;
  }

  const omitted = output.length - maxChars;
  return `…[truncated ${omitted} earlier chars]\n${output.slice(-maxChars)}`;
}

/**
 * Looks up the default command plan for a language, if any.
 */
export function getLanguageTestPlan(
  language: string
): LanguageTestPlan | undefined {
  return LANGUAGE_PLANS[language.toLowerCase()];
}

async function runCommandSequence(
  commands: readonly string[],
  workingDir: string
): Promise<TestResult> {
  let combined = '';
  let lastExitCode = 0;

  for (const command of commands) {
    const result = await exec.getExecOutput('bash', ['-lc', command], {
      cwd: workingDir,
      ignoreReturnCode: true,
      silent: true,
    });

    combined += result.stdout;
    if (result.stderr) {
      combined += result.stderr;
    }
    lastExitCode = result.exitCode;
  }

  return {
    ran: true,
    passed: lastExitCode === 0,
    output: capOutput(combined),
    exitCode: lastExitCode,
  };
}
