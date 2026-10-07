import type { LegacyFinancialReview } from './legacyFinancialHistory';
import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import { parseLegacyTaskHistory } from './legacyTaskHistory';
import { parseLegacyFinancialHistory } from './legacyFinancialHistory';
import { canonicalJson } from './validators';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';

type Input = Readonly<{ tenantId: string; migrationJobId: string; sourceId: string; gridJson: string; financialReview?: LegacyFinancialReview }>;
export function createLegacyTaskHistoryImporter(runTransaction: TenantImportTransactionRunner) {
  return async (input: Input) => {
    const plan = parseLegacyTaskHistory(input.gridJson, input.financialReview);
    return runTransaction(input.tenantId, async tx => {
      const tenant = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
      if (tenant.rows.length !== 1 || !['DRAFT', 'IMPORTING'].includes(String(tenant.rows[0].lifecycle))) throw new Error('Historical tasks require a private migration target.');
      const job = await tx.execute(sql`SELECT status FROM migration_jobs WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
      if (job.rows.length !== 1 || !['VALIDATED', 'IMPORTING'].includes(String(job.rows[0].status))) throw new Error('Historical task job is not ready.');
      const source = await tx.execute(sql`SELECT source_fingerprint FROM migration_sources
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId} AND provider='GOOGLE_SHEETS' FOR SHARE`);
      if (source.rows.length !== 1 || source.rows[0].source_fingerprint !== plan.sourceDigest) throw new Error('Historical task source binding mismatch.');
      const counts = await tx.execute(sql`SELECT
        (SELECT count(*) FROM task_assignments WHERE tenant_id=${input.tenantId})::int AS assignments,
        (SELECT count(*) FROM task_completions WHERE tenant_id=${input.tenantId})::int AS completions`);
      const replayed = Number(counts.rows[0].assignments) + Number(counts.rows[0].completions) > 0;
      const financial = parseLegacyFinancialHistory(input.gridJson, input.financialReview);
      const transactionNames = new Map(financial.records.map(r => [r.transaction.transactionId, r.transaction.items[0]?.name]));
      const origins = [
        ...plan.assignments.map(({ originId, event: e, sources }) => ({ originId, table: 'task_assignments', id: e.assignmentId, sources, historicalOperation: undefined,
          projection: { tenant_id: input.tenantId, assignment_id: e.assignmentId, task_id_snapshot: e.taskId, task_instance_id: e.taskInstanceId,
            cycle_id: e.cycleId, cycle_start_at: e.cycleStartsAt, cycle_end_at: e.cycleEndsAt, rule_version: e.ruleVersion,
            timezone: e.timeZone, student_id: e.studentId, event_type: e.status, source: e.source,
            previous_assignment_id: e.previousAssignmentId || null, created_at: e.createdAt, schema_version: 1, note: e.note || null,
            admin_operation_id: null, admin_operation_hash: null } })),
        ...plan.completions.map(({ originId, event: e, sources, transactionId, historicalOperation }) => ({ originId, table: 'task_completions', id: e.completionId, sources, historicalOperation,
          projection: { tenant_id: input.tenantId, completion_id: e.completionId, completed_at: e.timestamp, task_instance_id: e.taskInstanceId ?? null,
            task_id_snapshot: e.taskId, task_name_snapshot: (transactionId && transactionNames.get(transactionId)) || '과거 과제 (제목 기록 없음)',
            student_id: e.studentId, student_name_snapshot: e.studentName, reward_snapshot: e.reward,
            balance_before: e.balanceBefore, balance_after: e.balanceAfter, status: e.status === 'SUCCESS' ? 'COMPLETED' : 'CANCELLED', note: e.note || null,
            cycle_id: e.cycleId ?? null, cycle_start_at: e.cycleStartsAt ?? null, cycle_end_at: e.cycleEndsAt ?? null,
            rule_version: e.ruleVersion ?? null, timezone: e.timeZone ?? null, source: e.source ?? null, assignment_id: e.assignmentId || null,
            transaction_id: transactionId, operation_id: null, operation_hash: null, admin_operation_id: null, admin_operation_hash: null,
            schema_version: 1, evidence_provider: null, evidence_board_id: null, evidence_post_id: null,
            evidence_created_at: null, evidence_author_full_name: null, created_at: e.timestamp } })),
      ];
      if (!replayed) for (const o of origins) {
        await tx.execute(sql`INSERT INTO legacy_task_origins(tenant_id,origin_id,job_id,source_id,source_digest,target_table,target_id,source_rows,projection,historical_operation_id,historical_operation_hash)
          VALUES (${input.tenantId},${o.originId},${input.migrationJobId},${input.sourceId},${plan.sourceDigest},${o.table},${o.id},
            ${JSON.stringify(o.sources)}::jsonb,${JSON.stringify(o.projection)}::jsonb,${o.historicalOperation?.id ?? null},${o.historicalOperation?.hash ?? null})`);
        // Identifiers are generated only from the two closed projections above.
        const columns = [...Object.keys(o.projection), 'legacy_origin_id'];
        const names = sql.join(columns.map(column => sql.identifier(column)), sql`, `);
        await tx.execute(sql`INSERT INTO ${sql.identifier(o.table)} (${names})
          SELECT ${names} FROM jsonb_populate_record(NULL::${sql.identifier(o.table)},
            ${JSON.stringify({ ...o.projection, legacy_origin_id: o.originId })}::jsonb)`);
      }
      const stored = await tx.execute(sql`SELECT origin_id,job_id,source_id,source_digest,target_table,target_id,source_rows,projection,historical_operation_id,historical_operation_hash
        FROM legacy_task_origins WHERE tenant_id=${input.tenantId} ORDER BY origin_id`);
      const expected = origins.map(o => ({ origin_id: o.originId, job_id: input.migrationJobId, source_id: input.sourceId,
        source_digest: plan.sourceDigest, target_table: o.table, target_id: o.id, source_rows: o.sources, projection: o.projection,
        historical_operation_id: o.historicalOperation?.id ?? null, historical_operation_hash: o.historicalOperation?.hash ?? null }))
        .sort((a, b) => a.origin_id.localeCompare(b.origin_id));
      if (canonicalJson(stored.rows) !== canonicalJson(expected)) throw new Error('Historical task archive readback mismatch.');
      for (const table of ['task_assignments', 'task_completions']) {
        const mismatch = await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} e
          LEFT JOIN legacy_task_origins o ON o.tenant_id=e.tenant_id AND o.origin_id=e.legacy_origin_id
          WHERE e.tenant_id=${input.tenantId} AND (o.target_table IS DISTINCT FROM ${table}
            OR (to_jsonb(e)-'event_sequence'-'legacy_origin_id') IS DISTINCT FROM
              (to_jsonb(jsonb_populate_record(NULL::${sql.identifier(table)},o.projection))-'event_sequence'-'legacy_origin_id'))`);
        if (mismatch.rows[0].n !== 0) throw new Error('Historical task event readback mismatch.');
      }
      const queries = createDatabaseTaskCycleQueries({ tenantId: input.tenantId, runTenantSnapshot: (_id, callback) => callback(tx) });
      const history = await queries.getTaskCompletions();
      const expectedHistory = plan.completions.map(({ event }) => ({ ...event, schemaVersion: 1,
        ...(event.taskInstanceId ? { cycleStartsAt: new Date(event.cycleStartsAt!).toISOString(),
          cycleEndsAt: event.cycleEndsAt ? new Date(event.cycleEndsAt).toISOString() : null } : {}) }));
      const sort = <T extends { completionId: string }>(events: T[]) => [...events].sort((a, b) => a.completionId.localeCompare(b.completionId));
      if (canonicalJson(sort(history)) !== canonicalJson(sort(expectedHistory))) throw new Error('Historical completion reader differs from source.');
      const assignmentCount = await tx.execute(sql`SELECT count(*)::int AS n FROM task_assignments WHERE tenant_id=${input.tenantId}`);
      if (assignmentCount.rows[0].n !== plan.assignments.length) throw new Error('Historical assignment count mismatch.');
      return { sourceDigest: plan.sourceDigest, projectionDigest: plan.digest, assignmentRows: plan.sourceAssignmentRows,
        completionRows: plan.sourceCompletionRows, completionStateEvents: plan.completions.length,
        bankRewards: plan.completions.filter(e => e.event.source === 'BANK').length,
        replayed, modernOperationsCreated: 0 as const, currentBalancesChanged: false as const, activated: false as const };
    });
  };
}
