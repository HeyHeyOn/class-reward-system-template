import 'server-only';

import { types as nodeTypes } from 'node:util';
import { Pool, types as pgTypes, type PoolClient, type QueryConfig, type QueryResult } from 'pg';
import { getDatabaseConfig } from '@/server/db/config';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { authorizeTenantAdmin, TenantAuthorizationError, type TenantMembership } from '@/server/tenantAuth';
import { parseTenantSlug, resolveTenantContext, TenantContextError, type TenantRecord } from '@/server/tenantContext';

const STAGE_MS = 2_000;
const TOTAL_MS = 5_000;
const ID_BYTES = 1_024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const CANDIDATE = /^preparation:candidate:[a-f0-9]{64}$/;
const PLAN = /^preparation:plan:[a-f0-9]{64}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const LIFECYCLES = ['DRAFT', 'IMPORTING', 'READY', 'ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED'];

type Selection = Readonly<{ jobId: string; generationId: string }>;
export type PersistedLocalGenerationReadResult = Readonly<{
  kind: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE';
}> | Readonly<{
  kind: 'HISTORICAL_LOCAL_GENERATION';
  authority: 'NONAUTHORITY';
  readOnly: true;
  scope: 'HISTORICAL_ONLY';
  phase: 'LOCAL_CANDIDATE';
  exclusion: 'NOT_PROVEN';
  originalSnapshotPhase: 'PREFLIGHT';
  verification: 'PERSISTED_BINDING_ONLY';
  payloadIntegrity: 'NOT_VERIFIED';
  currentFreshness: 'NOT_VERIFIED';
  currentPreflight: 'NOT_EVALUATED';
  operationalAuthority: 'UNKNOWN';
  cutoverAllowed: false;
  activationAllowed: false;
  jobId: string;
  generationId: string;
  originalSourceId: string;
  originalSnapshotId: string;
  candidateManifestDigest: string;
  candidateSheetDigest: string;
  recordedStateVersion: string;
}>;
const unavailable = (): PersistedLocalGenerationReadResult => ({ kind: 'UNAVAILABLE' });

function boundedString(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length <= bytes && Buffer.byteLength(value, 'utf8') <= bytes;
}
function opaqueId(value: unknown): value is string {
  // Opaque DB IDs, not URL components: no decoding, trimming, Unicode repair,
  // normalization or UUID/numeric coercion. This reader admits at most 1024 UTF-8
  // bytes even though historical TEXT columns have no schema-wide length cap.
  return boundedString(value, ID_BYTES) && value.length > 0 && value.trim() === value
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value);
}
function selectionFrom(value: unknown): Selection | null {
  // Reject even revoked Proxies BEFORE reflective operations; do not invoke
  // caller getters/traps. Copy primitive values before the first await.
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value) || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes('jobId') || !keys.includes('generationId')) return null;
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!['jobId', 'generationId'].every(key => Object.hasOwn(fields[key], 'value') && fields[key].enumerable)) return null;
  const jobId: unknown = fields.jobId.value;
  const generationId: unknown = fields.generationId.value;
  if (!opaqueId(jobId) || !boundedString(generationId, 86) || !CANDIDATE.test(generationId)) return null;
  return { jobId, generationId };
}
function unambiguousCookie(request: Request): boolean {
  let count = 0;
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const segment = part.trim();
    const equals = segment.indexOf('=');
    const name = equals < 0 ? segment : segment.slice(0, equals).trim();
    if (name !== GOOGLE_AUTH_COOKIE) continue;
    if (++count !== 1 || equals < 0) return false;
    try {
      const token = decodeURIComponent(segment.slice(equals + 1));
      if (!boundedString(token, 8192) || !/^v2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return false;
    } catch { return false; }
  }
  return count === 1;
}

// A shared unbounded acquisition + Promise.race would leave a queued waiter.
// This module's bounded runtime pool removes expired waiters/connecting sockets;
// it does not mutate the application's shared pool, roles, grants or settings.
let pool: Pool | undefined;
function runtimePool(): Pool {
  if (!pool) {
    // Do not even inspect DIRECT_DATABASE_URL. Parse only the runtime URL using
    // the existing validator; never fall back to privileged/migration settings.
    const { databaseUrl } = getDatabaseConfig({ DATABASE_URL: process.env.DATABASE_URL });
    pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: STAGE_MS,
      idleTimeoutMillis: 1_000, allowExitOnIdle: true });
    pool.on('error', () => { /* pg-pool removes the failed idle client; no raw logs. */ });
  }
  return pool;
}

