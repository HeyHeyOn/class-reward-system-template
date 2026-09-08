import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import * as cycleQueries from '@/server/repositories/database/taskCycleQueries';
import { canonicalJson, sha256 } from './validators';
import { sourceRecurrenceProjections } from './recurrenceComparison';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest } from './importer';
import { makeSupportedSheets, makeSheets, makeRedis } from './__fixtures__/normalization';
import { prepareLegacyImportReady, reconcileLegacyImport } from './reconcile';
vi.mock('server-only', () => ({}));
const JOB = '20000000-0000-4000-8000-000000000017';
let harness: PgliteDatabaseHarness;
beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const name of (await readdir(resolve(process.cwd(), 'src/server/db/migrations'))).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8'));
  }
});
afterEach(async () => { vi.restoreAllMocks(); await harness?.close(); });
function manifest(mutate?: Parameters<typeof makeSupportedSheets>[1]) {
  return createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
    sheets: makeSupportedSheets(3, mutate) });
}
async function imported(source = manifest(), batchSize?: number) {
  expect(source.status).toBe('READY_FOR_IMPORT');
  await harness.database.query("INSERT INTO migration_jobs (tenant_id,job_id,status) VALUES ($1,$2,'VALIDATED')", [harness.tenantOneId, JOB]);
  await importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
    manifest: source, batchSize, runTransaction: harness.runTenantTransaction });
  return source;
}
function reconcile(source: LegacyNormalizationManifest, currentManifest = source, tenantId = harness.tenantOneId,
  comparisonInstant = '2026-08-31T03:00:00.000Z') {
  return reconcileLegacyImport({ tenantId, migrationJobId: JOB, manifest: source, currentManifest,
    comparisonInstant, runTransaction: harness.runTenantTransaction });
}
async function prepare(source: LegacyNormalizationManifest, currentManifest = source, tenantId = harness.tenantOneId) {
  return prepareLegacyImportReady({ tenantId, migrationJobId: JOB, manifest: source, currentManifest,
    comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: harness.runTenantTransaction });
}
async function reports() {
  return (await harness.database.query(`SELECT event_id,job_id,event_type,redacted_details FROM audit_events
    WHERE tenant_id=$1 AND job_id=$2 AND event_type='MIGRATION_RECONCILIATION_PREFLIGHT' ORDER BY event_id`, [harness.tenantOneId, JOB])).rows;
}
async function state() {
  return (await harness.database.query<{ lifecycle: string; status: string; state_version: number }>(`SELECT t.lifecycle,j.status,j.state_version,
    (SELECT count(*) FROM operations) AS operations,
    (SELECT count(*) FROM padlet_evidence_claims) AS claims,
    (SELECT count(*) FROM padlet_claim_digest_tombstones) AS tombstones
    FROM tenants t JOIN migration_jobs j ON t.id=j.tenant_id WHERE j.job_id=$1`, [JOB])).rows;
}

function membershipManifest() {
  return manifest((tabs) => {
    // Several IDs ensure the real deterministic target order differs from membership order.
    for (const id of ['S2', 'S3', 'S4']) {
      tabs.Students.rows.push({ ...structuredClone(tabs.Students.rows[0]), cells: [id, id, '0', 'ACTIVE'] });
    }
    tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf('allowedStudentIds')] = 'S1,S2,S3,S4';
    tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf('ruleVersion')] = '2';
  });
}

