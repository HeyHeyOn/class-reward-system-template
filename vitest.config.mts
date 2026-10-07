import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: 'jsdom',
    // These are native node:test programs, not Vitest modules. The adapter runs
    // all their assertions in child Node processes with per-suite conditions.
    // Do not globally enable react-server or alias away the server-only guard.
    exclude: [...configDefaults.exclude,
      'scripts/task21-synthetic-retained-backup.test.mjs',
      'test-support/crs-recovery/retained-store.test.mjs'],
  },
});
