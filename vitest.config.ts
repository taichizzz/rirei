import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.claude/**',
      'benchmarks/handoff/fixtures/**',
      'benchmarks/handoff/**/*.test.mjs',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    setupFiles: ['tests/setup.ts'],
  },
});
