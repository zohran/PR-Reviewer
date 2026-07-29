import {
  detectLanguage,
  extractLanguageTag,
  shouldIgnorePath,
} from '../src/detectLanguage';
import type { ChangedFile } from '../src/types';

function file(filename: string): Pick<ChangedFile, 'filename'> {
  return { filename };
}

describe('detectLanguage', () => {
  describe('explicit tag detection', () => {
    it('detects "Language: python" (case-insensitive)', () => {
      expect(
        detectLanguage([file('src/main.go')], 'Language: python')
      ).toBe('python');
    });

    it('detects "lang: go" with extra whitespace', () => {
      expect(
        detectLanguage([file('app.py')], '  lang  :   Go  \n')
      ).toBe('go');
    });

    it('prefers the tag over extension majority', () => {
      expect(
        detectLanguage(
          [file('a.ts'), file('b.ts'), file('c.ts')],
          'Please review.\n\nLanguage: Rust\n'
        )
      ).toBe('rust');
    });

    it('returns the tagged value lowercased even for uncommon names', () => {
      expect(extractLanguageTag('lang: Kotlin')).toBe('kotlin');
      expect(detectLanguage([], 'lang: Kotlin')).toBe('kotlin');
    });

    it('ignores missing or empty descriptions', () => {
      expect(extractLanguageTag(null)).toBeUndefined();
      expect(extractLanguageTag(undefined)).toBeUndefined();
      expect(extractLanguageTag('')).toBeUndefined();
      expect(extractLanguageTag('No language tag here')).toBeUndefined();
    });
  });

  describe('extension majority voting', () => {
    it('returns the language with the most matching files', () => {
      expect(
        detectLanguage(
          [
            file('src/a.py'),
            file('src/b.py'),
            file('src/c.py'),
            file('cmd/main.go'),
          ],
          null
        )
      ).toBe('python');
    });

    it('maps JS/TS extensions to node', () => {
      expect(
        detectLanguage(
          [file('src/index.ts'), file('src/App.tsx'), file('lib/util.js')],
          undefined
        )
      ).toBe('node');
    });

    it('maps each supported extension correctly', () => {
      expect(detectLanguage([file('Main.java')], null)).toBe('java');
      expect(detectLanguage([file('app.rb')], null)).toBe('ruby');
      expect(detectLanguage([file('main.rs')], null)).toBe('rust');
      expect(detectLanguage([file('Program.cs')], null)).toBe('csharp');
      expect(detectLanguage([file('main.go')], null)).toBe('go');
    });

    it('ignores vendor/generated paths and lockfiles when counting', () => {
      expect(
        detectLanguage(
          [
            file('node_modules/lodash/index.js'),
            file('dist/bundle.js'),
            file('vendor/pkg/file.go'),
            file('src/nested/node_modules/x.ts'),
            file('yarn.lock'),
            file('Cargo.lock'),
            file('src/app.py'),
            file('src/util.py'),
          ],
          null
        )
      ).toBe('python');
    });

    it('exposes shouldIgnorePath for vendor and lock paths', () => {
      expect(shouldIgnorePath('node_modules/foo.js')).toBe(true);
      expect(shouldIgnorePath('packages/dist/out.js')).toBe(true);
      expect(shouldIgnorePath('vendor/lib.go')).toBe(true);
      expect(shouldIgnorePath('pnpm-lock.yaml')).toBe(false);
      expect(shouldIgnorePath('Gemfile.lock')).toBe(true);
      expect(shouldIgnorePath('src/app.py')).toBe(false);
    });
  });

  describe('tie-breaking and unknown fallback', () => {
    it('returns unknown on a tie between languages', () => {
      expect(
        detectLanguage(
          [file('a.py'), file('b.py'), file('main.go'), file('util.go')],
          null
        )
      ).toBe('unknown');
    });

    it('returns unknown when there are no matching extensions', () => {
      expect(
        detectLanguage([file('README.md'), file('Dockerfile')], null)
      ).toBe('unknown');
    });

    it('returns unknown when all files are ignored', () => {
      expect(
        detectLanguage(
          [file('node_modules/x.js'), file('dist/y.ts'), file('yarn.lock')],
          null
        )
      ).toBe('unknown');
    });

    it('returns unknown for an empty file list without a tag', () => {
      expect(detectLanguage([], null)).toBe('unknown');
    });
  });
});
