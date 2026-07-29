import * as fs from 'node:fs';
import * as path from 'node:path';
import * as core from '@actions/core';
import * as exec from '@actions/exec';

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

const ESLINTRC_PATTERNS = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.eslintrc.json',
];

const GOLANGCI_CONFIG_FILES = [
  '.golangci.yml',
  '.golangci.yaml',
  '.golangci.toml',
  '.golangci.json',
];

/**
 * Runs the language-appropriate linter (when configured) and returns
 * normalized issues parsed from JSON output.
 *
 * @param language - Detected language (`python`, `node`, `go`, `java`, …)
 * @param workingDir - Absolute path to the checked-out repository
 */
export async function runLint(
  language: string,
  workingDir: string
): Promise<LintResult> {
  switch (language.toLowerCase()) {
    case 'python':
      return lintPython(workingDir);
    case 'node':
      return lintNode(workingDir);
    case 'go':
      return lintGo(workingDir);
    case 'java':
      return { issues: [], note: 'not yet supported' };
    default:
      return {
        issues: [],
        note: `No linter configured for language: ${language}`,
      };
  }
}

async function lintPython(workingDir: string): Promise<LintResult> {
  if (hasRuffConfig(workingDir)) {
    const ensured = await ensureBinary('ruff', workingDir, [
      'pip',
      'install',
      'ruff',
      '--break-system-packages',
    ]);
    if (!ensured) {
      return {
        issues: [],
        note: 'ruff is not installed and could not be installed',
      };
    }

    const output = await runShell(
      'ruff check --output-format=json .',
      workingDir
    );
    return { issues: parseRuffJson(output.stdout || output.stderr) };
  }

  const ensured = await ensureBinary('pylint', workingDir, [
    'pip',
    'install',
    'pylint',
    '--break-system-packages',
  ]);
  if (!ensured) {
    return {
      issues: [],
      note: 'pylint is not installed and could not be installed',
    };
  }

  const output = await runShell(
    'pylint --output-format=json $(find . -name "*.py" -not -path "./.git/*" -not -path "./.venv/*" -not -path "./venv/*" 2>/dev/null | tr "\\n" " ")',
    workingDir
  );
  return { issues: parsePylintJson(output.stdout || output.stderr) };
}

async function lintNode(workingDir: string): Promise<LintResult> {
  if (!hasEslintConfig(workingDir)) {
    return { issues: [], note: 'No .eslintrc* config found; skipping ESLint' };
  }

  const ensured = await ensureBinary('eslint', workingDir, [
    'npm',
    'install',
    'eslint',
    '--no-save',
  ]);
  if (!ensured) {
    return {
      issues: [],
      note: 'eslint is not installed and could not be installed',
    };
  }

  const localBin = path.join(workingDir, 'node_modules', '.bin', 'eslint');
  const eslintCmd = fs.existsSync(localBin)
    ? `"${localBin}" . --format json`
    : 'eslint . --format json';

  const output = await runShell(eslintCmd, workingDir);
  return { issues: parseEslintJson(output.stdout || output.stderr) };
}

async function lintGo(workingDir: string): Promise<LintResult> {
  if (!hasGolangciConfig(workingDir)) {
    return {
      issues: [],
      note: 'No golangci-lint config found; skipping',
    };
  }

  const ensured = await ensureBinary('golangci-lint', workingDir, [
    'go',
    'install',
    'github.com/golangci/golangci-lint/cmd/golangci-lint@latest',
  ]);
  if (!ensured) {
    return {
      issues: [],
      note: 'golangci-lint is not installed and could not be installed',
    };
  }

  const output = await runShell(
    'golangci-lint run --out-format json',
    workingDir
  );
  return { issues: parseGolangciJson(output.stdout || output.stderr) };
}

