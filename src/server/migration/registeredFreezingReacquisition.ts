import 'server-only';
import { createPublicKey, hkdfSync, KeyObject, randomBytes, sign, verify, type KeyLike } from 'node:crypto';
import { acquireDeploymentLocalRedisReader, readDeploymentLocalWriterStatus } from '../legacyMigrationBridge';
import { captureRedisClaimSnapshot, type RedisClaimSnapshot } from './redisClaimSnapshot';
import { captureSheetsSnapshot, type SheetsSnapshot, type WorkbookSnapshotReader } from './sheetsSnapshot';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { canonicalJson, openLegacyBridgeManifest, sealLegacyBridgeManifest, type AtomicNonceConsumer,
  type LegacyBridgeEnvelope, type SealManifestOptions } from './legacyBridgeManifest';
import { deepFreeze } from './sensitiveRedaction';
import { sha256 } from './validators';
import { readBridgeBytes, BRIDGE_RESPONSE_LIMIT } from './registeredBridgeProducer';
import { FREEZING_REACQUISITION_PATH as PATH, FREEZING_REACQUISITION_SCOPE as SCOPE,
  FREEZING_REACQUISITION_PURPOSE as PHASE, assertFreezingLifetime as fresh, exactFreezingData as exact,
  parseFreezingReacquisitionChallenge as parseChallenge, refuseFreezingReacquisition as refused,
  type FreezingReacquisitionChallenge } from './freezingReacquisitionContract';

const PURPOSE = 'CLASS_STORE_REGISTERED_FREEZING_REACQUISITION_REQUEST';
const PREFIX = 'class-store:registered-freezing-reacquisition-request:v1\0';
const BODY_LIMIT = 8192;
export type FreezingReacquisitionRegistration = Readonly<{
  endpoint: string; deploymentId: string; registrationVersion: string; registrationDigest: string;
  approvedScope: typeof SCOPE; tenantId: string; sourceId: string; spreadsheetId: string;
  requestKeyId: string; requestPublicKey: KeyLike; manifestPublicKey: KeyLike; writerPublicKey: KeyLike;
}>;
export type FreezingReacquisitionReservation = Readonly<{
  purpose: typeof PURPOSE; deploymentId: string; registrationDigest: string; challengeId: string;
  startCeremonyId: string; executionDigest: string; nonceDigest: string; requestDigest: string;
  issuedAt: number; expiresAt: number;
}>;
/** Durable implementation: createFreezingProducerReservations (0022 shared
 * global old/new replay ledger). Immutable INSERT, exact readback and COMMIT ACK.
 * Uncertain ACK is terminal; never retry/recover success from an old row.
 * This new shape must NOT be sent to the old-purpose SQL reservation adapter.
 * Deployment credential/registration composition root is a separate gate. */
export interface FreezingReacquisitionReservations {
  reserveAndCommit(row: FreezingReacquisitionReservation): Promise<FreezingReacquisitionReservation>;
}
export type FreezingReacquisitionBody = Readonly<{ challenge: FreezingReacquisitionChallenge }>;
type Auth = Readonly<{
  version: 1; purpose: typeof PURPOSE; method: 'POST'; path: typeof PATH; scope: typeof SCOPE;
  audience: string; registrationDigest: string; registrationVersion: string;
  challengeId: string; startCeremonyId: string; executionDigest: string; actorUserId: string;
  actorSubject: string; sessionBinding: string; bodyDigest: string;
  issuedAt: number; expiresAt: number; nonce: string; keyId: string; signature: string;
}>;
const AUTH_KEYS = ['version', 'purpose', 'method', 'path', 'scope', 'audience', 'registrationDigest', 'registrationVersion',
  'challengeId', 'startCeremonyId', 'executionDigest', 'actorUserId', 'actorSubject', 'sessionBinding', 'bodyDigest',
  'issuedAt', 'expiresAt', 'nonce', 'keyId', 'signature'];
