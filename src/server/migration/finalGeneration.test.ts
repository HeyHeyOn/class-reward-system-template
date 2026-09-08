import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest } from './importer';
import { makeSupportedSheets, makeRedis, makeSheets, finalizeSheetsSnapshot } from './__fixtures__/normalization';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import * as implementation from './finalGeneration';
vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000019';
let harness: PgliteDatabaseHarness;
const emptyRedis = () => makeRedis({ operationBindings: [], v2Claims: [] });
const original = () => ({ sheets: makeSupportedSheets(), redis: emptyRedis() });
async function applyRemainingMigrations() {
  const directory = resolve(process.cwd(), 'src/server/db/migrations');
  for (const name of (await readdir(directory)).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(directory, name), 'utf8'));
  }
}
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await applyRemainingMigrations();
});
afterEach(async () => { await harness?.close(); });
async function fixture(prior = original()) {
  const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, ...prior });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB, manifest, runTransaction: harness.runTenantTransaction });
  await harness.database.exec("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1,updated_at=now(); UPDATE migration_jobs SET status='READY',state_version=state_version+1,updated_at=now()");
  const { rows } = await harness.database.query<{ version: string }>('SELECT state_version::text AS version FROM migration_jobs');
  const source = await harness.database.query<{ source_id: string; snapshot_id: string }>('SELECT source_id,snapshot_id FROM migration_snapshots');
  return { tenantId: harness.tenantOneId, migrationJobId: JOB, expectedStateVersion: rows[0].version,
    originalSnapshotId: source.rows[0].snapshot_id, originalSourceId: source.rows[0].source_id,
    exclusionGenerationReference: 'a'.repeat(64), original: prior, candidate: original() };
}
async function stage(input: Awaited<ReturnType<typeof fixture>>, runTransaction = harness.runTenantTransaction) {
  return implementation.stageLegacyFinalGeneration(input, { runTransaction });
}
async function preserved() {
  const tables = ['tenants', 'migration_jobs', 'migration_sources', 'migration_snapshots', 'migration_source_records',
    'students', 'accounts', 'products', 'transactions', 'transaction_items', 'task_assignments', 'task_completions',
    'operations', 'padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'migration_authority_receipts', 'migration_authority_replays'];
  return Promise.all(tables.map(async (table) => (await harness.database.query(`SELECT * FROM ${table}`)).rows));
}
async function envelopes() {
  return (await harness.database.query<{ event_id: string; event_type: string; redacted_details: Record<string, unknown> }>(
    "SELECT event_id,event_type,redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%' ORDER BY event_id")).rows;
}

describe('untrusted immutable final candidate and delta PLAN through all production DDL', () => {
  it.each([['settings', 'candidate'], [' Settings ', 'candidate'], ['settings', 'original'], [' Settings ', 'original']] as const)('refuses rehashed credential alias %s in %s before a transaction', async (alias, side) => {
    const input = await fixture();
    const unsafe = makeSupportedSheets(3, (tabs) => {
      tabs[alias] = { headers: [' value ', ' key '], rows: [
        { rowNumber: 2, cells: ['local-dummy-not-a-real-secret', 'adminPassword'], hash: '' },
      ] };
    });
    const altered = { ...input, [side]: { ...input[side], sheets: unsafe } };
    if (side === 'original') {
      const manifest = createLegacyNormalizationManifest({ tenantId: input.tenantId, migrationJobId: JOB, ...altered.original });
      altered.originalSnapshotId = `import:${manifest.manifestDigest}`;
      altered.originalSourceId = `sheet:${unsafe.digest}`;
    }
    const run = vi.fn();
    await expect(stage(altered, (tenant, callback) => {
      run();
      return harness.runTenantTransaction(tenant, callback);
    })).rejects.toThrow('Final generation preparation refused.');
    expect(run).not.toHaveBeenCalled();
    expect(await envelopes()).toEqual([]);
  });
  it.each(['operator whitespace', 'equal timestamp row order'])('blocks retained source-only %s changes with unchanged canonical history', async (kind) => {
    const input = await fixture();
    input.candidate.sheets = makeSupportedSheets(3, (tabs) => {
      if (kind === 'operator whitespace') tabs.Transactions.rows[0].cells[9] = ' kiosk ';
      else {
        expect(tabs.Transactions.rows[0].cells[1]).toBe(tabs.Transactions.rows[1].cells[1]);
        tabs.Transactions.rows.reverse();
      }
    });
    const result = await stage(input);
    expect(result.plan.changes).toEqual([]);
    expect(result.plan.blockers).toContain('APPEND_ONLY_HISTORY_PROVENANCE_CHANGED');
    expect(result.plan.status).toBe('BLOCKED');
  });
  it('accepts actual canonical redacted acquisition without retaining dummy credentials', async () => {
    const sheet = makeSupportedSheets();
    const tabs = Object.fromEntries(Object.entries(sheet.tabs).map(([name, tab]) => [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
    tabs.Settings.push(['adminPassword', 'local-dummy-not-a-real-secret']);
    const acquired = await captureSheetsSnapshot({ spreadsheetId: sheet.spreadsheetId, capturedAt: sheet.capturedAt,
      reader: { listSheetNames: async () => Object.keys(tabs), getRows: async (name) => tabs[name], getRevision: async () => sheet.sourceRevision } });
    expect(acquired).toEqual(sheet);
    const input = await fixture({ sheets: acquired, redis: emptyRedis() });
    input.candidate = { sheets: acquired, redis: emptyRedis() };
    expect((await stage(input)).plan.status).toBe('DIFF_VALIDATED');
    expect(JSON.stringify(await envelopes())).not.toContain('local-dummy-not-a-real-secret');
  });
  it.each(['Adjustments', 'TaskAssignments', 'TaskCompletions'] as const)('preserves separate %s contributor hashes even when normalization trims cells', async (tab) => {
    const input = await fixture();
    input.candidate.sheets = makeSupportedSheets(3, (tabs) => {
      const index = tabs[tab].headers.indexOf(tab === 'Adjustments' ? 'operator' : 'note');
      tabs[tab].rows[0].cells[index] = ` ${tabs[tab].rows[0].cells[index]} `;
    });
    const result = await stage(input);
    expect(result.plan.changes).toEqual([]);
    expect(result.plan.blockers).toContain('APPEND_ONLY_HISTORY_PROVENANCE_CHANGED');
  });
  it('allows acquisition-wide digest changes when retained Redis contributors are identical', async () => {
    const redis = makeRedis({ operationBindings: [], v1Tombstones: [{ tupleDigest: 'b'.repeat(64), ownerDigest: 'c'.repeat(64), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }] });
    const input = await fixture({ sheets: makeSupportedSheets(), redis });
    input.candidate.redis = makeRedis({ operationBindings: [], v1Tombstones: redis.v1Tombstones, orphanedClaimDigests: ['d'.repeat(64)] });
    expect(input.candidate.redis.digest).not.toBe(redis.digest);
    expect((await stage(input)).plan.status).toBe('DIFF_VALIDATED');
  });
  it('blocks credential hash drift even when canonical target delta is empty', async () => {
    const input = await fixture();
    const sheet = structuredClone(input.candidate.sheets);
    const tabs = sheet.tabs as Record<string, { headers: string[]; rows: { rowNumber: number; cells: string[]; hash: string }[] }>;
    tabs.Settings.rows.find((r) => r.cells[0] === 'adminPasswordHash')!.cells[1] = 'b'.repeat(64);
    input.candidate.sheets = finalizeSheetsSnapshot({ ...sheet, credentialHashes: { ...sheet.credentialHashes, adminPasswordHash: 'b'.repeat(64) } });
    const result = await stage(input);
    expect(result.plan.changes).toEqual([]);
    expect(result.plan.blockers).toContain('CREDENTIAL_HASH_CHANGE_UNSUPPORTED');
  });
  it('blocks an additional quarantined BANK completion even with zero canonical target changes', async () => {
    const input = await fixture();
    input.candidate.sheets = makeSupportedSheets(3, (tabs) => {
      const bank = { ...makeSheets().tabs.TaskCompletions.rows[0], cells: [...makeSheets().tabs.TaskCompletions.rows[0].cells] };
      bank.cells[0] = 'BANK2'; bank.cells[17] = '';
      tabs.TaskCompletions.rows.push(bank as typeof tabs.TaskCompletions.rows[number]);
    });
    const result = await stage(input);
    expect(result.plan.changes).toEqual([]);
    expect(result.plan.blockers).toContain('NORMALIZATION_BLOCKED');
  });
  it('preserves v1 and orphan-v2 digests, rejects their removal and never publishes them', async () => {
    const redis = makeRedis({ operationBindings: [], v1Tombstones: [{ tupleDigest: 'b'.repeat(64), ownerDigest: 'c'.repeat(64), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }], orphanedClaimDigests: ['d'.repeat(64)] });
    const input = await fixture({ sheets: makeSupportedSheets(), redis });
    input.candidate.redis = redis;
    const unchanged = await stage(input); expect(unchanged.plan.status).toBe('DIFF_VALIDATED');
    input.candidate.redis = emptyRedis();
    const removed = await stage(input);
    expect(removed.plan.blockers).toContain('APPEND_ONLY_HISTORY_CHANGED');
    expect(removed.plan.changes.filter((r) => r.table === 'padlet_claim_digest_tombstones')).toHaveLength(2);
    expect((await harness.database.query('SELECT * FROM padlet_claim_digest_tombstones')).rows).toEqual([]);
  });
  it('refuses a conflicting content-addressed audit ID without overwriting the conflicting row', async () => {
    const input = await fixture();
    const result = await stage(input);
    const rows = await envelopes();
    // A second isolated harness reproduces a pre-existing INSERT-only conflict.
    const saved = harness;
    harness = await createPgliteDatabaseHarness();
    try {
      await applyRemainingMigrations();
      const freshInput = await fixture();
      expect(freshInput).toEqual(input);
      await harness.database.query(`INSERT INTO audit_events (tenant_id,event_id,job_id,event_type,redacted_details)
        VALUES ($1,$2,$3,'CONFLICT','{}')`, [input.tenantId, result.planId, JOB]);
      await expect(stage(freshInput)).rejects.toThrow('Final generation preparation refused.');
      expect(await envelopes()).toEqual([]);
      expect((await harness.database.query('SELECT event_type FROM audit_events')).rows).toEqual([{ event_type: 'CONFLICT' }]);
    } finally { await harness.close(); harness = saved; }
    expect(await envelopes()).toEqual(rows);
  });
  it('detaches snapshots before the first transaction await', async () => {
    const input = await fixture(); const candidate = input.candidate.sheets;
    const result = await stage(input, (tenant, callback) => {
      input.candidate.sheets = makeSheets();
      return harness.runTenantTransaction(tenant, callback);
    });
    expect(result.plan.status).toBe('DIFF_VALIDATED');
    expect((await envelopes()).find((r) => r.event_id === result.candidateGenerationId)?.redacted_details).toMatchObject({ acquisition: { sheets: candidate } });
  });
  it.each(['source', 'snapshot', 'version', 'status'])('refuses persisted %s drift and preserves prior generations', async (kind) => {
    const input = await fixture(); await stage(input); const prior = await envelopes();
    if (kind === 'source') await harness.database.exec("UPDATE migration_sources SET external_source_id='different' WHERE provider='GOOGLE_SHEETS'");
    if (kind === 'snapshot') await harness.withMigrationSnapshotTampering(() => harness.database.exec("UPDATE migration_snapshots SET row_count=row_count+1"));
    if (kind === 'version') input.expectedStateVersion = '01';
    if (kind === 'status') await harness.database.exec("UPDATE migration_jobs SET status='FREEZING',state_version=state_version+1,updated_at=now()");
    await expect(stage(input)).rejects.toThrow('Final generation preparation refused.'); expect(await envelopes()).toEqual(prior);
  });
  it('persists three linked immutable envelopes, retries exactly and never changes operational or authority state', async () => {
    const input = await fixture(); const before = await preserved();
    const result = await stage(input);
    expect(result).toMatchObject({ storage: 'UNTRUSTED_PREPARATION', plan: { status: 'DIFF_VALIDATED', changes: [], blockers: [] } });
    expect(await stage(input)).toEqual(result);
    expect(await envelopes()).toHaveLength(3);
    expect(await preserved()).toEqual(before);
    const rows = await envelopes();
    expect(rows.find((r) => r.event_id === result.originalGenerationId)?.redacted_details).toMatchObject({ phase: 'ORIGINAL_PREFLIGHT', acquisition: input.original });
    expect(rows.find((r) => r.event_id === result.candidateGenerationId)?.redacted_details).toMatchObject({ phase: 'FINAL_CANDIDATE', originalGenerationId: result.originalGenerationId, acquisition: input.candidate });
    await expect(harness.database.exec("UPDATE audit_events SET redacted_details=redacted_details WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rejects.toThrow('immutable');
    await expect(harness.database.exec("DELETE FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rejects.toThrow('immutable');
  });
  it('retains earlier generations when mutable definitions are added, removed and changed', async () => {
    const input = await fixture(); await stage(input); const before = await envelopes();
    input.candidate.sheets = makeSupportedSheets(3, (tabs) => {
      tabs.Products.rows[0].cells[1] = 'Changed'; tabs.Products.rows[0].cells[3] = '8';
      tabs.Products.rows.push({ ...tabs.Products.rows[0], cells: ['P2', 'New', '1', '2', 'TRUE', '', '', '2'] });
      tabs.PromotionProducts.rows = []; tabs.Promotions.rows = [];
    });
    const result = await stage(input);
    expect(result.plan.status).toBe('DIFF_VALIDATED');
    expect(result.plan.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'products', kind: 'MUTATED' }), expect.objectContaining({ table: 'products', kind: 'ADDED' }),
      expect.objectContaining({ table: 'promotions', kind: 'REMOVED' }), expect.objectContaining({ table: 'promotion_products', kind: 'REMOVED' }),
    ]));
    expect(await envelopes()).toHaveLength(5);
    expect(await envelopes()).toEqual(expect.arrayContaining(before));
  });
  it.each(['mutated', 'removed', 'added'] as const)('classifies %s append-only transaction history without applying it', async (kind) => {
    const input = await fixture(); const before = await preserved();
    input.candidate.sheets = makeSupportedSheets(3, (tabs) => {
      if (kind === 'mutated') tabs.Transactions.rows[0].cells[9] = 'different-operator';
      if (kind === 'removed') tabs.Transactions.rows.shift();
      if (kind === 'added') {
        const row = structuredClone(tabs.Transactions.rows[0]); row.cells[0] = 'TX2'; tabs.Transactions.rows.push(row);
      }
    });
    const result = await stage(input);
    expect(result.plan.status).toBe(kind === 'added' ? 'DIFF_VALIDATED' : 'BLOCKED');
    if (kind !== 'added') expect(result.plan.blockers).toContain('APPEND_ONLY_HISTORY_CHANGED');
    expect(await preserved()).toEqual(before);
  });
  it('retains BANK raw/canonical/evidence and blocks independently of target differences', async () => {
    const input = await fixture(); input.candidate = { sheets: makeSheets(), redis: makeRedis() };
    const result = await stage(input);
    expect(result.plan.status).toBe('BLOCKED'); expect(result.plan.blockers).toContain('NORMALIZATION_BLOCKED');
    const candidate = (await envelopes()).find((r) => r.event_id === result.candidateGenerationId)!;
    expect(candidate.redacted_details.acquisition).toEqual(input.candidate);
    expect(candidate.redacted_details.manifest).toMatchObject({ status: 'BLOCKED', quarantines: expect.arrayContaining([expect.objectContaining({ canonicalRecord: expect.objectContaining({ source: 'BANK' }) })]) });
  });
  it.each(['expectedStateVersion', 'originalSnapshotId', 'originalSourceId', 'tenantId', 'migrationJobId'] as const)('refuses incorrect %s binding before staging', async (key) => {
    const input = await fixture(); input[key] = key === 'expectedStateVersion' ? '999' : '30000000-0000-4000-8000-000000000099';
    await expect(stage(input)).rejects.toThrow('Final generation preparation refused.'); expect(await envelopes()).toEqual([]);
  });
  it('rejects a correlated rehashed original acquisition instead of replacing preflight', async () => {
    const input = await fixture(); input.original.sheets = makeSupportedSheets(3, (tabs) => { tabs.Students.rows[0].cells[2] = '999'; });
    const before = await preserved(); await expect(stage(input)).rejects.toThrow('Final generation preparation refused.');
    expect(await preserved()).toEqual(before); expect(await envelopes()).toEqual([]);
  });
  it('refuses same-shaped different workbook and missing complete Redis', async () => {
    const input = await fixture();
    input.candidate.sheets = finalizeSheetsSnapshot({ ...input.candidate.sheets, spreadsheetId: 'different' });
    await expect(stage(input)).rejects.toThrow('Final generation preparation refused.');
    const missing = { ...input, candidate: { sheets: input.original.sheets } };
    await expect(stage(missing as typeof input)).rejects.toThrow('Final generation preparation refused.');
    expect(await envelopes()).toEqual([]);
  });
  it('blocks real duplicate canonical identities instead of silently merging them', async () => {
    const input = await fixture(); input.candidate.sheets = makeSupportedSheets(3, (tabs) => { tabs.Students.rows.push(structuredClone(tabs.Students.rows[0])); });
    expect((await stage(input)).plan.blockers).toContain('NORMALIZATION_BLOCKED');
  });
  it('rejects forged receipt/phase/boolean additions without evaluating accessors', async () => {
    const input = await fixture(); const getter = vi.fn(() => true);
    Object.defineProperty(input, 'verified', { enumerable: true, get: getter });
    await expect(stage(input)).rejects.toThrow('Final generation preparation refused.'); expect(getter).not.toHaveBeenCalled();
    expect(await envelopes()).toEqual([]);
  });
  it.each(['MIGRATION_PREPARATION_ORIGINAL', 'MIGRATION_PREPARATION_CANDIDATE', 'MIGRATION_PREPARATION_PLAN'])('rolls back suppressed %s insertion with exact readback', async (type) => {
    const input = await fixture();
    await harness.database.exec(`CREATE FUNCTION suppress_generation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='${type}' THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_generation BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION suppress_generation();`);
    await expect(stage(input)).rejects.toThrow('Final generation preparation refused.'); expect(await envelopes()).toEqual([]);
  });
  it('rolls back after readback and recovers a lost commit response with an identical retry', async () => {
    const input = await fixture();
    await expect(stage(input, (tenant, callback) => harness.runTenantTransaction(tenant, async (tx) => { await callback(tx); throw new Error('rollback'); }))).rejects.toThrow();
    expect(await envelopes()).toEqual([]);
    await expect(stage(input, async (tenant, callback) => { await harness.runTenantTransaction(tenant, callback); throw new Error('lost response'); })).rejects.toThrow();
    const prior = await envelopes(); expect(prior).toHaveLength(3); await stage(input); expect(await envelopes()).toEqual(prior);
  });
  it('enforces existing forced RLS on preparation envelopes', async () => {
    const input = await fixture(); await stage(input);
    await harness.database.exec('SET ROLE app_runtime');
    await harness.database.query("SELECT set_config('app.tenant_id',$1,false)", [harness.tenantTwoId]);
    expect(await envelopes()).toEqual([]);
  });
});
