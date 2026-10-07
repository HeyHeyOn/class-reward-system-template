// Non-authoritative projection only: not an immutable report, backup, or freeze proof.
const categories = [
  'STUDENTS', 'BALANCES', 'PRODUCTS', 'STOCK', 'TRANSACTIONS', 'CANCELLATIONS',
  'TASKS', 'ASSIGNMENTS', 'COMPLETIONS', 'PROMOTIONS', 'RECURRENCE',
  'PADLET_CLAIMS', 'OPERATION_BINDINGS',
] as const;

const jobStatuses = new Set([
  'DISCOVERED', 'VALIDATED', 'IMPORTING', 'RECONCILING', 'READY', 'FREEZING',
  'FINAL_IMPORT', 'ACTIVE', 'FAILED', 'ABORTED',
]);
const resultStatuses = new Set(['MATCH', 'MISMATCH', 'BLOCKED']);
type Row = Record<string, unknown>;

function count(value: unknown, signed = false): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('invalid count');
  if (typeof value === 'string' && !/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error('invalid count');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!signed && parsed < 0)) throw new Error('invalid count');
  return parsed;
}

/** Strict allowlist of reconciliation evidence; never grants activation authority. */
export function buildReconciliationSummary(input: {
  tenantId: string; jobId: string; status: string; rows: readonly unknown[];
}) {
  if (typeof input.tenantId !== 'string' || !input.tenantId.trim() ||
      typeof input.jobId !== 'string' || !input.jobId.trim() ||
      !jobStatuses.has(input.status) || !Array.isArray(input.rows)) throw new Error('invalid summary input');
  const byCategory = new Map<string, {
    category: string; expected_count: number; actual_count: number; delta: number; status: string;
  }>();
  for (const value of input.rows) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid row');
    const row = value as Row;
    if (row.tenant_id !== input.tenantId || row.job_id !== input.jobId ||
        typeof row.category !== 'string' || !categories.includes(row.category as typeof categories[number]) ||
        byCategory.has(row.category) || typeof row.status !== 'string' || !resultStatuses.has(row.status)) {
      throw new Error('invalid reconciliation identity or status');
    }
    const expected_count = count(row.expected_count);
    const actual_count = count(row.actual_count);
    const delta = count(row.delta, true);
    if (BigInt(expected_count) + BigInt(delta) !== BigInt(actual_count) ||
        (row.status === 'MATCH' && (delta !== 0 || expected_count !== actual_count))) {
      throw new Error('inconsistent reconciliation counts');
    }
    byCategory.set(row.category, { category: row.category, expected_count, actual_count, delta, status: row.status });
  }
  const results = categories.flatMap((category) => {
    const result = byCategory.get(category);
    return result === undefined ? [] : [result];
  });
  return {
    tenantId: input.tenantId, jobId: input.jobId, status: input.status,
    complete: results.length === categories.length,
    blocked: results.some((result) => result.status !== 'MATCH'),
    activationAllowed: false as const,
    results,
  };
}
