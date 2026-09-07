import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantImportTransactionRunner } from './importer';
import { migrationJobStatuses } from '@/server/db/schema/migrations';
import { canonicalJson, sha256 } from './validators';

type AbortableStatus = Exclude<(typeof migrationJobStatuses)[number], 'ACTIVE' | 'FAILED' | 'ABORTED'>;
const ABORTABLE = migrationJobStatuses.filter((status) => !['ACTIVE', 'FAILED', 'ABORTED'].includes(status));
const INTENT_KEYS = ['expectedSourceFingerprint', 'expectedStateVersion', 'expectedStatus', 'migrationJobId'];

function parseIntent(value: CutoverAbortIntent): CutoverAbortIntent {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).some((key) => typeof key !== 'string')
    || Object.keys(value).sort().join(',') !== INTENT_KEYS.join(',')) throw new Error('intent');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable || !('value' in descriptor))) throw new Error('intent');
  // Detach scalar intent before authentication/transaction awaits.
  const { migrationJobId, expectedStatus, expectedStateVersion, expectedSourceFingerprint } = value;
  if (typeof migrationJobId !== 'string' || !migrationJobId || migrationJobId.length > 1024 || migrationJobId.trim() !== migrationJobId
    || !ABORTABLE.includes(expectedStatus)
    || typeof expectedStateVersion !== 'string' || !/^[1-9][0-9]{0,15}$/.test(expectedStateVersion)
    || BigInt(expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER)
    || (expectedSourceFingerprint !== null && (typeof expectedSourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSourceFingerprint)))) throw new Error('intent');
  return { migrationJobId, expectedStatus, expectedStateVersion, expectedSourceFingerprint };
}
export type CutoverAbortIntent = Readonly<{
  migrationJobId: string;
  expectedStatus: AbortableStatus;
  expectedStateVersion: string;
  expectedSourceFingerprint: string | null;
}>;
type AbortDependencies = Readonly<{
  tenantId: string;
  getAuthenticatedSubject: () => Promise<string | null>;
  runTransaction: TenantImportTransactionRunner;
}>;
/** Internal server composition only. tenantId is canonical route-resolved context;
 * getAuthenticatedSubject must read the authenticated identity, never request data
 * or a compatibility password. Dependencies are not public request parameters.
 *
 * Bounded Task19 checkpoint: ABORTED only. No forward transition, freeze capability,
 * source writer enable/disable, grant deletion or storage rollback is implemented.
 * Aborting records a stop; it does not assert that an external fence was released.
 */
export function createLegacyCutoverAbortService(dependencies: AbortDependencies) {
  const { tenantId, getAuthenticatedSubject, runTransaction } = dependencies;
  return async function abortLegacyCutover(rawIntent: CutoverAbortIntent): Promise<{
    status: 'ABORTED'; stateVersion: string; auditEventId: string; externalCleanup: 'NOT_PERFORMED';
  }> {
    try {
      const intent = parseIntent(rawIntent);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) throw new Error('tenant');
      const subject = await getAuthenticatedSubject();
      if (typeof subject !== 'string' || !subject || subject.length > 255 || subject.trim() !== subject) throw new Error('identity');
      return await runTransaction(tenantId, async (transaction) => {
        // Same tenant→job order as the importer/reconciler. Neither stale intent
        // nor earlier membership lookup can authorize a later state change.
        const { rows: tenants } = await transaction.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
        if (tenants.length !== 1 || !['DRAFT', 'IMPORTING', 'READY'].includes(String(tenants[0].lifecycle))) throw new Error('tenant');
        const { rows: jobs } = await transaction.execute(sql`SELECT status,state_version::text AS state_version,source_fingerprint
          FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} FOR UPDATE`);
        if (jobs.length !== 1 || jobs[0].status !== intent.expectedStatus
          || jobs[0].state_version !== intent.expectedStateVersion
          || jobs[0].source_fingerprint !== intent.expectedSourceFingerprint) throw new Error('binding');
        const { rows: actors } = await transaction.execute(sql`SELECT u.id FROM tenant_memberships m
          JOIN users u ON u.id=m.user_id WHERE m.tenant_id=${tenantId} AND u.google_subject=${subject}
          AND m.role IN ('OWNER','ADMIN') FOR SHARE OF m,u`);
        if (actors.length !== 1) throw new Error('actor');
        const actorUserId = String(actors[0].id);
        const details = { previousStatus: intent.expectedStatus, previousStateVersion: intent.expectedStateVersion,
          sourceFingerprint: intent.expectedSourceFingerprint, externalCleanup: 'NOT_PERFORMED' };
        const auditEventId = `cutover-abort:${sha256(canonicalJson([tenantId, intent.migrationJobId, actorUserId, details]))}`;
        await transaction.execute(sql`INSERT INTO audit_events
          (tenant_id,event_id,job_id,actor_user_id,event_type,operation_id,entity_type,entity_id,redacted_details)
          VALUES (${tenantId},${auditEventId},${intent.migrationJobId},${actorUserId},'MIGRATION_CUTOVER_ABORTED',NULL,NULL,NULL,${JSON.stringify(details)}::jsonb)`);
        const { rows: persisted } = await transaction.execute(sql`SELECT job_id,actor_user_id,event_type,operation_id,entity_type,entity_id,redacted_details
          FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${auditEventId}`);
        if (persisted.length !== 1 || canonicalJson(persisted[0]) !== canonicalJson({
          job_id: intent.migrationJobId, actor_user_id: actorUserId, event_type: 'MIGRATION_CUTOVER_ABORTED',
          operation_id: null, entity_type: null, entity_id: null, redacted_details: details,
        })) throw new Error('audit');
        const stateVersion = String(BigInt(intent.expectedStateVersion) + BigInt(1));
        const { rows } = await transaction.execute(sql`UPDATE migration_jobs SET status='ABORTED',
          state_version=state_version+1,updated_at=now(),completed_at=now()
          WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId} AND status=${intent.expectedStatus}
            AND state_version=${intent.expectedStateVersion}::bigint
            AND source_fingerprint IS NOT DISTINCT FROM ${intent.expectedSourceFingerprint}::text
          RETURNING state_version::text AS state_version`);
        if (rows.length !== 1 || rows[0].state_version !== stateVersion) throw new Error('state');
        const { rows: verified } = await transaction.execute(sql`SELECT status,state_version::text AS state_version,completed_at
          FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id=${intent.migrationJobId}`);
        if (verified.length !== 1 || verified[0].status !== 'ABORTED'
          || verified[0].state_version !== stateVersion || verified[0].completed_at === null) throw new Error('readback');
        return { status: 'ABORTED', stateVersion, auditEventId, externalCleanup: 'NOT_PERFORMED' };
      });
    } catch {
      throw new Error('Cutover abort refused.');
    }
  };
}
