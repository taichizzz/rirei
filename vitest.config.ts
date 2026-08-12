import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      'benchmarks/handoff/fixtures/**',
      'benchmarks/handoff/**/*.test.mjs',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
