import 'server-only';
import { randomUUID, type KeyLike } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { parseFinalBridgeChallenge, verifyWriterDisableEvidence, type FinalBridgeChallenge } from '../legacyMigrationBridge';
import type { TenantImportTransactionRunner } from './importer';
import type { SheetsSnapshot } from './sheetsSnapshot';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { canonicalJson, openLegacyBridgeManifest, type LegacyBridgeEnvelope } from './legacyBridgeManifest';
import { sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';
import { appendBridgeChallenge, consumeBridgeChallenge } from './bridgeReplay';

export type RegisteredFinalBridgeDeployment = Readonly<{
  tenantId: string; sourceId: string; spreadsheetId: string; spreadsheetIdDigest: string; deploymentId: string;
  keyId: string; signingPublicKey: KeyLike; encryptionKey: Uint8Array;
  writerKeyId: string; writerSigningPublicKey: KeyLike;
}>;
type Dependencies = Readonly<{
  tenantId: string; getAuthenticatedSubject: () => Promise<string | null>;
  registeredDeployments: readonly RegisteredFinalBridgeDeployment[]; runTransaction: TenantImportTransactionRunner;
}>;
declare const acquisitionBrand: unique symbol;
export type VerifiedFinalBridgeAcquisition = Readonly<{ [acquisitionBrand]: true }>;
type AcquisitionData = Readonly<{ sheets: SheetsSnapshot; redis: RedisClaimSnapshot;
  normalization: LegacyNormalizationManifest; exclusion: 'NOT_PROVEN' }>;
const acquisitions = new WeakMap<VerifiedFinalBridgeAcquisition, AcquisitionData>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function readVerifiedFinalBridgeAcquisition(value: VerifiedFinalBridgeAcquisition): AcquisitionData {
  const acquisition = acquisitions.get(value);
  if (!acquisition) refused();
  return acquisition;
}

/** Internal server composition ONLY, like the abort service. tenantId must come
 * from canonical route resolution, identity from the authenticated session, and
 * registrations from server-owned configuration, never a request or bridge URL.
 * No public route, network client, grant mutation, importer or forward transition.
 * The capability attests acquisition authenticity only, NOT maintained writer
 * exclusion (including Sheets humans/fleet), consent, freeze or activation.
 * Unsupported never-configured/null Redis finals are refused, never synthesized.
 */
export function createFinalBridgeIntake(dependencies: Dependencies) {
  const { tenantId, getAuthenticatedSubject, runTransaction } = dependencies;
  // Detach mutable configuration byte buffers at server composition time.
  const registrations = dependencies.registeredDeployments.map((r) => ({ ...r, encryptionKey: Buffer.from(r.encryptionKey) }));
  const trust = (sourceId: string, spreadsheetIdDigest: string) => {
    const matches = registrations.filter((r) => r.tenantId === tenantId && r.sourceId === sourceId && r.spreadsheetIdDigest === spreadsheetIdDigest);
    if (matches.length !== 1) refused();
    const r = matches[0];
    text(r.spreadsheetId, 512);
    if (!/^[0-9a-f]{64}$/.test(spreadsheetIdDigest) || sha256(r.spreadsheetId) !== spreadsheetIdDigest) refused();
    for (const value of [r.deploymentId, r.keyId, r.writerKeyId]) text(value, 128);
    if (r.encryptionKey.byteLength !== 32) refused();
    return r;
  };
  const authenticatedSubject = async () => {
    if (!UUID.test(tenantId)) refused();
    const subject = await getAuthenticatedSubject(); text(subject, 255);
    return subject;
  };
  return {
    async issueChallenge(raw: unknown): Promise<FinalBridgeChallenge> {
      try {
        const v = exactData(raw, ['migrationJobId', 'expectedStateVersion', 'sourceId']);
        const migrationJobId = v.migrationJobId; const expectedStateVersion = v.expectedStateVersion; const sourceId = v.sourceId;
        uuid(migrationJobId); version(expectedStateVersion); text(sourceId, 512);
        const subject = await authenticatedSubject();
        return await runTransaction(tenantId, async (tx) => {
          const current = await lockCurrent(tx, tenantId, migrationJobId, expectedStateVersion, sourceId, subject);
          const registration = trust(sourceId, current.spreadsheetIdDigest);
          const now = await databaseNow(tx);
          const binding = parseFinalBridgeChallenge({ purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE', bindingVersion: 2, challengeId: randomUUID(),
            tenantId, migrationJobId, expectedStatus: 'READY', expectedStateVersion, sourceId,
            spreadsheetIdDigest: current.spreadsheetIdDigest, jobSemanticFingerprint: current.jobSemanticFingerprint,
            sourceAcquisitionDigest: current.sourceAcquisitionDigest,
            deploymentId: registration.deploymentId, actorUserId: current.actorUserId, actorSubject: subject,
            issuedAt: now, expiresAt: now + 60_000 });
          await appendBridgeChallenge(tx, binding);
          return binding;
        });
      } catch { return refused(); }
    },
    async accept(raw: unknown): Promise<VerifiedFinalBridgeAcquisition> {
      try {
        const v = exactData(raw, ['challengeId', 'manifest']);
        const challengeId = v.challengeId; uuid(challengeId);
        // Copy exact bounded envelope data before authentication/transaction awaits.
        const envelope = detachEnvelope(v.manifest);
        const subject = await authenticatedSubject();
        const data = await runTransaction(tenantId, async (tx): Promise<AcquisitionData> => {
          // Immutable challenge needs no row lock/UPDATE privilege. Current mutable
          // authority is locked tenant→job→source→membership below; unique INSERT
          // constraints, not process memory, serialize both replay dimensions.
          const { rows } = await tx.execute(sql`SELECT binding FROM migration_bridge_challenges
            WHERE tenant_id=${tenantId} AND challenge_id=${challengeId}`);
          if (rows.length !== 1) refused();
          const b = parseFinalBridgeChallenge(rows[0].binding);
          if (b.tenantId !== tenantId || b.challengeId !== challengeId || b.actorSubject !== subject) refused();
          const current = await lockCurrent(tx, tenantId, b.migrationJobId, b.expectedStateVersion, b.sourceId, subject);
          if (current.actorUserId !== b.actorUserId || current.spreadsheetIdDigest !== b.spreadsheetIdDigest
            || current.jobSemanticFingerprint !== b.jobSemanticFingerprint || current.sourceAcquisitionDigest !== b.sourceAcquisitionDigest) refused();
          const registration = trust(b.sourceId, b.spreadsheetIdDigest);
          if (registration.deploymentId !== b.deploymentId || envelope.keyId !== registration.keyId) refused();
          const now = await databaseNow(tx);
          fresh(b, now);
          // This private consumer records that cryptographic opening finished; it
          // does NOT grant permission or return to callers. Durable consumption
          // occurs below only after complete semantic validation in this same tx.
          let cryptoVerified = false;
          const payload = await openLegacyBridgeManifest(envelope, {
            signingPublicKey: registration.signingPublicKey, encryptionKey: registration.encryptionKey,
            now: () => now, nonceConsumer: { consumeOnce: async () => { cryptoVerified = true; return true; } },
          });
          if (!cryptoVerified) refused();
          const p = exactData(payload, ['manifestType', 'deploymentId', 'mode', 'capturedAt', 'finalIntakeBinding',
            'sheetsSnapshot', 'redisSnapshot', 'redisAcquisition', 'redisNeverConfiguredProof', 'writerDisableRequired', 'writerDisableEvidence']);
          if (p.manifestType !== 'CLASS_STORE_LEGACY_ACQUISITION' || p.mode !== 'final-delta' || p.deploymentId !== b.deploymentId
            || canonicalJson(parseFinalBridgeChallenge(p.finalIntakeBinding)) !== canonicalJson(b)
            || p.redisAcquisition !== 'CAPTURED' || p.redisNeverConfiguredProof !== null || p.writerDisableRequired !== true
            || p.sheetsSnapshot === null || p.redisSnapshot === null) refused();
          const capturedAt = new Date(envelope.issuedAt).toISOString();
          if (p.capturedAt !== capturedAt || envelope.issuedAt < b.issuedAt) refused();
          const sheets = p.sheetsSnapshot as SheetsSnapshot; const redis = p.redisSnapshot as RedisClaimSnapshot;
          // The real normalizer verifies complete acquisition schemas, every digest,
          // references/provenance and credential redaction. BANK quarantine remains
          // blocking, even though a blocked authentic acquisition can be inspected.
          const normalization = createLegacyNormalizationManifest({ tenantId, migrationJobId: b.migrationJobId, sheets, redis });
          // The binding retains the ORIGINAL READY acquisition. A fresh final
          // capture legitimately has a different digest/time/revision; its own
          // provenance is validated above, never equalized to the original.
          if (sheets.spreadsheetId !== registration.spreadsheetId || sheets.capturedAt !== capturedAt || redis.capturedAt !== capturedAt
            || Object.keys(sheets.tabs).some((name) => name !== 'Settings' && name.trim().toLowerCase() === 'settings')) refused();
          const evidence = verifyWriterDisableEvidence(p.writerDisableEvidence, registration.writerSigningPublicKey,
            registration.writerKeyId, b.deploymentId, envelope.issuedAt);
          if (Date.parse(evidence.disabledAt) > now) refused();
          const finalNow = await databaseNow(tx);
          fresh(b, finalNow);
          if (finalNow >= envelope.expiresAt || finalNow < envelope.issuedAt) refused();
          // Purpose-framed nonce ONLY: do not tenant/key-scope global replay identity.
          await consumeBridgeChallenge(tx, b, sha256(canonicalJson(['CLASS_STORE_FINAL_BRIDGE_NONCE_V1', envelope.nonce])));
          const consumedAt = await databaseNow(tx);
          fresh(b, consumedAt);
          if (consumedAt >= envelope.expiresAt || consumedAt < envelope.issuedAt) refused();
          return deepFreeze({ sheets, redis, normalization, exclusion: 'NOT_PROVEN' });
        });
        // Mint only after a successful COMMIT response. No recovery method can
        // re-mint this handle if commit succeeded but its acknowledgement was lost.
        const capability = Object.freeze({}) as VerifiedFinalBridgeAcquisition;
        acquisitions.set(capability, data);
        return capability;
      } catch { return refused(); }
    },
  };
}
async function lockCurrent(tx: TenantTransaction, tenantId: string, jobId: string, stateVersion: string, sourceId: string, subject: string) {
  const { rows: tenants } = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${tenantId} FOR UPDATE`);
  if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING') refused();
  const { rows: jobs } = await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint
    FROM migration_jobs WHERE tenant_id=${tenantId} AND job_id=${jobId} FOR UPDATE`);
  if (jobs.length !== 1 || jobs[0].status !== 'READY' || jobs[0].version !== stateVersion) refused();
  const { rows: sources } = await tx.execute(sql`SELECT provider,external_source_id,source_fingerprint FROM migration_sources
    WHERE tenant_id=${tenantId} AND job_id=${jobId} AND source_id=${sourceId} FOR SHARE`);
  if (sources.length !== 1 || sources[0].provider !== 'GOOGLE_SHEETS') refused();
  const { rows: actors } = await tx.execute(sql`SELECT u.id FROM tenant_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.tenant_id=${tenantId} AND u.google_subject=${subject} AND m.role IN ('OWNER','ADMIN') FOR SHARE OF m,u`);
  if (actors.length !== 1) refused();
  return { actorUserId: String(actors[0].id), spreadsheetIdDigest: String(sources[0].external_source_id),
    jobSemanticFingerprint: String(jobs[0].source_fingerprint), sourceAcquisitionDigest: String(sources[0].source_fingerprint) };
}
async function databaseNow(tx: TenantTransaction): Promise<number> {
  const { rows } = await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`);
  const now = Number(rows[0]?.ms);
  if (!Number.isSafeInteger(now) || now < 0) refused();
  return now;
}
function fresh(b: FinalBridgeChallenge, now: number) { if (b.issuedAt > now || now >= b.expiresAt) refused(); }
function exactData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length) refused();
  const copy: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d)) refused();
    copy[key] = d.value;
  }
  return copy;
}
function detachEnvelope(value: unknown): LegacyBridgeEnvelope {
  const copy = exactData(value, ['version', 'algorithm', 'keyId', 'nonce', 'issuedAt', 'expiresAt', 'iv', 'ciphertext', 'authTag', 'signature']);
  for (const [key, item] of Object.entries(copy)) {
    if (['version', 'issuedAt', 'expiresAt'].includes(key)) {
      if (!Number.isSafeInteger(item)) refused();
    } else if (typeof item !== 'string' || item.length > (key === 'ciphertext' ? 1_400_000 : 128)) refused();
  }
  return copy as LegacyBridgeEnvelope;
}
function uuid(value: unknown): asserts value is string { if (typeof value !== 'string' || !UUID.test(value)) refused(); }
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || value.trim() !== value) refused();
}
function version(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) refused();
}
function refused(): never { throw new Error('Final bridge intake refused.'); }