describe('read-only bound import reconciliation through production migrations', () => {
  it.each([1, 2, 100])('compares allowed membership as a set across real import batchSize=%s', async (batchSize) => {
    const source = membershipManifest();
    const canonical = source.records.tasks[0].allowedStudentIds;
    const targetOrder = source.records.task_allowed_students.map((row) => row.studentId);
    expect(targetOrder).not.toEqual(canonical);
    await imported(source, batchSize);
    const queries = createDatabaseTaskCycleQueries({ tenantId: harness.tenantOneId,
      runTenantSnapshot: harness.runTenantTransaction });
    const rows = await queries.listTaskCycleProjections({ includeInactive: true, now: '2026-08-31T03:00:00.000Z' });
    if (batchSize === 1) expect(rows[0].allowedStudentIds).toEqual(targetOrder);
    const result = await prepare(source);
    expect(result.readiness, JSON.stringify(result.report)).toBe('READY');
    expect((await state())[0].status).toBe('READY');
  });

  it.each(['missing', 'extra'])('blocks actual %s database allowed membership without repair', async (kind) => {
    const source = await imported(membershipManifest());
    if (kind === 'missing') {
      await harness.database.query("DELETE FROM task_allowed_students WHERE tenant_id=$1 AND student_id='S4'", [harness.tenantOneId]);
    } else {
      await harness.database.query("INSERT INTO students (tenant_id,student_id,name,status) VALUES ($1,'EXTRA','Extra','ACTIVE')", [harness.tenantOneId]);
      await harness.database.query("INSERT INTO task_allowed_students (tenant_id,task_instance_id,student_id) VALUES ($1,'TI1','EXTRA')", [harness.tenantOneId]);
    }
    const read = async () => (await harness.database.query('SELECT * FROM task_allowed_students WHERE tenant_id=$1 ORDER BY student_id', [harness.tenantOneId])).rows;
    const before = await read();
    expect((await prepare(source)).readiness).toBe('BLOCKED');
    expect((await state())[0].status).toBe('IMPORTING');
    expect(await read()).toEqual(before);
  });

  it('retains database duplicate membership constraint and rejects duplicate source membership', async () => {
    await imported(membershipManifest());
    await expect(harness.database.query("INSERT INTO task_allowed_students (tenant_id,task_instance_id,student_id) VALUES ($1,'TI1','S1')", [harness.tenantOneId])).rejects.toThrow(/duplicate/);
    const duplicate = manifest((tabs) => {
      tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf('allowedStudentIds')] = 'S1,S1';
    });
    const result = await prepare(duplicate);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'INTEGRITY', code: 'INVALID_MANIFEST' });
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it.each(['allowedStudentIds', 'assignedStudentIds', 'completedStudentIds', 'students'].flatMap((field) =>
    ['missing', 'extra', 'duplicate'].map((kind) => [field, kind])))('blocks %s %s membership in the operational DTO', async (field, kind) => {
    const source = await imported(membershipManifest());
    const realFactory = cycleQueries.createDatabaseTaskCycleQueries;
    vi.spyOn(cycleQueries, 'createDatabaseTaskCycleQueries').mockImplementation((dependencies) => {
      const queries = realFactory(dependencies);
      return { ...queries, listTaskCycleProjections: async (options = {}) =>
        (await queries.listTaskCycleProjections(options)).map((row) => {
          const change = <T,>(values: T[], extra: T) => kind === 'missing' ? values.slice(1)
            : [...values, kind === 'extra' ? extra : values[0]];
          if (field === 'allowedStudentIds') return { ...row, allowedStudentIds: change(row.allowedStudentIds, 'EXTRA') };
          const currentCycle = { ...row.currentCycle };
          if (field === 'students') currentCycle.students = change(currentCycle.students, { ...currentCycle.students[0], studentId: 'EXTRA' });
          else if (field === 'assignedStudentIds') currentCycle.assignedStudentIds = change(currentCycle.assignedStudentIds, 'EXTRA');
          else currentCycle.completedStudentIds = change(currentCycle.completedStudentIds, 'EXTRA');
          return { ...row, currentCycle };
        }) };
    });
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ category: 'RECURRENCE', code: 'ROW_MISMATCH' }));
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it('requires a canonical explicit comparison instant rather than a createdAt or wall-clock fallback', async () => {
    const source = await imported();
    const report = await reconcile(source, source, harness.tenantOneId, 'not-an-instant');
    expect(report.status).toBe('BLOCKED');
    expect(report.diagnostics).toContainEqual({ category: 'RECURRENCE', code: 'INVALID_COMPARISON_INSTANT' });
  });

  it.each(['cycle', 'student'])('detects same-cardinality %s DTO corruption independently of persisted rows', async (kind) => {
    const source = await imported(manifest((tabs) => {
      for (const [key, value] of Object.entries({ ruleVersion: '2', recurrenceType: 'DAILY', recurrenceTime: '09:00' })) {
        tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf(key)] = value;
      }
    }));
    const realFactory = cycleQueries.createDatabaseTaskCycleQueries;
    const calls: Array<{ studentId?: string; now?: string }> = [];
    vi.spyOn(cycleQueries, 'createDatabaseTaskCycleQueries').mockImplementation((dependencies) => {
      const queries = realFactory(dependencies);
      return { ...queries, listTaskCycleProjections: async (options = {}) => {
        calls.push(options);
        const rows = await queries.listTaskCycleProjections(options);
        return rows.map((row) => ({ ...row,
          ...(kind === 'cycle' ? { currentCycle: { ...row.currentCycle, cycleId: 'wrong-cycle' } } : {}),
          ...(kind === 'student' && row.studentStatus
            ? { studentStatus: { ...row.studentStatus, completed: !row.studentStatus.completed } } : {}),
        }));
      } };
    });
    const report = await reconcile(source);
    expect(report.status).toBe('BLOCKED');
    expect(report.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'RECURRENCE', code: 'ROW_MISMATCH', rowReference: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    expect(calls).toContainEqual(expect.objectContaining({ now: '2026-08-31T03:00:00.000Z', studentId: 'S1' }));
    expect(report.metrics.find((row) => row.category === 'RECURRENCE')).toMatchObject({ expected: '2', actual: '2', delta: '0' });
  });
  it.each(['DAILY', 'WEEKLY', 'MONTHLY', 'NONE'].flatMap((type) =>
    [[false, false], [true, false], [false, true], [true, true]].map(([assignment, completion]) =>
      [type, assignment, completion] as const)))('compares nonzero retained %s history with reset flags assignment=%s completion=%s', async (recurrenceType, resetAssignment, resetCompletion) => {
      const source = manifest((tabs) => {
        const values = { ruleVersion: '2', recurrenceType,
          recurrenceTime: recurrenceType === 'NONE' ? '' : '09:00',
          recurrenceWeekdays: recurrenceType === 'WEEKLY' ? '1' : '',
          recurrenceDayOfMonth: recurrenceType === 'MONTHLY' ? '1' : '',
          resetAssignmentOnCycle: String(resetAssignment).toUpperCase(),
          resetCompletionOnCycle: String(resetCompletion).toUpperCase() };
        for (const [key, value] of Object.entries(values)) tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf(key)] = value;
      });
      expect(source.status).toBe('READY_FOR_IMPORT');
      const now = recurrenceType === 'WEEKLY' ? '2026-09-07T00:00:00.000Z'
        : recurrenceType === 'MONTHLY' ? '2026-10-01T00:00:00.000Z' : '2026-09-02T00:00:00.000Z';
      const projected = Array.from(sourceRecurrenceProjections(source, now))[1].projections[0];
      expect(projected.studentStatus).toMatchObject({ assigned: recurrenceType === 'NONE' || !resetAssignment,
        completed: recurrenceType === 'NONE' || !resetCompletion });
      await imported(source);
      expect(source.records.task_assignments).toHaveLength(2);
      expect(source.records.task_completions).toHaveLength(1);
      const report = await reconcile(source, source, harness.tenantOneId, now);
      expect(report.status, JSON.stringify(report)).toBe('MATCHED_PREFLIGHT');
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])(
    'compares explicit natural/configuration boundaries with reset flags assignment=%s completion=%s', async (resetAssignment, resetCompletion) => {
      const source = await imported(manifest((tabs) => {
        const values = { ruleVersion: '2', recurrenceType: 'DAILY', recurrenceTime: '09:00',
          resetAssignmentOnCycle: String(resetAssignment).toUpperCase(), resetCompletionOnCycle: String(resetCompletion).toUpperCase(),
          pendingRuleVersion: '3', pendingEffectiveFrom: '2026-08-31T12:00:00.000Z', pendingTimeZone: 'Asia/Seoul',
          pendingRecurrenceType: 'DAILY', pendingRecurrenceTime: '09:00',
          pendingResetAssignmentOnCycle: String(resetAssignment).toUpperCase(), pendingResetCompletionOnCycle: String(resetCompletion).toUpperCase() };
        for (const [key, value] of Object.entries(values)) tabs.Tasks.rows[0].cells[tabs.Tasks.headers.indexOf(key)] = value;
      }));
      const before = await state();
      for (const [now, transition, assigned, completed, origin, cycleId] of [
        ['2026-08-31T11:59:59.999Z', 'SCHEDULE_CHANGE_FIRST_CYCLE', true, true, 'EVENT', 'v1|TI1|r2|2026-08-31T00:00:00Z'],
        ['2026-08-31T12:00:00.000Z', 'SCHEDULE_CHANGE_FIRST_CYCLE', true, true, 'CARRY', 'v1|TI1|r3|2026-08-31T12:00:00Z'],
        ['2026-08-31T12:00:00.001Z', 'SCHEDULE_CHANGE_FIRST_CYCLE', true, true, 'CARRY', 'v1|TI1|r3|2026-08-31T12:00:00Z'],
        ['2026-09-01T00:00:00.000Z', 'NATURAL_BOUNDARY', !resetAssignment, !resetCompletion, null, 'v1|TI1|r3|2026-09-01T00:00:00Z'],
      ] as const) {
        const projected = Array.from(sourceRecurrenceProjections(source, now))[1].projections[0];
        expect(projected.currentCycle).toMatchObject({ transition, cycleId });
        expect(projected.studentStatus).toMatchObject({ assigned, completed,
          assignmentOrigin: origin ?? (assigned ? 'CARRY' : 'DEFAULT'),
          completionOrigin: origin ?? (completed ? 'CARRY' : 'DEFAULT') });
        expect((await reconcile(source, source, harness.tenantOneId, now)).status).toBe('MATCHED_PREFLIGHT');
      }
      expect(await state()).toEqual(before);
    });

  it('projects workbook v3 tasks as operational schedule schema v1 without altering canonical evidence', async () => {
    const source = await imported();
    expect(source.records.tasks[0].schemaVersion).toBe(3);
    const queries = createDatabaseTaskCycleQueries({ tenantId: harness.tenantOneId,
      runTenantSnapshot: harness.runTenantTransaction });
    await expect(queries.listTaskCycleProjections({ includeInactive: true, now: '2026-08-31T00:00:00.000Z' })).resolves.toHaveLength(1);
    const rows = await harness.database.query("SELECT canonical_record->>'schemaVersion' AS version FROM migration_source_records WHERE tenant_id=$1 AND target_table='tasks'", [harness.tenantOneId]);
    expect(rows.rows[0]).toMatchObject({ version: '3' });
  });
  it('matches real canonical import, independently reports sums and remains non-authoritative on rerun', async () => {
    const source = await imported();
    const before = await state();
    const report = await reconcile(source);
    expect(report.status, JSON.stringify(report)).toBe('MATCHED_PREFLIGHT');
    expect(report.diagnostics).toEqual([]);
    expect(report.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'STUDENTS', expected: '1', actual: '1', delta: '0' }),
      expect.objectContaining({ category: 'BALANCES', expected: '100', actual: '100', delta: '0' }),
      expect.objectContaining({ category: 'STOCK', expected: '5', actual: '5' }),
      expect.objectContaining({ category: 'TRANSACTIONS', expected: '2', actual: '2' }),
      expect.objectContaining({ category: 'TRANSACTION_AMOUNT', expected: '10', actual: '10' }),
      expect.objectContaining({ category: 'TRANSACTION_DELTA', expected: '-10', actual: '-10' }),
      expect.objectContaining({ category: 'RECURRENCE', status: 'MATCH' }),
    ]));
    expect(report.cutoverAllowed).toBe(false);
    expect(await reconcile(source)).toEqual(report);
    expect(await state()).toEqual(before);
    expect(before[0]).toMatchObject({ lifecycle: 'IMPORTING', status: 'IMPORTING', operations: 0, claims: 0, tombstones: 0 });
    expect(JSON.stringify(report)).not.toContain(source.sourceArtifacts.sheets.credentialHashes.adminPasswordHash);
  });

  it.each([
    ['accounts', 'balance=balance+1', 'BALANCES'],
    ['products', 'stock=stock+1', 'STOCK'],
    ['students', "name='Bearer secret-row-value'", 'STUDENTS'],
    ['tasks', "title='Changed title'", 'TASKS'],
    ['promotions', "name='Changed promotion'", 'PROMOTIONS'],
  ])('detects actual %s drift with row diagnostics even when counts match', async (table, change, category) => {
    const source = await imported();
    await harness.database.query(`UPDATE ${table} SET ${change} WHERE tenant_id=$1`, [harness.tenantOneId]);
    const before = await state();
    const report = await reconcile(source);
    expect(report.status).toBe('BLOCKED');
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ROW_MISMATCH' })]));
    expect(report.metrics.find((row) => row.category === category)).toBeDefined();
    expect(JSON.stringify(report)).not.toContain('secret-row-value');
    expect(await state()).toEqual(before);
  });

  it('finds extra immutable transaction rows using INSERT-only fixtures', async () => {
    const source = await imported();
    await harness.database.query(`INSERT INTO transactions (tenant_id,transaction_id,occurred_at,student_id,
      student_name_snapshot,kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,legacy_status_snapshot)
      SELECT tenant_id,'extra-TX',occurred_at,student_id,student_name_snapshot,kind,legacy_total_amount,
      balance_delta,balance_before,balance_after,operator_snapshot,legacy_status_snapshot
      FROM transactions WHERE tenant_id=$1 AND transaction_id='TX1'`, [harness.tenantOneId]);
    const report = await reconcile(source);
    expect(report.status).toBe('BLOCKED');
    expect(report.metrics.find((row) => row.category === 'TRANSACTIONS')).toMatchObject({ expected: '2', actual: '3', delta: '1' });
    expect(report.diagnostics.some((row) => row.code === 'CARDINALITY_MISMATCH')).toBe(true);
  });

  it('blocks missing completed checkpoints rather than trusting importer counts', async () => {
    const source = await imported();
    await harness.database.query("DELETE FROM migration_source_records WHERE tenant_id=$1 AND record_id=(SELECT record_id FROM migration_source_records WHERE tenant_id=$1 LIMIT 1)", [harness.tenantOneId]);
    const report = await reconcile(source);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'CHECKPOINTS', code: 'CARDINALITY_MISMATCH' })]));
    expect(report.status).toBe('BLOCKED');
  });

  it('blocks a changed current source without choosing either database or Sheets', async () => {
    const source = await imported();
    const current = manifest((tabs) => { tabs.Products.rows[0].cells[3] = '9'; });
    const before = await state();
    const report = await reconcile(source, current);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_MUTATION' })]));
    expect(report.status).toBe('BLOCKED');
    expect(await state()).toEqual(before);
  });

  it('requires the original job manifest binding, not a newly valid self-digest', async () => {
    await imported();
    const changed = manifest((tabs) => { tabs.Products.rows[0].cells[3] = '9'; });
    const report = await reconcile(changed);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'BINDING_MISMATCH' })]));
    expect(report.status).toBe('BLOCKED');
  });

  it('isolates tenant reads and rejects cross-tenant manifest binding', async () => {
    const source = await imported();
    await harness.database.query("INSERT INTO students (tenant_id,student_id,name,status) VALUES ($1,'OTHER','Other','ACTIVE')", [harness.tenantTwoId]);
    expect((await reconcile(source)).status).toBe('MATCHED_PREFLIGHT');
    expect((await reconcile(source, source, harness.tenantTwoId)).status).toBe('BLOCKED');
  });

  it('reports nonzero cancellation count and signed sums independently from source reversals', async () => {
    const source = await imported(manifest((tabs) => {
      tabs.Transactions.rows[0].cells[tabs.Transactions.headers.indexOf('status')] = 'CANCELLED';
      const reversal = structuredClone(tabs.Transactions.rows[0]);
      for (const [key, value] of Object.entries({ transactionId: 'REV1', timestamp: '2026-09-02T00:00:00.000Z',
        items: '[]', totalAmount: '-20', balanceBefore: '80', balanceAfter: '100', status: 'CANCEL_REVERSAL', operator: 'cancel:TX1' })) {
        reversal.cells[tabs.Transactions.headers.indexOf(key)] = value;
      }
      tabs.Transactions.rows.push(reversal);
    }));
    const result = await prepare(source);
    expect(result.readiness).toBe('READY');
    expect(result.report.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'CANCELLATIONS', expected: '1', actual: '1', delta: '0' }),
      expect.objectContaining({ category: 'CANCELLATION_AMOUNT', expected: '-20', actual: '-20', delta: '0' }),
      expect.objectContaining({ category: 'CANCELLATION_DELTA', expected: '20', actual: '20', delta: '0' }),
    ]));
  });

  it('counts staged Redis tombstones and orphan claims without publishing global authority', async () => {
    const source = await imported(createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      sheets: makeSupportedSheets(), redis: makeRedis({ v2Claims: [], operationBindings: [],
        v1Tombstones: [{ tupleDigest: 'a'.repeat(64), ownerDigest: 'b'.repeat(64), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }],
        orphanedClaimDigests: ['c'.repeat(64)] }) }));
    const report = await reconcile(source);
    expect(report.status, JSON.stringify(report)).toBe('MATCHED_PREFLIGHT');
    expect(report.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'TOMBSTONES', expected: '1', actual: '1' }),
      expect.objectContaining({ category: 'ORPHANED_CLAIMS', expected: '1', actual: '1' }),
      expect.objectContaining({ category: 'PADLET_CLAIMS', expected: '0', actual: '0' }),
      expect.objectContaining({ category: 'OPERATION_BINDINGS', expected: '0', actual: '0' }),
    ]));
    expect((await state())[0]).toMatchObject({ claims: 0, tombstones: 0, operations: 0 });
  });

  it('rejects a prematurely completed deferred checkpoint even with matching canonical counts', async () => {
    const source = await imported(createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      sheets: makeSupportedSheets(), redis: makeRedis({ v2Claims: [], operationBindings: [], orphanedClaimDigests: ['c'.repeat(64)] }) }));
    await harness.database.query(`UPDATE migration_source_records SET mapping_status='IMPORTED',
      target_table='padlet_claim_digest_tombstones', target_id='unpublished'
      WHERE tenant_id=$1 AND canonical_record->>'kind'='ORPHAN_V2'`, [harness.tenantOneId]);
    const report = await reconcile(source);
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'CHECKPOINTS', code: 'CHECKPOINT_INCOMPLETE' })]));
    expect(report.status).toBe('BLOCKED');
    expect(report.metrics.find((row) => row.category === 'ORPHANED_CLAIMS')).toMatchObject({ expected: '1', actual: '1', delta: '0' });
  });

  it.each([
    ['padlet_evidence_claims', '{tupleDigest}', 'a'.repeat(64), 'PADLET_CLAIMS'],
    ['padlet_evidence_claims', '{ownerDigest}', 'b'.repeat(64), 'PADLET_CLAIMS'],
    ['padlet_evidence_claims', '{operationId}', 'wrong-operation', 'PADLET_CLAIMS'],
    ['legacy_operation_bindings', '{binding,studentId}', 'OTHER-STUDENT', 'OPERATION_BINDINGS'],
    ['legacy_operation_bindings', '{binding,evidence,evidencePostId}', 'OTHER-POST', 'OPERATION_BINDINGS'],
    ['legacy_operation_bindings', '{ownerDigest}', 'b'.repeat(64), 'OPERATION_BINDINGS'],
    ['legacy_operation_bindings', '{operationId}', 'wrong-operation', 'OPERATION_BINDINGS'],
    ['V1_GLOBAL', '{ownerDigest}', 'c'.repeat(64), 'TOMBSTONES'],
    ['V1_GLOBAL', '{tupleDigest}', 'd'.repeat(64), 'TOMBSTONES'],
    ['ORPHAN_V2', '{tupleDigest}', 'e'.repeat(64), 'ORPHANED_CLAIMS'],
  ])('blocks same-count Redis %s %s corruption with exact canonical evidence retained', async (selector, path, value, category) => {
    const source = await imported(createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      sheets: makeSupportedSheets(), redis: makeRedis({
        v1Tombstones: [{ tupleDigest: 'f'.repeat(64), ownerDigest: 'a'.repeat(64), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }],
        orphanedClaimDigests: ['b'.repeat(64)],
      }) }));
    const before = await state();
    const checkpoints = (await harness.database.query('SELECT record_id,canonical_record FROM migration_source_records WHERE tenant_id=$1 ORDER BY record_id', [harness.tenantOneId])).rows;
    const positive = await reconcile(source);
    expect(positive.status, JSON.stringify(positive)).toBe('MATCHED_PREFLIGHT');
    expect(positive.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'PADLET_CLAIMS', expected: '1', actual: '1' }),
      expect.objectContaining({ category: 'OPERATION_BINDINGS', expected: '1', actual: '1' }),
    ]));
    const changed = await harness.database.query(`UPDATE migration_source_records SET canonical_record=jsonb_set(canonical_record,$2::text[],$3::jsonb)
      WHERE tenant_id=$1 AND (canonical_record->'migrationCheckpoint'->>'intendedTargetTable'=$4 OR canonical_record->>'kind'=$4)
      RETURNING record_id`, [harness.tenantOneId, path, JSON.stringify(value), selector]);
    expect(changed.rows).toHaveLength(1);
    const corrupted = (await harness.database.query('SELECT record_id,canonical_record FROM migration_source_records WHERE tenant_id=$1 ORDER BY record_id', [harness.tenantOneId])).rows;
    expect(corrupted).not.toEqual(checkpoints);
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.metrics).toContainEqual(expect.objectContaining({ category, expected: '1', actual: '1', delta: '0' }));
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ category: 'CHECKPOINTS', code: 'CHECKPOINT_INCOMPLETE' }));
    expect((await reports())[0]).toMatchObject({ redacted_details: { report: result.report } });
    expect((await harness.database.query('SELECT record_id,canonical_record FROM migration_source_records WHERE tenant_id=$1 ORDER BY record_id', [harness.tenantOneId])).rows).toEqual(corrupted);
    expect(await state()).toEqual(before);
  });

  it.each(['source', 'job'])('rejects changed persisted %s fingerprint without reporting authority', async (binding) => {
    const source = await imported();
    const table = binding === 'source' ? 'migration_sources' : 'migration_jobs';
    await harness.database.query(`UPDATE ${table} SET source_fingerprint=$2 WHERE tenant_id=$1 AND job_id=$3`, [harness.tenantOneId, 'f'.repeat(64), JOB]);
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
    expect(result.persistedReportId).toBeNull();
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it('preserves BANK quarantine as blocking without trusting zero surviving targets', async () => {
    const source = createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      sheets: makeSheets(), redis: makeRedis() });
    expect(source.records.task_completions).toHaveLength(0);
    const report = await reconcile(source);
    expect(report.status).toBe('BLOCKED');
    expect(report.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'INVALID_MANIFEST' })]));
    expect(report.cutoverAllowed).toBe(false);
  });
});

