import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export default mergeConfig(base, {
  envDir: false,
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'src/server/repositories/database/checkoutConcurrency.postgres.test.ts',
      'src/server/repositories/database/checkoutLoad.postgres.test.ts',
      'src/server/repositories/database/rewardCancellationConcurrency.postgres.test.ts',
    ],
  },
});