/** True when a Ruff config file (or `[tool.ruff]` in pyproject) is present. */
export function hasRuffConfig(workingDir: string): boolean {
  if (
    fs.existsSync(path.join(workingDir, 'ruff.toml')) ||
    fs.existsSync(path.join(workingDir, '.ruff.toml'))
  ) {
    return true;
  }

  const pyproject = path.join(workingDir, 'pyproject.toml');
  if (!fs.existsSync(pyproject)) {
    return false;
  }

  try {
    const contents = fs.readFileSync(pyproject, 'utf8');
    return /\[tool\.ruff\b/.test(contents);
  } catch {
    return false;
  }
}

/** True when an `.eslintrc*` file exists in the working directory. */
export function hasEslintConfig(workingDir: string): boolean {
  return ESLINTRC_PATTERNS.some((name) =>
    fs.existsSync(path.join(workingDir, name))
  );
}

/** True when a golangci-lint config file exists. */
export function hasGolangciConfig(workingDir: string): boolean {
  return GOLANGCI_CONFIG_FILES.some((name) =>
    fs.existsSync(path.join(workingDir, name))
  );
}

/**
 * Ensures `binary` is on PATH; if missing, runs `installArgs` via exec and
 * re-checks. Logs a warning and returns false when still unavailable.
 */
export async function ensureBinary(
  binary: string,
  workingDir: string,
  installArgs: readonly string[]
): Promise<boolean> {
  if (await isBinaryAvailable(binary, workingDir)) {
    return true;
  }

  core.warning(
    `${binary} not found; attempting install: ${installArgs.join(' ')}`
  );

  const [cmd, ...args] = installArgs;
  await exec.getExecOutput(cmd, args, {
    cwd: workingDir,
    ignoreReturnCode: true,
    silent: true,
  });

  if (await isBinaryAvailable(binary, workingDir)) {
    return true;
  }

  // npm install --no-save may only place the binary under node_modules/.bin
  if (
    binary === 'eslint' &&
    fs.existsSync(path.join(workingDir, 'node_modules', '.bin', 'eslint'))
  ) {
    return true;
  }

  core.warning(
    `${binary} is still unavailable after install attempt; skipping lint`
  );
  return false;
}

async function isBinaryAvailable(
  binary: string,
  workingDir: string
): Promise<boolean> {
  const result = await exec.getExecOutput(
    'bash',
    ['-lc', `command -v ${shellQuote(binary)}`],
    {
      cwd: workingDir,
      ignoreReturnCode: true,
      silent: true,
    }
  );
  return result.exitCode === 0;
}

async function runShell(
  command: string,
  workingDir: string
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return exec.getExecOutput('bash', ['-lc', command], {
    cwd: workingDir,
    ignoreReturnCode: true,
    silent: true,
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Parses Ruff `--output-format=json` output into normalized issues. */
export function parseRuffJson(raw: string): LintIssue[] {
  const data = safeJsonParse(raw);
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((item: Record<string, unknown>) => {
    const location = (item.location ?? {}) as Record<string, unknown>;
    const row = location.row;
    return {
      file: String(item.filename ?? item.file ?? ''),
      line: typeof row === 'number' ? row : null,
      severity: 'error' as const, // Ruff diagnostics are treated as errors
      message: formatMessage(item.message, item.code),
    };
  });
}

/** Parses Pylint `--output-format=json` output into normalized issues. */
export function parsePylintJson(raw: string): LintIssue[] {
  const data = safeJsonParse(raw);
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((item: Record<string, unknown>) => {
    const type = String(item.type ?? 'warning').toLowerCase();
    const severity: LintIssue['severity'] =
      type === 'error' || type === 'fatal' ? 'error' : 'warning';
    const line = item.line;
    return {
      file: String(item.path ?? item.module ?? ''),
      line: typeof line === 'number' ? line : null,
      severity,
      message: formatMessage(item.message, item['message-id'] ?? item.symbol),
    };
  });
}

/** Parses ESLint `--format json` output into normalized issues. */
export function parseEslintJson(raw: string): LintIssue[] {
  const data = safeJsonParse(raw);
  if (!Array.isArray(data)) {
    return [];
  }

  const issues: LintIssue[] = [];
  for (const fileResult of data as Array<Record<string, unknown>>) {
    const filePath = String(fileResult.filePath ?? '');
    const messages = Array.isArray(fileResult.messages)
      ? (fileResult.messages as Array<Record<string, unknown>>)
      : [];

    for (const msg of messages) {
      const severityNum = msg.severity;
      const severity: LintIssue['severity'] =
        severityNum === 2 ? 'error' : 'warning';
      const line = msg.line;
      issues.push({
        file: filePath,
        line: typeof line === 'number' ? line : null,
        severity,
        message: formatMessage(msg.message, msg.ruleId),
      });
    }
  }
  return issues;
}

/** Parses golangci-lint `--out-format json` output into normalized issues. */
export function parseGolangciJson(raw: string): LintIssue[] {
  const data = safeJsonParse(raw);
  if (!data || typeof data !== 'object') {
    return [];
  }

  const issuesRaw = (data as Record<string, unknown>).Issues;
  if (!Array.isArray(issuesRaw)) {
    return [];
  }

  return issuesRaw.map((item: Record<string, unknown>) => {
    const pos = (item.Pos ?? item.PosInfo ?? {}) as Record<string, unknown>;
    const line = pos.Line;
    const sev = String(item.Severity ?? 'warning').toLowerCase();
    const severity: LintIssue['severity'] =
      sev === 'error' ? 'error' : 'warning';
    return {
      file: String(pos.Filename ?? item.SourceLines ?? ''),
      line: typeof line === 'number' ? line : null,
      severity,
      message: formatMessage(item.Text, item.FromLinter),
    };
  });
}

function formatMessage(
  message: unknown,
  code: unknown
): string {
  const text = String(message ?? '').trim();
  const rule = code != null && String(code).length > 0 ? String(code) : null;
  if (rule && text) {
    return `${rule}: ${text}`;
  }
  return text || rule || '';
}

function safeJsonParse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  // Linters sometimes print non-JSON before/after the payload; try direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('[');
    const startObj = trimmed.indexOf('{');
    let sliceStart = -1;
    if (start >= 0 && (startObj < 0 || start < startObj)) {
      sliceStart = start;
    } else if (startObj >= 0) {
      sliceStart = startObj;
    }
    if (sliceStart < 0) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(sliceStart));
    } catch {
      return null;
    }
  }
}
