import 'server-only';

import type { PoolClient } from 'pg';
import { getDatabaseClient } from '@/server/db/client';
import type { TenantMembership } from '@/server/tenantAuth';
import type { TenantRecord } from '@/server/tenantContext';

const statuses = [
  'DISCOVERED', 'VALIDATED', 'IMPORTING', 'RECONCILING', 'READY', 'FREEZING',
  'FINAL_IMPORT', 'ACTIVE', 'FAILED', 'ABORTED',
] as const;
type PersistedStatus = (typeof statuses)[number];
const statusSet: ReadonlySet<unknown> = new Set(statuses);
const TIMEOUT_MS = 2_000;

export function isStatusJobId(value: unknown): value is string {
  // Jobs use opaque text IDs, not UUIDs. Do not normalize or echo them.
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && value.trim() === value && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

type JobStatus = Readonly<{
  availability: 'AVAILABLE';
  readOnly: true;
  migrationStatus: PersistedStatus;
  authority: 'UNKNOWN';
  reasonCode: 'OPERATIONAL_AUTHORITY_UNVERIFIED';
  reason: string;
}>;
export type JobReadResult =
  | Readonly<{ kind: 'JOB_AVAILABLE'; status: JobStatus }>
  | Readonly<{ kind: 'FORBIDDEN' | 'JOB_NOT_FOUND' | 'JOB_UNAVAILABLE' }>;

// No SELECT *, source columns, JSON, audit/receipt joins, or latest-job query.
// Recheck membership and canonical tenant in the SAME statement snapshot as
// the job read. The earlier HTTP access gate alone cannot prevent revocation
// between statements. NULL status means no tenant-bound job; no row means the
// canonical tenant/current membership binding no longer matches.
const JOB_STATUS_SQL = `
  SELECT CASE
    WHEN j.status IN ('DISCOVERED','VALIDATED','IMPORTING','RECONCILING','READY',
      'FREEZING','FINAL_IMPORT','ACTIVE','FAILED','ABORTED') THEN j.status
    WHEN j.job_id IS NULL THEN NULL
    ELSE 'UNKNOWN'
  END AS status
  FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m
  JOIN public.platform_find_tenant_by_slug($6) AS t ON t.id = m.tenant_id
  LEFT JOIN public.migration_jobs AS j ON j.tenant_id = $1 AND j.job_id = $3
  WHERE m.tenant_id = $1 AND m.google_subject = $2
    AND m.id = $4 AND m.user_id = $5 AND m.role IN ('OWNER','ADMIN')
    AND t.id = $1 AND t.slug = $6
  LIMIT 1`;

async function acquireConnection(): Promise<PoolClient> {
  const pool = getDatabaseClient().pool;
  return new Promise((resolve, reject) => {
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      reject(new Error('Status acquisition unavailable'));
    }, TIMEOUT_MS);
    // A queued acquisition may resolve after the deadline. Destroy that client
    // instead of leaking it or starting a query after the HTTP read has failed.
    void Promise.resolve().then(() => pool.connect()).then(connection => {
      clearTimeout(timer);
      if (expired) {
        connection.release(true);
      } else {
        resolve(connection);
      }
    }, error => {
      clearTimeout(timer);
      reject(error);
    }).catch(() => { /* A late release must not cause an unhandled rejection. */ });
  });
}

/** Called only after the shared current-Google tenant-admin access gate.
 * Single attempt, data SELECT only, explicit READ ONLY, transaction-local RLS.
 * A stored ACTIVE label is archival job state, never operational authority. */
export async function readJobStatus(
  tenant: TenantRecord,
  membership: TenantMembership,
  jobId: string,
): Promise<JobReadResult> {
  let connection: PoolClient | undefined;
  let rolledBack = false;
  try {
    connection = await acquireConnection();
    const client = connection;
    const query = (text: string, values?: unknown[]) => {
      // pg supports per-query query_timeout; keep it on the config variable
      // because @types/pg's narrower QueryConfig does not declare this field.
      const config = { text, values, query_timeout: TIMEOUT_MS };
      return client.query(config);
    };
    await query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await query("SET LOCAL statement_timeout = '1500ms'");
    await query("SET LOCAL lock_timeout = '500ms'");
    await query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
    const { rows } = await query(JOB_STATUS_SQL, [
      tenant.id, membership.googleSubject, jobId, membership.id, membership.userId, tenant.slug,
    ]);
    await query('ROLLBACK');
    rolledBack = true;
    if (rows.length === 0) return { kind: 'FORBIDDEN' };
    if (rows.length !== 1) return { kind: 'JOB_UNAVAILABLE' };
    const status: unknown = rows[0]?.status;
    if (status === null) return { kind: 'JOB_NOT_FOUND' };
    if (!statusSet.has(status)) return { kind: 'JOB_UNAVAILABLE' };
    return {
      kind: 'JOB_AVAILABLE',
      status: {
        availability: 'AVAILABLE', readOnly: true,
        migrationStatus: status as PersistedStatus, authority: 'UNKNOWN',
        reasonCode: 'OPERATIONAL_AUTHORITY_UNVERIFIED',
        reason: '저장된 작업 상태만 표시합니다. 실제 운영 권한은 확인되지 않았습니다.',
      },
    };
  } catch {
    return { kind: 'JOB_UNAVAILABLE' };
  } finally {
    // Closing a failed connection aborts its transaction. Never return an
    // uncertain/timeout/rollback-failed connection to the shared pool.
    try {
      if (rolledBack) connection?.release();
      else connection?.release(true);
    } catch { /* No raw connection errors or credentials leave this reader. */ }
  }
}