// A runtime URL is not proof of least privilege. Admit the SAME principal and
// canonical public tables used by discovery/historical bindings before any data
// read. A fixed boolean projection stays within the existing SQL/whole-call
// bounds. No SET ROLE, grants, schema repair, privileged URL or retry.
// This checks catalog prerequisites, NOT arbitrary policy/function bodies,
// credential provenance, effective grants or concurrent administrative changes.
const SECURITY_SQL = `SELECT COALESCE((SELECT NOT r.rolsuper AND NOT r.rolbypassrls
  AND current_user = session_user
  AND (SELECT count(*) = 7 AND count(DISTINCT c.relname) = 7
      AND bool_and(COALESCE(c.relrowsecurity AND c.relforcerowsecurity AND c.relowner <> r.oid, false))
    FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN ('tenants','tenant_memberships',
      'migration_final_generations','migration_jobs','migration_sources','migration_snapshots','audit_events')
      AND c.relkind = 'r')
  FROM pg_catalog.pg_roles AS r WHERE r.rolname = current_user), false) AS runtime_safe`;

// Bounded discovery on the SAME client/READ ONLY transaction, before the GUC.
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

// Do NOT inner-join away an existing corrupt generation. Its related scalars
// are left-joined; missing/cross-job/wrong-type links yield binding_valid=false,
// not NOT_FOUND. FK(candidate/plan) binds only tenant/event, not job/type.
// Recheck current member + canonical tenant in this READ COMMITTED statement.
// This is a statement snapshot, NOT a lease against a later revocation.
// All variable-width wire columns are gated BEFORE pg parsing; no JSON/payload
// or current job status/version is selected. LIMIT 2 detects duplicate results.
const GENERATION_SQL = `SELECT (g.generation_id IS NOT NULL) AS found,
  COALESCE(g.generation_id IS NOT NULL AND j.job_id IS NOT NULL AND s.source_id IS NOT NULL
    AND snap.snapshot_id IS NOT NULL AND candidate.event_id IS NOT NULL AND plan.event_id IS NOT NULL
    AND g.candidate_event_id = g.generation_id
    AND g.phase = 'LOCAL_CANDIDATE' AND g.exclusion = 'NOT_PROVEN'
    AND g.original_snapshot_phase = 'PREFLIGHT', false) AS binding_valid,
  g.tenant_id,
  CASE WHEN octet_length(convert_to(g.job_id, 'UTF8')) <= 1024 THEN g.job_id ELSE NULL::text END AS job_id,
  CASE WHEN octet_length(convert_to(g.generation_id, 'UTF8')) <= 86 THEN g.generation_id ELSE NULL::text END AS generation_id,
  CASE WHEN octet_length(convert_to(g.original_source_id, 'UTF8')) <= 1024 THEN g.original_source_id ELSE NULL::text END AS original_source_id,
  CASE WHEN octet_length(convert_to(g.original_snapshot_id, 'UTF8')) <= 1024 THEN g.original_snapshot_id ELSE NULL::text END AS original_snapshot_id,
  CASE WHEN octet_length(convert_to(g.candidate_event_id, 'UTF8')) <= 86 THEN g.candidate_event_id ELSE NULL::text END AS candidate_event_id,
  CASE WHEN octet_length(convert_to(g.plan_event_id, 'UTF8')) <= 81 THEN g.plan_event_id ELSE NULL::text END AS plan_event_id,
  CASE WHEN octet_length(convert_to(g.candidate_manifest_digest, 'UTF8')) <= 64 THEN g.candidate_manifest_digest ELSE NULL::text END AS candidate_manifest_digest,
  CASE WHEN octet_length(convert_to(g.candidate_sheet_digest, 'UTF8')) <= 64 THEN g.candidate_sheet_digest ELSE NULL::text END AS candidate_sheet_digest,
  CASE WHEN g.expected_state_version BETWEEN 1 AND 9007199254740991 THEN g.expected_state_version::text ELSE NULL::text END AS recorded_state_version,
  CASE WHEN g.phase = 'LOCAL_CANDIDATE' THEN g.phase ELSE NULL::text END AS phase,
  CASE WHEN g.exclusion = 'NOT_PROVEN' THEN g.exclusion ELSE NULL::text END AS exclusion,
  CASE WHEN g.original_snapshot_phase = 'PREFLIGHT' THEN g.original_snapshot_phase ELSE NULL::text END AS original_snapshot_phase
  FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2) AS m
  JOIN public.platform_find_tenant_by_slug($6) AS t ON t.id = m.tenant_id
  LEFT JOIN public.migration_final_generations AS g ON g.tenant_id = $1 AND g.job_id = $3 AND g.generation_id = $7
  LEFT JOIN public.migration_jobs AS j ON j.tenant_id = g.tenant_id AND j.job_id = g.job_id
  LEFT JOIN public.migration_sources AS s ON s.tenant_id = g.tenant_id AND s.job_id = g.job_id AND s.source_id = g.original_source_id
  LEFT JOIN public.migration_snapshots AS snap ON snap.tenant_id = g.tenant_id AND snap.job_id = g.job_id
    AND snap.source_id = g.original_source_id AND snap.snapshot_id = g.original_snapshot_id AND snap.phase = g.original_snapshot_phase
  LEFT JOIN public.audit_events AS candidate ON candidate.tenant_id = g.tenant_id AND candidate.job_id = g.job_id
    AND candidate.event_id = g.candidate_event_id AND candidate.event_type = 'MIGRATION_PREPARATION_CANDIDATE'
  LEFT JOIN public.audit_events AS plan ON plan.tenant_id = g.tenant_id AND plan.job_id = g.job_id
    AND plan.event_id = g.plan_event_id AND plan.event_type = 'MIGRATION_PREPARATION_PLAN'
  WHERE m.tenant_id = $1 AND m.google_subject = $2 AND m.id = $4 AND m.user_id = $5
    AND m.role IN ('OWNER','ADMIN') AND t.id = $1 AND t.slug = $6
  LIMIT 2`;

