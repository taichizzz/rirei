import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'coverage/', 'release/', 'desktop/renderer/vendor/'],
  },
  {
    // Electron main/preload run in Node, not the browser or TS build.
    files: ['desktop/**/*.{mjs,cjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
