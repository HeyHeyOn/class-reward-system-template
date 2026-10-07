import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import {
  normalizeSchema4BankHistory, importSchema4BankHistory, readSchema4BankHistory,
  replaySchema4BankReward,
} from './schema4BankHistory';
vi.mock('server-only', () => ({}));

// Entirely synthetic contract adversaries, never copied private business values.
export function syntheticBankGrid() {
  const tuple = { taskId: 'synthetic-task', taskInstanceId: 'synthetic-instance', studentId: 'synthetic-student',
    cycleId: 'synthetic-cycle', cycleStartsAt: '2026-01-01T00:00:00.000Z', cycleEndsAt: '', ruleVersion: '1', timeZone: 'Asia/Seoul' };
  const event = { completionId: 'synthetic-logical-PENDING', timestamp: '2026-01-01T01:00:00.000Z',
    ...tuple, studentName: 'Synthetic Person', reward: '5', balanceBefore: '10', balanceAfter: '15', status: 'PENDING',
    note: 'bank-self-completion:pending', source: 'BANK', assignmentId: 'synthetic-assignment', schemaVersion: '2',
    operationId: 'legacy-operation-not-uuid', operationPayloadHash: `sha256:${'a'.repeat(64)}` };
  const table = (records: Record<string, string>[]) => {
    const headers = [...new Set(records.flatMap(row => Object.keys(row)))];
    return [headers, ...records.map(row => headers.map(key => row[key] ?? ''))];
  };
  const tables = {
    Settings: [['key', 'value'], ['schemaVersion', '4']],
    TaskAssignments: table([{ assignmentId: 'synthetic-assignment', ...tuple, status: 'ASSIGNED', source: 'LEGACY_SEED',
      previousAssignmentId: '', createdAt: '2026-01-01T00:00:00.000Z', schemaVersion: '2', note: '' }]),
    TaskCompletions: table([
      event,
      { ...event, completionId: 'synthetic-logical-BALANCE_APPLIED', status: 'BALANCE_APPLIED', note: 'bank-self-completion:balance_applied' },
      { ...event, completionId: 'synthetic-logical-SUCCESS', status: 'SUCCESS', note: 'bank-self-completion:success' },
      { ...event, completionId: 'synthetic-reset', source: 'ADMIN_RESET', status: 'RESET', reward: '0',
        balanceBefore: '15', note: 'admin-reset', operationId: 'reset-not-bank', operationPayloadHash: `sha256:${'b'.repeat(64)}` },
    ]),
    Transactions: table([{ transactionId: 'TASK-LOGICAL-synthetic-logical', timestamp: event.timestamp, studentId: tuple.studentId,
      studentName: event.studentName, items: JSON.stringify([{ productId: tuple.taskId, name: 'Synthetic Task', price: -5, quantity: 1, subtotal: -5 }]),
      totalAmount: '-5', balanceBefore: '10', balanceAfter: '15', status: 'TASK_REWARD', operator: 'bank' }]),
  };
  return tables;
}
export function gridWire(tables: Record<string, string[][]>): string {
  return JSON.stringify({ spreadsheetId: 'synthetic-sheet', sheets: Object.entries(tables).map(([title, rows]) => ({
    properties: { title }, data: [{ rowData: rows.map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })) }],
  })) });
}
function change(tables: Record<string, string[][]>, tab: string, row: number, key: string, value: string) {
  tables[tab][row - 1][tables[tab][0].indexOf(key)] = value;
}