type Fields = readonly (readonly [string, number])[];
const SECURITY_FIELDS: Fields = [['runtime_safe', 16]];
const TENANT_FIELDS: Fields = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: Fields = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const GENERATION_FIELDS: Fields = [
  ['found', 16], ['binding_valid', 16], ['tenant_id', 2950], ['job_id', 25], ['generation_id', 25],
  ['original_source_id', 25], ['original_snapshot_id', 25], ['candidate_event_id', 25], ['plan_event_id', 25],
  ['candidate_manifest_digest', 25], ['candidate_sheet_digest', 25], ['recorded_state_version', 25],
  ['phase', 25], ['exclusion', 25], ['original_snapshot_phase', 25],
];
// Parsers run in pg event callbacks. Never throw there or invoke a JSON parser
// for an unexpected OID. Keep it inert, then refuse the field metadata below.
const scalarTypes: NonNullable<QueryConfig['types']> = {
  getTypeParser(oid, format) {
    // Only canonical PostgreSQL boolean wire values may admit the guard.
    if (oid === 16 && (!format || format === 'text')) return (value: string) => value === 't' ? true : value === 'f' ? false : value;
    if ((format && format !== 'text') || ![16, 25, 2950].includes(oid)) return pgTypes.getTypeParser(25, 'text');
    return pgTypes.getTypeParser(oid, format);
  },
};
function validRows(result: QueryResult, fields: Fields): boolean {
  return result.rows.length <= 1 && result.fields.length === fields.length
    && fields.every(([name, oid], i) => result.fields[i].name === name && result.fields[i].dataTypeID === oid
      && result.fields[i].format === 'text')
    && result.rows.every(row => row !== null && typeof row === 'object' && !Array.isArray(row)
      && Object.keys(row).length === fields.length && fields.every(([name]) => Object.hasOwn(row, name)));
}
function runtimeSafe(result: QueryResult): boolean {
  if (!Array.isArray(result.rows) || result.rows.length !== 1 || !Array.isArray(result.fields)) return false;
  const row: unknown = result.rows[0];
  if (!row || typeof row !== 'object' || nodeTypes.isProxy(row) || Array.isArray(row)) return false;
  const prototype = Object.getPrototypeOf(row);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(row).length !== 1) return false;
  const field = Object.getOwnPropertyDescriptor(row, 'runtime_safe');
  return !!field && field.enumerable === true && Object.hasOwn(field, 'value') && field.value === true
    && validRows(result, SECURITY_FIELDS);
}
function project(data: QueryResult, tenantId: string, selected: Selection): PersistedLocalGenerationReadResult {
  if (!validRows(data, GENERATION_FIELDS)) return unavailable();
  const row = data.rows[0];
  if (!row) return { kind: 'FORBIDDEN' };
  if (row.found === false && row.binding_valid === false
    && GENERATION_FIELDS.slice(2).every(([name]) => row[name] === null)) return { kind: 'NOT_FOUND' };
  if (row.found !== true || row.binding_valid !== true || row.tenant_id !== tenantId
    || row.job_id !== selected.jobId || row.generation_id !== selected.generationId
    || row.candidate_event_id !== selected.generationId
    || !boundedString(row.plan_event_id, 81) || !PLAN.test(row.plan_event_id)
    || !opaqueId(row.original_source_id) || !opaqueId(row.original_snapshot_id)
    || !boundedString(row.candidate_manifest_digest, 64) || !DIGEST.test(row.candidate_manifest_digest)
    || !boundedString(row.candidate_sheet_digest, 64) || !DIGEST.test(row.candidate_sheet_digest)
    || !boundedString(row.recorded_state_version, 16) || !/^[1-9][0-9]{0,15}$/.test(row.recorded_state_version)
    || BigInt(row.recorded_state_version) > BigInt('9007199254740991')
    || row.phase !== 'LOCAL_CANDIDATE' || row.exclusion !== 'NOT_PROVEN' || row.original_snapshot_phase !== 'PREFLIGHT') return unavailable();
  // New closed DTO, not a spread of a DB row or caller fields. No user/tenant
  // identity, plan/candidate event contents, source payload or source URL.
  return { kind: 'HISTORICAL_LOCAL_GENERATION', authority: 'NONAUTHORITY', readOnly: true, scope: 'HISTORICAL_ONLY',
    phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN', originalSnapshotPhase: 'PREFLIGHT',
    verification: 'PERSISTED_BINDING_ONLY', payloadIntegrity: 'NOT_VERIFIED', currentFreshness: 'NOT_VERIFIED',
    currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false, activationAllowed: false,
    jobId: row.job_id, generationId: row.generation_id, originalSourceId: row.original_source_id,
    originalSnapshotId: row.original_snapshot_id, candidateManifestDigest: row.candidate_manifest_digest,
    candidateSheetDigest: row.candidate_sheet_digest, recordedStateVersion: row.recorded_state_version };
}
class ChangedIdentity extends Error {}

