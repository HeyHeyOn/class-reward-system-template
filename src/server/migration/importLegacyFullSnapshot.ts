import type { LegacyFinancialReview } from './legacyFinancialHistory';
import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import { parseLegacyFullSnapshot } from './legacyFullSnapshot';
import { createLegacyFinancialHistoryImporter } from './importLegacyFinancialHistory';
import { createLegacyTaskHistoryImporter } from './importLegacyTaskHistory';
import { canonicalJson } from './validators';

type Input = Readonly<{ tenantId: string; migrationJobId: string; sourceId: string; gridJson: string; capturedAt: string; financialReview?: LegacyFinancialReview }>;
type Row = Record<string, unknown>;
function mapFields(row: Readonly<Row>, fields: Record<string, string>): Row {
  return Object.fromEntries(Object.entries(fields).map(([key, column]) => [column, row[key] ?? null]));
}
function currentProjections(plan: Awaited<ReturnType<typeof parseLegacyFullSnapshot>>, tenantId: string, capturedAt: string) {
  const tasks = plan.records.tasks;
  const taskInstance = new Map(tasks.map(t => [t.taskId, t.taskInstanceId]));
  const mapped = (table: keyof typeof plan.records, fields: Record<string, string>) => plan.records[table]
    .map(row => ({ tenant_id: tenantId, ...mapFields(row, fields) }));
  return [
    { table: 'students', rows: mapped('students', { studentId:'student_id',name:'name',status:'status' }) },
    { table: 'accounts', rows: mapped('accounts', { studentId:'student_id',balance:'balance' }) },
    { table: 'products', rows: mapped('products', { productId:'product_id',name:'name',price:'price',stock:'stock',isActive:'is_active',imageUrl:'image_url',category:'category',sortOrder:'sort_order' }) },
    { table: 'promotions', rows: plan.records.promotions.map(row => ({ tenant_id:tenantId,
      ...mapFields(row, {promotionId:'promotion_id',name:'name',description:'description',type:'type',buyQuantity:'n_plus_one_buy_quantity',freeQuantity:'n_plus_one_free_quantity',promotionalUnitPrice:'promotional_price',percent:'percent_discount',discountAmount:'fixed_discount',startsAt:'starts_at',endsAt:'ends_at',isActive:'is_active',sortOrder:'sort_order',schemaVersion:'schema_version',createdAt:'created_at',updatedAt:'updated_at'}) })) },
    { table: 'promotion_products', rows: mapped('promotion_products', {promotionProductId:'promotion_product_id',promotionId:'promotion_id',productId:'product_id',createdAt:'created_at',schemaVersion:'schema_version'}) },
    { table: 'tasks', rows: [...tasks.map(row => ({ tenant_id:tenantId,
      ...mapFields(row, {taskInstanceId:'task_instance_id',taskId:'task_id',title:'title',description:'description',reward:'reward',isActive:'is_active',sortOrder:'sort_order',currentSchedule:'current_schedule',pendingSchedule:'pending_schedule',createdAt:'created_at',updatedAt:'updated_at',availableFrom:'available_from',dueAt:'due_at'}),
      prerequisite_task_instance_id: row.prerequisiteTaskId ? taskInstance.get(row.prerequisiteTaskId) : null, schedule_schema_version:1, deleted_at: null })),
      // These are explicitly unavailable definitions, not reconstructed tasks.
      // The import timestamp is the identity record's creation/deletion time;
      // observed historical event times remain in the immutable source archive.
      ...plan.taskHistory.archivedTaskIdentities.map(identity => ({ tenant_id: tenantId, task_instance_id: identity.taskInstanceId,
        task_id: identity.taskId, title: '과거 과제 (원본 정의 없음)', description: '이전 이력 연결용 보관 항목', reward: 0,
        is_active: false, sort_order: 0, current_schedule: { legacyIdentityOnly: true, sourceDigest: plan.sourceDigest,
          ruleVersion: 1, effectiveFrom: capturedAt, timeZone: 'Asia/Seoul', recurrence: { type: 'UNAVAILABLE' },
          resetCompletionOnCycle: false, resetAssignmentOnCycle: false }, pending_schedule: null,
        created_at: capturedAt, updated_at: capturedAt, available_from: null, due_at: null,
        prerequisite_task_instance_id: null, schedule_schema_version: 1, deleted_at: capturedAt }))] },
    { table: 'task_allowed_students', rows: mapped('task_allowed_students', {taskInstanceId:'task_instance_id',studentId:'student_id'}) },
    { table: 'tenant_settings', rows: [{tenant_id:tenantId,settings:Object.fromEntries(plan.records.settings.map(row=>[String(row.key),row.value])),schema_version:4}] },
  ];
}

/** One complete Sheets snapshot -> one private PostgreSQL transaction.
 * This accepts an already bound job/source, not an end-user request. The caller
 * still owns acquisition/authentication, freeze, Redis coverage and activation.
 */