describe('schema4 historical BANK contract, not modern operation authority', () => {
  it('retains every checkpoint and later same-time reset; projects exactly one signed reward', () => {
    const wire = gridWire(syntheticBankGrid());
    const plan = normalizeSchema4BankHistory(wire);
    expect(plan.authority).toBe('OFFLINE_NONAUTHORITY');
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({ checkpointRows: [2, 3, 4], assignmentRow: 2, transactionRow: 2,
      laterResetRows: [5], reward: 5, signedTotal: -5, operationId: 'legacy-operation-not-uuid' });
    expect(plan.diagnostics).toContainEqual({ code: 'UNPROVEN_ADMIN_RESET_OPERATION', tab: 'TaskCompletions', rowNumber: 5 });
    expect(plan.sources.filter(row => row.tab === 'TaskCompletions').map(row => row.rowNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(plan).toEqual(normalizeSchema4BankHistory(wire));
  });
  it.each([
    ['missing checkpoint', (t: Record<string, string[][]>) => t.TaskCompletions.splice(2, 1)],
    ['duplicate checkpoint', (t: Record<string, string[][]>) => t.TaskCompletions.splice(2, 0, [...t.TaskCompletions[1]])],
    ['reordered checkpoint', (t: Record<string, string[][]>) => [t.TaskCompletions[1], t.TaskCompletions[2]] = [t.TaskCompletions[2], t.TaskCompletions[1]]],
    ['payload disagreement', (t: Record<string, string[][]>) => change(t, 'TaskCompletions', 3, 'operationPayloadHash', `sha256:${'b'.repeat(64)}`)],
    ['malformed payload', (t: Record<string, string[][]>) => t.TaskCompletions.slice(1, 4).forEach(r => r[t.TaskCompletions[0].indexOf('operationPayloadHash')] = 'A'.repeat(64))],
    ['unrelated SUCCESS ID', (t: Record<string, string[][]>) => change(t, 'TaskCompletions', 4, 'completionId', 'other-SUCCESS')],
    ['unknown event', (t: Record<string, string[][]>) => change(t, 'TaskCompletions', 3, 'status', 'ERROR')],
    ['tuple mismatch', (t: Record<string, string[][]>) => change(t, 'TaskCompletions', 4, 'cycleId', 'another-cycle')],
    ['operation reused outside BANK', (t: Record<string, string[][]>) => change(t, 'TaskCompletions', 5, 'operationId', 'legacy-operation-not-uuid')],
    ['missing assignment', (t: Record<string, string[][]>) => t.TaskAssignments.splice(1, 1)],
    ['admin assignment', (t: Record<string, string[][]>) => change(t, 'TaskAssignments', 2, 'source', 'ADMIN')],
    ['assignment chronology', (t: Record<string, string[][]>) => change(t, 'TaskAssignments', 2, 'createdAt', '2027-01-01T00:00:00.000Z')],
    ['ledger mismatch', (t: Record<string, string[][]>) => change(t, 'Transactions', 2, 'totalAmount', '-6')],
    ['missing ledger', (t: Record<string, string[][]>) => t.Transactions.splice(1, 1)],
    ['duplicate ledger', (t: Record<string, string[][]>) => t.Transactions.push([...t.Transactions[1]])],
  ])('does not publish an incomplete or conflicting group: %s', (_name, mutate) => {
    const tables = syntheticBankGrid(); mutate(tables);
    const plan = normalizeSchema4BankHistory(gridWire(tables));
    expect(plan.groups).toHaveLength(0);
    expect(plan.diagnostics.some(d => d.code.startsWith('BANK_'))).toBe(true);
    expect(plan.sources.filter(row => row.tab === 'TaskCompletions')).toHaveLength(tables.TaskCompletions.length);
  });
  it('refuses unknown workbook versions, credential tabs and ambiguous headers', () => {
    const t = syntheticBankGrid(); t.Settings[1][1] = '5';
    expect(() => normalizeSchema4BankHistory(gridWire(t))).toThrow();
    expect(() => normalizeSchema4BankHistory(gridWire({ ...syntheticBankGrid(), Recovery: [['secret']] }))).toThrow();
    const duplicate = syntheticBankGrid(); duplicate.TaskCompletions[0][1] = 'completionId';
    expect(() => normalizeSchema4BankHistory(gridWire(duplicate))).toThrow();
  });
  it('replays the historical reward without making a new operation or mistaking RESET for unpaid', () => {
    const plan = normalizeSchema4BankHistory(gridWire(syntheticBankGrid()));
    const group = plan.groups[0];
    expect(replaySchema4BankReward(plan, group.operationId, group.operationPayloadHash)).toEqual({
      kind: 'HISTORICAL_REWARD_ALREADY_RECORDED', changed: false, rewardToApply: 0, transactionRow: 2, successRow: 4,
      currentStateAuthority: 'BLOCKED',
    });
    expect(() => replaySchema4BankReward(plan, group.operationId, `sha256:${'c'.repeat(64)}`)).toThrow('BANK_REPLAY_CONFLICT');
    expect(() => replaySchema4BankReward(plan, 'unknown', group.operationPayloadHash)).toThrow('BANK_REPLAY_UNPROVEN');
  });
});

it('isolated PG retains immutable provenance, one ledger, rollback/retry, conflict and tenant boundaries', async () => {
  const db = await createPgliteDatabaseHarness();
  try {
    await db.database.exec(await readFile('test-support/schema4-bank-history.sql', 'utf8'));
    const gridJson = gridWire(syntheticBankGrid());
    const input = { tenantId: db.tenantOneId, gridJson, runTransaction: db.runTenantTransaction };
    // Inject failure at transaction boundary after all INSERTs, not a fake importer result.
    await expect(importSchema4BankHistory({ ...input, runTransaction: (tenant, callback) => db.runTenantTransaction(tenant, async tx => {
      await callback(tx); throw new Error('TEST_ROLLBACK');
    }) })).rejects.toThrow('TEST_ROLLBACK');
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.reward_groups')).rows).toEqual([{ n: 0 }]);
    const first = await importSchema4BankHistory(input);
    expect(await importSchema4BankHistory(input)).toEqual(first);
    await expect(importSchema4BankHistory({ ...input, runTransaction: async (tenant, callback) => {
      await db.runTenantTransaction(tenant, callback);
      throw new Error('COMMIT_RESPONSE_LOST');
    } })).rejects.toThrow('COMMIT_RESPONSE_LOST');
    expect(await importSchema4BankHistory(input)).toEqual(first);
    const stored = await readSchema4BankHistory({ tenantId: db.tenantOneId, sourceDigest: first.sourceDigest, runTransaction: db.runTenantTransaction });
    expect(stored.plan).toEqual(normalizeSchema4BankHistory(gridJson));
    expect(stored.snapshot.completions.map(row => row.status)).toEqual(['PENDING', 'BALANCE_APPLIED', 'SUCCESS', 'RESET']);
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.reward_ledger')).rows).toEqual([{ n: 1 }]);
    expect((await db.database.query('SELECT count(*)::int n FROM operations')).rows).toEqual([{ n: 0 }]);
    for (const table of ['captures', 'source_rows', 'reward_groups']) {
      await expect(db.database.exec(`DELETE FROM schema4_history.${table}`)).rejects.toThrow('SCHEMA4_HISTORY_IMMUTABLE');
      await expect(db.database.exec(`TRUNCATE schema4_history.${table} CASCADE`)).rejects.toThrow('SCHEMA4_HISTORY_IMMUTABLE');
    }
    await expect(db.database.exec('UPDATE schema4_history.reward_groups SET reward=6')).rejects.toThrow('SCHEMA4_HISTORY_IMMUTABLE');
    const conflicting = syntheticBankGrid(); change(conflicting, 'TaskCompletions', 5, 'note', 'different capture');
    await expect(importSchema4BankHistory({ ...input, gridJson: gridWire(conflicting) })).rejects.toThrow();
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.captures')).rows).toEqual([{ n: 1 }]);
    await expect(readSchema4BankHistory({ tenantId: db.tenantTwoId, sourceDigest: first.sourceDigest, runTransaction: db.runTenantTransaction })).rejects.toThrow('BANK_HISTORY_NOT_FOUND');
    await db.runTenantTransaction(db.tenantTwoId, async tx => {
      expect((await tx.execute(sql`SELECT * FROM schema4_history.reward_groups`)).rows).toHaveLength(0);
      expect((await tx.execute(sql`SELECT * FROM schema4_history.reward_ledger`)).rows).toHaveLength(0);
    });
    await importSchema4BankHistory({ ...input, tenantId: db.tenantTwoId });
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.reward_ledger')).rows).toEqual([{ n: 2 }]);
  } finally { await db.close(); }
});
