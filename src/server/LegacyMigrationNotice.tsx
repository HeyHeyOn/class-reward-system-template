import 'server-only';
import { connection } from 'next/server';
import { LegacyMigrationBanner } from '@/components/LegacyMigrationBanner';
import { getLegacyDeploymentMode } from './legacyDeploymentMode';

export async function LegacyMigrationNotice() {
  // Read deployment configuration at request time, not from a prerendered build.
  await connection();
  return <LegacyMigrationBanner mode={getLegacyDeploymentMode()} />;
}
