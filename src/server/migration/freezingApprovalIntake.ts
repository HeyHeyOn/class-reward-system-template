import 'server-only';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { TenantImportTransactionRunner } from './importer';
import { createNonAuthorityReceiptStorage } from './authorityReceiptStorage';
import { canonicalJson } from './legacyBridgeManifest';
import { sha256 } from './validators';

const PURPOSE = 'CLASS_STORE_START_FREEZING_APPROVAL_V1';
const ACTION = 'START_FREEZING_APPROVAL';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export type FreezingApprovalDisplay = Readonly<{
  purpose: typeof PURPOSE; action: typeof ACTION; challengeId: string; tenantId: string;
  migrationJobId: string; expectedStatus: 'READY'; expectedStateVersion: string;
  sourceId: string; externalSourceId: string; jobSemanticFingerprint: string; sourceAcquisitionDigest: string;
  preflightSnapshotId: string; preflightDigest: string; actorUserId: string;
  actorSubject: string; issuedAt: number; expiresAt: number;
}>;
const KEYS = ['purpose','action','challengeId','tenantId','migrationJobId','expectedStatus','expectedStateVersion',
  'sourceId','externalSourceId','jobSemanticFingerprint','sourceAcquisitionDigest','preflightSnapshotId','preflightDigest','actorUserId','actorSubject','issuedAt','expiresAt'];
declare const approvalBrand: unique symbol;
export type VerifiedFreezingApproval = Readonly<{[approvalBrand]: true}>;
const approvals = new WeakMap<VerifiedFreezingApproval, FreezingApprovalDisplay>();
export function readVerifiedFreezingApproval(handle: VerifiedFreezingApproval): FreezingApprovalDisplay {
  const data = approvals.get(handle);
  if (!data) refused();
  return data;
}
type Session = Readonly<{subject: string; csrfToken: string}>;
type Dependencies = Readonly<{
  tenantId: string; origin: string;
  getAuthenticatedSession: () => Promise<Session | null>;
  runTransaction: TenantImportTransactionRunner;
}>;
/** Internal composition only: canonical resolved tenant, configured HTTPS origin,
 * and authenticated session (including its server-generated synchronizer token).
 * No existing CSRF helper exists in this repository. This adapter verifies the
 * actual POST's origin + session token, never a caller-supplied authority boolean.
 * The session adapter must be request-local and must NOT read identity/token from
 * the confirmation JSON. No route is exposed here. This attests start approval
 * only: not writer exclusion, freeze execution, CAPTURED acquisition or activation.
 */
