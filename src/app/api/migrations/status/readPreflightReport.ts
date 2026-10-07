import 'server-only';

import { Pool, types as pgTypes, type PoolClient, type QueryConfig } from 'pg';
import { getDatabaseConfig } from '@/server/db/config';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { authorizeTenantAdmin, TenantAuthorizationError, type TenantMembership } from '@/server/tenantAuth';
import { parseTenantSlug, resolveTenantContext, TenantContextError, type TenantRecord } from '@/server/tenantContext';
import { projectPreflightReport, type PreflightReportProjectionResult } from './preflightReportProjection';

const STAGE_MS = 2_000;
const TOTAL_MS = 5_000;
const MAX_ENVELOPE_BYTES = 65_536;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const COOKIE = 'class_store_google_auth';
const unavailable = () => ({ kind: 'UNAVAILABLE' as const });
type HistoricalReport = Extract<PreflightReportProjectionResult, { kind: 'HISTORICAL_REPORT' }>;
export type PreflightReportReadResult = HistoricalReport | Readonly<{
  kind: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE';
}>;

// The shared runtime pool has no acquisition deadline. A Promise.race around
// it alone leaves an uncancellable pending acquisition. This reader-local pool
// uses ONLY the runtime URL (never the direct/migration URL), caps connections,
// and lets pg-pool remove expired waiters/destroy timed-out connecting sockets.
// No shared pool/default/auth configuration is changed. Idle sockets expire;
// no worker, source acquisition, grant, health query or retry is started here.
let pool: Pool | undefined;
function reportPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getDatabaseConfig().databaseUrl,
      max: 2, connectionTimeoutMillis: STAGE_MS, idleTimeoutMillis: 1_000, allowExitOnIdle: true });
    pool.on('error', () => { /* pg-pool removes the failed idle client. No raw error logging. */ });
  }
  return pool;
}

// Discovery runs on the SAME bounded client/READ ONLY transaction, before GUC.
// Bound every variable-width output BEFORE the driver sees it. The definer
// functions may still do work inside PostgreSQL; deadlines are not a constant
// database CPU/memory guarantee. Unknown/oversized discovery values fail closed.
const TENANT_SQL = `SELECT t.id,
  CASE WHEN octet_length(convert_to(t.slug, 'UTF8')) <= 63 THEN t.slug ELSE NULL::text END AS slug,
  CASE WHEN octet_length(convert_to(t.display_name, 'UTF8')) <= 1024 THEN t.display_name ELSE NULL::text END AS display_name,
  CASE WHEN t.lifecycle IN ('DRAFT','IMPORTING','READY','ACTIVE','MIGRATION_READ_ONLY','SUSPENDED') THEN t.lifecycle ELSE NULL::text END AS lifecycle,
  CASE WHEN t.timezone = 'Asia/Seoul' THEN t.timezone ELSE NULL::text END AS timezone
  FROM public.platform_find_tenant_by_slug($1) AS t LIMIT 2`;
const MEMBER_SQL = `SELECT m.id, m.tenant_id, m.user_id,
  CASE WHEN octet_length(convert_to(m.google_subject, 'UTF8')) <= 1024 THEN m.google_subject ELSE NULL::text END AS google_subject,
  CASE WHEN m.role IN ('OWNER','ADMIN') THEN m.role ELSE NULL::text END AS role
  FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m LIMIT 2`;

