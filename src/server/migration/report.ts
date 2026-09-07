import { createHash } from 'node:crypto';

export const RECONCILIATION_CATEGORIES = [
  'INTEGRITY', 'SOURCES', 'CHECKPOINTS', 'STUDENTS', 'BALANCES', 'PRODUCTS', 'STOCK',
  'TRANSACTIONS', 'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'TRANSACTION_ITEMS',
  'ADJUSTMENTS', 'CANCELLATIONS', 'CANCELLATION_AMOUNT', 'CANCELLATION_DELTA', 'TASKS', 'ASSIGNMENTS', 'COMPLETIONS',
  'PROMOTIONS', 'PROMOTION_PRODUCTS', 'RECURRENCE', 'SETTINGS', 'ALLOWED_STUDENTS',
  'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'ORPHANED_CLAIMS', 'TOMBSTONES',
] as const;
export type ReconciliationCategory = typeof RECONCILIATION_CATEGORIES[number];
export type ReconciliationMetric = Readonly<{ category: ReconciliationCategory; expected: bigint; actual: bigint }>;
const CODES = new Set([
  'INVALID_DIAGNOSTIC', 'INVALID_MANIFEST', 'INVALID_CURRENT_MANIFEST', 'UNSUPPORTED_HISTORY', 'BINDING_MISMATCH',
  'SOURCE_MUTATION', 'ROW_MISMATCH', 'CARDINALITY_MISMATCH', 'CHECKPOINT_INCOMPLETE',
  'HISTORY_ORDER', 'OPERATIONAL_PROJECTION', 'DATABASE_READ_FAILED', 'INVALID_COMPARISON_INSTANT', 'DATABASE_WRITE_FAILED',
]);
export type ReconciliationDiagnostic = Readonly<{
  code: string; category: string; rowReference?: string;
}>;

/** Presentation only. A matched preflight is deliberately not a cutover capability.
 * Never spread input objects or include upstream exception messages/raw values. */
export function createReconciliationReport(
  metrics: readonly ReconciliationMetric[], diagnostics: readonly unknown[],
) {
  const numericLimit = BigInt(10) ** BigInt(30);
  const seen = new Set<string>();
  const invalidMetrics = metrics.length > RECONCILIATION_CATEGORIES.length || metrics.some((metric) => {
    if (!metric || !RECONCILIATION_CATEGORIES.includes(metric.category)
      || seen.has(metric.category) || typeof metric.expected !== 'bigint' || typeof metric.actual !== 'bigint'
      || metric.expected <= -numericLimit || metric.expected >= numericLimit
      || metric.actual <= -numericLimit || metric.actual >= numericLimit) return true;
    seen.add(metric.category);
    return false;
  });
  if (invalidMetrics) {
    metrics = [];
    diagnostics = [{ category: 'INTEGRITY', code: 'INVALID_DIAGNOSTIC' }];
  }
  const rows = metrics.map((metric) => ({
    category: metric.category,
    expected: metric.expected.toString(), actual: metric.actual.toString(),
    delta: (metric.actual - metric.expected).toString(),
    status: metric.actual === metric.expected ? 'MATCH' as const : 'MISMATCH' as const,
  }));
  const safeDiagnostics = diagnostics.slice(0, 100).map((value) => {
    const row = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
    const valid = typeof row.code === 'string' && CODES.has(row.code)
      && typeof row.category === 'string' && (RECONCILIATION_CATEGORIES as readonly string[]).includes(row.category);
    return {
      code: valid ? row.code as string : 'INVALID_DIAGNOSTIC',
      category: valid ? row.category as ReconciliationCategory : 'INTEGRITY' as const,
      ...(typeof row.rowReference === 'string' ? {
        rowReference: createHash('sha256').update(row.rowReference.slice(0, 4096)).digest('hex'),
      } : {}),
    };
  });
  return {
    reportVersion: 1 as const, phase: 'PREFLIGHT' as const,
    status: diagnostics.length || rows.some((row) => row.status === 'MISMATCH')
      ? 'BLOCKED' as const : 'MATCHED_PREFLIGHT' as const,
    authority: 'SHEETS_AND_REDIS' as const, cutoverAllowed: false as const,
    metrics: rows, diagnostics: safeDiagnostics,
    omittedDiagnostics: Math.max(0, diagnostics.length - safeDiagnostics.length),
  };
}
export type ReconciliationReport = ReturnType<typeof createReconciliationReport>;
