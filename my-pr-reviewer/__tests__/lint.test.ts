import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { jest } from '@jest/globals';

const getExecOutput = jest.fn<
  (
    command: string,
    args?: string[],
    options?: { cwd?: string; ignoreReturnCode?: boolean; silent?: boolean }
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
>();

const warning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/exec', () => ({
  getExecOutput,
  exec: jest.fn(),
}));

jest.unstable_mockModule('@actions/core', () => ({
  warning,
  info: jest.fn(),
  error: jest.fn(),
  setFailed: jest.fn(),
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
}));

const {
  runLint,
  parseRuffJson,
  parsePylintJson,
  parseEslintJson,
  parseGolangciJson,
  hasRuffConfig,
  hasEslintConfig,
  hasGolangciConfig,
} = await import('../src/lint');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-lint-'));
}

function writeFile(dir: string, name: string, contents = ''): void {
  fs.writeFileSync(path.join(dir, name), contents);
}

describe('JSON parsers', () => {
  it('parses ruff JSON into the normalized shape', () => {
    const raw = JSON.stringify([
      {
        code: 'F401',
        message: '`os` imported but unused',
        filename: 'app.py',
        location: { row: 3, column: 8 },
      },
    ]);

    expect(parseRuffJson(raw)).toEqual([
      {
        file: 'app.py',
        line: 3,
        severity: 'error',
        message: 'F401: `os` imported but unused',
      },
    ]);
  });

  it('parses pylint JSON into the normalized shape', () => {
    const raw = JSON.stringify([
      {
        type: 'warning',
        line: 10,
        message: 'Unused variable',
        path: 'mod.py',
        'message-id': 'W0612',
        symbol: 'unused-variable',
      },
      {
        type: 'error',
        line: 2,
        message: 'Undefined variable',
        path: 'mod.py',
        'message-id': 'E0602',
      },
    ]);

    expect(parsePylintJson(raw)).toEqual([
      {
        file: 'mod.py',
        line: 10,
        severity: 'warning',
        message: 'W0612: Unused variable',
      },
      {
        file: 'mod.py',
        line: 2,
        severity: 'error',
        message: 'E0602: Undefined variable',
      },
    ]);
  });

  it('parses eslint JSON into the normalized shape', () => {
    const raw = JSON.stringify([
      {
        filePath: '/repo/src/index.js',
        messages: [
          {
            line: 4,
            severity: 2,
            message: "'x' is defined but never used.",
            ruleId: 'no-unused-vars',
          },
          {
            line: 8,
            severity: 1,
            message: 'Unexpected console statement.',
            ruleId: 'no-console',
          },
        ],
      },
    ]);

    expect(parseEslintJson(raw)).toEqual([
      {
        file: '/repo/src/index.js',
        line: 4,
        severity: 'error',
        message: "no-unused-vars: 'x' is defined but never used.",
      },
      {
        file: '/repo/src/index.js',
        line: 8,
        severity: 'warning',
        message: 'no-console: Unexpected console statement.',
      },
    ]);
  });

  it('parses golangci-lint JSON into the normalized shape', () => {
    const raw = JSON.stringify({
      Issues: [
        {
          FromLinter: 'errcheck',
          Text: 'Error return value is not checked',
          Severity: 'warning',
          Pos: { Filename: 'main.go', Line: 12 },
        },
        {
          FromLinter: 'staticcheck',
          Text: 'impossible condition',
          Severity: 'error',
          Pos: { Filename: 'util.go', Line: 5 },
        },
      ],
    });

    expect(parseGolangciJson(raw)).toEqual([
      {
        file: 'main.go',
        line: 12,
        severity: 'warning',
        message: 'errcheck: Error return value is not checked',
      },
      {
        file: 'util.go',
        line: 5,
        severity: 'error',
        message: 'staticcheck: impossible condition',
      },
    ]);
  });

  it('returns [] for empty or invalid JSON', () => {
    expect(parseRuffJson('')).toEqual([]);
    expect(parseEslintJson('not json')).toEqual([]);
    expect(parseGolangciJson('{}')).toEqual([]);
  });
});

