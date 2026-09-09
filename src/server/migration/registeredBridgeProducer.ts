import 'server-only';
import { createPublicKey, randomBytes, sign, verify, KeyObject, type KeyLike } from 'node:crypto';
import { parseFinalBridgeChallenge, runLegacyMigrationBridge, type FinalBridgeChallenge } from '../legacyMigrationBridge';
import { canonicalJson, type SealManifestOptions } from './legacyBridgeManifest';
import type { WorkbookSnapshotReader } from './sheetsSnapshot';
import { sha256 } from './validators';

export const FINAL_BRIDGE_PATH = '/api/internal/migrations/final-bridge';
const PURPOSE = 'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST';
const PREFIX = 'class-store:registered-final-bridge-request:v1\0';
const BODY_LIMIT = 8_192;
export const BRIDGE_RESPONSE_LIMIT = 1_500_000;
export type BridgeRegistration = Readonly<{
  endpoint: string; deploymentId: string; registrationVersion: string; registrationDigest: string;
  approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING';
  tenantId: string; sourceId: string; spreadsheetId: string;
  requestKeyId: string; requestPublicKey: KeyLike; manifestPublicKey: KeyLike; writerPublicKey: KeyLike;
}>;
export type BridgeRequestBody = Readonly<{ ceremonyId: string; challenge: FinalBridgeChallenge }>;
export type BridgeReservation = Readonly<{
  deploymentId: string; registrationDigest: string; ceremonyId: string; challengeId: string;
  nonceDigest: string; requestDigest: string; issuedAt: number; expiresAt: number;
}>;
/** Deployment-local durable adapter contract. MUST atomically INSERT globally
 * unique nonceDigest AND challengeId, exact readback, then COMMIT ACK before
 * resolving. No retries or recovery success on uncertain ACK. Never use a Map
 * outside tests. Rows are immutable replay tombstones, not action capabilities.
 */
