import 'server-only';
import { createHmac, randomBytes, randomUUID, timingSafeEqual, type KeyLike } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import { canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';
import { readFreezingConsentSession, revalidateFreezingConsentSession, type FreezingConsentSession } from './freezingConsentSession';
import { FREEZING_REACQUISITION_PURPOSE as PURPOSE, FREEZING_REACQUISITION_SCOPE as ACTION,
  exactFreezingData as exact, parseFreezingReacquisitionChallenge as parseChallenge,
  refuseFreezingReacquisition as refused, type FreezingReacquisitionChallenge } from './freezingReacquisitionContract';
import { openFreezingReacquisitionEnvelope, signFreezingReacquisitionRequest, validateFreezingReacquisitionRegistration,
  type FreezingReacquisitionRegistration } from './registeredFreezingReacquisition';
import { readBridgeBytes, BRIDGE_RESPONSE_LIMIT } from './registeredBridgeProducer';

const BOOTSTRAP = 'CLASS_STORE_FREEZING_REACQUISITION_BOOTSTRAP_V1';
const COOKIE = '__Secure-class_store_reacquisition_bootstrap';
const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Display = Readonly<FreezingReacquisitionChallenge & { action: typeof ACTION; spreadsheetId: string;
  authority: 'NONAUTHORITY'; exclusion: 'NOT_PROVEN'; finalImportEligible: false; automaticRetry: false; automaticEnable: false }>;
type Intent = Readonly<{ challenge: FreezingReacquisitionChallenge; display: Display; csrfDigest: string; intentDigest: string }>;
type Dependencies = Readonly<{ tenantId: string; migrationJobId: string; origin: string; canonicalPath: string;
  registration: FreezingReacquisitionRegistration; requestPrivateKey: KeyLike; encryptionKey: Uint8Array; manifestKeyId: string;
  runTransaction: TenantImportTransactionRunner; env?: Readonly<Record<string,string | undefined>> }>;
const equal = (a: unknown, b: unknown) => { if (canonicalJson(a) !== canonicalJson(b)) refused(); };
const digestToken = (phase: string, token: string) => sha256(canonicalJson([PURPOSE, phase, token]));
const token = () => randomBytes(32).toString('hex');
const response = (status: number, body: unknown, cookie?: string) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) },
});
const unknown = () => response(202, { status: 'UNKNOWN', externalEffect: 'UNKNOWN', automaticRetry: false, automaticEnable: false });

/** Internal, canonical-tenant-bound HTTP composition. Only low-level SQL and
 * server configuration are injected. No route export or production env factory
 * is installed by this slice; callers must never derive these dependencies from
 * request fields. All successful results are permanently diagnostic facts. */
