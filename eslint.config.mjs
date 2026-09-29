import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'node_modules/',
      '.wrangler/',
      'dist/',
      'coverage/',
      'brag-output*/',
      'worker-configuration.d.ts',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Array access is guarded by `noUncheckedIndexedAccess`; after an explicit
      // length/bounds check a non-null assertion is the clearest expression.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['log', 'warn', 'error', 'debug'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Small config files: linted, but typechecked via tsc rather than the project service.
    files: ['**/*.mjs', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['scripts/**/*.ts', 'vitest.config.ts', 'eslint.config.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests assert on shapes they just built; unsafe-member noise hides real signal.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
