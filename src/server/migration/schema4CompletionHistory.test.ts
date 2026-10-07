import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { getTaskRecords } from '@/server/sheetsRepository';
import { updateTaskAssignmentsBatch } from '@/server/repositories/sheets/taskAssignmentCommands';
import { loadTaskCycleLedgerSnapshot, projectTaskCycleStateFromSnapshot } from '@/server/repositories/sheets/taskCycleQueries';
import { inspectSchema4CompletionHistory, importSchema4CompletionHistory, readSchema4CompletionHistory,
  replaySchema4CompletionHistory } from './schema4CompletionHistory';
import { syntheticCompletionGrid, completionGridWire, setCompletionCell, completionMemoryStore,
  completionTimes, completionUuids, assignmentUuids } from '../../../test-support/schema4CompletionHistory.fixture';
vi.mock('server-only', () => ({}));
type Tables = Record<string, string[][]>;
const intent = 'OFFLINE_INSPECTION' as const;
const inspect = (t = syntheticCompletionGrid()) => inspectSchema4CompletionHistory(completionGridWire(t));
const change = (t: Tables, row: number, key: string, value: string) => setCompletionCell(t, 'TaskCompletions', row, key, value);

describe('A08 physical completion rows 6:7 only', () => {
  it('reports only an unproven event when the raw event shape is invalid', () => {
    const t = syntheticCompletionGrid(); change(t, 6, 'status', 'CANCELLED');
    expect(inspect(t).rows[0].event).toBe('UNPROVEN');
  });
  it('recognizes zero-effect ADMIN success/reset shape without authenticating writer, admin or claim', () => {
    const result = inspect();
    expect(result.rows.map(r => [r.rowNumber, r.event, r.consistency, r.assignmentRows, r.taskRows, r.logicalRows])).toEqual([
      [6, 'ADMIN_SUCCESS', 'ADMIN_TOGGLE_WRITER_COMPATIBLE', [3], [3], [6, 7]],
      [7, 'ADMIN_RESET', 'ADMIN_TOGGLE_WRITER_COMPATIBLE', [3], [3], [6, 7]],
    ]);
    expect(result.rows.every(r => Object.values(r.facts).every(Boolean) && r.adminAuthority === 'UNVERIFIED'
      && r.claimAuthority === 'UNVERIFIED' && r.writerAttribution === 'UNVERIFIED'
      && r.diagnosticCodes.includes('HISTORICAL_ADMIN_AUTH_UNVERIFIED'))).toBe(true);
    expect(result.authority).toBe('OFFLINE_NONAUTHORITY');
    expect(result.operationalBridge).toEqual({ status: 'BLOCKED', readerConnected: false, importerConnected: false });
    const text = JSON.stringify(result);
    for (const value of ['synthetic-student', 'Synthetic Person', 'synthetic-admin-task', ...completionUuids, ...assignmentUuids]) expect(text).not.toContain(value);
  });
  it.each([
    ['missing reset', (t: Tables) => t.TaskCompletions.pop()],
    ['duplicate completion id', (t: Tables) => t.TaskCompletions.push([...t.TaskCompletions[5]])],
    ['trimmed completion collision', (t: Tables) => { t.TaskCompletions.push([...t.TaskCompletions[5]]); change(t, 8, 'completionId', ` ${t.TaskCompletions[5][0]} `); }],
    ['reused pair id', (t: Tables) => change(t, 7, 'completionId', t.TaskCompletions[5][0])],
    ['additional logical success', (t: Tables) => { t.TaskCompletions.push([...t.TaskCompletions[5]]); change(t, 8, 'completionId', 'TC-80000000-0000-4000-8000-000000000003'); }],
    ['same instance different task id', (t: Tables) => { t.TaskCompletions.push([...t.TaskCompletions[5]]); change(t, 8, 'taskId', 'synthetic-other'); }],
    ['reward', (t: Tables) => change(t, 6, 'reward', '5')],
    ['bank source', (t: Tables) => change(t, 6, 'source', 'BANK')],
    ['cancelled outcome', (t: Tables) => change(t, 7, 'status', 'CANCELLED')],
    ['wrong note', (t: Tables) => change(t, 7, 'note', 'admin-completion-reset')],
    ['operation metadata', (t: Tables) => change(t, 6, 'operationId', 'synthetic-operation')],
    ['balance mutation', (t: Tables) => change(t, 6, 'balanceAfter', '37')],
    ['unsafe balance', (t: Tables) => { change(t, 6, 'balanceBefore', '9007199254740992'); change(t, 6, 'balanceAfter', '9007199254740992'); }],
    ['noncanonical balance', (t: Tables) => { change(t, 6, 'balanceBefore', '036'); change(t, 6, 'balanceAfter', '036'); }],
    ['wrong cycle', (t: Tables) => change(t, 6, 'cycleId', 'synthetic-other')],
    ['wrong assignment', (t: Tables) => change(t, 7, 'assignmentId', `A-${assignmentUuids[1]}`)],
    ['assignment duplicate', (t: Tables) => t.TaskAssignments.push([...t.TaskAssignments[2]])],
    ['assignment raw trim collision', (t: Tables) => { t.TaskAssignments.push([...t.TaskAssignments[2]]); setCompletionCell(t, 'TaskAssignments', 5, 'assignmentId', ` A-${assignmentUuids[0]} `); }],
    ['wrong assignment student', (t: Tables) => setCompletionCell(t, 'TaskAssignments', 3, 'studentId', 'synthetic-other')],
    ['missing unassignment', (t: Tables) => t.TaskAssignments.pop()],
    ['wrong unassignment predecessor', (t: Tables) => setCompletionCell(t, 'TaskAssignments', 4, 'previousAssignmentId', 'synthetic-other')],
    ['task duplicate', (t: Tables) => t.Tasks.push([...t.Tasks[2]])],
    ['unknown schedule', (t: Tables) => setCompletionCell(t, 'Tasks', 3, 'recurrenceType', 'DAILY')],
    ['same timestamp', (t: Tables) => change(t, 7, 'timestamp', completionTimes[0])],
    ['swapped physical rows', (t: Tables) => { [t.TaskCompletions[5], t.TaskCompletions[6]] = [t.TaskCompletions[6], t.TaskCompletions[5]]; }],
    ['cross-ledger id reuse', (t: Tables) => setCompletionCell(t, 'Transactions', 10, 'transactionId', `TC-${completionUuids[0]}`)],
    ['reward counterpart', (t: Tables) => { t.Transactions.push([...t.Transactions[1]]); setCompletionCell(t, 'Transactions', 11, 'items', JSON.stringify([{ productId: 'synthetic-admin-task' }])); }],
    ['direct task transaction', (t: Tables) => setCompletionCell(t, 'Transactions', 10, 'transactionId', `TASK-TC-${completionUuids[0]}`)],
    ['opaque transaction items', (t: Tables) => setCompletionCell(t, 'Transactions', 10, 'items', '{')],
    ['unknown completion header', (t: Tables) => change(t, 6, 'evidenceAdmin', 'true')],
    ['unknown transaction identity header', (t: Tables) => { t.Transactions[0][0] = 'notTransactionId'; }],
    ['task rule coercion', (t: Tables) => setCompletionCell(t, 'Tasks', 3, 'ruleVersion', '01')],
    ['task zone fallback', (t: Tables) => setCompletionCell(t, 'Tasks', 3, 'recurrenceTimeZone', '')],
  ])('fails closed before SQL: %s', async (_label, mutate) => {
    const t = syntheticCompletionGrid(); mutate(t);
    expect(inspect(t).rows.some(r => r.consistency === 'UNPROVEN')).toBe(true);
    const runTransaction = vi.fn();
    await expect(importSchema4CompletionHistory({ tenantId: 'synthetic', gridJson: completionGridWire(t), intent, runTransaction }))
      .rejects.toThrow('COMPLETION_HISTORY_SLICE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it.each(['OPERATIONAL_IMPORT', 'OPERATIONAL_READER', undefined, 'unknown'])('rejects bridge intent before any SQL: %s', async value => {
    const runTransaction = vi.fn();
    const input = { tenantId: 'synthetic', sourceDigest: '', gridJson: '', intent: value as typeof intent, runTransaction };
    await expect(importSchema4CompletionHistory(input)).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    await expect(readSchema4CompletionHistory(input)).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    await expect(replaySchema4CompletionHistory({ ...input, rowNumber: 6 })).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it('actual local batch writer reproduces rows; reset retry refuses without writes and reader applies no reward', async () => {
    const expected = syntheticCompletionGrid(), t = syntheticCompletionGrid();
    t.TaskCompletions.splice(5); t.TaskAssignments.splice(2);
    const { store, writes } = completionMemoryStore(t);
    const uuids = [assignmentUuids[0], completionUuids[0], completionUuids[1], assignmentUuids[1]];
    const random = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => uuids.shift() as ReturnType<typeof crypto.randomUUID>);
    try {
      for (const i of [0, 1]) {
        const target = [{ taskId: 'synthetic-admin-task', operations: [{ studentId: 'synthetic-student', assigned: i === 0, completed: i === 0, source: 'ADMIN' as const }] }];
        expect(await updateTaskAssignmentsBatch(store, target, { now: () => completionTimes[i] })).toEqual({ appliedCount: 1, failures: [] });
        const before = writes.length;
        const retry = await updateTaskAssignmentsBatch(store, target, { now: () => completionTimes[i] });
        if (i === 0) expect(retry).toEqual({ appliedCount: 0, failures: [] });
        else expect(retry).toEqual({ appliedCount: 0, failures: [{ taskId: 'synthetic-admin-task', studentId: 'synthetic-student', code: 'OPERATION_FAILED' }], aborted: true, notAttempted: [] });
        expect(writes.length).toBe(before);
        const snapshot = await loadTaskCycleLedgerSnapshot(store), task = (await getTaskRecords(store)).find(r => r.task.taskId === 'synthetic-admin-task')!.task;
        const state = projectTaskCycleStateFromSnapshot(task, completionTimes[i], snapshot).students['synthetic-student'];
        expect([state.assigned, state.completed]).toEqual([i === 0, i === 0]);
      }
      expect(t.TaskCompletions).toEqual(expected.TaskCompletions);
      expect(t.TaskAssignments).toEqual(expected.TaskAssignments);
      expect(t.Transactions).toEqual(expected.Transactions); expect(t.Students).toEqual(expected.Students);
      expect(writes.every(w => ['TaskAssignments', 'TaskCompletions', 'Tasks'].includes(w.tab))).toBe(true);
      expect(random).toHaveBeenCalledTimes(4);
    } finally { random.mockRestore(); }
  });
});

it('A08 isolated SQL raw readback rollback retry lost response replay tenant and tamper gates', async () => {
  const db = await createPgliteDatabaseHarness();
  try {
    await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
    const gridJson = completionGridWire(syntheticCompletionGrid());
    const input = { tenantId: db.tenantOneId, gridJson, intent, runTransaction: db.runTenantTransaction };
    const count = async () => (await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM schema4_history.captures)
      + (SELECT count(*) FROM schema4_history.source_rows) + (SELECT count(*) FROM schema4_history.reward_groups))::int n`)).rows[0].n;
    await expect(importSchema4CompletionHistory({ ...input, runTransaction: (tenant, cb) => db.runTenantTransaction(tenant, async tx => {
      await cb(tx); throw new Error('A08_ROLLBACK');
    }) })).rejects.toThrow('A08_ROLLBACK');
    expect(await count()).toBe(0);
    const first = await importSchema4CompletionHistory(input), read = { ...input, sourceDigest: first.sourceDigest };
    expect(await importSchema4CompletionHistory(input)).toEqual(first);
    await expect(importSchema4CompletionHistory({ ...input, runTransaction: async (tenant, cb) => {
      await db.runTenantTransaction(tenant, cb); throw new Error('A08_LOST_RESPONSE');
    } })).rejects.toThrow('A08_LOST_RESPONSE');
    expect(await importSchema4CompletionHistory(input)).toEqual(first);
    expect((await readSchema4CompletionHistory(read)).completionHistory).toEqual(inspect());
    expect((await db.database.query('SELECT grid_json FROM schema4_history.captures')).rows).toEqual([{ grid_json: gridJson }]);
    const before = await count();
    for (const rowNumber of [6, 7]) for (let attempt = 0; attempt < 2; attempt++) expect(await replaySchema4CompletionHistory({ ...read, rowNumber })).toMatchObject({
      rowNumber, changed: false, balanceToApply: 0, rewardToApply: 0, stockToApply: 0, completionToApply: false,
      claimPublished: false, authority: 'OFFLINE_NONAUTHORITY', currentStateAuthority: 'BLOCKED',
    });
    expect(await count()).toBe(before);
    await expect(replaySchema4CompletionHistory({ ...read, rowNumber: 5 })).rejects.toThrow('COMPLETION_REPLAY_UNPROVEN');
    await expect(readSchema4CompletionHistory({ ...read, tenantId: db.tenantTwoId })).rejects.toThrow('BANK_HISTORY_NOT_FOUND');
    expect((await db.database.query(`SELECT ((SELECT count(*) FROM operations) + (SELECT count(*) FROM accounts)
      + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM task_completions) + (SELECT count(*) FROM inventory_ledger))::int n`)).rows).toEqual([{ n: 0 }]);
    await expect(db.database.query("UPDATE schema4_history.source_rows SET cells='[]'::jsonb WHERE tab='TaskCompletions' AND row_number=6"))
      .rejects.toThrow('SCHEMA4_HISTORY_IMMUTABLE');
    // Adversarial corruption in this disposable in-memory database only, after
    // proving the real trigger rejects it. Restore the trigger before reads.
    await db.database.exec('ALTER TABLE schema4_history.source_rows DISABLE TRIGGER immutable_rows');
    try {
      await db.database.query("UPDATE schema4_history.source_rows SET cells='[]'::jsonb WHERE tab='TaskCompletions' AND row_number=6");
    } finally { await db.database.exec('ALTER TABLE schema4_history.source_rows ENABLE TRIGGER immutable_rows'); }
    await expect(readSchema4CompletionHistory(read)).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
    await expect(importSchema4CompletionHistory(input)).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
    await expect(replaySchema4CompletionHistory({ ...read, rowNumber: 6 })).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
  } finally { await db.close(); }
}, 30_000);
