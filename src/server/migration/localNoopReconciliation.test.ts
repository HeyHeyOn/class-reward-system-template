import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest } from './importer';
import { makeSupportedSheets, makeRedis } from './__fixtures__/normalization';
import { reconcileLocalNoopFinalDelta } from './localNoopReconciliation';
vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
let harness: PgliteDatabaseHarness;
const acquisition = () => ({ sheets: makeSupportedSheets(), redis: makeRedis({ operationBindings: [], v2Claims: [] }) });
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
});
afterEach(async () => { await harness?.close(); });
async function fixture() {
  const original = acquisition();
  const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, ...original });
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, manifest, runTransaction: harness.runTenantTransaction });
  await harness.database.exec("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now(); UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now()");
  const { rows } = await harness.database.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs');
  const source = await harness.database.query<{ source_id: string; snapshot_id: string }>('SELECT source_id,snapshot_id FROM migration_snapshots');
  return { tenantId: harness.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSnapshotId: source.rows[0].snapshot_id, originalSourceId: source.rows[0].source_id,
    // Legacy preparation requires this local fixture identifier; it is NOT proof
    // of any actual writer exclusion or externally issued generation.
    exclusionGenerationReference: 'a'.repeat(64), original, candidate: acquisition() };
}
async function audit() {
  return (await harness.database.query<{ event_type: string }>("SELECT event_type FROM audit_events WHERE event_type LIKE 'MIGRATION_%' ORDER BY event_type")).rows;
}

describe('local no-op final reconciliation in a real tenant transaction', () => {
  it('persists original, candidate, plan and no-op report atomically without promoting authority', async () => {
    const input = await fixture();
    const result = await reconcileLocalNoopFinalDelta(input, { runTransaction: harness.runTenantTransaction });
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', finding: 'IDENTICAL_CAPTURE' });
    expect((await audit()).map((row) => row.event_type)).toEqual([
      'MIGRATION_LOCAL_NOOP_RECONCILED', 'MIGRATION_PREPARATION_CANDIDATE',
      'MIGRATION_PREPARATION_ORIGINAL', 'MIGRATION_PREPARATION_PLAN',
    ]);
    expect((await harness.database.query('SELECT status,final_fingerprint FROM migration_jobs')).rows).toMatchObject([{ status: 'READY', final_fingerprint: null }]);
  });
  it('replays identical local reports without adding audit rows or advancing state', async () => {
    const input = await fixture();
    const first = await reconcileLocalNoopFinalDelta(input, { runTransaction: harness.runTenantTransaction });
    const second = await reconcileLocalNoopFinalDelta(input, { runTransaction: harness.runTenantTransaction });
    expect(second).toEqual(first);
    expect(await audit()).toHaveLength(4);
    expect((await harness.database.query('SELECT status,state_version::text AS state_version FROM migration_jobs')).rows)
      .toMatchObject([{ status: 'READY', state_version: input.expectedStateVersion }]);
  });
  it('rolls back all four writes for a changed capture, even if normalization can describe a delta', async () => {
    const input = await fixture();
    input.candidate.sheets = makeSupportedSheets(3, (tabs) => { tabs.Products.rows[0].cells[2] = '200'; });
    await expect(reconcileLocalNoopFinalDelta(input, { runTransaction: harness.runTenantTransaction })).rejects.toThrow('Local no-op reconciliation refused.');
    expect(await audit()).toEqual([]);
  });
  it('refuses stale job binding and retains neither envelope nor report', async () => {
    const input = await fixture();
    input.expectedStateVersion = '1';
    await expect(reconcileLocalNoopFinalDelta(input, { runTransaction: harness.runTenantTransaction })).rejects.toThrow('Local no-op reconciliation refused.');
    expect(await audit()).toEqual([]);
  });
});
