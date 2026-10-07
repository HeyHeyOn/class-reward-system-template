import type { LegacyFinancialReview } from './legacyFinancialHistory';
import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import { parseLegacyFinancialHistory } from './legacyFinancialHistory';
import { canonicalJson, sha256 } from './validators';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';

type Input = Readonly<{ tenantId: string; migrationJobId: string; sourceId: string; gridJson: string; financialReview?: LegacyFinancialReview }>;

/** Internal full-snapshot migration step, never a public HTTP command. The
 * caller must bind the authenticated source/job before calling this function.
 * This step imports financial history only. It cannot activate a classroom,
 * publish claims, prove writer exclusion or change accounts/inventory.
 */
export function createLegacyFinancialHistoryImporter(runTransaction: TenantImportTransactionRunner) {
  return async (input: Input) => {
    const plan = parseLegacyFinancialHistory(input.gridJson, input.financialReview);
    return runTransaction(input.tenantId, async tx => {
      const tenant = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
      if (tenant.rows.length !== 1 || !['DRAFT', 'IMPORTING'].includes(String(tenant.rows[0].lifecycle))) throw new Error('Historical import requires a private migration target.');
      const job = await tx.execute(sql`SELECT status FROM migration_jobs
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
      if (job.rows.length !== 1 || !['VALIDATED', 'IMPORTING'].includes(String(job.rows[0].status))) throw new Error('Historical import job is not ready.');
      const source = await tx.execute(sql`SELECT source_fingerprint FROM migration_sources
        WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND source_id=${input.sourceId}
          AND provider='GOOGLE_SHEETS' FOR SHARE`);
      if (source.rows.length !== 1 || source.rows[0].source_fingerprint !== plan.sourceDigest) throw new Error('Historical source binding mismatch.');
      if (plan.review) {
        const owners = await tx.execute(sql`SELECT u.id,u.google_subject FROM tenant_memberships m JOIN users u ON u.id=m.user_id
          WHERE m.tenant_id=${input.tenantId} AND m.role='OWNER' FOR SHARE OF m,u`);
        const actor = owners.rows.filter(row => sha256(String(row.google_subject)) === plan.review!.approvedBySubjectDigest);
        if (actor.length !== 1) throw new Error('Historical financial review owner mismatch.');
        const eventId = `financial-review:${sha256(canonicalJson([input.migrationJobId, input.sourceId]))}`;
        const details = { sourceDigest: plan.sourceDigest, review: plan.review, balancesPreserved: true, inventedTransactions: 0 };
        await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,actor_user_id,event_type,redacted_details)
          VALUES (${input.tenantId},${eventId},${input.migrationJobId},${String(actor[0].id)},'MIGRATION_FINANCIAL_DISCREPANCIES_PRESERVED',${JSON.stringify(details)}::jsonb)
          ON CONFLICT (tenant_id,event_id) DO NOTHING`);
        const audit = await tx.execute(sql`SELECT job_id,actor_user_id,event_type,redacted_details FROM audit_events WHERE tenant_id=${input.tenantId} AND event_id=${eventId}`);
        if (canonicalJson(audit.rows) !== canonicalJson([{ job_id: input.migrationJobId, actor_user_id: String(actor[0].id),
          event_type: 'MIGRATION_FINANCIAL_DISCREPANCIES_PRESERVED', redacted_details: details }])) throw new Error('Historical financial review readback mismatch.');
      }
      const balances = await tx.execute(sql`SELECT student_id,balance::text AS balance FROM accounts WHERE tenant_id=${input.tenantId} ORDER BY student_id FOR SHARE`);
      const expectedBalances = Object.entries(plan.currentBalances).map(([student_id, balance]) => ({ student_id, balance: String(balance) }))
        .sort((a, b) => a.student_id < b.student_id ? -1 : a.student_id > b.student_id ? 1 : 0);
      const actualBalances = [...balances.rows].sort((a, b) => String(a.student_id) < String(b.student_id) ? -1 : String(a.student_id) > String(b.student_id) ? 1 : 0);
      if (canonicalJson(actualBalances) !== canonicalJson(expectedBalances)) throw new Error('Imported current balances do not match the source.');
      const existing = await tx.execute(sql`SELECT count(*)::int AS n FROM transactions WHERE tenant_id=${input.tenantId}`);
      const expectedOrigins = plan.records.map(row => ({ transaction_id: row.transaction.transactionId,
        job_id: input.migrationJobId, source_id: input.sourceId, source_digest: plan.sourceDigest,
        source_row_number: row.rowNumber, source_row_digest: row.rowDigest, original_cells: row.originalCells,
        reverses_transaction_id: row.reversesTransactionId }));
      const replayed = Number(existing.rows[0].n) > 0;
      if (!replayed) {
        for (const row of plan.records) {
          const t = row.transaction;
          await tx.execute(sql`INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,
            kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,legacy_status_snapshot)
            VALUES (${input.tenantId},${t.transactionId},${t.timestamp}::timestamptz,${t.studentId},${t.studentName},
              'LEGACY',${t.totalAmount},${row.balanceDelta},${t.balanceBefore},${t.balanceAfter},${t.operator},${t.status})`);
          for (const [index, item] of t.items.entries()) {
            const extended = 'finalTotal' in item ? item : null;
            await tx.execute(sql`INSERT INTO transaction_items(tenant_id,transaction_id,line_number,
              product_id_snapshot,product_name_snapshot,quantity,unit_price_snapshot,subtotal_snapshot,
              regular_unit_price,regular_total,total_quantity,paid_quantity,free_quantity,final_total,total_discount,
              adjustments_snapshot,applied_promotions_snapshot)
              VALUES (${input.tenantId},${t.transactionId},${index + 1},
                ${item.productId},${item.name},${item.quantity},${item.price},${item.subtotal},
                ${extended?.regularUnitPrice ?? null},${extended?.regularTotal ?? null},${extended?.totalQuantity ?? null},
                ${extended?.paidQuantity ?? null},${extended?.freeQuantity ?? null},${extended?.finalTotal ?? null},${extended?.totalDiscount ?? null},
                ${extended ? JSON.stringify(extended.adjustments) : null}::jsonb,${extended ? JSON.stringify(extended.appliedPromotions) : null}::jsonb)`);
          }
        }
        // All peer transactions exist before their immutable source links.
        for (const row of expectedOrigins) await tx.execute(sql`INSERT INTO legacy_transaction_origins
          (tenant_id,transaction_id,job_id,source_id,source_digest,source_row_number,source_row_digest,original_cells,reverses_transaction_id)
          VALUES (${input.tenantId},${row.transaction_id},${row.job_id},${row.source_id},${row.source_digest},
            ${row.source_row_number},${row.source_row_digest},${JSON.stringify(row.original_cells)}::jsonb,${row.reverses_transaction_id})`);
      }
      const origins = await tx.execute(sql`SELECT transaction_id,job_id,source_id,source_digest,source_row_number,
        source_row_digest,original_cells,reverses_transaction_id FROM legacy_transaction_origins
        WHERE tenant_id=${input.tenantId} ORDER BY source_row_number`);
      if (canonicalJson(origins.rows) !== canonicalJson(expectedOrigins)) throw new Error('Historical source readback mismatch.');
      const queries = createDatabaseTransactionQueries({ tenantId: input.tenantId, runTenantTransaction: (_tenant, callback) => callback(tx) });
      const actual = await queries.getTransactions();
      const expected = plan.records.map(row => row.transaction);
      const sorted = <T extends { transactionId: string }>(values: T[]) => [...values].sort((a, b) => a.transactionId < b.transactionId ? -1 : a.transactionId > b.transactionId ? 1 : 0);
      if (canonicalJson(sorted(actual)) !== canonicalJson(sorted(expected))) throw new Error('Historical transaction reader differs from source.');
      return { sourceDigest: plan.sourceDigest, projectionDigest: plan.digest, transactions: plan.records.length,
        items: plan.records.reduce((sum, row) => sum + row.transaction.items.length, 0),
        reversals: plan.records.filter(row => row.reversesTransactionId !== null).length,
        netRecordedDelta: plan.netRecordedDelta, replayed, currentBalancesChanged: false as const,
        inventoryChanged: false as const, modernOperationsCreated: 0 as const, activated: false as const };
    });
  };
}