export interface BridgeReservations {
  reserveAndCommit(row: BridgeReservation): Promise<BridgeReservation>;
}
type Auth = Readonly<{
  version: 1; purpose: typeof PURPOSE; method: 'POST'; path: typeof FINAL_BRIDGE_PATH;
  audience: string; registrationDigest: string; registrationVersion: string;
  ceremonyId: string; bridgeChallengeId: string; bodyDigest: string;
  issuedAt: number; expiresAt: number; nonce: string; keyId: string; signature: string;
}>;
const AUTH_KEYS = ['version', 'purpose', 'method', 'path', 'audience', 'registrationDigest', 'registrationVersion',
  'ceremonyId', 'bridgeChallengeId', 'bodyDigest', 'issuedAt', 'expiresAt', 'nonce', 'keyId', 'signature'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function refused(): never { throw new Error('Registered bridge refused.'); }
function publicKey(key: KeyLike): KeyObject {
  const parsed = key instanceof KeyObject && key.type === 'public' ? key : createPublicKey(key);
  if (parsed.asymmetricKeyType !== 'ed25519') refused();
  return parsed;
}
function keyBytes(key: KeyLike) { return publicKey(key).export({ type: 'spki', format: 'der' }); }
/** Server composition only. HTTP input never selects a registration/URL/key. */
export function validateBridgeRegistration(raw: BridgeRegistration): BridgeRegistration {
  if (!raw) refused();
  const r = { ...raw, requestPublicKey: publicKey(raw.requestPublicKey),
    manifestPublicKey: publicKey(raw.manifestPublicKey), writerPublicKey: publicKey(raw.writerPublicKey) };
  const url = new URL(r.endpoint);
  const localTest = process.env.NODE_ENV === 'test' && url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if ((!localTest && url.protocol !== 'https:') || url.username || url.password || r.endpoint.includes('?') || r.endpoint.includes('#')
    || url.pathname !== FINAL_BRIDGE_PATH || url.href !== r.endpoint
    || r.approvedScope !== 'DISABLE_LOCAL_WRITER_AND_START_FREEZING'
    || !/^[0-9a-f]{64}$/.test(r.registrationDigest) || !UUID.test(r.tenantId)
    || !/^[1-9][0-9]{0,15}$/.test(r.registrationVersion)) refused();
  for (const value of [r.deploymentId, r.sourceId, r.spreadsheetId, r.requestKeyId]) {
    if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) refused();
  }
  const keys = [r.requestPublicKey, r.manifestPublicKey, r.writerPublicKey].map(keyBytes);
  if (keys.some((k, i) => keys.slice(i + 1).some(other => k.equals(other)))) refused();
  return Object.freeze(r);
}
function exact(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).length !== keys.length) refused();
  const copy: Record<string, unknown> = {};
  for (const k of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, k);
    if (!d?.enumerable || !('value' in d)) refused(); copy[k] = d.value;
  }
  return copy;
}
function binding(raw: unknown, r: BridgeRegistration): BridgeRequestBody {
  const b = exact(raw, ['ceremonyId', 'challenge']);
  if (typeof b.ceremonyId !== 'string' || !UUID.test(b.ceremonyId)) refused();
  const c = parseFinalBridgeChallenge(b.challenge);
  if (c.expiresAt - c.issuedAt !== 60_000 || c.tenantId !== r.tenantId || c.sourceId !== r.sourceId
    || c.deploymentId !== r.deploymentId || c.spreadsheetIdDigest !== sha256(r.spreadsheetId)) refused();
  return Object.freeze({ ceremonyId: b.ceremonyId, challenge: c });
}
function fresh(issuedAt: number, expiresAt: number) {
  const now = Date.now();
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt < 0
    || issuedAt > now || expiresAt <= now || expiresAt <= issuedAt || expiresAt - issuedAt > 60_000) refused();
}
function signatureBytes(auth: Omit<Auth, 'signature'>) { return Buffer.from(PREFIX + canonicalJson(auth), 'utf8'); }
export function signBridgeRequest(raw: BridgeRegistration, privateKey: KeyLike, input: BridgeRequestBody) {
  const r = validateBridgeRegistration(raw); const b = binding(input, r);
  if (!keyBytes(privateKey).equals(keyBytes(r.requestPublicKey))) refused();
  fresh(b.challenge.issuedAt, b.challenge.expiresAt);
  const body = canonicalJson(b);
  if (Buffer.byteLength(body) > BODY_LIMIT) refused();
  const unsigned: Omit<Auth, 'signature'> = {
    version: 1, purpose: PURPOSE, method: 'POST', path: FINAL_BRIDGE_PATH, audience: r.deploymentId,
    registrationDigest: r.registrationDigest, registrationVersion: r.registrationVersion,
    ceremonyId: b.ceremonyId, bridgeChallengeId: b.challenge.challengeId, bodyDigest: sha256(body),
    issuedAt: Date.now(), expiresAt: b.challenge.expiresAt, nonce: randomBytes(24).toString('base64url'), keyId: r.requestKeyId,
  };
  fresh(unsigned.issuedAt, unsigned.expiresAt);
  const auth = { ...unsigned, signature: sign(null, signatureBytes(unsigned), privateKey).toString('base64url') };
  return Object.freeze({ body, requestDigest: sha256(canonicalJson(auth)), headers: Object.freeze({
    'content-type': 'application/json', accept: 'application/json',
    'x-class-store-bridge': Buffer.from(canonicalJson(auth)).toString('base64url'),
  }) });
}
/** Cap bytes while streaming, before decoding. Cancellation never waits for an
 * uncooperative stream's cancel promise. Deadline covers pending reader.read(). */
export async function readBridgeBytes(stream: ReadableStream<Uint8Array> | null, limit: number, signal: AbortSignal): Promise<string> {
  if (!stream || signal.aborted) refused();
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let length = 0;
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { void reader.cancel().catch(() => {}); reject(new Error('Registered bridge refused.')); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) refused();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) refused(); parts.push(next.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
  } catch { void reader.cancel().catch(() => {}); return refused(); }
  finally { signal.removeEventListener('abort', onAbort); reader.releaseLock(); }
}
/** Server-local composition root: sheets MUST be built from this registered
 * deployment's server credential, never consent/browser tokens. No run/control
 * callback is injectable: the actual legacy producer is always invoked.
 * This core is not production durable integration until reservations is wired.
 */
