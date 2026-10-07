import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default mergeConfig(base, { envDir: false, test: { maxWorkers: 1, fileParallelism: false,
  include: ['src/server/migration/legacyFinancialHistory.test.ts', 'src/server/migration/importLegacyFinancialHistory.postgres.test.ts',
    'src/server/migration/legacyTaskHistory.test.ts', 'src/server/migration/importLegacyTaskHistory.postgres.test.ts',
    'src/server/migration/importLegacyFullSnapshot.postgres.test.ts', 'src/server/migration/legacyClaimPublication.postgres.test.ts',
    'src/server/migration/legacyHistoryRestore.postgres.test.ts', 'src/server/repositories/database/padletClaims.test.ts'] } });
