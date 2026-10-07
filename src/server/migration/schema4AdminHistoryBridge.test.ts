import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { resetTaskCompletionsBatch } from '@/server/sheetsRepository';
import { projectTaskCycleStateFromSnapshot } from '@/server/repositories/sheets/taskCycleQueries';
import { syntheticAdminGrid, adminGridWire, setAdminCell, syntheticTask, syntheticResetOperation } from '../../../test-support/schema4AdminHistory.fixture';
import { importSchema4BankHistory, replaySchema4BankReward } from './schema4BankHistory';
import { inspectSchema4AdminHistory, readSchema4AdminHistory } from './schema4AdminHistoryBridge';
vi.mock('server-only', () => ({}));
afterEach(() => vi.useRealTimers());

it('recognizes bounded writer consistency without declaring administrator authority or changing A04 provenance', () => {
  const report = inspectSchema4AdminHistory(adminGridWire(syntheticAdminGrid()));
  expect(report.authority).toBe('OFFLINE_NONAUTHORITY');
  expect(report.resets).toEqual([expect.objectContaining({ rowNumber: 5,
    consistency: 'SINGLE_BANK_RESET_WRITER_MATCH', authority: 'UNPROVEN_ADMIN_RESET_OPERATION',
    anchor: { assignmentRow: 2, checkpointRows: [2, 3, 4], transactionRow: 2 },
    diagnosticCodes: ['MISSING_ADMIN_OPERATION_PROVENANCE'] })]);
  expect(Object.values(report.resets[0].facts).every(Boolean)).toBe(true);
  expect(report.legacyDiagnostics).toContainEqual({ code: 'UNPROVEN_ADMIN_RESET_OPERATION', tab: 'TaskCompletions', rowNumber: 5 });
  expect(report.operationalBridge).toEqual({ status: 'BLOCKED', readerConnected: false, importerConnected: false,
    reasons: ['OFFLINE_NONAUTHORITY', 'MISSING_ADMIN_OPERATION_PROVENANCE', 'NO_SCHEMA4_OPERATIONAL_ADAPTER'] });
});

it.each([
  ['completionId', 'synthetic-forgery', 'ADMIN_RESET_ID_UNPROVEN'],
  ['operationPayloadHash', `sha256:${'b'.repeat(64)}`, 'ADMIN_RESET_PAYLOAD_SCOPE_UNPROVEN'],
  ['timestamp', '2026-01-01T02:00:00.000Z', 'ADMIN_RESET_TIMESTAMP_REUSE_UNPROVEN'],
  ['assignmentId', 'other', 'ADMIN_RESET_BANK_ANCHOR_UNPROVEN'],
  ['reward', '1', 'ADMIN_RESET_ZERO_EFFECT_UNPROVEN'],
  ['balanceBefore', '14', 'ADMIN_RESET_ZERO_EFFECT_UNPROVEN'],
  ['note', 'admin-completion-reset', 'ADMIN_RESET_BATCH_SHAPE_UNPROVEN'],
  ['schemaVersion', '1', 'ADMIN_RESET_BATCH_SHAPE_UNPROVEN'],
  ['studentName', 'Other synthetic person', 'ADMIN_RESET_BANK_ANCHOR_UNPROVEN'],
  ['evidenceProvider', 'PADLET', 'ADMIN_RESET_BATCH_SHAPE_UNPROVEN'],
])('quarantines a nonmatching %s without hiding its raw source row', (key, value, code) => {
  const t = syntheticAdminGrid(); setAdminCell(t, 'TaskCompletions', 5, key, value);
  const r = inspectSchema4AdminHistory(adminGridWire(t)).resets[0];
  expect(r.consistency).toBe('UNPROVEN');
  expect(r.diagnosticCodes).toContain(code);
  expect(r.authority).toBe('UNPROVEN_ADMIN_RESET_OPERATION');
});

it.each(['duplicate reset', 'other-kind operation reuse', 'zero marker collision', 'reset before SUCCESS', 'competing assignment', 'intervening reset'])('refuses ambiguous %s', fault => {
  const t = syntheticAdminGrid();
  if (fault === 'duplicate reset') t.TaskCompletions.push([...t.TaskCompletions[4]]);
  if (fault === 'other-kind operation reuse') {
    t.TaskCompletions.push([...t.TaskCompletions[4]]); setAdminCell(t, 'TaskCompletions', 6, 'source', 'ADMIN');
  }
  if (fault === 'zero marker collision') t.Settings.push([`taskResetOperation:${createHash('sha256').update(syntheticResetOperation).digest('hex')}`, '{}']);
  if (fault === 'reset before SUCCESS') [t.TaskCompletions[3], t.TaskCompletions[4]] = [t.TaskCompletions[4], t.TaskCompletions[3]];
  if (fault === 'competing assignment') {
    t.TaskAssignments.push([...t.TaskAssignments[1]]); setAdminCell(t, 'TaskAssignments', 3, 'assignmentId', 'later-assignment');
  }
  if (fault === 'intervening reset') {
    t.TaskCompletions.splice(4, 0, [...t.TaskCompletions[4]]);
    setAdminCell(t, 'TaskCompletions', 5, 'operationId', 'other-reset');
    setAdminCell(t, 'TaskCompletions', 5, 'completionId', 'other-reset-id');
  }
  const report = inspectSchema4AdminHistory(adminGridWire(t));
  expect(report.resets.every(r => r.consistency === 'UNPROVEN')).toBe(true);
  expect(report.operationalBridge.status).toBe('BLOCKED');
});

