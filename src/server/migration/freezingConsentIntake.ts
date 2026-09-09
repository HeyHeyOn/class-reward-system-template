import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import { createFreezingConsentUrl, MIGRATION_CALLBACK_PATH, withVerifiedFreezingAuthorization, type FreezingOAuthDependencies } from './googleSheetsConsent';
import { readFreezingConsentSession, revalidateFreezingConsentSession, issueFreezingConsentSynchronizer, verifyFreezingConsentPost, type FreezingConsentSession } from './freezingConsentSession';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { createGoogleWorkbookSnapshotReader } from './googleWorkbookSnapshotReader';
import { createLegacyNormalizationManifest } from './manifest';
import { canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';
import { appendStartFreezingIntent, confirmStartFreezingIntent, detachStartFreezingDisplay, detachStartFreezingRegistration, makeStartFreezingIntent, readStartFreezingConfirmation, type StartFreezingIntent, type StartFreezingRegistration } from './startFreezingCeremony';

const PURPOSE = 'CLASS_STORE_FREEZING_CONSENT_V1';
const SCOPE = 'CONSENT_AND_SHEET_CAPTURE_ONLY';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const LIFETIME = 300_000;
type Environment = Readonly<Record<string, string | undefined>>;
export type FreezingConsentBinding = Readonly<{
  purpose: typeof PURPOSE; tenantId: string; challengeId: string; migrationJobId: string;
  sourceId: string; expectedStateVersion: string; actorUserId: string; actorSubject: string; actorEmail: string;
  sessionBinding: string; csrfDigest: string; spreadsheetId: string; externalSourceId: string;
  jobSemanticFingerprint: string; sourceAcquisitionDigest: string; preflightSnapshotId: string; preflightDigest: string;
  clientId: string; callback: string; nonce: string; issuedAt: number; expiresAt: number;
}>;
type Binding = FreezingConsentBinding;
type Receipt = Readonly<{
  purpose: typeof PURPOSE; scope: typeof SCOPE; tenantId: string; challengeId: string;
  migrationJobId: string; sourceId: string; challengeDigest: string; captureDigest: string;
  acquisitionDigest: string; normalizationDigest: string; status: 'BLOCKED' | 'READY_FOR_IMPORT';
}>;
declare const consentBrand: unique symbol;
export type VerifiedFreezingConsent = Readonly<{ [consentBrand]: true }>;
const verified = new WeakMap<VerifiedFreezingConsent, Receipt>();
const verifiedStart = new WeakMap<VerifiedFreezingConsent, Readonly<{ intent: StartFreezingIntent; consent: Receipt; binding: Binding; stateDigest: string }>>();
/** Live callback metadata only. No setter, JSON or archival reconstruction. */
export function readVerifiedStartFreezingConsent(handle: VerifiedFreezingConsent) {
  const result = verifiedStart.get(handle);
  if (!result) refused();
  return result;
}
/** No reconstruction from database rows or JSON. This is NOT start/freeze authority. */
export function readVerifiedFreezingConsent(handle: VerifiedFreezingConsent): Receipt {
  const result = verified.get(handle);
  if (!result) refused();
  return result;
}
type Dependencies = Readonly<{
  tenantId: string; origin: string; env?: Environment; runTransaction: TenantImportTransactionRunner;
  registeredSheets: readonly Readonly<{ tenantId: string; sourceId: string; spreadsheetId: string }>[];
  oauth?: Pick<FreezingOAuthDependencies, 'createClient'>;
  startRegistration?: StartFreezingRegistration;
}>;
/** Internal request-local composition, not a route or global tenant resolver.
 * tenantId MUST come from the canonical dispatcher/directory, never request data.
 * issueChallenge is identity-only display/CSRF issuance, not approval. Its token
 * must be delivered only by a same-origin no-store endpoint. begin verifies the
 * actual synchronizer POST. freezingConsentHandlers rebinds the encrypted routing
 * hint through the canonical directory; this service binds exact login + state.
 * The runner must resolve ONLY after acknowledged COMMIT and discard uncertain
 * connections. No OAuth/capture call occurs inside any transaction callback.
 */
export function createFreezingConsentIntake(dependencies: Dependencies) {
  const { tenantId, origin, runTransaction } = dependencies;
  const env = Object.freeze({ ...(dependencies.env ?? process.env) });
  const oauth = { ...dependencies.oauth, env };
  const startRegistration = dependencies.startRegistration ? detachStartFreezingRegistration(dependencies.startRegistration) : undefined;
  const registrations = dependencies.registeredSheets.map(row => Object.freeze({ ...row }));
  if (!UUID.test(tenantId) || !origin.startsWith('https://') || new URL(origin).origin !== origin) refused();
  const clientId = env.MIGRATION_GOOGLE_CLIENT_ID?.trim();
  if (!clientId) refused();
  const callback = `${origin}${MIGRATION_CALLBACK_PATH}`;
  function registration(sourceId: string, externalSourceId: string): string {
    const rows = registrations.filter(row => row.tenantId === tenantId && row.sourceId === sourceId);
    if (rows.length !== 1) refused();
    const id = rows[0].spreadsheetId;
    text(id, 512);
    if (sha256(id) !== externalSourceId) refused();
    return id;
  }
  function fresh(b: Binding, session: FreezingConsentSession, request: Request, now: number) {
    if (b.tenantId !== tenantId || b.actorSubject !== session.subject || b.actorEmail !== session.email
      || b.sessionBinding !== session.sessionBinding || b.clientId !== clientId || b.callback !== callback
      || b.issuedAt > now || b.expiresAt <= now) refused();
    revalidateFreezingConsentSession(session, request, origin, now, env);
  }
  async function current(tx: TenantTransaction, jobId: string, version: string, sourceId: string, session: FreezingConsentSession, observedState: 'READY' | 'FREEZING' = 'READY') {
    const tenants = (await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`)).rows;
    if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING') refused();
    const jobs = (await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint FROM migration_jobs
      WHERE tenant_id=${tenantId} AND job_id=${jobId} FOR UPDATE`)).rows;
    if (jobs.length !== 1 || jobs[0].status !== observedState || jobs[0].version !== (observedState === 'READY' ? version : String(BigInt(version) + BigInt(1)))) refused();
    // FOR UPDATE also serializes FK snapshot inserts. READ COMMITTED below is
    // mandatory so the exact-one predicate is refreshed after a preceding wait.
    const sources = (await tx.execute(sql`SELECT provider,external_source_id,source_fingerprint FROM migration_sources
      WHERE tenant_id=${tenantId} AND job_id=${jobId} AND source_id=${sourceId} FOR UPDATE`)).rows;
    if (sources.length !== 1 || sources[0].provider !== 'GOOGLE_SHEETS') refused();
    const actors = (await tx.execute(sql`SELECT u.id,u.canonical_email FROM users u JOIN tenant_memberships m ON m.user_id=u.id
      WHERE m.tenant_id=${tenantId} AND u.google_subject=${session.subject} AND m.role IN ('OWNER','ADMIN') FOR SHARE OF u,m`)).rows;
    if (actors.length !== 1 || actors[0].canonical_email !== session.email) refused();
    const snapshots = (await tx.execute(sql`SELECT snapshot_id,artifact_digest FROM migration_snapshots
      WHERE tenant_id=${tenantId} AND job_id=${jobId} AND source_id=${sourceId} AND phase='PREFLIGHT' FOR SHARE`)).rows;
    if (snapshots.length !== 1) refused();
    const result = { actorUserId: String(actors[0].id), externalSourceId: String(sources[0].external_source_id),
      jobSemanticFingerprint: String(jobs[0].source_fingerprint), sourceAcquisitionDigest: String(sources[0].source_fingerprint),
      preflightSnapshotId: String(snapshots[0].snapshot_id), preflightDigest: String(snapshots[0].artifact_digest) };
    for (const value of [result.externalSourceId, result.jobSemanticFingerprint, result.sourceAcquisitionDigest, result.preflightDigest]) if (!DIGEST.test(value)) refused();
    return { ...result, spreadsheetId: registration(sourceId, result.externalSourceId) };
  }
  async function check(tx: TenantTransaction, b: Binding, session: FreezingConsentSession, request: Request, observedState: 'READY' | 'FREEZING' = 'READY') {
    fresh(b, session, request, await databaseNow(tx));
    const rows = await current(tx, b.migrationJobId, b.expectedStateVersion, b.sourceId, session, observedState);
    for (const key of Object.keys(rows) as (keyof typeof rows)[]) if (b[key] !== rows[key]) refused();
    fresh(b, session, request, await databaseNow(tx));
  }
  async function challenge(tx: TenantTransaction, id: string): Promise<Binding> {
    const data = await load(tx, 'challenges', tenantId, id);
    const b = parseBinding(data);
    if (b.tenantId !== tenantId || b.challengeId !== id) refused();
    return b;
  }
  return {
    /** Revalidation only: genuine start capability is checked before any SQL.
     * Caller owns a short READ COMMITTED transaction; no handle is minted here. */
    async revalidateStart(tx: TenantTransaction, rawRequest: Request, handle: VerifiedFreezingConsent, observedState: 'READY' | 'FREEZING' = 'READY') {
      const live = readVerifiedStartFreezingConsent(handle);
      const request = detachRequest(rawRequest);
      const session = readFreezingConsentSession(request, origin, env);
      if (!startRegistration) refused();
      equal(live.intent, makeStartFreezingIntent(live.binding, startRegistration));
      await isolation(tx);
      equal(await challenge(tx, live.binding.challengeId), live.binding);
      await check(tx, live.binding, session, request, observedState);
      await readStartFreezingConfirmation(tx, live.intent, live.stateDigest);
      equal(await load(tx, 'captures', tenantId, live.binding.challengeId), live.consent);
      fresh(live.binding, session, request, await databaseNow(tx));
      return live;
    },
    async issueChallenge(rawRequest: Request, raw: unknown) {
      try {
        const input = exact(raw, ['migrationJobId', 'expectedStateVersion', 'sourceId']);
        text(input.migrationJobId, 1024); text(input.sourceId, 1024); stateVersion(input.expectedStateVersion);
        const { migrationJobId, expectedStateVersion, sourceId } = input as Record<string, string>;
        const request = detachRequest(rawRequest);
        const session = readFreezingConsentSession(request, origin, env);
        const csrf = issueFreezingConsentSynchronizer();
        const b = await runTransaction(tenantId, async tx => {
          await isolation(tx);
          const rows = await current(tx, migrationJobId, expectedStateVersion, sourceId, session);
          const now = await databaseNow(tx);
          const binding = parseBinding({ purpose: PURPOSE, tenantId, challengeId: randomUUID(), migrationJobId, sourceId,
            expectedStateVersion, ...rows, actorSubject: session.subject, actorEmail: session.email,
            sessionBinding: session.sessionBinding, csrfDigest: csrf.digest, clientId, callback,
            nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + LIFETIME });
          fresh(binding, session, request, now);
          await tx.execute(sql`INSERT INTO migration_consent_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,binding)
            VALUES(${tenantId},${binding.challengeId},${migrationJobId},${sourceId},${binding.actorUserId},${JSON.stringify(binding)}::jsonb)`);
          equal(await challenge(tx, binding.challengeId), binding);
          if (startRegistration) await appendStartFreezingIntent(tx, makeStartFreezingIntent(binding, startRegistration));
          fresh(binding, session, request, await databaseNow(tx));
          return binding;
        });
        // No digest/session secrets are sent to the display. Raw Sheet is the
        // exact server registration, not the source identity digest field.
        return Object.freeze({ challengeId: b.challengeId, csrfToken: csrf.token, tenantId, migrationJobId,
          sourceId, spreadsheetId: b.spreadsheetId, expectedStateVersion, jobSemanticFingerprint: b.jobSemanticFingerprint,
          sourceAcquisitionDigest: b.sourceAcquisitionDigest, preflightSnapshotId: b.preflightSnapshotId,
          preflightDigest: b.preflightDigest, expiresAt: b.expiresAt,
          ...(startRegistration ? { startDisplay: makeStartFreezingIntent(b, startRegistration).display,
            startIntentDigest: sha256(canonicalJson(makeStartFreezingIntent(b, startRegistration))) } : {}) });
      } catch { return refused(); }
    },
    async begin(rawRequest: Request, raw: unknown): Promise<string> {
      try {
        const input = exact(raw, startRegistration ? ['challengeId', 'display'] : ['challengeId']);
        const display = startRegistration ? detachStartFreezingDisplay(input.display) : undefined;
        const id = uuid(input.challengeId);
        const request = detachRequest(rawRequest);
        const session = readFreezingConsentSession(request, origin, env);
        const state = `${id}.${randomBytes(32).toString('hex')}`;
        return await runTransaction(tenantId, async tx => {
          await isolation(tx);
          const b = await challenge(tx, id);
          verifyFreezingConsentPost(request, origin, b.csrfDigest, session, env);
          await check(tx, b, session, request);
          const binding = { purpose: PURPOSE, tenantId, challengeId: id, challengeDigest: sha256(canonicalJson(b)), stateDigest: sha256(state) };
          // URL construction can fail on misconfiguration: do it before commit.
          const url = createFreezingConsentUrl(origin, state, b.nonce, env);
          await tx.execute(sql`INSERT INTO migration_consent_confirmations(tenant_id,challenge_id,binding)
            VALUES(${tenantId},${id},${JSON.stringify(binding)}::jsonb)`);
          equal(await load(tx, 'confirmations', tenantId, id), binding);
          if (startRegistration && display) await confirmStartFreezingIntent(tx, makeStartFreezingIntent(b, startRegistration), display, sha256(state));
          fresh(b, session, request, await databaseNow(tx));
          return url;
        });
      } catch { return refused(); }
    },
    async complete(rawRequest: Request): Promise<VerifiedFreezingConsent> {
      try {
        const request = detachRequest(rawRequest);
        const url = new URL(request.url);
        if (request.method !== 'GET' || `${url.origin}${url.pathname}` !== callback || url.hash
          || !['code,state', 'error,state'].includes([...url.searchParams.keys()].sort().join(','))) refused();
        const denied = url.searchParams.has('error');
        const code = url.searchParams.get(denied ? 'error' : 'code'); text(code, 4096);
        const state = url.searchParams.get('state'); text(state, 101);
        if (!/^[0-9a-f-]{36}\.[0-9a-f]{64}$/.test(state)) refused();
        const id = uuid(state.slice(0, 36));
        const session = readFreezingConsentSession(request, origin, env);
        // Reservation is terminal even if provider exchange never finishes. A
        // lost commit ACK throws before the OAuth helper is entered. No retries.
        const b = await runTransaction(tenantId, async tx => {
          await isolation(tx);
          const binding = await challenge(tx, id);
          await check(tx, binding, session, request);
          const confirmation = { purpose: PURPOSE, tenantId, challengeId: id,
            challengeDigest: sha256(canonicalJson(binding)), stateDigest: sha256(state) };
          equal(await load(tx, 'confirmations', tenantId, id), confirmation);
          if (startRegistration) await readStartFreezingConfirmation(tx, makeStartFreezingIntent(binding, startRegistration), sha256(state));
          await tx.execute(sql`INSERT INTO migration_consent_attempts(tenant_id,challenge_id,binding)
            VALUES(${tenantId},${id},${JSON.stringify(confirmation)}::jsonb)`);
          equal(await load(tx, 'attempts', tenantId, id), confirmation);
          fresh(binding, session, request, await databaseNow(tx));
          return binding;
        });
        // A provider denial burns the same durable attempt without exchanging a code.
        if (denied) refused();
        const sheets = await withVerifiedFreezingAuthorization(origin, code,
          { subject: session.subject, email: session.email, nonce: b.nonce }, authorization =>
            captureSheetsSnapshot({ spreadsheetId: b.spreadsheetId, capturedAt: new Date().toISOString(),
              reader: createGoogleWorkbookSnapshotReader(authorization, b.spreadsheetId) }), oauth);
        // The real helper has completed revocation AND credential clearing now.
        // Normalization preserves BLOCKED/quarantine diagnostics; neither status
        // here grants permission to start freezing or import this acquisition.
        const normalization = createLegacyNormalizationManifest({ tenantId, migrationJobId: b.migrationJobId, sheets });
        const capture = { sheets, normalization };
        const captureBytes = canonicalJson(capture);
        if (Buffer.byteLength(captureBytes, 'utf8') > 8_000_000) refused();
        const receipt: Receipt = Object.freeze({ purpose: PURPOSE, scope: SCOPE, tenantId, challengeId: id,
          migrationJobId: b.migrationJobId, sourceId: b.sourceId, challengeDigest: sha256(canonicalJson(b)),
          captureDigest: sha256(captureBytes), acquisitionDigest: sheets.digest,
          normalizationDigest: normalization.manifestDigest, status: normalization.status });
        await runTransaction(tenantId, async tx => {
          await isolation(tx);
          equal(await challenge(tx, id), b);
          await check(tx, b, session, request);
          const confirmation = { purpose: PURPOSE, tenantId, challengeId: id,
            challengeDigest: receipt.challengeDigest, stateDigest: sha256(state) };
          equal(await load(tx, 'confirmations', tenantId, id), confirmation);
          equal(await load(tx, 'attempts', tenantId, id), confirmation);
          if (startRegistration) await readStartFreezingConfirmation(tx, makeStartFreezingIntent(b, startRegistration), sha256(state));
          await tx.execute(sql`INSERT INTO migration_consent_captures(tenant_id,challenge_id,binding,capture)
            VALUES(${tenantId},${id},${JSON.stringify(receipt)}::jsonb,${captureBytes}::jsonb)`);
          equal(await load(tx, 'captures', tenantId, id), receipt);
          const rows = (await tx.execute(sql`SELECT capture FROM migration_consent_captures WHERE tenant_id=${tenantId} AND challenge_id=${id}`)).rows;
          if (rows.length !== 1) refused();
          equal(rows[0].capture, capture);
          fresh(b, session, request, await databaseNow(tx));
        });
        // Only the acknowledged final commit reaches this registry. Archival
        // capture/receipt readback intentionally has no capability recovery API.
        const handle = Object.freeze({}) as VerifiedFreezingConsent;
        verified.set(handle, receipt);
        if (startRegistration) verifiedStart.set(handle, deepFreeze({ intent: makeStartFreezingIntent(b, startRegistration), consent: receipt, binding: b, stateDigest: sha256(state) }));
        return handle;
      } catch { return refused(); }
    },
  };
}
const BINDING_KEYS = ['purpose','tenantId','challengeId','migrationJobId','sourceId','expectedStateVersion','actorUserId',
  'actorSubject','actorEmail','sessionBinding','csrfDigest','spreadsheetId','externalSourceId','jobSemanticFingerprint',
  'sourceAcquisitionDigest','preflightSnapshotId','preflightDigest','clientId','callback','nonce','issuedAt','expiresAt'];
