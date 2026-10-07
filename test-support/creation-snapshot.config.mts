import { mergeConfig } from 'vitest/config';
import base from '../vitest.config.mts';
export default mergeConfig(base, { envDir: false, test: { maxWorkers: 1, fileParallelism: false, include: [
  'src/components/AdminManagePage.creationSnapshot.test.tsx',
  'src/components/AdminManagePage.studentEditor.test.tsx',
  'src/components/AdminManagePage.productEditor.test.tsx',
  'src/components/AdminManagePage.test.tsx',
] } });
