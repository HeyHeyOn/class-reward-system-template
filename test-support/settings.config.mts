import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';

export default mergeConfig(base, {
  envDir: false,
  test: { maxWorkers: 1, fileParallelism: false, include: [
    'src/app/api/settings/route.test.ts',
    'src/components/AdminSettingsPage*.test.tsx',
    'src/server/repositories/database/settingsCommands*.test.ts',
    'src/server/repositories/database/settingsQueries.test.ts',
  ] },
});
