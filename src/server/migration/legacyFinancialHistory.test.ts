import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { inspectLegacyFinancialDiscrepancies, parseLegacyFinancialHistory } from './legacyFinancialHistory';
import { sha256 } from './validators';
vi.mock('server-only', () => ({}));
const headers = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];
const item = (price: number) => JSON.stringify([{ productId: 'P1', name: 'Historical item', price, quantity: 1, subtotal: price }]);
function fixture() {
  return {
    Settings: [['key', 'value'], ['schemaVersion', '4']],
    Students: [['studentId', 'name', 'balance', 'status'], ['S1', 'Student', '120', 'ACTIVE']],
    Transactions: [headers,
      ['T1', '2026-09-01T00:00:00.000Z', 'S1', 'Student', item(-20), '-20', '100', '120', 'TASK_REWARD', 'bank'],
      ['T2', '2026-09-01T00:01:00.000Z', 'S1', 'Student', item(20), '20', '120', '100', 'CANCELLED', 'kiosk'],
      ['T3', '2026-09-01T00:02:00.000Z', 'S1', 'Student', item(-20), '-20', '100', '120', 'CANCEL_REVERSAL', 'cancel:T2'],
    ],
  };
}
function grid(tabs: Record<string, string[][]>) {
  return JSON.stringify({ spreadsheetId: 'synthetic-source', sheets: Object.entries(tabs).map(([title, rows]) => ({
    properties: { title }, data: [{ rowData: rows.map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })) }],
  })) });
}
describe('legacy financial facts preserve historical rows without replay', () => {
  it('requires exact owner-reviewed exceptions while preserving recorded balances and every original row', () => {
    const tabs = fixture(); tabs.Transactions[2][6] = '121'; tabs.Transactions[2][7] = '101';
    tabs.Transactions.pop(); tabs.Students[1][2] = '101';
    const source = grid(tabs), report = inspectLegacyFinancialDiscrepancies(source);
    expect(Object.keys(report).sort()).toEqual(['discrepancies', 'sourceDigest']);
    expect(report.discrepancies.map(d => [d.code, d.amount])).toEqual([['BALANCE_CHAIN_GAP', 1], ['MISSING_REVERSAL', -20]]);
    const review = { policy: 'PRESERVE_RECORDED_BALANCES' as const, sourceIdentityDigest: sha256('synthetic-source'),
      approvedBySubjectDigest: sha256('owner'), approvalEvidenceDigest: sha256('explicit owner decision'), discrepancies: report.discrepancies };
    expect(() => parseLegacyFinancialHistory(source)).toThrow('LEGACY_FINANCIAL_REVIEW_REQUIRED');
    const result = parseLegacyFinancialHistory(source, review);
    expect(result.records.map(r => r.originalCells)).toEqual(tabs.Transactions.slice(1));
    expect(result.currentBalances).toEqual({ S1: 101 }); expect(result.review).toEqual(review);
    for (const changed of [{ ...review, sourceIdentityDigest: sha256('another-source') },
      { ...review, discrepancies: review.discrepancies.slice(1) },
      { ...review, discrepancies: review.discrepancies.map(d => ({ ...d, amount: d.amount + 1 })) },
      { ...review, unexpected: 'private data' }]) {
      expect(() => parseLegacyFinancialHistory(source, changed)).toThrow('LEGACY_FINANCIAL_REVIEW_REQUIRED');
    }
    tabs.Transactions[2][3] = 'changed source row';
    expect(() => parseLegacyFinancialHistory(grid(tabs), review)).toThrow('LEGACY_FINANCIAL_REVIEW_REQUIRED');
  });
  it('preserves signed rewards, cancellation links, exact source cells and current balances', () => {
    const tabs = fixture(); const source = grid(tabs); const result = parseLegacyFinancialHistory(source);
    expect(result.records).toHaveLength(3);
    expect(result.records.map(row => row.balanceDelta)).toEqual([20, -20, 20]);
    expect(result.records[2].reversesTransactionId).toBe('T2');
    expect(result.records.map(row => row.originalCells)).toEqual(tabs.Transactions.slice(1));
    expect(result.firstRecordedBalances).toEqual({ S1: 100 });
    expect(result.currentBalances).toEqual({ S1: 120 });
    expect(result.netRecordedDelta).toBe('20');
    expect(parseLegacyFinancialHistory(source)).toEqual(result);
  });
  it('does not invent an Adjustments counterpart or opening deposit for a recorded admin adjustment', () => {
    const tabs = fixture(); tabs.Transactions[1][8] = 'ADMIN_ADJUSTMENT'; tabs.Transactions[1][9] = 'admin';
    const result = parseLegacyFinancialHistory(grid(tabs));
    expect(result.records).toHaveLength(3);
    expect(result.records[0].transaction.status).toBe('ADMIN_ADJUSTMENT');
    expect(result.records[0]).not.toHaveProperty('operationId');
    expect(result.records[0]).not.toHaveProperty('adjustmentId');
  });
  it.each(['1', '2', '3', '4'])('preserves schema %s and its historical itemsJson header without rewriting source cells', schema => {
    const tabs = fixture(); tabs.Settings[1][1] = schema;
    tabs.Transactions[0] = [...headers]; tabs.Transactions[0][4] = 'itemsJson';
    const source = grid(tabs), result = parseLegacyFinancialHistory(source);
    expect(result.records.map(row => row.originalCells)).toEqual(tabs.Transactions.slice(1));
    expect(result.records[0].transaction.items).toEqual(JSON.parse(tabs.Transactions[1][4]));
    expect(result.currentBalances).toEqual({ S1: 120 });
  });
  it.each(['cancel-task:', 'cancel-task-unlinked:', 'cancel-task-pre-reset:'])('retains a signed task cancellation linked by %s', prefix => {
    const tabs = fixture(); tabs.Students[1][2] = '-15';
    tabs.Transactions = [headers,
      ['R1', '2026-09-01T00:00:00.000Z', 'S1', 'Student', item(-20), '-20', '0', '20', 'CANCELLED', 'bank'],
      ['A1', '2026-09-01T00:01:00.000Z', 'S1', 'Student', item(15), '15', '20', '5', 'ADMIN_ADJUSTMENT', 'admin'],
      ['R2', '2026-09-01T00:02:00.000Z', 'S1', 'Student', item(20), '20', '5', '-15', 'CANCEL_REVERSAL', `${prefix}R1`],
    ];
    const result = parseLegacyFinancialHistory(grid(tabs));
    expect(result.records[2].reversesTransactionId).toBe('R1');
    expect(result.records[2].transaction.operator).toBe(`${prefix}R1`);
    expect(result.currentBalances).toEqual({ S1: -15 });
  });
  it('rejects ambiguous transaction item columns', () => {
    const tabs = fixture(); tabs.Transactions[0] = [...headers, 'itemsJson'];
    expect(() => parseLegacyFinancialHistory(grid(tabs))).toThrow('LEGACY_FINANCIAL_HEADERS');
  });
  it.each(['duplicate', 'missing-peer', 'broken-chain', 'stale-balance', 'bad-item', 'unsupported-reversal'])('rejects %s before returning a usable plan', kind => {
    const tabs = fixture();
    if (kind === 'duplicate') tabs.Transactions[2][0] = 'T1';
    if (kind === 'missing-peer') tabs.Transactions.pop();
    if (kind === 'broken-chain') { tabs.Transactions[2][6] = '121'; tabs.Transactions[2][7] = '101'; }
    if (kind === 'stale-balance') tabs.Students[1][2] = '121';
    if (kind === 'bad-item') tabs.Transactions[1][4] = '[{}]';
    if (kind === 'unsupported-reversal') tabs.Transactions[3][9] = 'cancel-task:T2';
    expect(() => parseLegacyFinancialHistory(grid(tabs))).toThrow(/^LEGACY_FINANCIAL_/);
  });
});