function parseBinding(raw: unknown): Binding {
  const b = exact(raw, BINDING_KEYS);
  if (b.purpose !== PURPOSE) refused();
  for (const key of ['tenantId','challengeId','actorUserId']) uuid(b[key]);
  for (const key of ['migrationJobId','sourceId','actorSubject','actorEmail','spreadsheetId','preflightSnapshotId','clientId','callback']) text(b[key], 1024);
  for (const key of ['sessionBinding','csrfDigest','externalSourceId','jobSemanticFingerprint','sourceAcquisitionDigest','preflightDigest','nonce']) if (typeof b[key] !== 'string' || !DIGEST.test(b[key])) refused();
  stateVersion(b.expectedStateVersion);
  if (typeof b.issuedAt !== 'number' || typeof b.expiresAt !== 'number' || !Number.isSafeInteger(b.issuedAt)
    || !Number.isSafeInteger(b.expiresAt) || b.issuedAt < 0 || b.expiresAt - b.issuedAt !== LIFETIME) refused();
  return deepFreeze(b) as Binding;
}
function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== keys.length) refused();
  const detached: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !('value' in d)) refused();
    detached[key] = d.value;
  }
  return detached;
}
function detachRequest(request: Request): Request {
  if (!(request instanceof Request)) refused();
  return new Request(request.url, { method: request.method, headers: new Headers(request.headers) });
}
async function isolation(tx: TenantTransaction) {
  const rows = (await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`)).rows;
  if (rows.length !== 1 || rows[0].isolation !== 'read committed') refused();
}
async function databaseNow(tx: TenantTransaction): Promise<number> {
  const rows = (await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows;
  if (rows.length !== 1) refused();
  const now = Number(rows[0].ms);
  if (!Number.isSafeInteger(now) || now < 0) refused();
  return now;
}
async function load(tx: TenantTransaction, table: 'challenges' | 'confirmations' | 'attempts' | 'captures', tenantId: string, id: string): Promise<unknown> {
  const name = sql.raw(`migration_consent_${table}`); // closed server enum, never request text
  const rows = (await tx.execute(sql`SELECT binding FROM ${name} WHERE tenant_id=${tenantId} AND challenge_id=${id}`)).rows;
  if (rows.length !== 1) refused();
  return rows[0].binding;
}
function equal(actual: unknown, expected: unknown) { if (canonicalJson(actual) !== canonicalJson(expected)) refused(); }
function uuid(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) refused(); return value; }
function text(value: unknown, max: number): asserts value is string { if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value) refused(); }
function stateVersion(value: unknown) { if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) refused(); }
function refused(): never { throw Error('Freezing consent intake refused.'); }
