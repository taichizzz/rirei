import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Reduce I/O and child-process contention on shared Windows CI runners.
    ...(process.platform === 'win32' && process.env.CI === 'true'
      ? { maxWorkers: 2 }
      : {}),
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
