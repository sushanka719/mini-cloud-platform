import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/*.d.ts', 'storage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Node globals for config files and any plain JS/MJS tooling scripts.
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', __dirname: 'readonly' },
    },
  },
  {
    // migrations are plain CJS-style scripts run by node-pg-migrate
    files: ['packages/db/migrations/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
