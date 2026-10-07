import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default mergeConfig(base, { envDir: false, test: { maxWorkers: 1, fileParallelism: false,
  include: ['src/server/migration/frozenFullCutover.postgres.test.ts'] } });
