import 'server-only';
import { sql } from 'drizzle-orm';
import { withTenantTransaction } from '@/server/db/transaction';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { inspectLegacyImport, type LegacyMigrationImportInput } from './importer';
import type { LegacyNormalizationManifest } from './manifest';
import { sourceRecurrenceProjections } from './recurrenceComparison';
import { canonicalJson, sha256 } from './validators';
import { createReconciliationReport, type ReconciliationCategory, type ReconciliationMetric,
  type ReconciliationReport } from './report';

/** A local snapshot comparison, not an authenticated live freeze or READY grant.
 * This entrypoint never imports, repairs, publishes registries or updates jobs.
 * Caller summaries are not accepted. All metrics come from canonical sources and
 * independent SQL aggregates, inside the same locked verification transaction. */
export async function reconcileLegacyImport(input: LegacyMigrationImportInput & {
  currentManifest: LegacyNormalizationManifest;
  comparisonInstant: string;
}): Promise<ReconciliationReport> {
  const invalidInstant = typeof input.comparisonInstant !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.comparisonInstant)
    || !Number.isFinite(Date.parse(input.comparisonInstant))
    || new Date(input.comparisonInstant).toISOString() !== input.comparisonInstant;
  try {
    return await (input.runTransaction ?? withTenantTransaction)(input.tenantId, async (transaction) => {
      const diagnostics = await inspectLegacyImport(transaction, input, input.currentManifest);
      if (invalidInstant) diagnostics.unshift({ category: 'RECURRENCE', code: 'INVALID_COMPARISON_INSTANT' });
      if (invalidInstant || diagnostics.some((row) => row.code === 'INVALID_MANIFEST' || row.code === 'BINDING_MISMATCH')) {
        return createReconciliationReport([], diagnostics);
      }
      const metrics = await independentMetrics(transaction, input.tenantId, input.manifest);
      try {
        const queries = createDatabaseTaskCycleQueries({ tenantId: input.tenantId,
          runTenantSnapshot: (_tenantId, callback) => callback(transaction) });
        await queries.loadTaskCycleLedgerSnapshot();
        let expectedCount = 0;
        let actualCount = 0;
        for (const expected of sourceRecurrenceProjections(input.manifest, input.comparisonInstant)) {
          const projections = await queries.listTaskCycleProjections({ includeInactive: true,
            now: input.comparisonInstant, studentId: expected.studentId });
          expectedCount += expected.projections.length;
          actualCount += projections.length;
          const byId = new Map(projections.map((row) => [row.taskInstanceId, row]));
          if (projections.length !== expected.projections.length || byId.size !== projections.length) {
            diagnostics.push({ category: 'RECURRENCE', code: 'CARDINALITY_MISMATCH' });
          }
          // Eligibility is set-valued, not ranked. The domain seeds its student
          // map and membership lists from this set, so those DTO views inherit
          // its incidental order too. Compare these membership views by code units,
          // without deduplication (multiplicity must fail), never sorting history.
          const comparable = (row: (typeof projections)[number] | undefined) => row ? {
            ...row, allowedStudentIds: [...row.allowedStudentIds].sort(),
            currentCycle: { ...row.currentCycle,
              assignedStudentIds: [...row.currentCycle.assignedStudentIds].sort(),
              completedStudentIds: [...row.currentCycle.completedStudentIds].sort(),
              students: [...row.currentCycle.students].sort((a, b) => a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0),
            },
          } : null;
          for (const row of expected.projections) {
            if (canonicalJson(comparable(byId.get(row.taskInstanceId))) !== canonicalJson(comparable(row))) {
              diagnostics.push({ category: 'RECURRENCE', code: 'ROW_MISMATCH',
                rowReference: canonicalJson([row.taskInstanceId, expected.studentId ?? null, input.comparisonInstant]) });
            }
          }
        }
        metrics.push({ category: 'RECURRENCE', expected: BigInt(expectedCount), actual: BigInt(actualCount) });
      } catch {
        diagnostics.push({ category: 'RECURRENCE', code: 'OPERATIONAL_PROJECTION' });
      }
      return createReconciliationReport(metrics, diagnostics);
    });
  } catch {
    // No upstream SQL, identifiers, credentials or raw manifest fields in errors.
    return createReconciliationReport([], [{ category: 'INTEGRITY', code: 'DATABASE_READ_FAILED' }]);
  }
}

/** Internal trusted-acquisition orchestration only; intentionally no public route.
 * currentManifest must come from the existing Sheets/Redis acquisition + normalizer
 * under the caller's authenticated source-ownership boundary. Digest equality proves
 * a bound snapshot comparison, NOT that a caller supplied current live truth. This
 * function mints no acquisition capability and accepts no report/summary authority.
 * READY is preparatory only: live write-freeze/final-delta/activation remain separate.
 */
