import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default mergeConfig(base, { envDir: false, test: { maxWorkers: 1, fileParallelism: false, include: [
  'src/server/repositories/database/taskCompletionCommands.test.ts',
  'src/server/repositories/database/taskCycleQueries.test.ts',
  'src/components/AdminManagePage.creationSnapshot.test.tsx',
] } });