export function createRegisteredBridgeProducer(dependencies: Readonly<{
  registration: BridgeRegistration; reservations: BridgeReservations;
  sheets: WorkbookSnapshotReader; manifest: Omit<SealManifestOptions, 'now' | 'ttlMs' | 'nonce'>;
}>) {
  const r = validateBridgeRegistration(dependencies.registration);
  const manifest = { ...dependencies.manifest, encryptionKey: Buffer.from(dependencies.manifest.encryptionKey) };
  if (!keyBytes(manifest.signingPrivateKey).equals(keyBytes(r.manifestPublicKey)) || manifest.encryptionKey.length !== 32) refused();
  const reserve = dependencies.reservations.reserveAndCommit.bind(dependencies.reservations);
  const sheets = Object.freeze({ ...dependencies.sheets });
  return async (request: Request): Promise<Response> => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5_000);
    const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
    let started = false;
    const response = (status: number, data: unknown) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
    try {
      if (request.signal.aborted || request.method !== 'POST' || request.url !== r.endpoint
        || request.headers.get('content-type') !== 'application/json'
        || request.headers.has('authorization') || request.headers.has('cookie') || request.headers.has('content-encoding')) refused();
      const encoded = request.headers.get('x-class-store-bridge');
      if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded)) refused();
      const auth = exact(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), AUTH_KEYS) as Auth;
      const { signature, ...unsigned } = auth;
      if (auth.version !== 1 || auth.purpose !== PURPOSE || auth.method !== 'POST' || auth.path !== FINAL_BRIDGE_PATH
        || auth.audience !== r.deploymentId || auth.registrationDigest !== r.registrationDigest
        || auth.registrationVersion !== r.registrationVersion || auth.keyId !== r.requestKeyId
        || typeof auth.nonce !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(auth.nonce)
        || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)
        || !verify(null, signatureBytes(unsigned), r.requestPublicKey, Buffer.from(signature, 'base64url'))) refused();
      fresh(auth.issuedAt, auth.expiresAt);
      // Resolve actual writer-evidence purpose locally before reservation/disable.
      const writerPublic = process.env.CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY;
      const writerPrivate = process.env.CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY;
      if (!writerPublic || !writerPrivate || !keyBytes(writerPublic).equals(keyBytes(r.writerPublicKey))
        || !keyBytes(writerPrivate).equals(keyBytes(r.writerPublicKey))) refused();
      const bytes = await readBridgeBytes(request.body, BODY_LIMIT, controller.signal);
      if (sha256(bytes) !== auth.bodyDigest) refused();
      const b = binding(JSON.parse(bytes), r);
      if (auth.ceremonyId !== b.ceremonyId || auth.bridgeChallengeId !== b.challenge.challengeId
        || auth.issuedAt < b.challenge.issuedAt || auth.expiresAt !== b.challenge.expiresAt) refused();
      const check = () => { if (controller.signal.aborted || request.signal.aborted) refused(); fresh(auth.issuedAt, auth.expiresAt); };
      check();
      const row = Object.freeze({ deploymentId: r.deploymentId, registrationDigest: r.registrationDigest,
        ceremonyId: b.ceremonyId, challengeId: b.challenge.challengeId,
        nonceDigest: sha256(canonicalJson([PURPOSE, auth.nonce])), requestDigest: sha256(canonicalJson(auth)),
        issuedAt: auth.issuedAt, expiresAt: auth.expiresAt });
      let cancelReservation: () => void = () => {};
      const reservationAborted = new Promise<never>((_, reject) => {
        cancelReservation = () => reject(new Error('Reservation ACK unavailable.'));
        controller.signal.addEventListener('abort', cancelReservation, { once: true });
        if (controller.signal.aborted) cancelReservation();
      });
      let ack: BridgeReservation;
      try { ack = await Promise.race([reserve(row), reservationAborted]); }
      finally { controller.signal.removeEventListener('abort', cancelReservation); }
      if (canonicalJson(ack) !== canonicalJson(row)) refused();
      check(); clearTimeout(timer);
      // No auto-enable on failure/cancel after this line; external result UNKNOWN.
      started = true;
      const now = Date.now();
      if (auth.expiresAt - now < 1000) refused();
      const result = await runLegacyMigrationBridge({ deploymentId: r.deploymentId, mode: 'final-delta',
        capturedAt: new Date(now).toISOString(), finalIntakeBinding: b.challenge,
        sheets: { spreadsheetId: r.spreadsheetId, reader: sheets }, crypto: { ...manifest, ttlMs: auth.expiresAt - now } });
      check();
      const json = JSON.stringify(result.manifest);
      if (Buffer.byteLength(json) > BRIDGE_RESPONSE_LIMIT) refused();
      return response(200, result.manifest);
    } catch { return response(started ? 503 : 403, { outcome: started ? 'UNKNOWN' : 'REFUSED' }); }
    finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); }
  };
}
