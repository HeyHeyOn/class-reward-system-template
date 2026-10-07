import { defineConfig } from 'vitest/config';

// Sol-only, inside the reviewed fixture; never use the shared checkout config.
// This config is not an isolation mechanism and does not launch any service.
export default defineConfig({
  root: '/fixture',
  envDir: false,
  cacheDir: '/scratch/crs-task20/vite-cache',
  test: {
    environment: 'node',
    include: ['src/app/c/**/admin/migrations/history/download.acceptance.test.tsx'],
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
    watch: false,
    testTimeout: 240_000,
    reporters: ['default', 'json'],
    outputFile: { json: '/scratch/crs-task20/vitest-result.json' },
  },
});
