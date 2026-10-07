import { describe, expect, it } from 'vitest';
import { buildReconciliationSummary } from './reconciliationSummary';

const categories = [
  'STUDENTS', 'BALANCES', 'PRODUCTS', 'STOCK', 'TRANSACTIONS', 'CANCELLATIONS',
  'TASKS', 'ASSIGNMENTS', 'COMPLETIONS', 'PROMOTIONS', 'RECURRENCE',
  'PADLET_CLAIMS', 'OPERATION_BINDINGS',
];
const tenantId = 'tenant-1';
const jobId = 'job-1';
const row = (category: string, overrides: Record<string, unknown> = {}) => ({
  tenant_id: tenantId, job_id: jobId, category,
  expected_count: '2', actual_count: '2', delta: '0', status: 'MATCH',
  diagnostics: [{ recoveryPlaintext: 'do-not-export' }],
  redacted_manifest: { secret: 'do-not-export' }, ...overrides,
});
const input = (rows: unknown[]) => ({ tenantId, jobId, status: 'READY', rows });

describe('buildReconciliationSummary', () => {
  it('projects only allowlisted fields in stable schema order, without mutating the input', () => {
    const rows = categories.slice().reverse().map((category) => row(category));
    const value = input(rows);
    const before = JSON.stringify(value);
    const result = buildReconciliationSummary(value);
    expect(JSON.stringify(value)).toBe(before);
    expect(result).toEqual({
      tenantId, jobId, status: 'READY', complete: true, blocked: false,
      activationAllowed: false,
      results: categories.map((category) => ({
        category, expected_count: 2, actual_count: 2, delta: 0, status: 'MATCH',
      })),
    });
    expect(JSON.stringify(result)).not.toMatch(/diagnostics|secret|manifest|recoveryPlaintext/);
    expect(buildReconciliationSummary(input([...rows].reverse()))).toEqual(result);
  });

  it('marks a missing category incomplete and never grants authority even if every row matches', () => {
    expect(buildReconciliationSummary(input([row('STUDENTS')]))).toMatchObject({
      complete: false, blocked: false, activationAllowed: false,
    });
    expect(buildReconciliationSummary(input(categories.map((category) => row(category))))).toMatchObject({
      complete: true, blocked: false, activationAllowed: false,
    });
  });

  it('marks non-MATCH rows blocked and checks signed delta arithmetic', () => {
    expect(buildReconciliationSummary(input([
      row('PRODUCTS', { expected_count: 4, actual_count: '2', delta: '-2', status: 'MISMATCH' }),
    ]))).toMatchObject({ blocked: true, complete: false, activationAllowed: false });
    expect(buildReconciliationSummary(input([
      row('PRODUCTS', { expected_count: 4, actual_count: 4, delta: 0, status: 'BLOCKED' }),
    ]))).toMatchObject({ blocked: true });
    expect(() => buildReconciliationSummary(input([
      row('PRODUCTS', { expected_count: 4, actual_count: 2, delta: -1, status: 'MISMATCH' }),
    ]))).toThrow();
    expect(() => buildReconciliationSummary(input([
      row('PRODUCTS', { expected_count: 2, actual_count: 3, delta: 1, status: 'MATCH' }),
    ]))).toThrow();
  });

  it('rejects duplicate, unknown, cross-tenant and cross-job rows', () => {
    for (const rows of [
      [row('STUDENTS'), row('STUDENTS')], [row('UNKNOWN')],
      [row('STUDENTS', { tenant_id: 'other' })],
      [row('STUDENTS', { job_id: 'other' })],
    ]) expect(() => buildReconciliationSummary(input(rows))).toThrow();
  });

  it('rejects unsafe, imprecise, malformed or out-of-range counts', () => {
    for (const bad of ['9007199254740992', 9007199254740992, '1.0', '1e2', NaN, -1, '']) {
      expect(() => buildReconciliationSummary(input([
        row('STUDENTS', { expected_count: bad }),
      ]))).toThrow();
    }
    expect(() => buildReconciliationSummary(input([
      row('STUDENTS', { expected_count: '9007199254740991', actual_count: '0', delta: '-9007199254740991', status: 'MISMATCH' }),
    ]))).not.toThrow();
  });
});