/** Server-internal metadata read, NOT a route, export/backup, source acquisition
 * or current preflight. The future transport owner must admit canonical URL
 * selectors, authenticate every request, disable shared caching, and map errors.
 * Here slug and a closed primitive selection are the ONLY selectors: Request
 * provides method, current Google cookie and cancellation, never tenant headers,
 * body or query authority. No caller-supplied dependency/pool/session override.
 *
 * One attempt, one runtime connection, one READ COMMITTED READ ONLY transaction.
 * A 5s whole-call deadline covers admission/discovery/projection/rollback; each
 * async step is capped at 2s, SQL at 1.5s (lock 0.5s). Event-loop pauses/native
 * work cannot be preempted, so check again before publication. SQL gates bound
 * wire output, not a constant PostgreSQL detoast/CPU/memory cost. Revocation
 * after the final statement snapshot is not locked out. No retry/fallback/grant.
 * Catalog admission requires a non-superuser/non-BYPASSRLS, matching session
 * role that owns none of the seven canonical RLS/FORCE-RLS tables. This is an
 * observation, not a lock against later role/policy changes. Missing runtime
 * grants on local staging tables still yield UNAVAILABLE; none are added here.
 */
export async function readPersistedLocalGeneration(
  slug: unknown, request: Request, selection: unknown,
): Promise<PersistedLocalGenerationReadResult> {
  const deadline = performance.now() + TOTAL_MS;
  let selected: Selection | null;
  let originalCookie: string | null;
  let session: ReturnType<typeof getGoogleSessionFromRequest>;
  try {
    const canonical = parseTenantSlug(slug);
    if (canonical.needsRedirect) return { kind: 'FORBIDDEN' };
    selected = selectionFrom(selection);
    if (!selected || !['GET', 'HEAD'].includes(request.method)
      || !boundedString(request.headers.get('cookie') ?? '', 32768)) return { kind: 'INVALID_REQUEST' };
    if (!unambiguousCookie(request)) return { kind: 'UNAUTHENTICATED' };
    originalCookie = request.headers.get('cookie');
    session = getGoogleSessionFromRequest(request);
    if (!session || !boundedString(session.subject, 1024)) return { kind: 'UNAUTHENTICATED' };
  } catch (error) {
    return { kind: error instanceof TenantContextError ? 'FORBIDDEN' : 'INVALID_REQUEST' };
  }

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
      // Never double-release into a pool with uncertain release state. End an
      // active non-pipelined connection; observe late rejection without logging.
      try { void client.end().catch(() => {}); } catch { /* No raw error. */ }
      throw new Error('Local generation cleanup unavailable');
    } finally { client.removeListener('error', stop); }
  };
  function stop() {
    failed = true;
    try { release(true); } catch { /* Already refusing publication. */ }
    rejectStep?.();
  }
  const check = () => {
    if (failed || request.signal.aborted || performance.now() >= deadline) throw new Error('Local generation deadline');
  };
  const checkIdentity = () => {
    if (request.headers.get('cookie') !== originalCookie) throw new ChangedIdentity();
    const current = getGoogleSessionFromRequest(request);
    if (!unambiguousCookie(request) || !current || current.subject !== session.subject
      || current.issuedAt !== session.issuedAt) throw new ChangedIdentity();
  };
  const run = <T>(start: () => Promise<T>, late?: (value: T) => void): Promise<T> => {
    check();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = () => { settled = true; clearTimeout(timer); rejectStep = undefined; };
      rejectStep = () => { finish(); reject(new Error('Local generation unavailable')); };
      const timer = setTimeout(stop, Math.max(1, Math.min(STAGE_MS, deadline - performance.now())));
      try {
        void start().then(value => {
          if (settled) { try { late?.(value); } catch { /* Observe late cleanup, never resume SQL. */ } return; }
          finish(); resolve(value);
        }, error => { if (!settled) { finish(); reject(error); } });
      } catch (error) { if (!settled) { finish(); reject(error); } }
    });
  };
  const query = (text: string, values?: unknown[]) => {
    check(); checkIdentity();
    const config = { text, values, types: scalarTypes,
      query_timeout: Math.max(1, Math.floor(Math.min(STAGE_MS, deadline - performance.now()))) };
    return run(() => client!.query(config));
  };
  request.signal.addEventListener('abort', stop, { once: true });
  try {
    check();
    client = await run(() => runtimePool().connect(), late => {
      try { late.release(true); } catch { try { void late.end().catch(() => {}); } catch { /* No raw error. */ } }
    });
    client.on('error', stop);
    check(); checkIdentity();
    await query('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
    await query("SET LOCAL statement_timeout = '1500ms'");
    await query("SET LOCAL lock_timeout = '500ms'");
    await query("SET LOCAL idle_in_transaction_session_timeout = '5000ms'");
    const security = await query(SECURITY_SQL);
    if (!runtimeSafe(security)) throw new Error('Unsafe runtime context');
    let result: PersistedLocalGenerationReadResult;
    try {
      const { tenant } = await resolveTenantContext(slug, {
        async findBySlug(canonicalSlug) {
          const data = await query(TENANT_SQL, [canonicalSlug]);
          if (!validRows(data, TENANT_FIELDS)) throw new Error('Invalid directory result');
          const row = data.rows[0];
          if (!row || !boundedString(row.id, 36) || !UUID.test(row.id) || !boundedString(row.slug, 63)
            || !boundedString(row.display_name, 1024) || row.timezone !== 'Asia/Seoul'
            || !LIFECYCLES.includes(row.lifecycle)) return null;
          return { id: row.id, slug: row.slug, displayName: row.display_name, lifecycle: row.lifecycle,
            timezone: row.timezone } as TenantRecord;
        },
      });
      const membership = await authorizeTenantAdmin(tenant, session, {
        async findByTenantAndSubject(tenantId, subject) {
          const data = await query(MEMBER_SQL, [tenantId, subject]);
          if (!validRows(data, MEMBER_FIELDS)) throw new Error('Invalid membership result');
          const row = data.rows[0];
          if (!row || !boundedString(row.id, 36) || !UUID.test(row.id)
            || !boundedString(row.user_id, 36) || !UUID.test(row.user_id) || !boundedString(row.google_subject, 1024)) return null;
          return { id: row.id, tenantId: row.tenant_id, userId: row.user_id, googleSubject: row.google_subject,
            role: row.role } as TenantMembership;
        },
      });
      await query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);
      const data = await query(GENERATION_SQL, [tenant.id, session.subject, selected.jobId,
        membership.id, membership.userId, tenant.slug, selected.generationId]);
      check(); checkIdentity();
      result = project(data, tenant.id, selected);
    } catch (error) {
      if (error instanceof TenantContextError || error instanceof TenantAuthorizationError) result = { kind: 'FORBIDDEN' };
      else throw error;
    }
    check(); checkIdentity();
    await query('ROLLBACK');
    rolledBack = true;
    check(); checkIdentity();
    release(false); // Cleanup must finish successfully BEFORE publication.
    check(); checkIdentity();
    return result;
  } catch (error) {
    return error instanceof ChangedIdentity ? { kind: 'UNAUTHENTICATED' } : unavailable();
  } finally {
    request.signal.removeEventListener('abort', stop);
    try { release(!rolledBack); } catch { /* Already refused; sanitized result only. */ }
  }
}