export function createFreezingReacquisitionIntake(dependencies: Dependencies) {
  const { tenantId, migrationJobId, origin, canonicalPath, runTransaction, requestPrivateKey, manifestKeyId } = dependencies;
  const env = Object.freeze({ ...(dependencies.env ?? process.env) });
  const registration = validateFreezingReacquisitionRegistration(dependencies.registration);
  const encryptionKey = Buffer.from(dependencies.encryptionKey);
  const secret = env.AUTH_SECRET;
  if (!UUID.test(tenantId) || !UUID.test(migrationJobId) || registration.tenantId !== tenantId || encryptionKey.length !== 32
    || !secret || secret.length < 32 || secret.length > 1024 || secret.trim() !== secret
    || !origin.startsWith('https://') || new URL(origin).origin !== origin
    || !/^\/api\/c\/[a-z0-9-]+\/migrations\/[0-9a-f-]{36}\/freezing\/reacquisition$/.test(canonicalPath)
    || canonicalPath.split('/')[5] !== migrationJobId) refused();
  const cookieAttributes = `Path=${canonicalPath}; HttpOnly; Secure; SameSite=Strict`;
  const clear = `${COOKIE}=; Max-Age=0; ${cookieAttributes}`;
  const mac = (bytes: string) => createHmac('sha256', secret).update(canonicalJson([BOOTSTRAP, origin, canonicalPath, bytes])).digest('hex');
  const display = (b: FreezingReacquisitionChallenge): Display => deepFreeze({ ...b, action: ACTION,
    spreadsheetId: registration.spreadsheetId, authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', finalImportEligible: false,
    automaticRetry: false, automaticEnable: false });
  const intentDigest = (b: FreezingReacquisitionChallenge, d: Display) => sha256(canonicalJson([PURPOSE, b, d]));
  // Refuse re-entry even if an accidentally retrying runner is supplied.
  async function transaction<T>(fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
    let entered = false;
    return runTransaction(tenantId, async tx => {
      if (entered) refused(); entered = true;
      const rows = (await tx.execute(sql`SHOW transaction_isolation`)).rows;
      if (rows.length !== 1 || rows[0].transaction_isolation !== 'read committed') refused();
      return fn(tx);
    });
  }
  function authenticate(request: Request, method: string, suffix: string): FreezingConsentSession {
    if (request.method !== method || request.url !== origin + canonicalPath + suffix || request.signal.aborted
      || request.headers.has('content-encoding') || request.headers.get('sec-fetch-site') !== 'same-origin'
      || (method === 'POST' ? request.headers.get('origin') !== origin : ![null, origin].includes(request.headers.get('origin')))
      || (method === 'POST' && request.headers.get('content-type') !== 'application/json')) refused();
    return readFreezingConsentSession(request, origin, env);
  }
  async function clock(tx: TenantTransaction) {
    const rows = (await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows;
    const now = Number(rows[0]?.ms); if (rows.length !== 1 || !Number.isSafeInteger(now) || now < 0) refused(); return now;
  }
  function fresh(session: FreezingConsentSession, request: Request, now: number, b?: {issuedAt:number; expiresAt:number}) {
    revalidateFreezingConsentSession(session, request, origin, now, env);
    if (request.signal.aborted || (b && (b.issuedAt > now || now >= b.expiresAt))) refused();
  }
  async function member(tx: TenantTransaction, session: FreezingConsentSession) {
    const rows = (await tx.execute(sql`SELECT u.id,u.canonical_email FROM users u JOIN tenant_memberships m ON m.user_id=u.id
      WHERE m.tenant_id=${tenantId} AND u.google_subject=${session.subject} AND m.role IN ('OWNER','ADMIN') FOR SHARE OF u,m`)).rows;
    if (rows.length !== 1 || rows[0].canonical_email !== session.email) refused(); return String(rows[0].id);
  }
  async function current(tx: TenantTransaction, session: FreezingConsentSession, request: Request, b?: FreezingReacquisitionChallenge) {
    fresh(session, request, await clock(tx), b);
    const tenants = (await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`)).rows;
    if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING') refused();
    const jobs = (await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint,freeze_started_at,freeze_verified_at,final_fingerprint,completed_at
      FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id=${migrationJobId} FOR UPDATE`)).rows;
    const j = jobs[0];
    if (jobs.length !== 1 || j.status !== 'FREEZING' || !j.freeze_started_at || j.freeze_verified_at !== null || j.final_fingerprint !== null || j.completed_at !== null) refused();
    const sources = (await tx.execute(sql`SELECT provider,external_source_id,source_fingerprint FROM migration_sources
      WHERE tenant_id=${tenantId} AND job_id=${migrationJobId} AND source_id=${registration.sourceId} FOR UPDATE`)).rows;
    const s = sources[0];
    if (sources.length !== 1 || s.provider !== 'GOOGLE_SHEETS' || s.external_source_id !== sha256(registration.spreadsheetId)) refused();
    const actorUserId = await member(tx, session);
    const preflights = (await tx.execute(sql`SELECT snapshot_id,artifact_digest FROM migration_snapshots
      WHERE tenant_id=${tenantId} AND job_id=${migrationJobId} AND source_id=${registration.sourceId} AND phase='PREFLIGHT' FOR SHARE`)).rows;
    if (preflights.length !== 1) refused();
    const p = preflights[0];
    const starts = (await tx.execute(sql`SELECT e.ceremony_id,e.binding,e.audit_event_id,a.redacted_details,a.job_id,a.actor_user_id,a.event_type
      FROM migration_start_executions e JOIN audit_events a ON a.tenant_id=e.tenant_id AND a.event_id=e.audit_event_id
      WHERE e.tenant_id=${tenantId} AND e.job_id=${migrationJobId}`)).rows;
    if (starts.length !== 1) refused();
    const start = starts[0]; const e = start.binding as Record<string,unknown>;
    if (e.purpose !== 'CLASS_STORE_START_EXECUTION_V1' || e.status !== 'STARTED' || e.exclusion !== 'NOT_PROVEN'
      || e.tenantId !== tenantId || e.migrationJobId !== migrationJobId || e.sourceId !== registration.sourceId
      || e.ceremonyId !== start.ceremony_id || e.stateVersion !== j.version
      || e.jobSemanticFingerprint !== j.source_fingerprint || e.sourceAcquisitionDigest !== s.source_fingerprint
      || e.preflightSnapshotId !== p.snapshot_id || e.preflightDigest !== p.artifact_digest
      || e.auditEventId !== start.audit_event_id || e.acquisitionDigest !== sha256(canonicalJson(start.redacted_details))
      || start.job_id !== migrationJobId || start.actor_user_id !== e.actorUserId || start.event_type !== 'AUTHENTIC_START_ACQUISITION') refused();
    const value = { tenantId, migrationJobId, expectedStateVersion: String(j.version), sourceId: registration.sourceId,
      spreadsheetIdDigest: String(s.external_source_id), jobSemanticFingerprint: String(j.source_fingerprint), sourceAcquisitionDigest: String(s.source_fingerprint),
      actorUserId, actorSubject: session.subject, sessionBinding: session.sessionBinding,
      startCeremonyId: String(start.ceremony_id), executionDigest: sha256(canonicalJson(e)),
      preflightSnapshotId: String(p.snapshot_id), preflightSnapshotDigest: String(p.artifact_digest),
      deploymentId: registration.deploymentId, registrationDigest: registration.registrationDigest, registrationVersion: registration.registrationVersion };
    if (b) for (const key of Object.keys(value) as (keyof typeof value)[]) if (b[key] !== value[key]) refused();
    fresh(session, request, await clock(tx), b);
    return value;
  }
  async function load(tx: TenantTransaction, id: string): Promise<Intent> {
    if (!UUID.test(id)) refused();
    const rows = (await tx.execute(sql`SELECT binding FROM migration_reacquisition_challenges WHERE tenant_id=${tenantId} AND challenge_id=${id}`)).rows;
    if (rows.length !== 1) refused();
    const v = exact(rows[0].binding, ['challenge','display','csrfDigest','intentDigest']); const b = parseChallenge(v.challenge);
    if (b.tenantId !== tenantId || b.migrationJobId !== migrationJobId || b.challengeId !== id || typeof v.csrfDigest !== 'string' || !DIGEST.test(v.csrfDigest)) refused();
    equal(v.display, display(b)); if (v.intentDigest !== intentDigest(b, display(b))) refused();
    return deepFreeze({ challenge: b, display: display(b), csrfDigest: v.csrfDigest, intentDigest: String(v.intentDigest) });
  }
  function csrf(request: Request, phase: string, expected: string) {
    const value = request.headers.get('x-csrf-token');
    if (!value || !DIGEST.test(value) || !DIGEST.test(expected)
      || !timingSafeEqual(Buffer.from(digestToken(phase, value),'hex'),Buffer.from(expected,'hex'))) refused();
  }
  async function body(request: Request) {
    const controller = new AbortController(); const abort = () => controller.abort(); const timer = setTimeout(abort, 5000);
    request.signal.addEventListener('abort', abort, {once:true}); if (request.signal.aborted) abort();
    try { return JSON.parse(await readBridgeBytes(request.body, 8192, controller.signal)) as unknown; }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
  }
  function bootstrapCookie(request: Request, session: FreezingConsentSession) {
    const values = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE+'='));
    if (values.length !== 1) refused();
    const encoded = values[0].slice(COOKIE.length+1); if (encoded.length > 4096) refused();
    const parts = encoded.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !DIGEST.test(parts[1])
      || !timingSafeEqual(Buffer.from(mac(parts[0]),'hex'),Buffer.from(parts[1],'hex'))) refused();
    const b = exact(JSON.parse(Buffer.from(parts[0],'base64url').toString('utf8')),
      ['purpose','tenantId','migrationJobId','actorUserId','actorSubject','sessionBinding','csrfDigest','issuedAt','expiresAt']);
    if (b.purpose !== BOOTSTRAP || b.tenantId !== tenantId || b.migrationJobId !== migrationJobId || b.actorSubject !== session.subject
      || b.sessionBinding !== session.sessionBinding || typeof b.actorUserId !== 'string' || !UUID.test(b.actorUserId)
      || typeof b.csrfDigest !== 'string' || !DIGEST.test(b.csrfDigest) || !Number.isSafeInteger(b.issuedAt) || !Number.isSafeInteger(b.expiresAt)
      || Number(b.expiresAt)-Number(b.issuedAt) !== 60_000) refused();
    csrf(request, BOOTSTRAP, b.csrfDigest);
    return { actorUserId: b.actorUserId, issuedAt: Number(b.issuedAt), expiresAt: Number(b.expiresAt) };
  }
  return Object.freeze({
    async bootstrap(request: Request): Promise<Response> {
      try {
        const session = authenticate(request, 'GET', '/bootstrap'); const csrfToken = token();
        const bootstrap = await transaction(async tx => {
          const state = await current(tx, session, request); const now = await clock(tx);
          return { purpose: BOOTSTRAP, tenantId, migrationJobId, actorUserId: state.actorUserId, actorSubject: session.subject,
            sessionBinding: session.sessionBinding, csrfDigest: digestToken(BOOTSTRAP,csrfToken), issuedAt: now, expiresAt: now+60_000 };
        });
        fresh(session, request, Date.now(), bootstrap);
        const encoded = Buffer.from(canonicalJson(bootstrap)).toString('base64url');
        return response(200, { csrfToken, expiresAt: bootstrap.expiresAt, scope: 'NONEXECUTING_BOOTSTRAP' }, `${COOKIE}=${encoded}.${mac(encoded)}; Max-Age=60; ${cookieAttributes}`);
      } catch { return response(403, { status: 'REFUSED' }); }
    },
    async challenge(request: Request): Promise<Response> {
      try {
        const session = authenticate(request, 'POST', '/challenge'); const bootstrap = bootstrapCookie(request, session);
        exact(await body(request), []); const csrfToken = token();
        const intent = await transaction(async tx => {
          const state = await current(tx, session, request); fresh(session, request, await clock(tx), bootstrap);
          if (bootstrap.actorUserId !== state.actorUserId) refused();
          const now = await clock(tx);
          const b = parseChallenge({ ...state, purpose: PURPOSE, bindingVersion: 1, expectedStatus: 'FREEZING', challengeId: randomUUID(), issuedAt: now, expiresAt: now+60_000 });
          const d = display(b); const i: Intent = { challenge: b, display: d, csrfDigest: digestToken('CONFIRMATION',csrfToken), intentDigest: intentDigest(b,d) };
          await tx.execute(sql`INSERT INTO migration_reacquisition_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,start_ceremony_id,preflight_snapshot_id,binding)
            VALUES(${tenantId},${b.challengeId},${migrationJobId},${b.sourceId},${b.actorUserId},${b.startCeremonyId},${b.preflightSnapshotId},${canonicalJson(i)}::jsonb)`);
          equal(await load(tx,b.challengeId),i); await current(tx,session,request,b); fresh(session,request,await clock(tx),bootstrap); return i;
        });
        fresh(session,request,Date.now(),intent.challenge);
        return response(200, { challengeId: intent.challenge.challengeId, display: intent.display, intentDigest: intent.intentDigest, csrfToken }, clear);
      } catch { return response(403, { status: 'REFUSED' }, clear); }
    },
    async confirm(request: Request): Promise<Response> {
      let reservationAttempted = false;
      try {
        const session = authenticate(request,'POST',''); const v = exact(await body(request),['challengeId','display']);
        if (typeof v.challengeId !== 'string' || !UUID.test(v.challengeId)) refused(); const id = v.challengeId;
        const i = await transaction(async tx => {
          const intent = await load(tx,id); csrf(request,'CONFIRMATION',intent.csrfDigest); equal(v.display,intent.display);
          await current(tx,session,request,intent.challenge); return intent;
        });
        const b = i.challenge;
        const signed = signFreezingReacquisitionRequest(registration,requestPrivateKey,{challenge:b});
        const dispatch = { purpose: PURPOSE, tenantId, challengeId: id, intentDigest: i.intentDigest,
          requestDigest: signed.requestDigest, registrationDigest: registration.registrationDigest };
        reservationAttempted = true;
        await transaction(async tx => {
          equal(await load(tx,id),i); await current(tx,session,request,b);
          await tx.execute(sql`INSERT INTO migration_reacquisition_dispatches(tenant_id,challenge_id,binding) VALUES(${tenantId},${id},${canonicalJson(dispatch)}::jsonb)`);
          const rows = (await tx.execute(sql`SELECT binding FROM migration_reacquisition_dispatches WHERE tenant_id=${tenantId} AND challenge_id=${id}`)).rows;
          if (rows.length !== 1) refused(); equal(rows[0].binding,dispatch); await current(tx,session,request,b);
        });
        // ACK is mandatory. Recheck current membership/session immediately before
        // send, with no transaction spanning the external operation.
        await transaction(async tx => { await current(tx,session,request,b); }); fresh(session,request,Date.now(),b);
        const controller = new AbortController(); const abort = () => controller.abort();
        request.signal.addEventListener('abort',abort,{once:true});
        const timer = setTimeout(abort,Math.min(15_000,b.expiresAt-Date.now()));
        let cancel: () => void = () => {};
        const aborted = new Promise<never>((_,reject) => { cancel=()=>reject(Error('Unavailable')); controller.signal.addEventListener('abort',cancel,{once:true}); });
        let raw: unknown;
        try {
          if (request.signal.aborted) abort();
          const r = await Promise.race([globalThis.fetch(registration.endpoint,{method:'POST',headers:signed.headers,body:signed.body,
            redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:controller.signal}),aborted]);
          if (r.status !== 200 || r.redirected || r.headers.get('content-type') !== 'application/json' || r.headers.has('content-encoding')) {
            void r.body?.cancel().catch(()=>{}); refused();
          }
          raw=JSON.parse(await readBridgeBytes(r.body,BRIDGE_RESPONSE_LIMIT,controller.signal));
        } finally { controller.abort(); clearTimeout(timer); request.signal.removeEventListener('abort',abort); controller.signal.removeEventListener('abort',cancel); }
        await transaction(async tx => { await current(tx,session,request,b); });
        const wrapper = exact(raw,['purpose','bindingVersion','envelope']);
        const envelope = exact(wrapper.envelope,['version','algorithm','keyId','nonce','issuedAt','expiresAt','iv','ciphertext','authTag','signature']);
        if (envelope.keyId !== manifestKeyId || typeof envelope.nonce !== 'string') refused();
        // The original digest framing is intentionally GLOBAL across central
        // phases. Phase-specific crypto nonce digest is retained separately.
        const nonceDigest = sha256(canonicalJson(['CLASS_STORE_FINAL_BRIDGE_NONCE_V1',envelope.nonce]));
        const candidate = await transaction(async tx => {
          await current(tx,session,request,b); equal(await load(tx,id),i);
          const rows = (await tx.execute(sql`SELECT binding FROM migration_reacquisition_dispatches WHERE tenant_id=${tenantId} AND challenge_id=${id}`)).rows;
          if (rows.length !== 1) refused(); equal(rows[0].binding,dispatch);
          let phaseNonceDigest: string | undefined;
          const payload = await openFreezingReacquisitionEnvelope(raw,{encryptionKey,signingPublicKey:registration.manifestPublicKey,expectedChallenge:b,
            nonceConsumer:{consumeOnce:async digest => { phaseNonceDigest=digest; return true; }}});
          if (!phaseNonceDigest || payload.sheetsSnapshot.spreadsheetId !== registration.spreadsheetId) refused();
          await current(tx,session,request,b);
          const audit = { kind:'AUTHENTIC_FREEZING_ACQUISITION', authority:'NONAUTHORITY', exclusion:'NOT_PROVEN', finalImportEligible:false,
            intentDigest:i.intentDigest, requestDigest:signed.requestDigest, envelopeDigest:sha256(canonicalJson(raw)), phaseNonceDigest, payload };
          const bytes=canonicalJson(audit); if (Buffer.byteLength(bytes)>8_000_000) refused();
          const candidateDigest=sha256(bytes); const auditEventId=`freezing-candidate:${id}:${candidateDigest}`;
          const binding = { purpose:PURPOSE, tenantId, challengeId:id, authority:'NONAUTHORITY', exclusion:'NOT_PROVEN', finalImportEligible:false,
            intentDigest:i.intentDigest, candidateDigest, auditEventId, nonceDigest, executionDigest:b.executionDigest,
            envelopeDigest:audit.envelopeDigest, sheetsDigest:payload.sheetsSnapshot.digest, redisDigest:payload.redisSnapshot.digest,
            normalizationDigest:payload.normalization.manifestDigest, observationDigest:sha256(canonicalJson(payload.localWriterObservation)) };
          await tx.execute(sql`INSERT INTO migration_bridge_consumptions(nonce_digest,tenant_id,challenge_id,freezing_challenge_id) VALUES(${nonceDigest},${tenantId},NULL,${id})`);
          const nonces=(await tx.execute(sql`SELECT nonce_digest,tenant_id,challenge_id,freezing_challenge_id FROM migration_bridge_consumptions WHERE nonce_digest=${nonceDigest}`)).rows;
          if (nonces.length!==1) refused(); equal(nonces[0],{nonce_digest:nonceDigest,tenant_id:tenantId,challenge_id:null,freezing_challenge_id:id});
          await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,actor_user_id,event_type,entity_type,entity_id,redacted_details)
            VALUES(${tenantId},${auditEventId},${migrationJobId},${b.actorUserId},'AUTHENTIC_FREEZING_ACQUISITION','MIGRATION_JOB',${migrationJobId},${bytes}::jsonb)`);
          const audits=(await tx.execute(sql`SELECT job_id,actor_user_id,event_type,entity_type,entity_id,redacted_details FROM audit_events WHERE tenant_id=${tenantId} AND event_id=${auditEventId}`)).rows;
          if (audits.length!==1) refused(); equal(audits[0],{job_id:migrationJobId,actor_user_id:b.actorUserId,event_type:'AUTHENTIC_FREEZING_ACQUISITION',entity_type:'MIGRATION_JOB',entity_id:migrationJobId,redacted_details:audit});
          await tx.execute(sql`INSERT INTO migration_reacquisition_candidates(tenant_id,challenge_id,nonce_digest,audit_event_id,binding) VALUES(${tenantId},${id},${nonceDigest},${auditEventId},${canonicalJson(binding)}::jsonb)`);
          const candidates=(await tx.execute(sql`SELECT binding FROM migration_reacquisition_candidates WHERE tenant_id=${tenantId} AND challenge_id=${id}`)).rows;
          if (candidates.length!==1) refused(); equal(candidates[0].binding,binding);
          await current(tx,session,request,b);
          fresh(session,request,await clock(tx),{issuedAt:Number(envelope.issuedAt),expiresAt:Number(envelope.expiresAt)});
          return binding;
        });
        // A post-commit authority loss/expiry leaves only archival facts. No handle.
        await transaction(async tx => { await current(tx,session,request,b); });
        fresh(session,request,Date.now(),b);
        fresh(session,request,Date.now(),{issuedAt:Number(envelope.issuedAt),expiresAt:Number(envelope.expiresAt)});
        return response(200,{...candidate,status:'AUTHENTIC_FREEZING_ACQUISITION',automaticRetry:false,automaticEnable:false});
      } catch { return reservationAttempted ? unknown() : response(403,{status:'REFUSED'}); }
    },
    async status(request: Request): Promise<Response> {
      try {
        const id=new URL(request.url).pathname.split('/').at(-1)!; if (!UUID.test(id)) refused();
        const session=authenticate(request,'GET',`/${id}`); const digest=request.headers.get('x-reacquisition-intent-digest');
        if (!digest || !DIGEST.test(digest)) refused();
        const fact=await transaction(async tx => {
          const actor=await member(tx,session); const i=await load(tx,id); const b=i.challenge;
          if (i.intentDigest!==digest || b.actorUserId!==actor || b.actorSubject!==session.subject || b.sessionBinding!==session.sessionBinding) refused();
          const rows=(await tx.execute(sql`SELECT c.binding,a.redacted_details,a.job_id,a.actor_user_id,a.event_type,a.entity_type,a.entity_id FROM migration_reacquisition_candidates c
            JOIN audit_events a ON a.tenant_id=c.tenant_id AND a.event_id=c.audit_event_id WHERE c.tenant_id=${tenantId} AND c.challenge_id=${id}`)).rows;
          fresh(session,request,await clock(tx));
          if (!rows.length) return {scope:'ARCHIVAL_ONLY',status:'UNKNOWN',automaticRetry:false,automaticEnable:false};
          if (rows.length!==1) refused(); const c=rows[0].binding as Record<string,unknown>;
          if (c.intentDigest!==digest || c.candidateDigest!==sha256(canonicalJson(rows[0].redacted_details)) || c.authority!=='NONAUTHORITY'
            || c.exclusion!=='NOT_PROVEN' || c.finalImportEligible!==false || c.tenantId!==tenantId || c.challengeId!==id
            || rows[0].job_id!==migrationJobId || rows[0].actor_user_id!==actor || rows[0].event_type!=='AUTHENTIC_FREEZING_ACQUISITION'
            || rows[0].entity_type!=='MIGRATION_JOB' || rows[0].entity_id!==migrationJobId) refused();
          return {...c,scope:'ARCHIVAL_ONLY',status:'AUTHENTIC_FREEZING_ACQUISITION',automaticRetry:false,automaticEnable:false};
        });
        fresh(session,request,Date.now()); return response(200,fact);
      } catch { return response(403,{status:'REFUSED'}); }
    },
  });
}
