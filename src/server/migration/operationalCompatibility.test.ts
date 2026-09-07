import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseTaskCompletionCommand } from '@/server/repositories/database/taskCompletionCommands';
import { createDatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { materializeTaskConfigurationBoundaryCyclesInternal, materializeTaskNaturalCycleInternal } from '@/server/repositories/database/taskCycleMaterialization';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest } from './importer';
import { makeRedis, makeSheets, makeSupportedSheets } from './__fixtures__/normalization';
import { canonicalJson, deterministicId, sha256 } from './validators';
import type { LegacyNormalizationManifest } from './manifest';

// Deliberately reconstruct a correlated pre-quarantine manifest, including every
// child/mapping, so importer defense tests cannot pass at the BLOCKED gate.
function bypassQuarantine(manifest: LegacyNormalizationManifest): LegacyNormalizationManifest {
  const draft = structuredClone(manifest);
  const records = draft.records as Record<string, Record<string, unknown>[]>;
  const sources = draft.sourceRecords.map((source) => {
    if (source.mappingStatus !== 'QUARANTINED') return source;
    const value = source.canonicalRecord!;
    const table = value.completionId ? 'task_completions' : value.binding
      ? 'legacy_operation_bindings' : 'padlet_evidence_claims';
    const id = table === 'task_completions' ? String(value.completionId)
      : deterministicId(draft.tenantId, draft.migrationJobId, table,
        String(table === 'legacy_operation_bindings' ? value.operationId : value.tupleDigest));
    const record = table === 'task_completions' ? { tenantId: draft.tenantId, ...value } : { ...value };
    if (!(records[table] ?? []).some((row) => canonicalJson(row) === canonicalJson(record))) {
      (records[table] ??= []).push(structuredClone(record));
    }
    (draft.mappings as Array<LegacyNormalizationManifest['mappings'][number]>).push({
      sourceDigest: source.source.kind === 'SHEET' ? source.source.rowHash : source.source.sourceDigest,
      targetTable: table, targetId: id, status: 'STAGED',
    });
    return { ...source, canonicalRecord: structuredClone(value), mappingStatus: 'STAGED' as const,
      targetTable: table, targetId: id, errorCodes: [] };
  });
  const { manifestDigest: _digest, ...unsigned } = { ...draft, sourceRecords: sources,
    status: 'READY_FOR_IMPORT' as const, quarantines: [], blockingConflicts: [] };
  void _digest;
  return { ...unsigned, manifestDigest: sha256(canonicalJson(unsigned)) };
}

vi.mock('server-only', () => ({}));

const JOB_ID = '20000000-0000-4000-8000-000000000099';
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const migration of ['0009_promotion_tombstone_invariant.sql', '0010_task_admin_invariants.sql',
    '0011_generator_grant_claims.sql', '0012_platform_tenant_discovery.sql']) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', migration), 'utf8'));
  }
});
afterEach(async () => { await harness?.close(); });

function sourceManifest(operationId = 'op-1') {
  const redis = makeRedis();
  return createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
    sheets: makeSheets(3, (tabs) => {
      tabs.TaskCompletions.rows[0].cells[tabs.TaskCompletions.headers.indexOf('operationId')] = operationId;
      for (const tab of [tabs.TaskAssignments, tabs.TaskCompletions]) {
        tab.rows[0].cells[tab.headers.indexOf('cycleId')] = 'v1|TI1|r1|2026-08-31T00:00:00Z';
      }
    }), redis: makeRedis({ ...redis, operationBindings: redis.operationBindings.map((row) => ({ ...row, operationId })) }) });
}
function retainedManifest(mutate?: Parameters<typeof makeSheets>[1]) {
  const sheets = makeSupportedSheets(3, mutate);
  return createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID, sheets });
}
async function importSource(manifest = retainedManifest()) {
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')",
    [harness.tenantOneId, JOB_ID]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
    manifest, runTransaction: harness.runTenantTransaction });
  return manifest;
}

