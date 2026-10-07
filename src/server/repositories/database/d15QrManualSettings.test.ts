import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseSettingsQueries } from '@/server/repositories/database/settingsQueries';

vi.mock('server-only', () => ({}));
let harness: PgliteDatabaseHarness;
beforeEach(async () => { harness = await createPgliteDatabaseHarness(); });
afterEach(async () => { await harness?.close(); });
async function seed(tenantId: string, settings: Record<string, unknown>) {
  await harness.database.query(
    'INSERT INTO tenant_settings (tenant_id, schema_version, settings) VALUES ($1, 1, $2::jsonb)',
    [tenantId, JSON.stringify(settings)],
  );
}
function read(tenantId = harness.tenantOneId) {
  return createDatabaseSettingsQueries({ tenantId, runTenantTransaction: harness.runTenantTransaction }).getAppSettings();
}

describe('D15 bank PG QR direct-input policy projection', () => {
  it.each([
    { stored: true, enabled: true },
    { stored: false, enabled: false },
    { stored: 'TRUE', enabled: true },
    { stored: 'FALSE', enabled: false },
  ])('reads stored QR policy $stored as $enabled', async ({ stored, enabled }) => {
    await seed(harness.tenantOneId, { qrManualInputEnabled: stored });
    await expect(read()).resolves.toMatchObject({ source: 'database', qrManualInputEnabled: enabled });
  });
  it('keeps missing legacy PG policy absent so the bank retains its false default', async () => {
    expect(await read()).not.toHaveProperty('qrManualInputEnabled');
  });
  it('isolates true and false policy for two tenants', async () => {
    await seed(harness.tenantOneId, { qrManualInputEnabled: true });
    await seed(harness.tenantTwoId, { qrManualInputEnabled: false });
    await expect(read()).resolves.toMatchObject({ qrManualInputEnabled: true });
    await expect(read(harness.tenantTwoId)).resolves.toMatchObject({ qrManualInputEnabled: false });
  });
  it.each(['true', 1, null, [], {}].map((invalid) => ({ invalid })))(
    'rejects an invalid stored policy instead of truthy coercion: $invalid',
    async ({ invalid }) => {
      await seed(harness.tenantOneId, { qrManualInputEnabled: invalid });
      await expect(read()).rejects.toThrow(/qrManualInputEnabled must be a boolean or canonical Sheets boolean/);
    },
  );
});