export async function prepareLegacyImportReady(input: Parameters<typeof reconcileLegacyImport>[0]): Promise<{
  readiness: 'READY' | 'BLOCKED'; report: ReconciliationReport; persistedReportId: string | null;
}> {
  try {
    return await (input.runTransaction ?? withTenantTransaction)(input.tenantId, async (transaction) => {
      // Reuse the full runtime verifier, but never open a second transaction or
      // release its tenant/job/source/checkpoint/target locks before persistence.
      const report = await reconcileLegacyImport({ ...input,
        runTransaction: (_tenantId, callback) => callback(transaction) });
      if (report.diagnostics.some((row) => ['INVALID_MANIFEST', 'BINDING_MISMATCH',
        'DATABASE_READ_FAILED'].includes(row.code))) {
        return { readiness: 'BLOCKED' as const, report, persistedReportId: null };
      }
      const details = { report,
        comparisonInstant: report.diagnostics.some((row) => row.code === 'INVALID_COMPARISON_INSTANT')
          ? null : input.comparisonInstant,
        manifestDigest: input.manifest.manifestDigest,
        currentManifestDigest: report.diagnostics.some((row) => row.code === 'INVALID_CURRENT_MANIFEST')
          ? null : input.currentManifest.manifestDigest,
        sourceFingerprint: input.manifest.sourceFingerprint, freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE' };
      const persistedReportId = `reconciliation:${sha256(canonicalJson([input.tenantId, input.migrationJobId, details]))}`;
      // 0003 reconciliation_results is a mutable, one-category/job count table;
      // it cannot store signed aggregate sums or immutable rerun history. Reuse
      // 0003's RLS-protected, UPDATE/DELETE-rejected audit_events instead of either
      // weakening its constraints or adding a redundant report schema.
      await transaction.execute(sql`INSERT INTO audit_events
        (tenant_id,event_id,job_id,operation_id,actor_user_id,event_type,entity_type,entity_id,redacted_details)
        VALUES (${input.tenantId},${persistedReportId},${input.migrationJobId},NULL,NULL,
          'MIGRATION_RECONCILIATION_PREFLIGHT',NULL,NULL,${JSON.stringify(details)}::jsonb)
        ON CONFLICT (tenant_id,event_id) DO NOTHING`);
      const { rows: persisted } = await transaction.execute(sql`SELECT job_id,event_type,operation_id,
        actor_user_id,entity_type,entity_id,redacted_details FROM audit_events
        WHERE tenant_id=${input.tenantId} AND event_id=${persistedReportId}`);
      if (persisted.length !== 1 || canonicalJson(persisted[0]) !== canonicalJson({
        job_id: input.migrationJobId, event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT',
        operation_id: null, actor_user_id: null, entity_type: null, entity_id: null, redacted_details: details,
      })) throw new Error('Report readback mismatch.');
      const { rows: jobs } = await transaction.execute(sql`SELECT status FROM migration_jobs
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
      const status = jobs[0]?.status;
      if (report.status === 'MATCHED_PREFLIGHT') {
        if (status === 'IMPORTING') await transition(transaction, input, 'IMPORTING', 'RECONCILING');
        if (status === 'IMPORTING' || status === 'RECONCILING') await transition(transaction, input, 'RECONCILING', 'READY');
        else if (status !== 'READY') throw new Error('Invalid preparatory state.');
      } else if (status === 'READY') {
        // Schema deliberately forbids READY -> IMPORTING. Never retain a stale
        // readiness grant after a binding-valid verification detects drift.
        await transition(transaction, input, 'READY', 'FAILED');
      }
      const { rows: verified } = await transaction.execute(sql`SELECT status FROM migration_jobs
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId}`);
      if (report.status === 'MATCHED_PREFLIGHT' && verified[0]?.status !== 'READY') throw new Error('Readiness readback mismatch.');
      return { readiness: report.status === 'MATCHED_PREFLIGHT' ? 'READY' as const : 'BLOCKED' as const,
        report, persistedReportId };
    });
  } catch {
    return { readiness: 'BLOCKED', persistedReportId: null,
      report: createReconciliationReport([], [{ category: 'INTEGRITY', code: 'DATABASE_WRITE_FAILED' }]) };
  }
}

async function transition(transaction: TenantTransaction, input: LegacyMigrationImportInput,
  from: 'IMPORTING' | 'RECONCILING' | 'READY', to: 'RECONCILING' | 'READY' | 'FAILED') {
  const { rows } = await transaction.execute(sql`UPDATE migration_jobs SET status=${to},
    state_version=state_version+1, updated_at=now(), completed_at=CASE WHEN ${to}='FAILED' THEN now() ELSE NULL END
    WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND status=${from} RETURNING status`);
  if (rows.length !== 1 || rows[0].status !== to) throw new Error('Migration transition failed.');
}

function canonicalSheetRows(manifest: LegacyNormalizationManifest, tab: string) {
  return manifest.sourceRecords.filter((row) => row.source.kind === 'SHEET'
    && row.source.tab === tab && row.canonicalRecord !== null).map((row) => row.canonicalRecord!);
}

async function independentMetrics(transaction: TenantTransaction, tenantId: string,
  manifest: LegacyNormalizationManifest): Promise<ReconciliationMetric[]> {
  const metrics: ReconciliationMetric[] = [];
  for (const [category, tab, table] of [
    ['STUDENTS', 'Students', 'students'], ['PRODUCTS', 'Products', 'products'],
    ['TRANSACTIONS', 'Transactions', 'transactions'], ['ADJUSTMENTS', 'Adjustments', 'adjustments'],
    ['TASKS', 'Tasks', 'tasks'], ['ASSIGNMENTS', 'TaskAssignments', 'task_assignments'],
    ['COMPLETIONS', 'TaskCompletions', 'task_completions'], ['PROMOTIONS', 'Promotions', 'promotions'],
    ['PROMOTION_PRODUCTS', 'PromotionProducts', 'promotion_products'],
  ] as const) {
    const { rows } = await transaction.execute(sql`SELECT count(*)::text AS actual FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}`);
    metrics.push({ category, expected: BigInt(canonicalSheetRows(manifest, tab).length), actual: BigInt(String(rows[0].actual)) });
  }
  const transactions = canonicalSheetRows(manifest, 'Transactions');
  const sums: readonly [ReconciliationCategory, string, string, bigint][] = [
    ['BALANCES', 'accounts', 'balance', sum(canonicalSheetRows(manifest, 'Students'), 'balance')],
    ['STOCK', 'products', 'stock', sum(canonicalSheetRows(manifest, 'Products'), 'stock')],
    ['TRANSACTION_AMOUNT', 'transactions', 'legacy_total_amount', sum(transactions, 'totalAmount')],
    ['TRANSACTION_DELTA', 'transactions', 'balance_delta', sum(transactions, 'balanceAfter') - sum(transactions, 'balanceBefore')],
  ];
  for (const [category, table, column, expected] of sums) {
    const { rows } = await transaction.execute(sql`SELECT coalesce(sum(${sql.identifier(column)}),0)::text AS actual FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId}`);
    metrics.push({ category, expected, actual: BigInt(String(rows[0].actual)) });
  }
  const { rows: cancelled } = await transaction.execute(sql`SELECT count(*)::text AS actual FROM transactions WHERE tenant_id=${tenantId} AND kind='CANCELLATION'`);
  metrics.push({ category: 'CANCELLATIONS', expected: BigInt(transactions.filter((row) => row.status === 'CANCELLED').length), actual: BigInt(String(cancelled[0].actual)) });
  const reversals = transactions.filter((row) => row.status === 'CANCEL_REVERSAL');
  for (const [category, column, expected] of [
    ['CANCELLATION_AMOUNT', 'legacy_total_amount', sum(reversals, 'totalAmount')],
    ['CANCELLATION_DELTA', 'balance_delta', sum(reversals, 'balanceAfter') - sum(reversals, 'balanceBefore')],
  ] as const) {
    const { rows } = await transaction.execute(sql`SELECT coalesce(sum(${sql.identifier(column)}),0)::text AS actual
      FROM transactions WHERE tenant_id=${tenantId} AND kind='CANCELLATION'`);
    metrics.push({ category, expected, actual: BigInt(String(rows[0].actual)) });
  }
  for (const [category, table, kind] of [
    ['PADLET_CLAIMS', 'padlet_evidence_claims', null],
    ['OPERATION_BINDINGS', 'legacy_operation_bindings', null],
    ['TOMBSTONES', 'padlet_claim_digest_tombstones', 'V1_GLOBAL'],
    ['ORPHANED_CLAIMS', 'padlet_claim_digest_tombstones', 'ORPHAN_V2'],
  ] as const) {
    const expected = manifest.sourceRecords.filter((row) => row.source.kind === 'REDIS'
      && row.targetTable === table && (kind === null || row.canonicalRecord?.kind === kind)).length;
    const { rows } = await transaction.execute(sql`SELECT count(*)::text AS actual
      FROM migration_source_records r JOIN migration_sources s
        ON s.tenant_id=r.tenant_id AND s.job_id=r.job_id AND s.source_id=r.source_id
      WHERE r.tenant_id=${tenantId} AND r.job_id=${manifest.migrationJobId}
        AND s.provider='LEGACY_REDIS_BRIDGE'
        AND r.canonical_record->'migrationCheckpoint'->>'intendedTargetTable'=${table}
        AND (${kind}::text IS NULL OR r.canonical_record->>'kind'=${kind})`);
    metrics.push({ category, expected: BigInt(expected), actual: BigInt(String(rows[0].actual)) });
  }
  return metrics;
}
function sum(rows: readonly Readonly<Record<string, unknown>>[], field: string): bigint {
  return rows.reduce((total, row) => {
    if (typeof row[field] !== 'number' || !Number.isSafeInteger(row[field])) throw new Error('Invalid canonical scalar.');
    return total + BigInt(row[field]);
  }, BigInt(0));
}