// Acceptance regressions, intentionally RED until an operational representation
// is selected. These call real consumers, not SQL-shaped mocks or repair UPDATEs.
describe('legacy operational event compatibility acceptance', () => {
  it('blocks unsupported legacy BANK authority before READY while retaining canonical evidence', () => {
    const manifest = sourceManifest();
    const completion = manifest.sourceRecords.find((row) => row.canonicalRecord?.completionId === 'C1');
    expect(completion?.canonicalRecord).toMatchObject({ schemaVersion: 2, status: 'SUCCESS', operationId: 'op-1' });
    expect(manifest.status).toBe('BLOCKED');
  });

  it('does not mistake a UUID-shaped legacy evidence binding for modern BANK command authority', () => {
    const operationId = '20000000-0000-4000-8000-000000000077';
    const manifest = sourceManifest(operationId);
    expect(manifest.sourceRecords.find((row) => row.canonicalRecord?.completionId === 'C1')?.canonicalRecord)
      .toMatchObject({ operationId, schemaVersion: 2, status: 'SUCCESS' });
    expect(manifest.status).toBe('BLOCKED');
  });

  it('quarantines all BANK claim contributors but preserves unrelated history', () => {
    const manifest = sourceManifest();
    const affected = manifest.sourceRecords.filter((row) => row.canonicalRecord?.operationId === 'op-1');
    expect(affected).toHaveLength(4);
    for (const row of affected) {
      expect(row.mappingStatus).toBe('QUARANTINED');
      expect(row.canonicalRecord).not.toBeNull();
      expect(row.errorCodes).toContain('UNSUPPORTED_LEGACY_BANK_AUTHORITY');
    }
    for (const table of ['task_completions', 'padlet_evidence_claims', 'legacy_operation_bindings']) {
      expect(manifest.records[table]).toEqual([]);
      expect(manifest.mappings.filter((row) => row.targetTable === table)).toEqual([]);
    }
    expect(manifest.records.transactions).toHaveLength(2);
    expect(manifest.records.students).toHaveLength(1);
    expect(manifest.records.task_assignments).toHaveLength(1);
  });

  it.each(['op-1', '20000000-0000-4000-8000-000000000077'])(
    'rejects a correlated rehashed READY BANK bypass before any transaction: %s', async (operationId) => {
      const manifest = bypassQuarantine(sourceManifest(operationId));
      expect(manifest.status).toBe('READY_FOR_IMPORT');
      expect(manifest.records.task_completions).toHaveLength(1);
      expect(manifest.records.legacy_operation_bindings).toHaveLength(1);
      expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
      const runTransaction = vi.fn(async () => { throw new Error('TRANSACTION_SENTINEL'); });
      await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId,
        migrationJobId: JOB_ID, manifest, runTransaction })).rejects.toThrow(/unsupported legacy BANK authority/i);
      expect(runTransaction).not.toHaveBeenCalled();
    });

  it('never publishes an accepted import that the actual history reader rejects', async () => {
    const manifest = await importSource();
    const queries = createDatabaseTaskCycleQueries({ tenantId: harness.tenantOneId,
      runTenantSnapshot: harness.runTenantTransaction });
    const snapshot = await queries.loadTaskCycleLedgerSnapshot();
    expect(snapshot.completions).toEqual(expect.arrayContaining([
      expect.objectContaining({ completionId: 'C1', status: 'SUCCESS', reward: 0 }),
    ]));
    expect(manifest.sourceRecords.find((row) => row.canonicalRecord?.completionId === 'C1')?.canonicalRecord)
      .toMatchObject({ schemaVersion: 2, status: 'SUCCESS', operationId: null });
  });

  it.each(['original completion note', '', '  \t  ', '  padded note  '])('materializes supported retained note %j at the actual configuration boundary', async (note) => {
    const manifest = await importSource(retainedManifest((tabs) => {
      tabs.TaskCompletions.rows[0].cells[tabs.TaskCompletions.headers.indexOf('note')] = note;
    }));
    expect(manifest.sourceRecords.find((row) => row.canonicalRecord?.completionId === 'C1')?.canonicalRecord?.note).toBe(note.trim());
    const result = await harness.runTenantTransaction(harness.tenantOneId, (tx) =>
      materializeTaskConfigurationBoundaryCyclesInternal({ tx, tenantId: harness.tenantOneId, targets: [{
        taskId: 'T1', taskInstanceId: 'TI1', oldRuleVersion: 2, newRuleVersion: 3,
        oldCycle: { cycleId: 'v1|TI1|r2|2026-08-31T00:00:00Z', startsAt: '2026-08-31T00:00:00Z',
          endsAt: '2026-09-01T00:00:00Z', nextResetAt: '2026-09-01T00:00:00Z' },
        newCycle: { cycleId: 'v1|TI1|r3|2026-08-31T12:00:00Z', startsAt: '2026-08-31T12:00:00Z',
          endsAt: '2026-09-01T12:00:00Z', nextResetAt: '2026-09-01T12:00:00Z' },
        timeZone: 'Asia/Seoul', now: new Date('2026-08-31T12:00:00Z'),
      }] }));
    expect(result[0].assignmentEventIds).toHaveLength(1);
    expect(result[0].completionEventIds).toHaveLength(1);
    const staged = await harness.database.query<{ canonical_record: Record<string, unknown> }>(
      'SELECT canonical_record FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2 AND target_table IN (\'task_assignments\',\'task_completions\')',
      [harness.tenantOneId, JOB_ID]);
    for (const source of manifest.sourceRecords.filter((row) => row.canonicalRecord?.assignmentId === 'AS1'
      || row.canonicalRecord?.completionId === 'C1')) {
      expect(staged.rows.map((row) => {
        const { migrationCheckpoint, ...original } = row.canonical_record;
        expect(migrationCheckpoint).toBeDefined();
        return original;
      })).toContainEqual(source.canonicalRecord);
    }
    expect((await harness.database.query('SELECT schema_version,status,note,created_at FROM task_completions WHERE completion_id=$1', ['C1'])).rows)
      .toEqual([{ schema_version: 1, status: 'COMPLETED', note: note.trim() || null, created_at: new Date('2026-08-31T00:00:00Z') }]);
    expect((await harness.database.query('SELECT schema_version,note FROM task_assignments WHERE assignment_id=$1', ['AS1'])).rows)
      .toEqual([{ schema_version: 1, note: null }]);
  });

  it('resumes supported history after interruption, then reruns exactly without activating or leaking tenants', async () => {
    const manifest = retainedManifest();
    await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')",
      [harness.tenantOneId, JOB_ID]);
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      manifest, batchSize: 1, runTransaction: harness.runTenantTransaction };
    let interrupted = false;
    await expect(importLegacyNormalizationManifest({ ...input, runTransaction: async (tenantId, callback) => {
      const accounts = await harness.database.query('SELECT student_id FROM accounts WHERE tenant_id=$1', [tenantId]);
      if (accounts.rows.length && !interrupted) { interrupted = true; throw new Error('SUPPORTED_INTERRUPTION'); }
      return harness.runTenantTransaction(tenantId, callback);
    } })).rejects.toThrow('SUPPORTED_INTERRUPTION');
    const result = await importLegacyNormalizationManifest(input);
    const history = (await harness.database.query('SELECT * FROM task_completions ORDER BY event_sequence')).rows;
    const checkpoints = (await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows;
    expect(await importLegacyNormalizationManifest(input)).toEqual(result);
    expect((await harness.database.query('SELECT * FROM task_completions ORDER BY event_sequence')).rows).toEqual(history);
    expect((await harness.database.query('SELECT * FROM migration_source_records ORDER BY record_id')).rows).toEqual(checkpoints);
    expect(history).toHaveLength(1);
    expect((await harness.database.query('SELECT lifecycle AS status FROM tenants WHERE id=$1', [harness.tenantOneId])).rows)
      .toEqual([{ status: 'IMPORTING' }]);
    expect((await harness.database.query('SELECT * FROM task_completions WHERE tenant_id=$1', [harness.tenantTwoId])).rows).toEqual([]);
    const changed = retainedManifest((tabs) => { tabs.Students.rows[0].cells[1] = 'Changed'; });
    await expect(importLegacyNormalizationManifest({ ...input, manifest: changed })).rejects.toThrow(/source|manifest/i);
    expect((await harness.database.query('SELECT * FROM task_completions ORDER BY event_sequence')).rows).toEqual(history);
  });

  it('rolls back the supported target batch on a conflicting preexisting product', async () => {
    const manifest = retainedManifest();
    await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')",
      [harness.tenantOneId, JOB_ID]);
    await harness.database.query("INSERT INTO products (tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES ($1,'P1','Conflict',99,1,true,1)",
      [harness.tenantOneId]);
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      manifest, batchSize: 500, runTransaction: harness.runTenantTransaction })).rejects.toThrow(/conflict|different|diverg/i);
    expect((await harness.database.query('SELECT * FROM students WHERE tenant_id=$1', [harness.tenantOneId])).rows).toEqual([]);
    expect((await harness.database.query('SELECT * FROM task_completions')).rows).toEqual([]);
    expect((await harness.database.query('SELECT name FROM products')).rows).toEqual([{ name: 'Conflict' }]);
  });

  it('stages independent legacy Redis evidence without minting a modern operation', async () => {
    const manifest = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      sheets: makeSheets(3, (tabs) => { tabs.TaskAssignments.rows = []; tabs.TaskCompletions.rows = []; }),
      redis: makeRedis() });
    await importSource(manifest);
    expect((await harness.database.query('SELECT * FROM operations')).rows).toEqual([]);
    const staged = (await harness.database.query<{ canonical_record: Record<string, unknown> }>(
      'SELECT canonical_record FROM migration_source_records WHERE tenant_id=$1 AND job_id=$2',
      [harness.tenantOneId, JOB_ID])).rows;
    expect(staged).toContainEqual({ canonical_record: expect.objectContaining({
      operationId: 'op-1', binding: makeRedis().operationBindings[0].binding,
      migrationCheckpoint: expect.objectContaining({ intendedTargetTable: 'legacy_operation_bindings', publication: 'DEFERRED' }),
    }) });
    await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB_ID,
      manifest, runTransaction: harness.runTenantTransaction });
    expect((await harness.database.query('SELECT * FROM operations')).rows).toEqual([]);
  });

  it('keeps real modern BANK writer, exact retry and configuration-boundary validation operational', async () => {
    await importSource(retainedManifest((tabs) => {
      tabs.TaskCompletions.rows = [];
      for (const [key, value] of Object.entries({ ruleVersion: '2', recurrenceType: 'DAILY', recurrenceTime: '09:00' })) {
        tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf(key)] = value;
      }
    }));
    const command = createDatabaseTaskCompletionCommand({ tenantId: harness.tenantOneId,
      runTenantTransaction: harness.runTenantTransaction, padletClaims: createDatabasePadletClaimRepository(),
      resolvePadletEvidence: async () => { throw new Error('No Padlet configured'); },
      now: () => new Date('2026-08-31T03:00:00Z') });
    const input = { operationId: '20000000-0000-4000-8000-000000000077', taskId: 'T1', studentId: 'S1' };
    const result = await command.execute(input);
    expect(result).toMatchObject({ ok: true, reward: 10, balanceBefore: 100, balanceAfter: 110 });
    expect(await command.execute(input)).toEqual(result);
    const snapshot = await createDatabaseTaskCycleQueries({ tenantId: harness.tenantOneId,
      runTenantSnapshot: harness.runTenantTransaction }).loadTaskCycleLedgerSnapshot();
    expect(snapshot.completions).toEqual([expect.objectContaining({ source: 'BANK', status: 'SUCCESS', reward: 10 })]);
    const boundary = new Date(Date.now() + 60_000);
    const boundaryStart = boundary.toISOString().replace('.000Z', 'Z');
    const boundaryEnd = new Date(boundary.getTime() + 86_400_000).toISOString().replace('.000Z', 'Z');
    const materialized = await harness.runTenantTransaction(harness.tenantOneId, (tx) =>
      materializeTaskConfigurationBoundaryCyclesInternal({ tx, tenantId: harness.tenantOneId, targets: [{
        taskId: 'T1', taskInstanceId: 'TI1', oldRuleVersion: 2, newRuleVersion: 3,
        oldCycle: { cycleId: 'v1|TI1|r2|2026-08-31T00:00:00Z', startsAt: '2026-08-31T00:00:00Z',
          endsAt: '2026-09-01T00:00:00Z', nextResetAt: '2026-09-01T00:00:00Z' },
        newCycle: { cycleId: `v1|TI1|r3|${boundaryStart}`, startsAt: boundaryStart,
          endsAt: boundaryEnd, nextResetAt: boundaryEnd },
        timeZone: 'Asia/Seoul', now: boundary,
      }] }));
    expect(materialized[0].completionEventIds).toHaveLength(1);
    expect((await harness.database.query('SELECT operation_kind FROM operations')).rows).toEqual([{ operation_kind: 'TASK_REWARD' }]);
  });

  it.each([
    ['TaskAssignments', 'cycleId', 'CYCLE1'],
    ['TaskAssignments', 'createdAt', '2026-09-01T00:00:00.000Z'],
    ['TaskAssignments', 'status', 'UNASSIGNED'],
    ['TaskAssignments', 'source', 'LEGACY_SEED'],
    ['TaskCompletions', 'timestamp', '2026-09-01T00:00:00.000Z'],
    ['TaskCompletions', 'timestamp', '2026-08-30T23:59:59.000Z'],
    ['TaskCompletions', 'status', 'RESET'],
    ['TaskCompletions', 'assignmentId', ''],
  ])('blocks unsupported nonfinancial operational field %s.%s=%s', (tab, key, value) => {
    const manifest = retainedManifest((tabs) => {
      const row = tabs[tab].rows[tab === 'TaskAssignments' ? 1 : 0];
      row.cells[tabs[tab].headers.indexOf(key)] = value;
    });
    expect(manifest.status).toBe('BLOCKED');
  });

  it('rejects correlated nonfinancial chronology bypass before a transaction', async () => {
    const draft = structuredClone(retainedManifest());
    for (const row of draft.records.task_completions) (row as Record<string, unknown>).timestamp = '2026-09-01T00:00:00.000Z';
    for (const source of draft.sourceRecords) {
      if (source.canonicalRecord?.completionId === 'C1') {
        (source.canonicalRecord as Record<string, unknown>).timestamp = '2026-09-01T00:00:00.000Z';
      }
    }
    const { manifestDigest: _digest, ...unsigned } = draft;
    void _digest;
    const manifest = { ...unsigned, manifestDigest: sha256(canonicalJson(unsigned)) };
    const runTransaction = vi.fn(async () => { throw new Error('TRANSACTION_SENTINEL'); });
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID, manifest, runTransaction })).rejects.toThrow(/unsupported legacy operational history/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });


  it.each(['   ', ' padded note '])('rejects correlated unnormalized completion note %j before a transaction', async (note) => {
    const draft = structuredClone(retainedManifest());
    for (const row of draft.records.task_completions) (row as Record<string, unknown>).note = note;
    for (const source of draft.sourceRecords) {
      if (source.canonicalRecord?.completionId === 'C1') (source.canonicalRecord as Record<string, unknown>).note = note;
    }
    const { manifestDigest: _digest, ...unsigned } = draft;
    void _digest;
    const manifest = { ...unsigned, manifestDigest: sha256(canonicalJson(unsigned)) };
    const runTransaction = vi.fn(async () => { throw new Error('TRANSACTION_SENTINEL'); });
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID, manifest, runTransaction })).rejects.toThrow(/unsupported legacy operational history/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  function seedManifest(openEnded: boolean) {
    return retainedManifest((tabs) => {
      tabs.TaskAssignments.rows = [tabs.TaskAssignments.rows[0]];
      tabs.TaskCompletions.rows = [];
      if (openEnded) tabs.TaskAssignments.rows[0].cells[tabs.TaskAssignments.headers.indexOf('cycleEndsAt')] = '';
      tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf('recurrenceType')] = 'DAILY';
      tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf('recurrenceTime')] = '09:00';
    });
  }

  it('quarantines an older open-ended seed rather than admitting history the natural consumer rejects', async () => {
    const manifest = seedManifest(true);
    // RED must exercise the real consumer if the normalizer admits this source.
    if (manifest.status === 'READY_FOR_IMPORT') {
      await importSource(manifest);
      await harness.runTenantTransaction(harness.tenantOneId, (tx) =>
        materializeTaskNaturalCycleInternal({ tx, tenantId: harness.tenantOneId,
          taskId: 'T1', taskInstanceId: 'TI1', taskTitle: 'Homework',
          schedule: { ruleVersion: 1, effectiveFrom: '2026-08-30T00:00:00.000Z',
            recurrence: { type: 'DAILY' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false },
          cycle: { cycleId: 'v1|TI1|r1|2026-09-01T00:00:00Z', startsAt: '2026-09-01T00:00:00Z',
            endsAt: '2026-09-02T00:00:00Z', nextResetAt: '2026-09-02T00:00:00Z' },
          isAvailable: true, now: new Date('2026-09-01T00:00:00Z') }));
    }
    expect(manifest.status).toBe('BLOCKED');
    const source = manifest.sourceRecords.find((row) => row.canonicalRecord?.assignmentId === 'AS0');
    expect(source).toMatchObject({ mappingStatus: 'QUARANTINED',
      canonicalRecord: { source: 'LEGACY_SEED', cycleEndsAt: null },
      errorCodes: expect.arrayContaining(['UNSUPPORTED_LEGACY_OPERATIONAL_HISTORY']) });
    expect(manifest.records.task_assignments).toEqual([]);
    expect(manifest.mappings.filter((row) => row.targetTable === 'task_assignments')).toEqual([]);
    expect(manifest.records.transactions).toHaveLength(2);
  });

  it('rejects a correlated open-ended seed bypass before any transaction', async () => {
    const draft = structuredClone(seedManifest(false));
    expect(draft.status).toBe('READY_FOR_IMPORT');
    for (const row of draft.records.task_assignments) (row as Record<string, unknown>).cycleEndsAt = null;
    for (const source of draft.sourceRecords) {
      if (source.canonicalRecord?.assignmentId === 'AS0') (source.canonicalRecord as Record<string, unknown>).cycleEndsAt = null;
    }
    const { manifestDigest: _digest, ...unsigned } = draft;
    void _digest;
    const manifest = { ...unsigned, manifestDigest: sha256(canonicalJson(unsigned)) };
    const runTransaction = vi.fn(async () => { throw new Error('TRANSACTION_SENTINEL'); });
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId,
      migrationJobId: JOB_ID, manifest, runTransaction })).rejects.toThrow(/unsupported legacy operational history/i);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('never silently loses accepted retained completion state during actual natural-cycle carry', async () => {
    await importSource();
    const result = await harness.runTenantTransaction(harness.tenantOneId, (tx) =>
      materializeTaskNaturalCycleInternal({ tx, tenantId: harness.tenantOneId,
        taskId: 'T1', taskInstanceId: 'TI1', taskTitle: 'Homework',
        schedule: { ruleVersion: 2, effectiveFrom: '2026-08-31T00:00:00.000Z',
          recurrence: { type: 'DAILY' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false },
        cycle: { cycleId: 'v1|TI1|r2|2026-09-01T00:00:00Z', startsAt: '2026-09-01T00:00:00Z',
          endsAt: '2026-09-02T00:00:00Z', nextResetAt: '2026-09-02T00:00:00Z' }, isAvailable: true, now: new Date('2026-09-01T00:00:00Z') }));
    expect(result.assignmentEventIds).toHaveLength(1);
    expect(result.completionEventIds).toHaveLength(1);
    const queries = createDatabaseTaskCycleQueries({ tenantId: harness.tenantOneId,
      runTenantSnapshot: harness.runTenantTransaction });
    expect((await queries.loadTaskCycleLedgerSnapshot()).completions).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'CARRY_FORWARD', status: 'SUCCESS', reward: 0, balanceAfter: 90 }),
    ]));
  });
});