// All NINE envelope fields (including metadata and JSON escaping) contribute to
// the UTF-8 transmission gate. Never return JSON/JSONB, e.*, raw length inputs,
// compressed pg_column_size, or a separately fetched/re-read report. LATERAL
// is an expression, not an application materialization; PostgreSQL may inline
// and detoast it. Both result arms are TEXT. Bound authorization flags only.
// READ COMMITTED rechecks canonical binding/current membership in this exact
// statement snapshot, not in a stale admission snapshot. It is NOT a lease
// against a revocation committed after this statement's snapshot.
const REPORT_SQL = `SELECT (e.event_id IS NOT NULL) AS found,
  COALESCE(octet_length(convert_to(envelope_text, 'UTF8')) > 65536, false) AS oversized,
  CASE WHEN octet_length(convert_to(envelope_text, 'UTF8')) <= 65536
    THEN envelope_text ELSE NULL::text END AS envelope_text
  FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m
  JOIN public.platform_find_tenant_by_slug($6) AS t ON t.id = m.tenant_id
  LEFT JOIN public.migration_jobs AS j ON j.tenant_id = $1 AND j.job_id = $3
  LEFT JOIN public.audit_events AS e ON e.tenant_id = j.tenant_id AND e.job_id = j.job_id
    AND e.event_id = $7 AND e.event_type = 'MIGRATION_RECONCILIATION_PREFLIGHT'
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'tenant_id', e.tenant_id, 'event_id', e.event_id, 'job_id', e.job_id,
      'event_type', e.event_type, 'operation_id', e.operation_id, 'actor_user_id', e.actor_user_id,
      'entity_type', e.entity_type, 'entity_id', e.entity_id, 'redacted_details', e.redacted_details
    )::text AS envelope_text WHERE e.event_id IS NOT NULL
  ) AS serialized ON true
  WHERE m.tenant_id = $1 AND m.google_subject = $2
    AND m.id = $4 AND m.user_id = $5 AND m.role IN ('OWNER','ADMIN')
    AND t.id = $1 AND t.slug = $6
  LIMIT 2`;

// pg calls parsers from event callbacks, not query's promise try/catch. Never
// throw here or select a JSON/JSONB parser: keep unexpected OIDs inert, then
// reject their metadata before JSON.parse/projection. Only the SQL gate bounds
// wire bytes. Fixed UUID, boolean and explicitly bounded TEXT are permitted.
const textTypes: NonNullable<QueryConfig['types']> = {
  getTypeParser(oid, format) {
    if ((format && format !== 'text') || ![16, 25, 2950].includes(oid)) return pgTypes.getTypeParser(25, 'text');
    return pgTypes.getTypeParser(oid, format);
  },
};
const TENANT_FIELDS = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]] as const;
const MEMBER_FIELDS = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]] as const;
const REPORT_FIELDS = [['found', 16], ['oversized', 16], ['envelope_text', 25]] as const;
type Fields = readonly (readonly [string, number])[];
function validRows(result: { rows: unknown[]; fields: { name: string; dataTypeID: number }[] }, fields: Fields): boolean {
  return result.rows.length <= 1 && result.fields.length === fields.length
    && fields.every(([name, oid], i) => result.fields[i].name === name && result.fields[i].dataTypeID === oid)
    && result.rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row)
      && Object.keys(row).length === fields.length && fields.every(([name]) => Object.hasOwn(row, name)));
}
function boundedString(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && value.length <= maxBytes && Buffer.byteLength(value, 'utf8') <= maxBytes;
}
function isJobId(value: string): boolean {
  // No trimming, decoding twice, normalization, UUID conversion or lone UTF-16
  // surrogate replacement (pg would otherwise silently change literal bytes).
  return value.length > 0 && value.length <= 1024 && value.trim() === value
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value);
}
function selectors(slug: string, request: Request): { jobId: string; reportId: string } | null {
  if (!['GET', 'HEAD'].includes(request.method) || !boundedString(request.url, 16_384)
    || !boundedString(request.headers.get('cookie') ?? '', 32_768)) return null;
  const url = new URL(request.url);
  if (url.hash || (url.pathname !== `/api/migrations/status/${slug}/preflight`
    && url.pathname !== `/api/migrations/status/${slug}/preflight/download`)) return null;
  const pairs = url.search.slice(1).split('&');
  if (pairs.length !== 2) return null;
  const values = new Map<string, string>();
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    const key = pair.slice(0, equals);
    if (equals < 0 || !['jobId', 'reportId'].includes(key) || values.has(key)) return null;
    // URLSearchParams silently repairs malformed UTF-8/% escapes. Do not use it.
    values.set(key, decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' ')));
  }
  const jobId = values.get('jobId');
  const reportId = values.get('reportId');
  if (jobId === undefined || !isJobId(jobId) || reportId?.length !== 79
    || !/^reconciliation:[a-f0-9]{64}$/.test(reportId)) return null;
  return { jobId, reportId };
}
function unambiguousCookie(request: Request): boolean {
  let count = 0;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const segment = part.trim();
    const equals = segment.indexOf('=');
    const name = equals < 0 ? segment : segment.slice(0, equals).trim();
    if (name !== COOKIE) continue;
    if (++count !== 1 || equals < 0) return false;
    try {
      const token = decodeURIComponent(segment.slice(equals + 1));
      if (!/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
    } catch { return false; }
  }
  return count === 1;
}
class ExpiredIdentity extends Error {}