function publicKey(key: KeyLike): KeyObject {
  const parsed = key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key);
  if (parsed.asymmetricKeyType !== 'ed25519') refused();
  return parsed;
}
function keyBytes(key: KeyLike) { return publicKey(key).export({ type: 'spki', format: 'der' }); }
export function validateFreezingReacquisitionRegistration(raw: FreezingReacquisitionRegistration): FreezingReacquisitionRegistration {
  const r = { ...raw, requestPublicKey: publicKey(raw.requestPublicKey),
    manifestPublicKey: publicKey(raw.manifestPublicKey), writerPublicKey: publicKey(raw.writerPublicKey) };
  const url = new URL(r.endpoint);
  const localTest = process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!localTest && url.protocol !== 'https:') || url.username || url.password || r.endpoint.includes('?') || r.endpoint.includes('#')
    || url.pathname !== PATH || url.href !== r.endpoint || r.approvedScope !== SCOPE
    || !/^[0-9a-f]{64}$/.test(r.registrationDigest) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.tenantId)
    || !/^[1-9][0-9]{0,15}$/.test(r.registrationVersion) || BigInt(r.registrationVersion) > BigInt(Number.MAX_SAFE_INTEGER)) refused();
  for (const text of [r.deploymentId, r.sourceId, r.spreadsheetId, r.requestKeyId]) {
    if (typeof text !== 'string' || !text || text.length > 512 || text.trim() !== text || /[\x00-\x1f\x7f]/.test(text)) refused();
  }
  const keys = [r.requestPublicKey, r.manifestPublicKey, r.writerPublicKey].map(keyBytes);
  if (keys.some((key, index) => keys.slice(index + 1).some(other => key.equals(other)))) refused();
  return Object.freeze(r);
}
function binding(raw: unknown, r: FreezingReacquisitionRegistration): FreezingReacquisitionBody {
  const b = exact(raw, ['challenge']); const c = parseChallenge(b.challenge);
  if (c.tenantId !== r.tenantId || c.sourceId !== r.sourceId || c.deploymentId !== r.deploymentId
    || c.spreadsheetIdDigest !== sha256(r.spreadsheetId) || c.registrationDigest !== r.registrationDigest
    || c.registrationVersion !== r.registrationVersion) refused();
  return Object.freeze({ challenge: c });
}
function signatureBytes(auth: Omit<Auth, 'signature'>) { return Buffer.from(PREFIX + canonicalJson(auth), 'utf8'); }
export function signFreezingReacquisitionRequest(raw: FreezingReacquisitionRegistration, privateKey: KeyLike, input: FreezingReacquisitionBody) {
  const r = validateFreezingReacquisitionRegistration(raw); const b = binding(input, r); const c = b.challenge;
  if (!keyBytes(privateKey).equals(keyBytes(r.requestPublicKey))) refused();
  fresh(c.issuedAt, c.expiresAt);
  const body = canonicalJson(b); if (Buffer.byteLength(body) > BODY_LIMIT) refused();
  const unsigned: Omit<Auth, 'signature'> = { version: 1, purpose: PURPOSE, method: 'POST', path: PATH, scope: SCOPE,
    audience: r.deploymentId, registrationDigest: r.registrationDigest, registrationVersion: r.registrationVersion,
    challengeId: c.challengeId, startCeremonyId: c.startCeremonyId, executionDigest: c.executionDigest,
    actorUserId: c.actorUserId, actorSubject: c.actorSubject, sessionBinding: c.sessionBinding,
    bodyDigest: sha256(body), issuedAt: Date.now(), expiresAt: c.expiresAt, nonce: randomBytes(24).toString('base64url'), keyId: r.requestKeyId };
  fresh(unsigned.issuedAt, unsigned.expiresAt);
  const auth = { ...unsigned, signature: sign(null, signatureBytes(unsigned), privateKey).toString('base64url') };
  return Object.freeze({ body, requestDigest: sha256(canonicalJson(auth)), headers: Object.freeze({
    'content-type': 'application/json', accept: 'application/json',
    'x-class-store-freezing-reacquisition': Buffer.from(canonicalJson(auth)).toString('base64url'),
  }) });
}
export type FreezingReacquisitionPayload = Readonly<{
  purpose: typeof PHASE; bindingVersion: 1; authority: 'NONAUTHORITY'; outcome: 'AUTHENTIC_FREEZING_ACQUISITION';
  exclusion: 'NOT_PROVEN'; finalImportEligible: false; challenge: FreezingReacquisitionChallenge;
  capturedAt: string; sheetsSnapshot: SheetsSnapshot; redisSnapshot: RedisClaimSnapshot;
  normalization: LegacyNormalizationManifest;
  localWriterObservation: Awaited<ReturnType<typeof readDeploymentLocalWriterStatus>> & Readonly<{ observedAt: string }>;
}>;
export type FreezingReacquisitionEnvelope = Readonly<{ purpose: typeof PHASE; bindingVersion: 1; envelope: LegacyBridgeEnvelope }>;
// Reuse the existing bounded crypto codec with a separate encryption domain and
// strict phase wrapper. Old envelope parsers reject this wrapper; no old binding
// is fabricated. The wrapper's phase is also inside authenticated ciphertext.
function phaseKey(key: Uint8Array): Buffer {
  if (!ArrayBuffer.isView(key) || key.byteLength !== 32) refused();
  return Buffer.from(hkdfSync('sha256', key, PHASE, 'encrypted-candidate:v1', 32));
}
export async function openFreezingReacquisitionEnvelope(raw: unknown, options: Readonly<{
  encryptionKey: Uint8Array; signingPublicKey: KeyLike; expectedChallenge: FreezingReacquisitionChallenge;
  nonceConsumer: AtomicNonceConsumer;
}>): Promise<FreezingReacquisitionPayload> {
  const wrapper = exact(raw, ['purpose', 'bindingVersion', 'envelope']);
  if (wrapper.purpose !== PHASE || wrapper.bindingVersion !== 1) refused();
  const challenge = parseChallenge(options.expectedChallenge); fresh(challenge.issuedAt, challenge.expiresAt);
  const envelope = exact(wrapper.envelope, ['version', 'algorithm', 'keyId', 'nonce', 'issuedAt', 'expiresAt',
    'iv', 'ciphertext', 'authTag', 'signature']) as LegacyBridgeEnvelope;
  if (envelope.issuedAt < challenge.issuedAt || envelope.expiresAt > challenge.expiresAt) refused();
  const payload = await openLegacyBridgeManifest<FreezingReacquisitionPayload>(envelope, {
    encryptionKey: phaseKey(options.encryptionKey), signingPublicKey: publicKey(options.signingPublicKey),
    // Codec completion is not replay consumption or an authority mint. Defer
    // the caller's durable nonce seam until phase/provenance validation below.
    nonceConsumer: { consumeOnce: async () => true },
  });
  validateCandidatePayload(payload, challenge, envelope.issuedAt);
  fresh(challenge.issuedAt, challenge.expiresAt); fresh(envelope.issuedAt, envelope.expiresAt);
  if (!await options.nonceConsumer.consumeOnce(sha256(canonicalJson([PHASE, envelope.nonce])), envelope.expiresAt)) refused();
  fresh(challenge.issuedAt, challenge.expiresAt); fresh(envelope.issuedAt, envelope.expiresAt);
  return deepFreeze(payload);
}
function instant(raw: unknown): number {
  if (typeof raw !== 'string') refused();
  const ms = Date.parse(raw);
  if (!Number.isSafeInteger(ms) || ms < 0 || new Date(ms).toISOString() !== raw) refused();
  return ms;
}
function validateCandidatePayload(payload: FreezingReacquisitionPayload, challenge: FreezingReacquisitionChallenge, sealedAt: number): void {
  exact(payload, ['purpose', 'bindingVersion', 'authority', 'outcome', 'exclusion', 'finalImportEligible', 'challenge',
    'capturedAt', 'sheetsSnapshot', 'redisSnapshot', 'normalization', 'localWriterObservation']);
  if (payload.purpose !== PHASE || payload.bindingVersion !== 1 || payload.authority !== 'NONAUTHORITY'
    || payload.outcome !== 'AUTHENTIC_FREEZING_ACQUISITION' || payload.exclusion !== 'NOT_PROVEN' || payload.finalImportEligible !== false
    || canonicalJson(parseChallenge(payload.challenge)) !== canonicalJson(challenge)) refused();
  const observed = exact(payload.localWriterObservation, ['version', 'deploymentId', 'source', 'status', 'disabled',
    'generation', 'evidence', 'disabledAt', 'observedAt']);
  const captureMs = instant(payload.capturedAt); const observedMs = instant(observed.observedAt);
  if (observed.version !== 1 || observed.deploymentId !== challenge.deploymentId || observed.source !== 'UPSTASH_REDIS_REST'
    || observed.status !== 'DISABLED' || observed.disabled !== true || !Number.isSafeInteger(observed.generation) || Number(observed.generation) < 1
    || typeof observed.evidence !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(observed.evidence)
    || instant(observed.disabledAt) > captureMs || captureMs < challenge.issuedAt || captureMs > observedMs
    || observedMs > sealedAt || sealedAt >= challenge.expiresAt) refused();
  if (!payload.sheetsSnapshot || !payload.redisSnapshot || payload.sheetsSnapshot.capturedAt !== payload.capturedAt
    || payload.redisSnapshot.capturedAt !== payload.capturedAt || sha256(payload.sheetsSnapshot.spreadsheetId) !== challenge.spreadsheetIdDigest
    || Object.keys(payload.sheetsSnapshot.tabs).some(name => name !== 'Settings' && name.trim().toLowerCase() === 'settings')) refused();
  const normalization = createLegacyNormalizationManifest({ tenantId: challenge.tenantId,
    migrationJobId: challenge.migrationJobId, sheets: payload.sheetsSnapshot, redis: payload.redisSnapshot });
  if (canonicalJson(normalization) !== canonicalJson(payload.normalization)) refused();
}
/** Server-local registered executable core. No route, SQL or central membership
 * credential is installed here. Sheets is the low-level deployment credential
 * reader; HTTP never supplies callbacks, keys, registration or control config. */