it.skipIf(!process.env.CRS_PRIVATE_BASELINE)('parses the authorized private representative capture without publishing rows', async () => {
  const source = await readFile(process.env.CRS_PRIVATE_BASELINE!, 'utf8');
  const started = performance.now(); const result = parseLegacyFinancialHistory(source);
  const summary = { scope: 'FINANCIAL_PROJECTION_ONLY_NOT_FULL_IMPORT', transactions: result.records.length,
    reversals: result.records.filter(row => row.reversesTransactionId !== null).length,
    bankRewards: result.records.filter(row => row.transaction.status === 'TASK_REWARD').length,
    adminAdjustments: result.records.filter(row => row.transaction.status === 'ADMIN_ADJUSTMENT').length,
    students: Object.keys(result.currentBalances).length, netRecordedDelta: result.netRecordedDelta,
    sourceDigest: result.sourceDigest, projectionDigest: result.digest, durationMs: performance.now() - started,
    historicalCommandsReplayed: 0, pgWrites: 0, activation: false };
  expect(summary).toMatchObject({ transactions: 9, reversals: 2, bankRewards: 1, adminAdjustments: 4, students: 3, netRecordedDelta: '20' });
  if (process.env.CRS_FINANCIAL_REPORT) await writeFile(process.env.CRS_FINANCIAL_REPORT, JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
});
