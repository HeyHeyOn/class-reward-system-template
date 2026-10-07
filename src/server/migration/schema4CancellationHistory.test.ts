import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { cancelTransaction, getTransactions, type SheetsStore } from '@/server/sheetsRepository';
import { inspectSchema4CancellationHistory, importSchema4CancellationHistory, readSchema4CancellationHistory,
  replaySchema4CancellationHistory } from './schema4CancellationHistory';
import { syntheticCancellationGrid, cancellationGridWire, setCancellationCell } from '../../../test-support/schema4CancellationHistory.fixture';
vi.mock('server-only', () => ({}));
const intent = 'OFFLINE_INSPECTION' as const;
const inspect = (t = syntheticCancellationGrid()) => inspectSchema4CancellationHistory(cancellationGridWire(t));
const change = (t: Record<string, string[][]>, row: number, key: string, value: string) => setCancellationCell(t, 'Transactions', row, key, value);

describe('A06 coordinate-bounded checkout cancellation history', () => {
  it('retains two original/reversal pairs without inventing operation authority or pre-cancel stock', () => {
    const result = inspect();
    expect(result.authority).toBe('OFFLINE_NONAUTHORITY');
    expect(result.rows.map(r => [r.rowNumber, r.consistency])).toEqual([3, 4, 5, 6].map(n => [n, 'CHECKOUT_CANCELLATION_WRITER_MATCH']));
    expect(result.pairs.map(p => [p.originalRow, p.reversalRow, p.balanceDelta, p.stockDeltas])).toEqual([
      [3, 5, 6, [{ itemIndex: 0, quantity: 2 }]], [4, 6, 6, [{ itemIndex: 0, quantity: 2 }]],
    ]);
    expect(result.pairs.every(p => p.stockAuthority === 'DERIVED_ONLY_NOT_OBSERVED')).toBe(true);
    expect(result.rows.every(r => r.diagnosticCodes.includes('UNPROVEN_CANCELLATION_AUTHORITY'))).toBe(true);
    expect(result.operationalBridge.status).toBe('BLOCKED');
    expect(JSON.stringify(result)).not.toContain('opaque-one');
    expect(JSON.stringify(result)).not.toContain('Synthetic Person');
  });
  it.each([
    ['wrong link', (t: Record<string, string[][]>) => change(t, 5, 'operator', 'cancel:unknown')],
    ['task cancel prefix', (t: Record<string, string[][]>) => change(t, 5, 'operator', 'cancel-task:synthetic-checkout-one')],
    ['duplicate original', (t: Record<string, string[][]>) => t.Transactions.push([...t.Transactions[2]])],
    ['duplicate reversal', (t: Record<string, string[][]>) => t.Transactions.push([...t.Transactions[4]])],
    ['trim collision', (t: Record<string, string[][]>) => { t.Transactions.push([...t.Transactions[2]]); change(t, 7, 'transactionId', ' synthetic-checkout-one '); }],
    ['second link other status', (t: Record<string, string[][]>) => { t.Transactions.push([...t.Transactions[4]]); change(t, 7, 'transactionId', 'other'); change(t, 7, 'status', 'COMPLETED'); }],
    ['same reversal ID elsewhere', (t: Record<string, string[][]>) => { t.Transactions.push([...t.Transactions[4]]); change(t, 7, 'operator', 'unrelated'); }],
    ['missing row', (t: Record<string, string[][]>) => t.Transactions.splice(4, 1)],
    ['not cancelled', (t: Record<string, string[][]>) => change(t, 3, 'status', 'COMPLETED')],
    ['wrong original kind', (t: Record<string, string[][]>) => change(t, 3, 'operator', 'bank')],
    ['same timestamp', (t: Record<string, string[][]>) => change(t, 5, 'timestamp', '2026-01-01T02:00:00.000Z')],
    ['wrong student', (t: Record<string, string[][]>) => change(t, 5, 'studentId', 'synthetic-other')],
    ['wrong name', (t: Record<string, string[][]>) => change(t, 5, 'studentName', 'Synthetic Other')],
    ['wrong total', (t: Record<string, string[][]>) => change(t, 5, 'totalAmount', '-7')],
    ['wrong balance', (t: Record<string, string[][]>) => change(t, 5, 'balanceAfter', '27')],
    ['unsafe integer', (t: Record<string, string[][]>) => change(t, 3, 'balanceBefore', '9007199254740992')],
    ['coercible integer', (t: Record<string, string[][]>) => change(t, 3, 'totalAmount', '06')],
    ['empty reversal item', (t: Record<string, string[][]>) => change(t, 5, 'items', '[]')],
    ['wrong reversal item', (t: Record<string, string[][]>) => change(t, 5, 'items', JSON.stringify([{ productId: 'wrong', name: '거래 취소', price: -6, quantity: 1, subtotal: -6 }]))],
    ['broken snapshot', (t: Record<string, string[][]>) => { const items = JSON.parse(t.Transactions[2][4]); items[0].totalQuantity = 3; change(t, 3, 'items', JSON.stringify(items)); }],
    ['not a checkout snapshot', (t: Record<string, string[][]>) => change(t, 3, 'items', JSON.stringify([{ productId: 'synthetic-product', name: 'Synthetic Product', price: 6, quantity: 1, subtotal: 6 }]))],
  ])('keeps malformed pair diagnostic and refuses SQL: %s', async (_label, mutate) => {
    const t = syntheticCancellationGrid(); mutate(t);
    const result = inspect(t);
    expect(result.rows.some(r => r.consistency === 'UNPROVEN')).toBe(true);
    const runTransaction = vi.fn();
    await expect(importSchema4CancellationHistory({ tenantId: 'synthetic', gridJson: cancellationGridWire(t), intent, runTransaction }))
      .rejects.toThrow('CANCELLATION_HISTORY_SLICE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it.each(['OPERATIONAL_READER', 'OPERATIONAL_IMPORT', undefined, 'unknown'])('blocks non-inspection intent before runner: %s', async value => {
    const runTransaction = vi.fn();
    const base = { tenantId: 'synthetic', gridJson: cancellationGridWire(syntheticCancellationGrid()), sourceDigest: '', intent: value as typeof intent, runTransaction };
    await expect(importSchema4CancellationHistory(base)).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    await expect(readSchema4CancellationHistory(base)).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    await expect(replaySchema4CancellationHistory({ ...base, originalRow: 3, reversalRow: 5 })).rejects.toThrow('SCHEMA4_OPERATIONAL_BRIDGE_BLOCKED');
    expect(runTransaction).not.toHaveBeenCalled();
  });
  it('actual Sheets writer restores snapshot totalQuantity once; reader and operation retry agree', async () => {
    const t = syntheticCancellationGrid(); t.Transactions.splice(4);
    change(t, 3, 'status', 'COMPLETED'); change(t, 4, 'status', 'COMPLETED');
    t.Products = [['productId', 'name', 'price', 'stock', 'isActive', 'sortOrder'], ['synthetic-product', 'Synthetic Product', '3', '5', 'TRUE', '1']];
    t.Students[1][2] = '20';
    let writes = 0;
    const store = { getRows: async (name: string) => t[name] ?? [],
      applyAtomicMutation: async (mutation: Parameters<NonNullable<SheetsStore['applyAtomicMutation']>>[0]) => {
        writes++;
        for (const u of mutation.updates) t[u.sheetName][u.rowNumber - 1][u.columnNumber - 1] = String(u.value);
        for (const a of mutation.appends) t[a.sheetName].push(a.values.map(String));
      } } as SheetsStore;
    const op1 = 'synthetic-operation-one', op2 = 'synthetic-operation-two';
    const first = await cancelTransaction(store, 'synthetic-checkout-one', op1);
    await cancelTransaction(store, 'synthetic-checkout-two', op2);
    expect(await cancelTransaction(store, 'synthetic-checkout-one', op1)).toEqual(first);
    expect(writes).toBe(2); expect(t.Products[1][3]).toBe('9'); expect(t.Students[1][2]).toBe('32');
    expect(inspect(t).pairs).toHaveLength(2);
    const transactions = await getTransactions(store);
    expect(transactions.find(r => r.transactionId === 'synthetic-checkout-one')?.cancelledAt).toBe(first.reversalTransaction.timestamp);
    await expect(cancelTransaction(store, 'synthetic-checkout-one', 'another')).rejects.toThrow();
    expect(writes).toBe(2);
  });
});

describe('isolated PGlite cancellation history', () => {
  let db: Awaited<ReturnType<typeof createPgliteDatabaseHarness>>;
  beforeEach(async () => { db = await createPgliteDatabaseHarness(); });
  afterEach(async () => { await db?.close(); });

  it('proves exact raw readback, rollback, lost acknowledgement, replay and tenant isolation', async () => {
    await db.database.exec(readFileSync('test-support/schema4-bank-history.sql', 'utf8'));
    const gridJson = cancellationGridWire(syntheticCancellationGrid());
    const input = { tenantId: db.tenantOneId, gridJson, intent, runTransaction: db.runTenantTransaction };
    await expect(importSchema4CancellationHistory({ ...input, runTransaction: (tenant, callback) => db.runTenantTransaction(tenant, async tx => {
      await callback(tx); throw new Error('A06_ROLLBACK');
    }) })).rejects.toThrow('A06_ROLLBACK');
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.source_rows')).rows).toEqual([{ n: 0 }]);
    const first = await importSchema4CancellationHistory(input);
    expect(await importSchema4CancellationHistory(input)).toEqual(first);
    await expect(importSchema4CancellationHistory({ ...input, runTransaction: async (tenant, cb) => {
      await db.runTenantTransaction(tenant, cb); throw new Error('A06_LOST_RESPONSE');
    } })).rejects.toThrow('A06_LOST_RESPONSE');
    expect(await importSchema4CancellationHistory(input)).toEqual(first);
    const read = { ...input, sourceDigest: first.sourceDigest };
    const result = await readSchema4CancellationHistory(read);
    expect(result.cancellationHistory).toEqual(inspect());
    expect(result.observation.plan.sources.filter(r => r.tab === 'Transactions').map(r => r.cells)).toEqual(syntheticCancellationGrid().Transactions);
    expect((await db.database.query('SELECT count(*)::int n FROM schema4_history.captures')).rows).toEqual([{ n: 1 }]);
    expect((await db.database.query("SELECT count(*)::int n FROM schema4_history.source_rows WHERE tab='Transactions'")).rows).toEqual([{ n: 6 }]);
    expect((await db.database.query('SELECT count(*)::int n FROM operations')).rows).toEqual([{ n: 0 }]);
    expect(await replaySchema4CancellationHistory({ ...read, originalRow: 3, reversalRow: 5 })).toMatchObject({
      changed: false, balanceToApply: 0, stockToApply: 0, currentStateAuthority: 'BLOCKED',
    });
    await expect(replaySchema4CancellationHistory({ ...read, originalRow: 3, reversalRow: 6 })).rejects.toThrow('CANCELLATION_REPLAY_UNPROVEN');
    await expect(readSchema4CancellationHistory({ ...read, tenantId: db.tenantTwoId })).rejects.toThrow('BANK_HISTORY_NOT_FOUND');
    // Unexpected INSERTs must be detected, not healed by an ON CONFLICT retry.
    await db.database.query("INSERT INTO schema4_history.source_rows VALUES ($1,$2,'Transactions',99,$3,'[]')", [db.tenantOneId, first.sourceDigest, 'a'.repeat(64)]);
    await expect(readSchema4CancellationHistory(read)).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
    await expect(importSchema4CancellationHistory(input)).rejects.toThrow('BANK_HISTORY_SOURCE_CONFLICT');
  });
});