describe('locked persisted preparatory READY, never cutover', () => {
  it.each(['FINAL_FROZEN', 'ROLLBACK_EXPORT', 'OTHER_PREFLIGHT'])('does not confuse intentional %s snapshots with the import binding', async (kind) => {
    const source = await imported();
    await harness.database.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      SELECT tenant_id,job_id,source_id,'other-snapshot',$3,$4,$5::jsonb,row_count FROM migration_snapshots
      WHERE tenant_id=$1 AND job_id=$2`, [harness.tenantOneId, JOB,
      kind === 'OTHER_PREFLIGHT' ? 'PREFLIGHT' : kind, 'a'.repeat(64),
      JSON.stringify({ bindingKind: kind === 'OTHER_PREFLIGHT' ? 'OTHER' : 'LEGACY_NORMALIZATION_IMPORT' })]);
    expect((await prepare(source)).readiness).toBe('READY');
  });

  it.each(['missing', 'extra'])('requires exactly one import snapshot: %s', async (kind) => {
    const source = await imported();
    if (kind === 'missing') await harness.withMigrationSnapshotTampering(() => harness.database.query('DELETE FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2', [harness.tenantOneId, JOB]));
    else await harness.database.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      SELECT tenant_id,job_id,source_id,'extra-snapshot',phase,$3,redacted_manifest,row_count
      FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2`, [harness.tenantOneId, JOB, 'a'.repeat(64)]);
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'INTEGRITY', code: 'BINDING_MISMATCH' });
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it.each(['row_count', 'row_count_max', 'snapshot_id', 'source_id'])('rejects persisted import snapshot %s corruption without repair', async (field) => {
    const source = await imported(createLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      sheets: makeSupportedSheets(), redis: makeRedis({ v2Claims: [], operationBindings: [], orphanedClaimDigests: ['c'.repeat(64)] }) }));
    expect((await reconcile(source)).status).toBe('MATCHED_PREFLIGHT');
    const before = await state();
    const change = field === 'row_count_max' ? 'row_count=9007199254740991'
      : field === 'row_count' ? 'row_count=row_count+1'
      : field === 'snapshot_id' ? "snapshot_id='corrupted-snapshot'"
        : "source_id=(SELECT source_id FROM migration_sources WHERE tenant_id=$1 AND job_id=$2 AND provider='LEGACY_REDIS_BRIDGE')";
    const changed = await harness.withMigrationSnapshotTampering(() => harness.database.query(`UPDATE migration_snapshots SET ${change}
      WHERE tenant_id=$1 AND job_id=$2 AND phase='PREFLIGHT' RETURNING *`, [harness.tenantOneId, JOB]));
    expect(changed.rows).toHaveLength(1);
    if (field === 'source_id') {
      const redis = await harness.database.query('SELECT provider FROM migration_sources WHERE tenant_id=$1 AND job_id=$2 AND source_id=$3',
        [harness.tenantOneId, JOB, (changed.rows[0] as Record<string, unknown>).source_id]);
      expect(redis.rows).toEqual([{ provider: 'LEGACY_REDIS_BRIDGE' }]);
    }
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'INTEGRITY', code: 'BINDING_MISMATCH' });
    expect(result.persistedReportId).toBeNull();
    expect(await reports()).toEqual([]);
    expect(await state()).toEqual(before);
    expect((await harness.database.query("SELECT * FROM migration_snapshots WHERE tenant_id=$1 AND job_id=$2 AND phase='PREFLIGHT'",
      [harness.tenantOneId, JOB])).rows).toEqual(changed.rows);
  });

  it('persists exact immutable credential-free report and atomically advances without a live freeze', async () => {
    const source = await imported();
    const before = (await state())[0];
    const result = await prepare(source);
    expect(result.readiness).toBe('READY');
    expect(result.report.status).toBe('MATCHED_PREFLIGHT');
    expect(result.report.cutoverAllowed).toBe(false);
    const persisted = await reports();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ event_id: result.persistedReportId,
      redacted_details: { report: result.report, comparisonInstant: '2026-08-31T03:00:00.000Z',
        manifestDigest: source.manifestDigest, currentManifestDigest: source.manifestDigest,
        sourceFingerprint: source.sourceFingerprint, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE' } });
    expect(JSON.stringify(persisted)).not.toContain(source.sourceArtifacts.sheets.credentialHashes.adminPasswordHash);
    expect((await state())[0]).toMatchObject({ lifecycle: 'IMPORTING', status: 'READY',
      state_version: Number(before.state_version) + 2, claims: 0, operations: 0, tombstones: 0 });
    expect((await harness.database.query('SELECT freeze_verified_at,freeze_started_at,final_fingerprint FROM migration_jobs WHERE job_id=$1', [JOB])).rows)
      .toEqual([{ freeze_verified_at: null, freeze_started_at: null, final_fingerprint: null }]);
    expect(await prepare(source)).toEqual(result);
    expect(await reports()).toEqual(persisted);
    await expect(importLegacyNormalizationManifest({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      manifest: source, runTransaction: harness.runTenantTransaction })).rejects.toThrow();
    await expect(harness.database.query("UPDATE audit_events SET redacted_details='{}' WHERE event_id=$1", [result.persistedReportId])).rejects.toThrow(/immutable/);
    await expect(harness.database.query('DELETE FROM audit_events WHERE event_id=$1', [result.persistedReportId])).rejects.toThrow(/immutable/);
  });

  it('persists bound mismatch diagnostics without granting READY or changing targets', async () => {
    const source = await imported();
    await harness.database.query('UPDATE accounts SET balance=balance+1 WHERE tenant_id=$1', [harness.tenantOneId]);
    const before = await state();
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.metrics).toContainEqual(expect.objectContaining({ category: 'BALANCES', expected: '100', actual: '101', delta: '1' }));
    expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: 'ROW_MISMATCH', rowReference: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect((await reports())[0]).toMatchObject({ redacted_details: { report: result.report } });
    expect(await prepare(source)).toEqual(result);
    expect(await reports()).toHaveLength(1);
    expect(await state()).toEqual(before);
  });

  it('revalidates actual target state on READY rerun and revokes a stale preparatory state', async () => {
    const source = await imported();
    expect((await prepare(source)).readiness).toBe('READY');
    await harness.database.query('UPDATE products SET stock=stock+1 WHERE tenant_id=$1', [harness.tenantOneId]);
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.status).toBe('BLOCKED');
    expect((await state())[0]).toMatchObject({ lifecycle: 'IMPORTING', status: 'FAILED' });
    expect(await reports()).toHaveLength(2);
  });

  it('persists source mutation when original binding remains valid', async () => {
    const source = await imported();
    const current = manifest((tabs) => { tabs.Products.rows[0].cells[3] = '9'; });
    const result = await prepare(source, current);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'SOURCES', code: 'SOURCE_MUTATION' });
    expect(await reports()).toHaveLength(1);
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it('compares the complete current normalized snapshot, not only matching fingerprint and acquisition summaries', async () => {
    const source = await imported();
    const { manifestDigest: _digest, ...unsigned } = structuredClone(source);
    void _digest;
    const changed = { ...unsigned, mappings: [...unsigned.mappings].reverse() };
    const current = { ...changed, manifestDigest: sha256(canonicalJson(changed)) };
    expect(current.sourceFingerprint).toBe(source.sourceFingerprint);
    expect(current.sourceArtifacts).toEqual(source.sourceArtifacts);
    const result = await prepare(source, current);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'SOURCES', code: 'SOURCE_MUTATION' });
    expect(await reports()).toHaveLength(1);
  });

  it('persists invalid current-snapshot diagnostics when the original job binding is independently valid', async () => {
    const source = await imported();
    const current = { ...source, manifestDigest: 'a'.repeat(64) };
    const result = await prepare(source, current);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'SOURCES', code: 'INVALID_CURRENT_MANIFEST' });
    expect((await reports())[0]).toMatchObject({ redacted_details: { report: result.report, currentManifestDigest: null } });
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it('rejects wrong-tenant and forged caller reports without persistence or readiness', async () => {
    const source = await imported();
    const result = await prepare(source, source, harness.tenantTwoId);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.persistedReportId).toBeNull();
    expect(await reports()).toEqual([]);
    await harness.database.query("UPDATE migration_source_records SET mapping_status='STAGED',target_table=NULL,target_id=NULL WHERE tenant_id=$1 AND target_table='students'", [harness.tenantOneId]);
    const input = { tenantId: harness.tenantOneId, migrationJobId: JOB, manifest: source, currentManifest: source,
      comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: harness.runTenantTransaction,
      report: { status: 'MATCHED_PREFLIGHT', diagnostics: [], metrics: [] }, readiness: 'READY' };
    expect((await prepareLegacyImportReady(input)).readiness).toBe('BLOCKED');
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it('persists a redacted invalid-instant report only after independently checking original source bindings', async () => {
    const source = await imported();
    const result = await prepareLegacyImportReady({ tenantId: harness.tenantOneId, migrationJobId: JOB,
      manifest: source, currentManifest: source, comparisonInstant: 'Bearer secret-clock', runTransaction: harness.runTenantTransaction });
    expect(result.readiness).toBe('BLOCKED');
    expect(result.report.diagnostics).toContainEqual({ category: 'RECURRENCE', code: 'INVALID_COMPARISON_INSTANT' });
    expect((await reports())[0]).toMatchObject({ redacted_details: { report: result.report, comparisonInstant: null } });
    expect(JSON.stringify(await reports())).not.toContain('secret-clock');
    expect((await state())[0].status).toBe('IMPORTING');
  });

  it('rolls back persisted report and both job transitions on final transition failure', async () => {
    const source = await imported();
    const before = await state();
    await harness.database.exec(`CREATE FUNCTION reject_test_ready() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status='READY' THEN RAISE EXCEPTION 'READY_FAILURE_SECRET'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_ready BEFORE UPDATE ON migration_jobs FOR EACH ROW EXECUTE FUNCTION reject_test_ready();`);
    const result = await prepare(source);
    expect(result.readiness).toBe('BLOCKED');
    expect(result.persistedReportId).toBeNull();
    expect(JSON.stringify(result)).not.toContain('READY_FAILURE_SECRET');
    expect(await reports()).toEqual([]);
    expect(await state()).toEqual(before);
  });
});