it('actual Sheets writer reproduces same-time physical reset and exact retry without balance/ledger writes', async () => {
  const t = syntheticAdminGrid(); const expected = [...t.TaskCompletions.pop()!];
  const write = vi.fn();
  const appendRows = vi.fn(async (tab: string, rows: string[][]) => { t[tab].push(...rows.map(row => [...row])); });
  const store = { getRows: async (tab: string) => t[tab].map(row => [...row]),
    getRowsFresh: async (tab: string) => t[tab].map(row => [...row]), appendRows,
    lookupSheet: async (tab: string) => ({ found: true, info: { sheetId: 1, title: tab, columnCount: t[tab][0].length } }),
    updateCell: write, appendRow: write, deleteRows: write };
  const ledger = JSON.stringify(t.Transactions), students = JSON.stringify(t.Students);
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
  const first = await resetTaskCompletionsBatch(store as never, [syntheticTask.taskId], { operationId: syntheticResetOperation });
  vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
  expect(await resetTaskCompletionsBatch(store as never, [syntheticTask.taskId], { operationId: syntheticResetOperation })).toEqual(first);
  expect(t.TaskCompletions.at(-1)).toEqual(expected);
  expect(appendRows).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled();
  expect(JSON.stringify(t.Transactions)).toBe(ledger); expect(JSON.stringify(t.Students)).toBe(students);
  expect(inspectSchema4AdminHistory(adminGridWire(t)).resets[0].consistency).toBe('SINGLE_BANK_RESET_WRITER_MATCH');
});

describe('explicit nonauthority bridge admission', () => {
  it.each(['OPERATIONAL_READER', 'OPERATIONAL_IMPORT', undefined, 'READY_FOR_IMPORT'])('rejects %s before calling any runner', async intent => {
    const runTransaction = vi.fn();
    await expect(readSchema4AdminHistory({ tenantId: 'ignored', sourceDigest: 'ignored', runTransaction,
      intent: intent as 'OFFLINE_INSPECTION' })).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
});

it('derives the reset from immutable PG rows; rollback/lost response/retry retain one reward and an observed incomplete state', async () => {
  const db = await createPgliteDatabaseHarness();
  try {
    await db.database.exec(await readFile('test-support/schema4-bank-history.sql', 'utf8'));
    const gridJson = adminGridWire(syntheticAdminGrid());
    const input = { tenantId: db.tenantOneId, gridJson, runTransaction: db.runTenantTransaction };
    await expect(importSchema4BankHistory({ ...input, runTransaction: (tenant, callback) => db.runTenantTransaction(tenant, async tx => {
      await callback(tx); throw new Error('A05_ROLLBACK');
    }) })).rejects.toThrow('A05_ROLLBACK');
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.source_rows')).rows).toEqual([{ n: 0 }]);
    const imported = await importSchema4BankHistory(input);
    await expect(importSchema4BankHistory({ ...input, runTransaction: async (tenant, callback) => {
      await db.runTenantTransaction(tenant, callback); throw new Error('A05_LOST_RESPONSE');
    } })).rejects.toThrow('A05_LOST_RESPONSE');
    expect(await importSchema4BankHistory(input)).toEqual(imported);
    const read = { tenantId: db.tenantOneId, sourceDigest: imported.sourceDigest, runTransaction: db.runTenantTransaction,
      intent: 'OFFLINE_INSPECTION' as const };
    const observed = await readSchema4AdminHistory(read);
    expect(observed.adminHistory).toEqual(inspectSchema4AdminHistory(gridJson));
    expect(observed.observation.snapshot.completions.map(r => r.status)).toEqual(['PENDING', 'BALANCE_APPLIED', 'SUCCESS', 'RESET']);
    expect(projectTaskCycleStateFromSnapshot(syntheticTask, '2026-02-01T00:00:00.000Z', observed.observation.snapshot)
      .students['synthetic-student']).toMatchObject({ assigned: true, completed: false });
    const g = observed.observation.plan.groups[0];
    expect(replaySchema4BankReward(observed.observation.plan, g.operationId, g.operationPayloadHash).rewardToApply).toBe(0);
    expect(await readSchema4AdminHistory(read)).toEqual(observed);
    await expect(readSchema4AdminHistory({ ...read, tenantId: db.tenantTwoId })).rejects.toThrow('BANK_HISTORY_NOT_FOUND');
    await expect(readSchema4AdminHistory({ ...read, sourceDigest: '0'.repeat(64) })).rejects.toThrow('BANK_HISTORY_NOT_FOUND');
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.reward_ledger')).rows).toEqual([{ n: 1 }]);
    expect((await db.database.query('SELECT count(*)::int n FROM operations')).rows).toEqual([{ n: 0 }]);
  } finally { await db.close(); }
});