export function createFreezingApprovalIntake(dependencies: Dependencies) {
  const {tenantId, origin, getAuthenticatedSession, runTransaction} = dependencies;
  async function session() {
    if (!UUID.test(tenantId) || new URL(origin).origin !== origin || !origin.startsWith('https://')) refused();
    const s = await getAuthenticatedSession();
    if (!s) refused();
    text(s.subject,255);
    if (typeof s.csrfToken !== 'string' || !DIGEST.test(s.csrfToken)) refused();
    return {subject:s.subject,csrfToken:s.csrfToken};
  }
  return {
    async issueChallenge(raw: unknown): Promise<FreezingApprovalDisplay> {
      try {
        const v = exact(raw,['migrationJobId','expectedStateVersion','sourceId']);
        text(v.migrationJobId,1024); text(v.sourceId,1024); version(v.expectedStateVersion);
        const s = await session();
        return await runTransaction(tenantId,async tx => {
          await requireReadCommitted(tx);
          const current = await lockCurrent(tx,tenantId,v.migrationJobId as string,v.expectedStateVersion as string,v.sourceId as string,s.subject);
          const now = await databaseNow(tx);
          const b = parseDisplay({purpose:PURPOSE,action:ACTION,challengeId:randomUUID(),tenantId,
            migrationJobId:v.migrationJobId,expectedStatus:'READY',expectedStateVersion:v.expectedStateVersion,
            sourceId:v.sourceId,...current,actorSubject:s.subject,issuedAt:now,expiresAt:now+60_000});
          await tx.execute(sql`INSERT INTO migration_freezing_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,binding)
            VALUES(${tenantId},${b.challengeId},${b.migrationJobId},${b.sourceId},${b.actorUserId},${JSON.stringify(b)}::jsonb)`);
          const stored = await load(tx,tenantId,b.challengeId);
          if (canonicalJson(stored)!==canonicalJson(b)) refused();
          fresh(b,await databaseNow(tx));
          return b;
        });
      } catch { return refused(); }
    },
    async accept(request: Request): Promise<VerifiedFreezingApproval> {
      try {
        // Capture headers before the first await. Require explicit Origin even for
        // clients omitting Fetch Metadata; a matching token alone is insufficient.
        if (!(request instanceof Request) || request.method !== 'POST' || new URL(request.url).origin !== origin
          || new URL(request.url).search || request.headers.get('origin') !== origin
          || !['application/json'].includes(request.headers.get('content-type') ?? '')
          || ![null,'same-origin'].includes(request.headers.get('sec-fetch-site'))) refused();
        const csrf = request.headers.get('x-csrf-token');
        const body = exact(await boundedJson(request),['display','confirmation']);
        const displayed = parseDisplay(body.display);
        if (body.confirmation !== ACTION) refused();
        const s = await session();
        if (!csrf || !DIGEST.test(csrf) || !timingSafeEqual(Buffer.from(csrf),Buffer.from(s.csrfToken))) refused();
        const data = await runTransaction(tenantId,async tx => {
          await requireReadCommitted(tx);
          const b = await load(tx,tenantId,displayed.challengeId);
          if (canonicalJson(b)!==canonicalJson(displayed) || b.tenantId!==tenantId || b.actorSubject!==s.subject) refused();
          fresh(b,await databaseNow(tx));
          const current = await lockCurrent(tx,tenantId,b.migrationJobId,b.expectedStateVersion,b.sourceId,s.subject);
          for (const key of ['actorUserId','externalSourceId','jobSemanticFingerprint','sourceAcquisitionDigest','preflightSnapshotId','preflightDigest'] as const) if (current[key]!==b[key]) refused();
          fresh(b,await databaseNow(tx));
          const replayDigest = sha256(canonicalJson([PURPOSE,'CONFIRMATION_REPLAY',b.challengeId]));
          await tx.execute(sql`INSERT INTO migration_freezing_consumptions(replay_digest,tenant_id,challenge_id)
            VALUES(${replayDigest},${tenantId},${b.challengeId})`);
          const {rows} = await tx.execute(sql`SELECT replay_digest,tenant_id,challenge_id FROM migration_freezing_consumptions
            WHERE tenant_id=${tenantId} AND challenge_id=${b.challengeId}`);
          if (rows.length!==1 || rows[0].replay_digest!==replayDigest || rows[0].tenant_id!==tenantId || rows[0].challenge_id!==b.challengeId) refused();
          // Reuse the consistency-only writer inside THIS transaction. It cannot
          // commit independently or mint a capability. Archival recovery stays
          // NON_AUTHORITY and has no path into this module's private WeakMap.
          const storage = createNonAuthorityReceiptStorage({tenantId,runTransaction:async (t,cb) => {
            if (t!==tenantId) refused();
            return cb(tx);
          }});
          await storage.append({tenant_id:tenantId,receipt_id:b.challengeId,job_id:b.migrationJobId,source_id:b.sourceId,
            provider:'GOOGLE_SHEETS',external_source_id:b.externalSourceId,actor_user_id:b.actorUserId,actor_subject:b.actorSubject,
            action:ACTION,expected_status:'READY',expected_state_version:b.expectedStateVersion,source_fingerprint:b.jobSemanticFingerprint,source_acquisition_digest:b.sourceAcquisitionDigest,
            issued_at_ms:String(b.issuedAt),expires_at_ms:String(b.expiresAt),issuer_digest:sha256(canonicalJson([PURPOSE,'AUTHENTICATED_SESSION_CONFIRMATION'])),
            content_digest:sha256(canonicalJson(b)),replay_digest:replayDigest,
            final_sheet_digest:null,final_redis_digest:null,final_report_digest:null});
          fresh(b,await databaseNow(tx));
          return b;
        });
        // Only acknowledged outer COMMIT may mint. Lost responses are NOT
        // recoverable permission; a new explicit confirmation is required.
        const handle = Object.freeze({}) as VerifiedFreezingApproval;
        approvals.set(handle,data);
        return handle;
      } catch { return refused(); }
    },
  };
}
async function requireReadCommitted(tx: TenantTransaction) {
  // FOR UPDATE blocks preceding snapshot FK inserts, but only READ COMMITTED
  // refreshes the subsequent cardinality read after that wait. A fixed snapshot
  // can miss the committed insert without any serialization failure. Check the
  // actual transaction before all binding reads; runner declarations can differ.
  const {rows} = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation`);
  if (rows.length!==1 || rows[0].isolation!=='read committed') refused();
}
async function lockCurrent(tx: TenantTransaction, tenantId: string, jobId: string, stateVersion: string, sourceId: string, subject: string) {
  const {rows:tenants} = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
  if (tenants.length!==1 || tenants[0].lifecycle!=='IMPORTING') refused();
  const {rows:jobs} = await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint FROM migration_jobs
    WHERE tenant_id=${tenantId} AND job_id=${jobId} FOR UPDATE`);
  if (jobs.length!==1 || jobs[0].status!=='READY' || jobs[0].version!==stateVersion) refused();
  // Snapshot inserts take FK KEY SHARE here; UPDATE protects exact-one PREFLIGHT cardinality.
  const {rows:sources} = await tx.execute(sql`SELECT provider,external_source_id,source_fingerprint FROM migration_sources
    WHERE tenant_id=${tenantId} AND job_id=${jobId} AND source_id=${sourceId} FOR UPDATE`);
  if (sources.length!==1 || sources[0].provider!=='GOOGLE_SHEETS') refused();
  const {rows:actors} = await tx.execute(sql`SELECT u.id FROM users u JOIN tenant_memberships m ON m.user_id=u.id
    WHERE m.tenant_id=${tenantId} AND u.google_subject=${subject} AND m.role IN ('OWNER','ADMIN') FOR SHARE OF u,m`);
  if (actors.length!==1) refused();
  const {rows:snapshots} = await tx.execute(sql`SELECT snapshot_id,artifact_digest FROM migration_snapshots
    WHERE tenant_id=${tenantId} AND job_id=${jobId} AND source_id=${sourceId} AND phase='PREFLIGHT' FOR SHARE`);
  if (snapshots.length!==1) refused();
  return {actorUserId:String(actors[0].id),externalSourceId:String(sources[0].external_source_id),jobSemanticFingerprint:String(jobs[0].source_fingerprint),sourceAcquisitionDigest:String(sources[0].source_fingerprint),
    preflightSnapshotId:String(snapshots[0].snapshot_id),preflightDigest:String(snapshots[0].artifact_digest)};
}
async function load(tx: TenantTransaction, tenantId: string, challengeId: string) {
  const {rows} = await tx.execute(sql`SELECT binding FROM migration_freezing_challenges WHERE tenant_id=${tenantId} AND challenge_id=${challengeId}`);
  if (rows.length!==1) refused();
  const b = parseDisplay(rows[0].binding);
  if (b.tenantId!==tenantId || b.challengeId!==challengeId) refused();
  return b;
}
function parseDisplay(raw: unknown): FreezingApprovalDisplay {
  const b = exact(raw,KEYS);
  if (b.purpose!==PURPOSE || b.action!==ACTION || b.expectedStatus!=='READY') refused();
  for (const k of ['tenantId','challengeId','actorUserId']) if (typeof b[k]!=='string' || !UUID.test(b[k])) refused();
  for (const k of ['migrationJobId','sourceId','externalSourceId','preflightSnapshotId']) text(b[k],1024);
  text(b.actorSubject,255); version(b.expectedStateVersion);
  for (const k of ['jobSemanticFingerprint','sourceAcquisitionDigest','preflightDigest']) if(typeof b[k]!=='string'||!DIGEST.test(b[k])) refused();
  if (typeof b.issuedAt!=='number' || typeof b.expiresAt!=='number' || !Number.isSafeInteger(b.issuedAt)
    || !Number.isSafeInteger(b.expiresAt) || b.issuedAt<0 || b.expiresAt-b.issuedAt!==60_000) refused();
  return Object.freeze(b) as FreezingApprovalDisplay;
}
function exact(raw: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!raw || typeof raw!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length!==keys.length) refused();
  const copy: Record<string,unknown> = {};
  for(const key of keys) {
    const d=Object.getOwnPropertyDescriptor(raw,key);
    if (!d?.enumerable || !('value' in d)) refused();
    copy[key]=d.value;
  }
  return copy;
}
async function boundedJson(request: Request): Promise<unknown> {
  const reader=request.body?.getReader(); if(!reader) refused();
  const chunks: Uint8Array[]=[]; let length=0;
  try {
    while(true) {
      const {done,value}=await reader.read(); if(done) break;
      length+=value.byteLength; if(length>8192) refused(); chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel(); reader.releaseLock(); }
}
async function databaseNow(tx: TenantTransaction) {
  const {rows}=await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`);
  const now=Number(rows[0]?.ms); if(!Number.isSafeInteger(now)||now<0) refused(); return now;
}
function fresh(b: FreezingApprovalDisplay, now: number) { if(b.issuedAt>now||b.expiresAt<=now) refused(); }
function text(v: unknown,max: number): asserts v is string { if(typeof v!=='string'||!v||v.length>max||v.trim()!==v) refused(); }
function version(v: unknown): asserts v is string { if(typeof v!=='string'||!/^[1-9][0-9]{0,15}$/.test(v)||BigInt(v)>BigInt(Number.MAX_SAFE_INTEGER)) refused(); }
function refused(): never { throw Error('Freezing approval intake refused.'); }