/** Server-only reader; no route exports, inventory changes or producer calls.
 * Admit exactly the canonical /api/migrations/status/[slug]/preflight and
 * /api/migrations/status/[slug]/preflight/download pathnames on the original
 * Request. Routes own their separate inline/attachment representations and
 * transport/cache/error mapping; this reader publishes no endpoint itself.
 *
 * One attempt, one runtime connection, one READ ONLY transaction. The deadline
 * includes admission/discovery/decoding/rollback, with bounded SQL statements.
 * Historical integrity never proves original provenance, live source freshness,
 * production preflight, operational authority, or permission for cutover.
 */
export async function readPreflightReport(slug: unknown, request: Request): Promise<PreflightReportReadResult> {
  const deadline = performance.now() + TOTAL_MS;
  let selected: ReturnType<typeof selectors>;
  try {
    const parsed = parseTenantSlug(slug);
    if (parsed.needsRedirect) return { kind: 'FORBIDDEN' };
    selected = selectors(parsed.slug, request);
  } catch (error) {
    return { kind: error instanceof TenantContextError ? 'FORBIDDEN' : 'INVALID_REQUEST' };
  }
  if (!selected) return { kind: 'INVALID_REQUEST' };
  if (!unambiguousCookie(request)) return { kind: 'UNAUTHENTICATED' };
  const originalCookie = request.headers.get('cookie');
  const session = getGoogleSessionFromRequest(request);
  if (!session || !boundedString(session.subject, 1024)) return { kind: 'UNAUTHENTICATED' };

  let client: PoolClient | undefined;
  let rolledBack = false;
  let releaseAttempted = false;
  let failed = false;
  let rejectStep: (() => void) | undefined;
  const release = (destroy: boolean) => {
    if (!client || releaseAttempted) return;
    releaseAttempted = true;
    try {
      if (destroy) client.release(true);
      else client.release();
    } catch {
      // Do not double-release into a pool whose release state is uncertain.
      // end() destroys an active non-pipelined query; observe late rejection.
      try { void client.end().catch(() => {}); } catch { /* No raw error. */ }
      throw new Error('Report cleanup unavailable');
    } finally { client.removeListener('error', stop); }
  };
  function stop() {
    failed = true;
    try { release(true); } catch { /* The result is already unavailable. */ }
    rejectStep?.();
  }
  const check = () => {
    if (failed || request.signal.aborted || performance.now() >= deadline) throw new Error('Report deadline');
  };
  const checkIdentity = () => {
    // Reject changed headers before decrypting an unadmitted replacement.
    if (request.headers.get('cookie') !== originalCookie) throw new ExpiredIdentity();
    const current = getGoogleSessionFromRequest(request);
    if (!unambiguousCookie(request) || !current || current.subject !== session.subject
      || current.issuedAt !== session.issuedAt) throw new ExpiredIdentity();
  };
  const run = <T>(start: () => Promise<T>, late?: (value: T) => void): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = () => { settled = true; clearTimeout(timer); rejectStep = undefined; };
      rejectStep = () => { finish(); reject(new Error('Report unavailable')); };
      const timer = setTimeout(stop, Math.max(1, Math.min(STAGE_MS, deadline - performance.now())));
      // Invoke once only; a synchronous failure and any late rejection are also
      // observed. No detached async continuation may begin further queries.
      try {
        void start().then(value => {
          if (settled) { try { late?.(value); } catch { /* No unhandled late cleanup. */ } return; }
          finish(); resolve(value);
        }, error => { if (!settled) { finish(); reject(error); } });
      } catch (error) { if (!settled) { finish(); reject(error); } }
    });
  };
  const query = (text: string, values?: unknown[]) => {
    check(); checkIdentity();
    const config = { text, values, types: textTypes,
      query_timeout: Math.max(1, Math.floor(Math.min(STAGE_MS, deadline - performance.now()))) };
    return run(() => client!.query(config));
  };
  request.signal.addEventListener('abort', stop, { once: true });
  try {
    check();
    client = await run(() => reportPool().connect(), late => {
      try { late.release(true); } catch { try { void late.end().catch(() => {}); } catch { /* No raw error. */ } }
    });
    client.on('error', stop);
    check(); checkIdentity();
    await query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await query("SET LOCAL statement_timeout = '1500ms'");
    await query("SET LOCAL lock_timeout = '500ms'");
    await query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    let result: PreflightReportReadResult;
    try {
      const { tenant } = await resolveTenantContext(slug, {
        async findBySlug(canonicalSlug) {
          const data = await query(TENANT_SQL, [canonicalSlug]);
          if (!validRows(data, TENANT_FIELDS)) throw new Error('Invalid directory result');
          const row = data.rows[0];
          if (!row || !boundedString(row.display_name, 1024) || row.timezone !== 'Asia/Seoul'
            || !['DRAFT', 'IMPORTING', 'READY', 'ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED'].includes(row.lifecycle)) return null;
          return { id: row.id, slug: row.slug, displayName: row.display_name, lifecycle: row.lifecycle,
            timezone: row.timezone } as TenantRecord;
        },
      });
      const membership = await authorizeTenantAdmin(tenant, session, {
        async findByTenantAndSubject(tenantId, subject) {
          const data = await query(MEMBER_SQL, [tenantId, subject]);
          if (!validRows(data, MEMBER_FIELDS)) throw new Error('Invalid membership result');
          const row = data.rows[0];
          if (!row || !UUID.test(row.id) || !UUID.test(row.user_id) || !boundedString(row.google_subject, 1024)) return null;
          return { id: row.id, tenantId: row.tenant_id, userId: row.user_id, googleSubject: row.google_subject,
            role: row.role } as TenantMembership;
        },
      });
      await query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
      const data = await query(REPORT_SQL, [tenant.id, session.subject, selected.jobId,
        membership.id, membership.userId, tenant.slug, selected.reportId]);
      check(); checkIdentity();
      result = unavailable();
      if (validRows(data, REPORT_FIELDS)) {
        const row = data.rows[0];
        if (!row) result = { kind: 'FORBIDDEN' };
        else if (row.found === false && row.oversized === false && row.envelope_text === null) result = { kind: 'NOT_FOUND' };
        else if (row.found === true && row.oversized === false && boundedString(row.envelope_text, MAX_ENVELOPE_BYTES)) {
          const projected = projectPreflightReport(JSON.parse(row.envelope_text), {
            tenantId: tenant.id, migrationJobId: selected.jobId, reportId: selected.reportId,
          });
          if (projected.kind === 'HISTORICAL_REPORT') result = projected;
        }
      }
    } catch (error) {
      if (error instanceof TenantContextError || error instanceof TenantAuthorizationError) result = { kind: 'FORBIDDEN' };
      else throw error;
    }
    check();
    await query('ROLLBACK');
    rolledBack = true;
    check(); checkIdentity();
    release(false); // Cleanup failure must prevent publication, even after rollback.
    check(); checkIdentity();
    return result;
  } catch (error) {
    return error instanceof ExpiredIdentity ? { kind: 'UNAUTHENTICATED' } : unavailable();
  } finally {
    request.signal.removeEventListener('abort', stop);
    try { release(!rolledBack); } catch { /* Failure was already sanitized. */ }
  }
}