export function createLegacyFullSnapshotImporter(runTransaction: TenantImportTransactionRunner) {
  return async (input: Input) => {
    const plan = await parseLegacyFullSnapshot(input);
    const projections = currentProjections(plan, input.tenantId, input.capturedAt);
    return runTransaction(input.tenantId, async tx => {
      const tenant = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
      if (tenant.rows.length!==1 || !['DRAFT','IMPORTING'].includes(String(tenant.rows[0].lifecycle))) throw new Error('Full import requires a private target.');
      const job = await tx.execute(sql`SELECT status FROM migration_jobs WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
      if(job.rows.length!==1 || !['VALIDATED','IMPORTING'].includes(String(job.rows[0].status))) throw new Error('Full import job is not ready.');
      const source=await tx.execute(sql`SELECT source_fingerprint FROM migration_sources
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId} AND provider='GOOGLE_SHEETS' FOR SHARE`);
      if(source.rows.length!==1 || source.rows[0].source_fingerprint!==plan.sourceDigest) throw new Error('Full import source mismatch.');
      const archive=await tx.execute(sql`SELECT source_digest,projection_digest,grid_json,physical_rows,business_rows,captured_at
        FROM legacy_full_snapshot_archives WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId}`);
      const replayed=archive.rows.length>0;
      if (!replayed) {
        for(const table of [...projections.map(p=>p.table),'transactions','transaction_items','task_assignments','task_completions','operations','inventory_ledger','adjustments']) {
          const existing=await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id=${input.tenantId}`);
          if(existing.rows[0].n!==0) throw new Error('Full import requires empty business tables.');
        }
        for(const {table,rows} of projections) {
          if(!rows.length) continue;
          const columns=sql.join(Object.keys(rows[0]).map(key=>sql.identifier(key)),sql`, `);
          await tx.execute(sql`INSERT INTO ${sql.identifier(table)} (${columns}) SELECT ${columns}
            FROM jsonb_populate_recordset(NULL::${sql.identifier(table)},${JSON.stringify(rows)}::jsonb)`);
        }
      }
      const inThisTransaction: TenantImportTransactionRunner = (_id, callback) => callback(tx);
      const financial=await createLegacyFinancialHistoryImporter(inThisTransaction)(input);
      const tasks=await createLegacyTaskHistoryImporter(inThisTransaction)(input);
      for(const {table,rows} of projections) {
        if(!rows.length) {
          const count=await tx.execute(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id=${input.tenantId}`);
          if(count.rows[0].n!==0) throw new Error('Empty source collection has unexpected target rows.');
          continue;
        }
        const columns=sql.join(Object.keys(rows[0]).map(key=>sql.identifier(key)),sql`, `);
        const result=await tx.execute(sql`WITH expected AS (SELECT ${columns} FROM jsonb_populate_recordset(NULL::${sql.identifier(table)},${JSON.stringify(rows)}::jsonb)),
          actual AS (SELECT ${columns} FROM ${sql.identifier(table)} WHERE tenant_id=${input.tenantId})
          SELECT count(*)::int AS n FROM ((TABLE expected EXCEPT ALL TABLE actual) UNION ALL (TABLE actual EXCEPT ALL TABLE expected)) differences`);
        if(result.rows[0].n!==0) throw new Error('Full import current-state reconciliation mismatch.');
      }
      if(!replayed) await tx.execute(sql`INSERT INTO legacy_full_snapshot_archives
        (tenant_id,job_id,source_id,source_digest,projection_digest,grid_json,physical_rows,business_rows,captured_at)
        VALUES (${input.tenantId},${input.migrationJobId},${input.sourceId},${plan.sourceDigest},${plan.digest},${input.gridJson},${plan.physicalRows},${plan.businessRows},${input.capturedAt}::timestamptz)`);
      const readback=await tx.execute(sql`SELECT source_digest,projection_digest,grid_json,physical_rows,business_rows,
        to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS captured_at
        FROM legacy_full_snapshot_archives WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId}`);
      if(canonicalJson(readback.rows)!==canonicalJson([{source_digest:plan.sourceDigest,projection_digest:plan.digest,grid_json:input.gridJson,
        physical_rows:plan.physicalRows,business_rows:plan.businessRows,captured_at:input.capturedAt}])) throw new Error('Full source archive readback mismatch.');
      return {sourceDigest:plan.sourceDigest,projectionDigest:plan.digest,physicalRows:plan.physicalRows,businessRows:plan.businessRows,
        sourceCounts:plan.counts,currentCounts:Object.fromEntries(projections.map(p=>[p.table,p.rows.length])),
        financialRows:financial.transactions,assignmentRows:tasks.assignmentRows,completionSourceRows:tasks.completionRows,
        completionStateEvents:tasks.completionStateEvents,replayed,scope:'SHEETS_PRIVATE_IMPORT' as const,
        writerFreezeProven:false as const,redisClaims:'UNCONFIRMED' as const,claimsPublished:false as const,activated:false as const};
    });
  };
}
