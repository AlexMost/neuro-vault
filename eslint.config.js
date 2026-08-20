import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '.worktrees/**',
      'package-lock.json',
      '.claude/worktrees/**',
      // subagent-driven-development scratch (ledger, task briefs, review
      // diffs) — throwaway, deleted at the end of each apply run.
      '.superpowers/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        // import.meta.dirname requires Node >= 20.11 (engines says >=20; CI uses latest 20.x)
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Test-only relaxation: these rules false-positive on the mock/fixture
    // idiom — async interface conformance without await, expect(mock.method),
    // probing unknown payloads. Promise-safety rules (no-floating-promises,
    // no-misused-promises) stay ON here deliberately: an un-awaited assertion
    // is exactly the bug class tests must not have.
    files: ['test/**'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // JS config files (eslint.config.js, commitlint.config.js) sit outside
    // tsconfig — no type info, so type-aware rules must not run on them.
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
);