describe('runLint', () => {
  beforeEach(() => {
    getExecOutput.mockReset();
    warning.mockReset();
  });

  it('uses ruff when ruff config exists and parses its JSON', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'ruff.toml', '');

    getExecOutput.mockImplementation(async (command, args = []) => {
      const script = args[1] ?? '';
      if (script.startsWith('command -v')) {
        return { exitCode: 0, stdout: '/usr/bin/ruff\n', stderr: '' };
      }
      if (script.includes('ruff check')) {
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              code: 'E501',
              message: 'line too long',
              filename: 'main.py',
              location: { row: 99, column: 1 },
            },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await runLint('python', dir);
    expect(result.issues).toEqual([
      {
        file: 'main.py',
        line: 99,
        severity: 'error',
        message: 'E501: line too long',
      },
    ]);
    expect(hasRuffConfig(dir)).toBe(true);
  });

  it('falls back to pylint when ruff config is missing', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'requirements.txt', 'flask\n');

    getExecOutput.mockImplementation(async (command, args = []) => {
      const script = args[1] ?? '';
      if (script.startsWith('command -v')) {
        return {
          exitCode: script.includes('pylint') ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      }
      if (script.includes('pylint')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              type: 'error',
              line: 1,
              message: 'Missing docstring',
              path: 'app.py',
              'message-id': 'C0114',
            },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await runLint('python', dir);
    expect(result.issues[0]).toMatchObject({
      file: 'app.py',
      line: 1,
      severity: 'error',
    });
    expect(result.issues[0]?.message).toContain('Missing docstring');
  });

  it('runs eslint for node when .eslintrc.json exists', async () => {
    const dir = makeTempDir();
    writeFile(dir, '.eslintrc.json', '{}');
    expect(hasEslintConfig(dir)).toBe(true);

    getExecOutput.mockImplementation(async (command, args = []) => {
      const script = args[1] ?? '';
      if (script.startsWith('command -v')) {
        return {
          exitCode: script.includes('eslint') ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      }
      if (script.includes('eslint')) {
        return {
          exitCode: 1,
          stdout: JSON.stringify([
            {
              filePath: 'src/app.js',
              messages: [
                {
                  line: 2,
                  severity: 2,
                  message: 'Unexpected var',
                  ruleId: 'no-var',
                },
              ],
            },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await runLint('node', dir);
    expect(result.issues).toEqual([
      {
        file: 'src/app.js',
        line: 2,
        severity: 'error',
        message: 'no-var: Unexpected var',
      },
    ]);
  });

  it('skips eslint when no .eslintrc* is present', async () => {
    const dir = makeTempDir();
    const result = await runLint('node', dir);
    expect(result.issues).toEqual([]);
    expect(result.note).toMatch(/No \.eslintrc/i);
    expect(getExecOutput).not.toHaveBeenCalled();
  });

  it('runs golangci-lint when configured and parses Issues', async () => {
    const dir = makeTempDir();
    writeFile(dir, '.golangci.yml', 'linters:\n  enable:\n    - errcheck\n');
    expect(hasGolangciConfig(dir)).toBe(true);

    getExecOutput.mockImplementation(async (command, args = []) => {
      const script = args[1] ?? '';
      if (script.startsWith('command -v')) {
        return {
          exitCode: script.includes('golangci-lint') ? 0 : 1,
          stdout: '',
          stderr: '',
        };
      }
      if (script.includes('golangci-lint')) {
        return {
          exitCode: 1,
          stdout: JSON.stringify({
            Issues: [
              {
                FromLinter: 'govet',
                Text: 'printf verb',
                Severity: 'error',
                Pos: { Filename: 'main.go', Line: 7 },
              },
            ],
          }),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    const result = await runLint('go', dir);
    expect(result.issues).toEqual([
      {
        file: 'main.go',
        line: 7,
        severity: 'error',
        message: 'govet: printf verb',
      },
    ]);
  });

  it('skips go when golangci-lint is not configured', async () => {
    const dir = makeTempDir();
    const result = await runLint('go', dir);
    expect(result.issues).toEqual([]);
    expect(result.note).toMatch(/No golangci-lint config/i);
  });

  it('returns empty issues with note for java', async () => {
    const result = await runLint('java', makeTempDir());
    expect(result).toEqual({ issues: [], note: 'not yet supported' });
  });

  it('attempts install then warns when the binary stays missing', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'ruff.toml', '');

    getExecOutput.mockImplementation(async (command, args = []) => {
      const script = args[1] ?? '';
      if (command === 'bash' && script.startsWith('command -v')) {
        return { exitCode: 1, stdout: '', stderr: '' };
      }
      // pip install / anything else
      return { exitCode: 1, stdout: '', stderr: 'fail' };
    });

    const result = await runLint('python', dir);
    expect(result.issues).toEqual([]);
    expect(result.note).toMatch(/could not be installed/i);
    expect(warning).toHaveBeenCalled();
    expect(getExecOutput).toHaveBeenCalledWith(
      'pip',
      ['install', 'ruff', '--break-system-packages'],
      expect.objectContaining({ ignoreReturnCode: true })
    );
  });
});
