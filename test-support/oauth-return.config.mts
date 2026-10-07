import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export default mergeConfig(base, {
  envDir: false,
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    include: [
      'src/app/api/google/login/route.test.ts',
      'src/app/api/google/callback/route.test.ts',
      'src/server/googleOAuth*.test.ts',
      'src/components/AdminLoginPage*.test.tsx',
      'src/proxy.test.ts',
      'src/server/tenantAdminPageAccess.test.ts',
      'src/server/tenantAuth.test.ts',
      'src/server/tenantContext.test.ts',
    ],
  },
});
