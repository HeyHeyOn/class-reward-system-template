import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyCutoverAbortService, type CutoverAbortIntent } from './cutover';

vi.mock('server-only', () => ({}));
const JOB = 'cutover-job';
const USER = '20000000-0000-4000-8000-000000000019';
const FINGERPRINT = 'a'.repeat(64);
const STATES = ['DISCOVERED', 'VALIDATED', 'IMPORTING', 'RECONCILING', 'READY', 'FREEZING', 'FINAL_IMPORT'] as const;
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
  await harness.database.query("INSERT INTO users (id,google_subject,canonical_email) VALUES ($1,'owner-subject','owner@example.invalid')", [USER]);
  await harness.database.query("INSERT INTO tenant_memberships (tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [harness.tenantOneId, USER]);
  await harness.database.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1", [harness.tenantOneId]);
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status,source_fingerprint) VALUES ($1,$2,'DISCOVERED',$3)", [harness.tenantOneId, JOB, FINGERPRINT]);
  await harness.database.query(`INSERT INTO migration_sources (tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
    VALUES ($1,$2,'sheet-source','GOOGLE_SHEETS','exact-source-sheet',$3)`, [harness.tenantOneId, JOB, FINGERPRINT]);
  await harness.database.query(`INSERT INTO migration_source_records
    (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,redacted_record,canonical_record,mapping_status,error_details)
    VALUES ($1,$2,'sheet-source','preserved','TaskCompletions','1',$3,'{}','{"source":"BANK"}','QUARANTINED','["UNSUPPORTED_OPERATIONAL_HISTORY"]')`, [harness.tenantOneId, JOB, FINGERPRINT]);
  await harness.database.query(`INSERT INTO migration_snapshots (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
    VALUES ($1,$2,'sheet-source','original','PREFLIGHT',$3,'{}',1)`, [harness.tenantOneId, JOB, FINGERPRINT]);
});
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); });