export function createRegisteredFreezingReacquisition(dependencies: Readonly<{
  registration: FreezingReacquisitionRegistration; reservations: FreezingReacquisitionReservations;
  sheets: WorkbookSnapshotReader; manifest: Omit<SealManifestOptions, 'now' | 'ttlMs' | 'nonce'>;
}>) {
  const r = validateFreezingReacquisitionRegistration(dependencies.registration);
  const manifest = { ...dependencies.manifest, encryptionKey: phaseKey(dependencies.manifest.encryptionKey) };
  if (!keyBytes(manifest.signingPrivateKey).equals(keyBytes(r.manifestPublicKey))) refused();
  const reserve = dependencies.reservations.reserveAndCommit.bind(dependencies.reservations);
  const sheets = Object.freeze({ ...dependencies.sheets });
  return async (request: Request): Promise<Response> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    let started = false;
    const response = (status: number, data: unknown) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
    try {
      if (request.signal.aborted || request.method !== 'POST' || request.url !== r.endpoint
        || request.headers.get('content-type') !== 'application/json' || request.headers.has('authorization')
        || request.headers.has('cookie') || request.headers.has('origin') || request.headers.has('referer')
        || request.headers.has('content-encoding')) refused();
      const encoded = request.headers.get('x-class-store-freezing-reacquisition');
      if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) refused();
      const auth = exact(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), AUTH_KEYS) as Auth;
      const { signature, ...unsigned } = auth;
      if (auth.version !== 1 || auth.purpose !== PURPOSE || auth.method !== 'POST' || auth.path !== PATH || auth.scope !== SCOPE
        || auth.audience !== r.deploymentId || auth.registrationDigest !== r.registrationDigest || auth.registrationVersion !== r.registrationVersion
        || auth.keyId !== r.requestKeyId || typeof auth.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(auth.nonce)
        || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)
        || !verify(null, signatureBytes(unsigned), r.requestPublicKey, Buffer.from(signature, 'base64url'))) refused();
      fresh(auth.issuedAt, auth.expiresAt);
      const bytes = await readBridgeBytes(request.body, BODY_LIMIT, controller.signal);
      if (sha256(bytes) !== auth.bodyDigest) refused();
      const b = binding(JSON.parse(bytes), r); const c = b.challenge;
      for (const key of ['challengeId', 'startCeremonyId', 'executionDigest', 'actorUserId', 'actorSubject', 'sessionBinding'] as const) {
        if (auth[key] !== c[key]) refused();
      }
      if (auth.issuedAt < c.issuedAt || auth.expiresAt !== c.expiresAt) refused();
      const check = () => {
        if (controller.signal.aborted || request.signal.aborted) refused();
        fresh(auth.issuedAt, auth.expiresAt); fresh(c.issuedAt, c.expiresAt);
      };
      check();
      const row: FreezingReacquisitionReservation = Object.freeze({ purpose: PURPOSE, deploymentId: r.deploymentId,
        registrationDigest: r.registrationDigest, challengeId: c.challengeId, startCeremonyId: c.startCeremonyId,
        executionDigest: c.executionDigest, nonceDigest: sha256(canonicalJson([PURPOSE, auth.nonce])),
        requestDigest: sha256(canonicalJson(auth)), issuedAt: auth.issuedAt, expiresAt: auth.expiresAt });
      let cancelReservation: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        cancelReservation = () => reject(new Error('Reservation ACK unavailable.'));
        controller.signal.addEventListener('abort', cancelReservation, { once: true });
        if (controller.signal.aborted) cancelReservation();
      });
      let ack: FreezingReacquisitionReservation;
      try { ack = await Promise.race([reserve(row), aborted]); }
      finally { controller.signal.removeEventListener('abort', cancelReservation); }
      if (canonicalJson(ack) !== canonicalJson(row)) refused();
      check(); clearTimeout(timer); started = true;
      // Historical disable time is not a lease and must not be renewed.
      const before = await readDeploymentLocalWriterStatus(r.deploymentId); check();
      if (Date.parse(before.disabledAt) > Date.now()) refused();
      const capturedAt = new Date(Date.now()).toISOString();
      const reader = await acquireDeploymentLocalRedisReader(); check();
      if (!reader) refused();
      const redisSnapshot = await captureRedisClaimSnapshot(reader, { capturedAt }); check();
      const sheetsSnapshot = await captureSheetsSnapshot({ spreadsheetId: r.spreadsheetId, capturedAt, reader: sheets }); check();
      const normalization = createLegacyNormalizationManifest({ tenantId: c.tenantId, migrationJobId: c.migrationJobId,
        sheets: sheetsSnapshot, redis: redisSnapshot });
      const after = await readDeploymentLocalWriterStatus(r.deploymentId); check();
      if (canonicalJson(before) !== canonicalJson(after)) refused();
      const now = Date.now();
      const payload: FreezingReacquisitionPayload = { purpose: PHASE, bindingVersion: 1, authority: 'NONAUTHORITY',
        outcome: 'AUTHENTIC_FREEZING_ACQUISITION', exclusion: 'NOT_PROVEN', finalImportEligible: false,
        challenge: c, capturedAt, sheetsSnapshot, redisSnapshot, normalization,
        localWriterObservation: { ...after, observedAt: new Date(now).toISOString() } };
      validateCandidatePayload(payload, c, now);
      check();
      const envelope = sealLegacyBridgeManifest(payload, { ...manifest, now: () => now, ttlMs: c.expiresAt - now });
      check();
      const result: FreezingReacquisitionEnvelope = { purpose: PHASE, bindingVersion: 1, envelope };
      if (Buffer.byteLength(JSON.stringify(result)) > BRIDGE_RESPONSE_LIMIT) refused();
      return response(200, result);
    } catch { return response(started ? 503 : 403, { outcome: started ? 'UNKNOWN' : 'REFUSED' }); }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
  };
}
