import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';

// Application suites plus the explicit Node-test adapter. Its child entrypoints
// run only under their owning adapter; never discover them as standalone tests.
export default mergeConfig(base, {
  envDir: false,
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx,mts,mjs}', 'test-support/nodeTestRunners.test.ts'],
    maxWorkers: 2,
    fileParallelism: true,
    // PGlite fixtures install a full schema before each case. Their setup
    // budget must allow parallel cold starts without changing test deadlines.
    hookTimeout: 30_000,
  },
});
