import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { bulkAdjustStudentBalances, getTransactions, type SheetsStore } from '@/server/sheetsRepository';
import { inspectSchema4AdjustmentHistory, importSchema4AdjustmentHistory, readSchema4AdjustmentHistory,
  replaySchema4AdjustmentHistory } from './schema4AdjustmentHistory';
import { syntheticAdjustmentGrid, adjustmentGridWire, setAdjustmentCell, adjustmentOperations,
  adjustmentCommands } from '../../../test-support/schema4AdjustmentHistory.fixture';
vi.mock('server-only', () => ({}));
const intent = 'OFFLINE_INSPECTION' as const;
type Tables = Record<string, string[][]>;
const inspect = (t = syntheticAdjustmentGrid()) => inspectSchema4AdjustmentHistory(adjustmentGridWire(t));
const change = (t: Tables, row: number, key: string, value: string) => setAdjustmentCell(t, 'Transactions', row, key, value);

describe('A07 coordinate-bounded single-target adjustment history', () => {
  it('recognizes four writer-consistent rows, not authenticated operations, linked reversals or claims', () => {
    const result = inspect();
    expect(result.authority).toBe('OFFLINE_NONAUTHORITY');
    expect(result.rows.map(r => [r.rowNumber, r.mode, r.predecessorRow, r.consistency])).toEqual([
      [7, 'subtract', 6, 'BULK_ADJUSTMENT_WRITER_MATCH'], [8, 'add', 7, 'BULK_ADJUSTMENT_WRITER_MATCH'],
      [9, 'add', 8, 'BULK_ADJUSTMENT_WRITER_MATCH'], [10, 'subtract', 9, 'BULK_ADJUSTMENT_WRITER_MATCH'],
    ]);
    expect(result.rows.every(r => Object.values(r.facts).every(Boolean) && r.priorTransactionLink === 'NONE'
      && r.claimAuthority === 'UNOBSERVED' && r.diagnosticCodes.includes('UNPROVEN_ADJUSTMENT_AUTHORITY')
      && r.diagnosticCodes.includes('MISSING_ADJUSTMENTS_COUNTERPART'))).toBe(true);
    expect(result.operationalBridge).toEqual({ status: 'BLOCKED', readerConnected: false, importerConnected: false });
    const text = JSON.stringify(result);
    for (const privateValue of ['synthetic-student', 'Synthetic Person', ...adjustmentOperations]) expect(text).not.toContain(privateValue);
  });
  it.each([
    ['missing row', (t: Tables) => t.Transactions.pop()],
    ['duplicate id', (t: Tables) => t.Transactions.push([...t.Transactions[6]])],
    ['trim collision', (t: Tables) => { t.Transactions.push([...t.Transactions[6]]); change(t, 11, 'transactionId', ` ${t.Transactions[6][0]} `); }],
    ['operation residue', (t: Tables) => { t.Transactions.push([...t.Transactions[6]]); change(t, 11, 'transactionId', `ADMIN-${adjustmentOperations[0]}-bad-bad`); change(t, 11, 'status', 'UNKNOWN'); }],
    ['different payload', (t: Tables) => change(t, 7, 'transactionId', t.Transactions[6][0].replace(/-[a-f0-9]{64}-/, `-${'0'.repeat(64)}-`))],
    ['different student suffix', (t: Tables) => change(t, 7, 'transactionId', t.Transactions[6][0].slice(0, -12) + '0'.repeat(12))],
    ['noncanonical operation UUID', (t: Tables) => change(t, 7, 'transactionId', t.Transactions[6][0].replace('-4000-', '-0000-'))],
    ['list-save is out of scope', (t: Tables) => change(t, 7, 'transactionId', t.Transactions[6][0].replace('ADMIN-', 'ADMIN-LIST-'))],
    ['wrong student', (t: Tables) => change(t, 7, 'studentId', 'synthetic-other')],

    ['wrong operator', (t: Tables) => change(t, 7, 'operator', 'bank')],
    ['wrong status', (t: Tables) => change(t, 7, 'status', 'CANCELLED')],
    ['wrong signed total', (t: Tables) => change(t, 7, 'totalAmount', '-40')],
    ['wrong balance', (t: Tables) => change(t, 7, 'balanceAfter', '8')],
    ['unsafe integer', (t: Tables) => change(t, 7, 'balanceBefore', '9007199254740992')],
    ['noncanonical integer', (t: Tables) => change(t, 7, 'totalAmount', '040')],
    ['unknown item key', (t: Tables) => { const items = JSON.parse(t.Transactions[6][4]); items[0].extra = true; change(t, 7, 'items', JSON.stringify(items)); }],
    ['bad quantity', (t: Tables) => { const items = JSON.parse(t.Transactions[6][4]); items[0].quantity = 2; change(t, 7, 'items', JSON.stringify(items)); }],
    ['wrong label', (t: Tables) => { const items = JSON.parse(t.Transactions[6][4]); items[0].name = '관리자 지급'; change(t, 7, 'items', JSON.stringify(items)); }],
    ['malformed JSON', (t: Tables) => change(t, 7, 'items', '{')],
    ['SET is out of scope', (t: Tables) => { const items = JSON.parse(t.Transactions[6][4]); items[0].productId = 'ADMIN-SET'; items[0].name = '관리자 잔액 지정'; change(t, 7, 'items', JSON.stringify(items)); }],
    ['same timestamp', (t: Tables) => change(t, 8, 'timestamp', t.Transactions[6][1])],
    ['reordered physical rows', (t: Tables) => { [t.Transactions[6], t.Transactions[7]] = [t.Transactions[7], t.Transactions[6]]; }],
    ['broken predecessor continuity', (t: Tables) => change(t, 6, 'balanceAfter', '31')],
    ['incoming cancellation', (t: Tables) => { t.Transactions.push([...t.Transactions[4]]); change(t, 11, 'operator', `cancel:${t.Transactions[6][0]}`); }],
    ['unexpected adjustment counterpart', (t: Tables) => t.Adjustments.push(['synthetic-adjustment', '', '', '', '', ''])],
    ['missing counterpart header', (t: Tables) => { delete t.Adjustments; }],
  ])('fails closed without SQL for %s', async (_label, mutate) => {
    const t = syntheticAdjustmentGrid(); mutate(t);
    expect(inspect(t).rows.some(r => r.consistency === 'UNPROVEN')).toBe(true);
    const runTransaction = vi.fn();
    await expect(importSchema4AdjustmentHistory({ tenantId: 'synthetic', gridJson: adjustmentGridWire(t), intent, runTransaction }))
      .rejects.toThrow('ADJUSTMENT_HISTORY_SLICE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it('preserves a changed display-name snapshot between independent operations without inventing identity links', () => {
    const t = syntheticAdjustmentGrid();
    change(t, 9, 'studentName', 'Synthetic Renamed'); change(t, 10, 'studentName', 'Synthetic Renamed');
    const result = inspect(t);
    expect(result.rows.every(r => r.consistency === 'BULK_ADJUSTMENT_WRITER_MATCH')).toBe(true);
    expect(result.rows.map(r => r.predecessorNameMatches)).toEqual([true, true, false, true]);
    expect(result.rows[2].diagnosticCodes).toContain('ADJUSTMENT_NAME_SNAPSHOT_CHANGED');
    expect(result.authority).toBe('OFFLINE_NONAUTHORITY');
    expect(result.operationalBridge.status).toBe('BLOCKED');
  });
  it.each(['OPERATIONAL_READER', 'OPERATIONAL_IMPORT', undefined, 'unknown'])('rejects non-inspection intent before SQL: %s', async value => {
    const runTransaction = vi.fn();
    const input = { tenantId: 'synthetic', gridJson: '', sourceDigest: '', intent: value as typeof intent, runTransaction };
    await expect(importSchema4AdjustmentHistory(input)).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    await expect(readSchema4AdjustmentHistory(input)).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    await expect(replaySchema4AdjustmentHistory({ ...input, rowNumber: 7 })).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it('actual local Sheets writer matches every byte, retries immediately without writes, and reader sorts newest first', async () => {
    const expected = syntheticAdjustmentGrid(), t = syntheticAdjustmentGrid(); t.Transactions.splice(6); t.Students[1][2] = '32';
    let writes = 0;
    const store = { getRows: async (name: string) => t[name] ?? [],
      applyAtomicMutation: async (mutation: Parameters<NonNullable<SheetsStore['applyAtomicMutation']>>[0]) => {
        writes++;
        expect(mutation.uniqueClaim).toBeUndefined(); expect(mutation.uniqueClaims).toBeUndefined();
        for (const u of mutation.updates) t[u.sheetName][u.rowNumber - 1][u.columnNumber - 1] = String(u.value);
        for (const a of mutation.appends) t[a.sheetName].push(a.values.map(String));
      } } as SheetsStore;
    vi.useFakeTimers();
    try {
      for (const [index, command] of adjustmentCommands.entries()) {
        vi.setSystemTime(new Date(expected.Transactions[index + 6][1]));
        const input = { ...command, studentIds: ['synthetic-student'], operationId: adjustmentOperations[index] };
        const first = await bulkAdjustStudentBalances(store, input);
        expect(await bulkAdjustStudentBalances(store, input)).toEqual(first);
        expect(writes).toBe(index + 1);
      }
      expect(t.Transactions).toEqual(expected.Transactions);
      expect(inspect(t).rows.every(r => r.consistency === 'BULK_ADJUSTMENT_WRITER_MATCH')).toBe(true);
      const read = await getTransactions(store);
      expect(read.slice(0, 4).map(r => r.transactionId)).toEqual(expected.Transactions.slice(6).reverse().map(r => r[0]));
      // Historical recognition must not be confused with the writer's current-balance replay gate.
      await expect(bulkAdjustStudentBalances(store, { ...adjustmentCommands[0], studentIds: ['synthetic-student'], operationId: adjustmentOperations[0] })).rejects.toThrow();
      expect(writes).toBe(4); expect(t.Adjustments).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });
});

it('A07 isolated SQL rollback/retry/lost-response/raw readback/replay/tenant/tamper gates', async () => {
  const db = await createPgliteDatabaseHarness();
  try {
    await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
    const t = syntheticAdjustmentGrid(), gridJson = adjustmentGridWire(t);
    const input = { tenantId: db.tenantOneId, gridJson, intent, runTransaction: db.runTenantTransaction };
    const count = async () => (await db.database.query<{ n: number }>(`SELECT ((SELECT count(*) FROM schema4_history.captures)
      + (SELECT count(*) FROM schema4_history.source_rows) + (SELECT count(*) FROM schema4_history.reward_groups))::int n`)).rows[0].n;
    await expect(importSchema4AdjustmentHistory({ ...input, runTransaction: (tenant, cb) => db.runTenantTransaction(tenant, async tx => {
      await cb(tx); throw new Error('A07_ROLLBACK');
    }) })).rejects.toThrow('A07_ROLLBACK');
    expect(await count()).toBe(0);
    const first = await importSchema4AdjustmentHistory(input);
    expect(await importSchema4AdjustmentHistory(input)).toEqual(first);
    await expect(importSchema4AdjustmentHistory({ ...input, runTransaction: async (tenant, cb) => {
      await db.runTenantTransaction(tenant, cb); throw new Error('A07_LOST_RESPONSE');
    } })).rejects.toThrow('A07_LOST_RESPONSE');
    expect(await importSchema4AdjustmentHistory(input)).toEqual(first);
    const read = { ...input, sourceDigest: first.sourceDigest }, stored = await readSchema4AdjustmentHistory(read);
    expect(stored.adjustmentHistory).toEqual(inspect(t));
    expect(stored.observation.plan.sources.filter(r => r.tab === 'Transactions').map(r => r.cells)).toEqual(t.Transactions);
    expect((await db.database.query('SELECT grid_json FROM schema4_history.captures')).rows).toEqual([{ grid_json: gridJson }]);
    const before = await count();
    for (const rowNumber of [7, 8, 9, 10]) for (let attempt = 0; attempt < 2; attempt++) {
      expect(await replaySchema4AdjustmentHistory({ ...read, rowNumber })).toMatchObject({
        rowNumber, authority: 'OFFLINE_NONAUTHORITY', changed: false, balanceToApply: 0, stockToApply: 0,
        rewardToApply: 0, claimPublished: false, currentStateAuthority: 'BLOCKED',
      });
    }
    expect(await count()).toBe(before);
    await expect(replaySchema4AdjustmentHistory({ ...read, rowNumber: 6 })).rejects.toThrow('ADJUSTMENT_REPLAY_UNPROVEN');
    await expect(readSchema4AdjustmentHistory({ ...read, tenantId: db.tenantTwoId })).rejects.toThrow('BANK_HISTORY_NOT_FOUND');
    const modern = await db.database.query(`SELECT ((SELECT count(*) FROM operations) + (SELECT count(*) FROM accounts)
      + (SELECT count(*) FROM transactions) + (SELECT count(*) FROM adjustments) + (SELECT count(*) FROM inventory_ledger)
      + (SELECT count(*) FROM task_completions))::int n`);
    expect(modern.rows).toEqual([{ n: 0 }]);
    await db.database.query("INSERT INTO schema4_history.source_rows VALUES ($1,$2,'Transactions',99,$3,'[]')", [db.tenantOneId, first.sourceDigest, 'a'.repeat(64)]);
    await expect(readSchema4AdjustmentHistory(read)).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
    await expect(importSchema4AdjustmentHistory(input)).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
    await expect(replaySchema4AdjustmentHistory({ ...read, rowNumber: 7 })).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
  } finally { await db.close(); }
});