async function advance(status: typeof STATES[number]) {
  for (const next of STATES.slice(1, STATES.indexOf(status) + 1)) {
    await harness.database.query('UPDATE migration_jobs SET status=$1,state_version=state_version+1,updated_at=now() WHERE tenant_id=$2 AND job_id=$3', [next, harness.tenantOneId, JOB]);
  }
}
function intent(status: typeof STATES[number] = 'DISCOVERED'): CutoverAbortIntent {
  return { migrationJobId: JOB, expectedStatus: status,
    expectedStateVersion: String(STATES.indexOf(status) + 1), expectedSourceFingerprint: FINGERPRINT };
}
function service(subject: string | null = 'owner-subject', tenantId = harness.tenantOneId) {
  return createLegacyCutoverAbortService({ tenantId, getAuthenticatedSubject: async () => subject,
    runTransaction: harness.runTenantTransaction });
}
async function state() {
  return (await harness.database.query<{ status: string; completed_at: Date | null; source_fingerprint: string | null }>('SELECT * FROM migration_jobs ORDER BY tenant_id,job_id')).rows;
}
async function preserved() {
  const result: Record<string, unknown> = {};
  for (const table of ['tenants', 'migration_sources', 'migration_source_records', 'migration_snapshots',
    'operations', 'padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'padlet_claim_digest_registry']) {
    result[table] = (await harness.database.query(`SELECT * FROM ${table}`)).rows;
  }
  return result;
}
async function audits() { return (await harness.database.query('SELECT * FROM audit_events')).rows; }

// This is a real abort-only checkpoint, NOT proof of implemented forward cutover.
describe('cutover abort boundary with every production migration', () => {
  it.each(STATES)('aborts %s without publishing claims, deleting grants, or releasing a freeze', async (status) => {
    await advance(status);
    const before = await preserved();
    const result = await service()(intent(status));
    expect(result).toMatchObject({ status: 'ABORTED', stateVersion: String(STATES.indexOf(status) + 2), externalCleanup: 'NOT_PERFORMED' });
    expect((await state())[0]).toMatchObject({ status: 'ABORTED', state_version: STATES.indexOf(status) + 2,
      source_fingerprint: FINGERPRINT, final_fingerprint: null, freeze_verified_at: null });
    expect((await state())[0].completed_at).not.toBeNull();
    expect(await preserved()).toEqual(before);
    expect(await audits()).toEqual([expect.objectContaining({ event_id: result.auditEventId,
      actor_user_id: USER, event_type: 'MIGRATION_CUTOVER_ABORTED', job_id: JOB,
      redacted_details: { previousStatus: status, previousStateVersion: intent(status).expectedStateVersion,
        sourceFingerprint: FINGERPRINT, externalCleanup: 'NOT_PERFORMED' } })]);
  });

  it('permits an unbound DISCOVERED job to abort without fabricating a fingerprint', async () => {
    await harness.database.query('UPDATE migration_jobs SET source_fingerprint=NULL');
    await expect(service()({ ...intent(), expectedSourceFingerprint: null })).resolves.toMatchObject({ status: 'ABORTED' });
    expect((await state())[0].source_fingerprint).toBeNull();
  });

  it.each(['OWNER', 'ADMIN'])('rechecks an authenticated %s membership in the transaction', async (role) => {
    await harness.database.query('UPDATE tenant_memberships SET role=$1', [role]);
    await expect(service()(intent())).resolves.toMatchObject({ status: 'ABORTED' });
  });

  it.each([null, 'nonmember', ' owner-subject '])('rejects absent or nonmatching authenticated subject %s', async (subject) => {
    const before = await state();
    await expect(service(subject)(intent())).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it('does not reuse membership authority removed after service construction', async () => {
    const abort = service();
    await harness.database.query('DELETE FROM tenant_memberships');
    await expect(abort(intent())).rejects.toThrow('Cutover abort refused.');
    expect((await state())[0].status).toBe('DISCOVERED');
  });

  it('does not use another tenant membership or select a job outside RLS', async () => {
    const before = await state();
    await expect(service('owner-subject', harness.tenantTwoId)(intent())).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it.each([
    { expectedStatus: 'READY' }, { expectedStateVersion: '2' }, { expectedSourceFingerprint: 'b'.repeat(64) },
    { migrationJobId: 'missing' }, { expectedSourceFingerprint: null },
  ])('refuses a stale exact intent %j', async (patch) => {
    const before = await state();
    await expect(service()({ ...intent(), ...patch } as CutoverAbortIntent)).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it.each(['ACTIVE', 'FAILED', 'ABORTED'])('cannot leave terminal job %s', async (status) => {
    await advance('FINAL_IMPORT');
    await harness.database.query(`UPDATE migration_jobs SET status=$1,state_version=state_version+1,updated_at=now(),completed_at=now(),
      freeze_started_at=now(),freeze_verified_at=now(),final_fingerprint=$2`, [status, FINGERPRINT]);
    const before = await state();
    await expect(service()({ ...intent('FINAL_IMPORT'), expectedStatus: status, expectedStateVersion: '8' } as CutoverAbortIntent)).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it.each(['ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED'])('refuses potentially authoritative tenant lifecycle %s', async (lifecycle) => {
    await harness.database.query('UPDATE tenants SET lifecycle=$1 WHERE id=$2', [lifecycle, harness.tenantOneId]);
    const before = await state();
    await expect(service()(intent())).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
  });

  it.each(['0', '01', '-1', '1.0', '9007199254740992'])('rejects invalid exact version %s before a transaction', async (expectedStateVersion) => {
    const runTransaction = vi.fn(() => {});
    const abort = createLegacyCutoverAbortService({ tenantId: harness.tenantOneId,
      getAuthenticatedSubject: async () => 'owner-subject', runTransaction: (tenantId, callback) => { runTransaction(); return harness.runTenantTransaction(tenantId, callback); } });
    await expect(abort({ ...intent(), expectedStateVersion })).rejects.toThrow('Cutover abort refused.');
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('never rounds the maximum state version and rolls back overflow', async () => {
    await harness.database.query('DELETE FROM migration_source_records');
    await harness.withMigrationSnapshotTampering(() => harness.database.query('DELETE FROM migration_snapshots'));
    await harness.database.query('DELETE FROM migration_sources');
    await harness.database.query('DELETE FROM migration_jobs');
    await harness.database.query(`INSERT INTO migration_jobs (tenant_id,job_id,status,state_version,source_fingerprint)
      VALUES ($1,$2,'READY',9007199254740991,$3)`, [harness.tenantOneId, JOB, FINGERPRINT]);
    const before = await state();
    await expect(service()({ ...intent('READY'), expectedStateVersion: '9007199254740991' })).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it.each(['audit_events', 'migration_jobs'])('rolls back when %s silently suppresses its write', async (table) => {
    await harness.database.exec(`CREATE FUNCTION suppress_cutover_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER suppress_cutover_write BEFORE ${table === 'audit_events' ? 'INSERT' : 'UPDATE'} ON ${table}
      FOR EACH ROW EXECUTE FUNCTION suppress_cutover_write();`);
    const before = await state();
    const evidence = await preserved();
    await expect(service()(intent())).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
    expect(await preserved()).toEqual(evidence);
  });

  it('rolls back both writes when the transaction fails after the callback', async () => {
    const before = await state();
    const abort = createLegacyCutoverAbortService({ tenantId: harness.tenantOneId,
      getAuthenticatedSubject: async () => 'owner-subject',
      runTransaction: (tenantId, callback) => harness.runTenantTransaction(tenantId, async (transaction) => {
        await callback(transaction);
        throw new Error('simulated commit-boundary failure');
      }) });
    await expect(abort(intent())).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual([]);
  });

  it('preserves existing freeze metadata without treating timestamps as freeze authority', async () => {
    await advance('FINAL_IMPORT');
    // Database shape only: these timestamps are deliberately NOT freeze proofs.
    await harness.database.query('UPDATE migration_jobs SET freeze_started_at=now(),freeze_verified_at=now(),final_fingerprint=$1,updated_at=now()', [FINGERPRINT]);
    const read = async () => (await harness.database.query('SELECT freeze_started_at,freeze_verified_at,final_fingerprint FROM migration_jobs')).rows;
    const before = await read();
    await service()(intent('FINAL_IMPORT'));
    expect(await read()).toEqual(before);
    expect((await state())[0].status).toBe('ABORTED');
  });

  it('refuses repeated intent without rewriting terminal state or duplicating audit evidence', async () => {
    const abort = service();
    await abort(intent());
    const before = await state();
    const evidence = await audits();
    await expect(abort(intent())).rejects.toThrow('Cutover abort refused.');
    expect(await state()).toEqual(before);
    expect(await audits()).toEqual(evidence);
  });

  it('redacts upstream errors and never persists claimed freeze approval from extra input', async () => {
    const runTransaction = vi.fn(() => {});
    const abort = createLegacyCutoverAbortService({ tenantId: harness.tenantOneId,
      getAuthenticatedSubject: async () => { throw new Error('Bearer credential-secret'); }, runTransaction: (tenantId, callback) => { runTransaction(); return harness.runTenantTransaction(tenantId, callback); } });
    await expect(abort(intent())).rejects.toThrow(/^Cutover abort refused\.$/);
    expect(runTransaction).not.toHaveBeenCalled();
    await expect(service()({ ...intent(), freezeVerified: true, activate: true } as CutoverAbortIntent)).rejects.toThrow('Cutover abort refused.');
    expect(await audits()).toEqual([]);
  });
});
