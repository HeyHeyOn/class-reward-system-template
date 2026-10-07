import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';

// Run from the repository root. Never load the operator's .env.local for tests.
export default mergeConfig(base, {
  envDir: false,
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'src/app/api/classes/route.test.ts',
      'src/app/classes/**/*.test.tsx',
      'src/server/classMembershipPageAccess.test.ts',
      'src/server/repositories/database/classCreation*.test.ts',
      'src/server/repositories/database/classStart*.test.ts',
      'src/server/classStart.test.ts',
      'src/server/classManagement.test.ts',
      'src/server/repositories/database/classDashboard*.test.ts',
      'src/server/repositories/database/classMemberships.test.ts',
      'src/server/tenantAccess.test.ts',
      'src/server/tenantAuth.test.ts',
      'src/server/tenantContext.test.ts',
      'src/server/googleOAuth.ordinaryIdentityFallback.test.ts',
      'src/server/googleOAuth.identityKeyBoundary.test.ts',
    ],
  },
});
