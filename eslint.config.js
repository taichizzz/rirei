import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/',
      'coverage/',
      'release/',
      'desktop/renderer/vendor/',
      // Generated local Relay state (provider-usage collectors, checkpoints,
      // runtime artifacts). Written at run time, never source.
      '.relay/',
    ],
  },
  {
    // Electron main/preload run in Node, not the browser or TS build.
    files: ['desktop/**/*.{mjs,cjs,js}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        console: 'readonly',
        atob: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        TextDecoder: 'readonly',
        WebSocket: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
