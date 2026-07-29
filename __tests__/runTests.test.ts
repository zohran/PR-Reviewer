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

jest.unstable_mockModule('@actions/exec', () => ({
  getExecOutput,
  exec: jest.fn(),
}));

const { runTests, capOutput, hasAnyConfigFile, getLanguageTestPlan } =
  await import('../src/runTests');

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-'));
}

function writeFile(dir: string, name: string, contents = ''): void {
  fs.writeFileSync(path.join(dir, name), contents);
}

describe('runTests', () => {
  beforeEach(() => {
    getExecOutput.mockReset();
    getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'ok\n',
      stderr: '',
    });
  });

  it('returns ran:false when no config file exists for the language', async () => {
    const dir = makeTempDir();
    const result = await runTests('python', dir);

    expect(result).toEqual({
      ran: false,
      passed: null,
      output: 'No test config found',
      exitCode: null,
    });
    expect(getExecOutput).not.toHaveBeenCalled();
  });

  it('returns ran:false for unsupported languages without a custom command', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'package.json', '{}');
    const result = await runTests('rust', dir);

    expect(result.ran).toBe(false);
    expect(result.output).toBe('No test config found');
  });

  it('runs python install + pytest when requirements.txt exists', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'requirements.txt', 'pytest\n');

    getExecOutput
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'installed\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '1 passed\n',
        stderr: '',
      });

    const result = await runTests('python', dir);

    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('installed');
    expect(result.output).toContain('1 passed');

    expect(getExecOutput).toHaveBeenNthCalledWith(
      1,
      'bash',
      ['-lc', 'pip install -r requirements.txt --break-system-packages || true'],
      expect.objectContaining({ cwd: dir, ignoreReturnCode: true })
    );
    expect(getExecOutput).toHaveBeenNthCalledWith(
      2,
      'bash',
      ['-lc', 'pytest --tb=short -q'],
      expect.objectContaining({ cwd: dir, ignoreReturnCode: true })
    );
  });

  it('accepts pyproject.toml as python config', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'pyproject.toml', '[project]\nname="x"\n');

    await runTests('python', dir);
    expect(getExecOutput).toHaveBeenCalled();
  });

  it('runs node install + test when package.json exists', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'package.json', '{}');

    await runTests('node', dir);

    expect(getExecOutput).toHaveBeenNthCalledWith(
      1,
      'bash',
      ['-lc', 'npm ci || npm install'],
      expect.objectContaining({ ignoreReturnCode: true })
    );
    expect(getExecOutput).toHaveBeenNthCalledWith(
      2,
      'bash',
      ['-lc', 'npm test --if-present'],
      expect.objectContaining({ ignoreReturnCode: true })
    );
  });

  it('runs go / java / ruby default commands when config exists', async () => {
    const goDir = makeTempDir();
    writeFile(goDir, 'go.mod', 'module example');
    await runTests('go', goDir);
    expect(getExecOutput).toHaveBeenLastCalledWith(
      'bash',
      ['-lc', 'go test ./...'],
      expect.objectContaining({ cwd: goDir })
    );

    getExecOutput.mockClear();
    const javaDir = makeTempDir();
    writeFile(javaDir, 'pom.xml', '<project/>');
    await runTests('java', javaDir);
    expect(getExecOutput).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'mvn -q -B test'],
      expect.objectContaining({ cwd: javaDir })
    );

    getExecOutput.mockClear();
    const rubyDir = makeTempDir();
    writeFile(rubyDir, 'Gemfile', 'source "https://rubygems.org"');
    await runTests('ruby', rubyDir);
    expect(getExecOutput).toHaveBeenNthCalledWith(
      1,
      'bash',
      ['-lc', 'bundle install'],
      expect.any(Object)
    );
    expect(getExecOutput).toHaveBeenNthCalledWith(
      2,
      'bash',
      ['-lc', 'bundle exec rspec'],
      expect.any(Object)
    );
  });

  it('marks passed:false when the final command exits non-zero', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'go.mod', 'module example');
    getExecOutput.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'FAIL\n',
    });

    const result = await runTests('go', dir);

    expect(result).toMatchObject({
      ran: true,
      passed: false,
      exitCode: 1,
    });
    expect(result.output).toContain('FAIL');
  });

  it('runs custom-test-command instead of language defaults', async () => {
    const dir = makeTempDir();
    // No config file — custom command should still run
    getExecOutput.mockResolvedValue({
      exitCode: 0,
      stdout: 'custom ok\n',
      stderr: '',
    });

    const result = await runTests('python', dir, 'make test');

    expect(result.ran).toBe(true);
    expect(result.passed).toBe(true);
    expect(getExecOutput).toHaveBeenCalledTimes(1);
    expect(getExecOutput).toHaveBeenCalledWith(
      'bash',
      ['-lc', 'make test'],
      expect.objectContaining({ cwd: dir, ignoreReturnCode: true })
    );
  });

  it('caps huge output to the last ~5000 characters', async () => {
    const dir = makeTempDir();
    writeFile(dir, 'go.mod', 'module example');
    const huge = 'x'.repeat(6000) + 'FAILURE_TAIL';
    getExecOutput.mockResolvedValue({
      exitCode: 1,
      stdout: huge,
      stderr: '',
    });

    const result = await runTests('go', dir);

    expect(result.output.length).toBeLessThan(huge.length);
    expect(result.output.endsWith('FAILURE_TAIL')).toBe(true);
    expect(result.output).toContain('truncated');
  });
});

describe('capOutput / helpers', () => {
  it('returns short output unchanged', () => {
    expect(capOutput('hello')).toBe('hello');
  });

  it('keeps the end of long output', () => {
    const capped = capOutput('ABCDEFGHIJ', 4);
    expect(capped.endsWith('GHIJ')).toBe(true);
    expect(capped).toContain('truncated');
  });

  it('detects config files in the working directory', () => {
    const dir = makeTempDir();
    expect(hasAnyConfigFile(dir, ['package.json'])).toBe(false);
    writeFile(dir, 'package.json', '{}');
    expect(hasAnyConfigFile(dir, ['package.json'])).toBe(true);
  });

  it('exposes language plans for supported languages', () => {
    expect(getLanguageTestPlan('node')?.configFiles).toContain('package.json');
    expect(getLanguageTestPlan('PYTHON')?.commands[1]).toContain('pytest');
    expect(getLanguageTestPlan('rust')).toBeUndefined();
  });
});
