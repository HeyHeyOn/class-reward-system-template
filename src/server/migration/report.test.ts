import { describe, expect, it } from 'vitest';
import { createReconciliationReport } from './report';

describe('credential-free reconciliation report', () => {
  it('reports exact expected/actual/delta without granting READY or cutover', () => {
    const report = createReconciliationReport([
      { category: 'BALANCES', expected: BigInt(100), actual: BigInt(90) },
      { category: 'TRANSACTIONS', expected: BigInt(-10), actual: BigInt(-10) },
    ], []);
    expect(report.status).toBe('BLOCKED');
    expect(report.cutoverAllowed).toBe(false);
    expect(report.metrics[0]).toEqual({ category: 'BALANCES', expected: '100', actual: '90', delta: '-10', status: 'MISMATCH' });
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(createReconciliationReport([], []).status).toBe('MATCHED_PREFLIGHT');
  });

  it('does not let zero deltas override blocking history or echo secrets from hostile diagnostics', () => {
    const secret = 'Bearer credential-super-secret';
    const report = createReconciliationReport([{ category: 'COMPLETIONS', expected: BigInt(0), actual: BigInt(0) }], [
      { code: 'UNSUPPORTED_HISTORY', category: 'COMPLETIONS', rowReference: secret, detail: secret },
      { code: secret, category: secret, rowReference: secret },
    ]);
    expect(report.status).toBe('BLOCKED');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(report.diagnostics[0]).toMatchObject({ code: 'UNSUPPORTED_HISTORY', category: 'COMPLETIONS' });
    expect(report.diagnostics[0].rowReference).toMatch(/^[a-f0-9]{64}$/);
    expect(report.diagnostics[1]).toMatchObject({ code: 'INVALID_DIAGNOSTIC', category: 'INTEGRITY' });
  });

  it('rejects forged metric labels, duplicate categories and oversized numeric payloads without echoing values', () => {
    const secret = 'Bearer metric-secret';
    const hostile = [{ category: secret, expected: BigInt(0), actual: BigInt(0) }] as unknown as Parameters<typeof createReconciliationReport>[0];
    const report = createReconciliationReport(hostile, []);
    expect(report.status).toBe('BLOCKED');
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(createReconciliationReport([
      { category: 'BALANCES', expected: BigInt(0), actual: BigInt(0) },
      { category: 'BALANCES', expected: BigInt(0), actual: BigInt(0) },
    ], []).status).toBe('BLOCKED');
    const huge = createReconciliationReport([{ category: 'BALANCES', expected: BigInt(10) ** BigInt(10000), actual: BigInt(0) }], []);
    expect(huge.status).toBe('BLOCKED');
    expect(JSON.stringify(huge).length).toBeLessThan(1000);
  });

  it('caps diagnostics without hiding the blocking outcome', () => {
    const report = createReconciliationReport([], Array.from({ length: 150 }, () => ({ code: 'ROW_MISMATCH', category: 'STUDENTS' })));
    expect(report.diagnostics).toHaveLength(100);
    expect(report.omittedDiagnostics).toBe(50);
    expect(report.status).toBe('BLOCKED');
  });
});
