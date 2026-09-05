import {
  createCipheriv, createDecipheriv, hkdfSync, randomBytes, sign, verify,
  type KeyLike,
} from 'node:crypto';
import { assertNoSensitiveData, deepFreeze } from './sensitiveRedaction';

const VERSION = 1;
const ALGORITHM = 'Ed25519+A256GCM';
const MAX_PLAINTEXT_BYTES = 1_000_000;
const MAX_ENVELOPE_BYTES = 1_500_000;
const MAX_LIFETIME_MS = 5 * 60_000;
const MIN_LIFETIME_MS = 1_000;
const MAX_RECORDS = 200_000;
const MAX_STRING = 100_000;
const KDF_SALT = Buffer.from('class-store:legacy-bridge-manifest:kdf:v1', 'utf8');
const KDF_INFO = Buffer.from('authenticated-encryption', 'utf8');
const SIGNATURE_PURPOSE = Buffer.from('class-store:legacy-bridge-manifest:signature:v1\0', 'utf8');

export type LegacyBridgeEnvelope = Readonly<{
  version: 1;
  algorithm: typeof ALGORITHM;
  keyId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  iv: string;
  ciphertext: string;
  authTag: string;
  signature: string;
}>;

export interface AtomicNonceConsumer {
  /** Must atomically persist the nonce iff absent; concurrent calls cannot both return true. */
  consumeOnce(nonce: string, expiresAt: number): Promise<boolean>;
}

export type SealManifestOptions = Readonly<{
  keyId: string;
  encryptionKey: Uint8Array;
  signingPrivateKey: KeyLike;
  now?: () => number;
  nonce?: () => Uint8Array;
  ttlMs?: number;
}>;

export function sealLegacyBridgeManifest(payload: unknown, options: SealManifestOptions): LegacyBridgeEnvelope {
  validatePayloadShape(payload);
  assertNoSensitiveData(payload);
  const plaintext = Buffer.from(canonicalJson(payload), 'utf8');
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('Legacy bridge manifest size limit exceeded.');
  validateKey(options.encryptionKey);
  assertBoundedString(options.keyId, 128);
  const issuedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new Error('Legacy bridge manifest time is invalid.');
  const ttlMs = options.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LIFETIME_MS || ttlMs > MAX_LIFETIME_MS) {
    throw new Error('Legacy bridge manifest lifetime is invalid.');
  }
  if (issuedAt > Number.MAX_SAFE_INTEGER - ttlMs) throw new Error('Legacy bridge manifest time is invalid.');
  const nonceBytes = Buffer.from((options.nonce ?? (() => randomBytes(24)))());
  if (nonceBytes.byteLength !== 24) throw new Error('Legacy bridge manifest nonce is invalid.');
  const iv = randomBytes(12);
  const header: Pick<LegacyBridgeEnvelope,
    'version' | 'algorithm' | 'keyId' | 'nonce' | 'issuedAt' | 'expiresAt' | 'iv'> = {
    version: VERSION,
    algorithm: ALGORITHM,
    keyId: options.keyId,
    nonce: nonceBytes.toString('base64url'),
    issuedAt,
    expiresAt: issuedAt + ttlMs,
    iv: iv.toString('base64url'),
  };
  const aad = Buffer.from(canonicalJson(header), 'utf8');
  const cipher = createCipheriv('aes-256-gcm', deriveEncryptionKey(options.encryptionKey), iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64url');
  const unsigned = { ...header, ciphertext, authTag: cipher.getAuthTag().toString('base64url') };
  const signature = sign(null, signatureBytes(unsigned), options.signingPrivateKey).toString('base64url');
  const envelope = { ...unsigned, signature };
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_ENVELOPE_BYTES) throw new Error('Legacy bridge manifest size limit exceeded.');
  return deepFreeze(envelope);
}

export async function openLegacyBridgeManifest<T = unknown>(rawEnvelope: unknown, options: Readonly<{
  encryptionKey: Uint8Array;
  signingPublicKey: KeyLike;
  nonceConsumer: AtomicNonceConsumer;
  now?: () => number;
}>): Promise<T> {
  const envelope = parseEnvelope(rawEnvelope);
  validateKey(options.encryptionKey);
  const unsigned = {
    version: envelope.version, algorithm: envelope.algorithm, keyId: envelope.keyId,
    nonce: envelope.nonce, issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt,
    iv: envelope.iv, ciphertext: envelope.ciphertext, authTag: envelope.authTag,
  };
  let signatureValid = false;
  try {
    signatureValid = verify(null, signatureBytes(unsigned), options.signingPublicKey,
      Buffer.from(envelope.signature, 'base64url'));
  } catch { /* safe invalid result below */ }
  if (!signatureValid) throw new Error('Legacy bridge manifest is invalid.');

  const now = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Legacy bridge manifest time is invalid.');
  if (now > envelope.expiresAt) throw new Error('Legacy bridge manifest is expired.');
  if (now < envelope.issuedAt - 30_000) throw new Error('Legacy bridge manifest is not yet valid.');

  let payload: unknown;
  try {
    const header = {
      version: envelope.version, algorithm: envelope.algorithm, keyId: envelope.keyId,
      nonce: envelope.nonce, issuedAt: envelope.issuedAt, expiresAt: envelope.expiresAt, iv: envelope.iv,
    };
    const decipher = createDecipheriv('aes-256-gcm', deriveEncryptionKey(options.encryptionKey), Buffer.from(envelope.iv, 'base64url'));
    decipher.setAAD(Buffer.from(canonicalJson(header), 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) throw new Error('oversized');
    payload = JSON.parse(plaintext.toString('utf8')) as unknown;
    validatePayloadShape(payload);
    assertNoSensitiveData(payload);
  } catch {
    throw new Error('Legacy bridge manifest is invalid.');
  }

  // Consume only after structural validation, signature verification, authenticated decryption, and payload validation.
  if (!await options.nonceConsumer.consumeOnce(`${envelope.keyId}:${envelope.nonce}`, envelope.expiresAt)) {
    throw new Error('Legacy bridge manifest replay detected.');
  }
  return deepFreeze(payload as T);
}

function parseEnvelope(value: unknown): LegacyBridgeEnvelope {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !==
    ['algorithm','authTag','ciphertext','expiresAt','issuedAt','iv','keyId','nonce','signature','version'].sort().join(',')
    || value.version !== VERSION || value.algorithm !== ALGORITHM
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || Number(value.issuedAt) < 0 || Number(value.expiresAt) - Number(value.issuedAt) < MIN_LIFETIME_MS
    || Number(value.expiresAt) - Number(value.issuedAt) > MAX_LIFETIME_MS) {
    throw new Error('Legacy bridge manifest is invalid.');
  }
  for (const [key, max] of [['keyId',128], ['nonce',64], ['iv',32], ['ciphertext',1_400_000], ['authTag',32], ['signature',128]] as const) {
    if (typeof value[key] !== 'string' || !(value[key] as string) || (value[key] as string).length > max) throw new Error('Legacy bridge manifest is invalid.');
  }
  if (!/^[A-Za-z0-9_-]{32}$/.test(value.nonce as string)
    || !/^[A-Za-z0-9_-]{16}$/.test(value.iv as string)
    || !/^[A-Za-z0-9_-]{22}$/.test(value.authTag as string)
    || !/^[A-Za-z0-9_-]{86}$/.test(value.signature as string)
    || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_ENVELOPE_BYTES) {
    throw new Error('Legacy bridge manifest is invalid.');
  }
  return value as unknown as LegacyBridgeEnvelope;
}

function deriveEncryptionKey(input: Uint8Array): Buffer {
  return Buffer.from(hkdfSync('sha256', input, KDF_SALT, KDF_INFO, 32));
}
function signatureBytes(value: unknown): Buffer { return Buffer.concat([SIGNATURE_PURPOSE, Buffer.from(canonicalJson(value), 'utf8')]); }
function validateKey(value: Uint8Array) { if (!ArrayBuffer.isView(value) || value.byteLength !== 32) throw new Error('Legacy bridge key is invalid.'); }
function assertBoundedString(value: unknown, max: number) { if (typeof value !== 'string' || !value || value.length > max) throw new Error('Legacy bridge manifest string is invalid.'); }
function validatePayloadShape(value: unknown, enforceStringLimit = true) {
  let records = 0;
  const ancestors = new WeakSet<object>();
  const visit = (item: unknown): void => {
    records += 1;
    if (records > MAX_RECORDS) throw new Error('Legacy bridge manifest record limit exceeded.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') {
      if (enforceStringLimit && item.length > MAX_STRING) {
        throw new Error('Legacy bridge manifest string size limit exceeded.');
      }
      return;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Legacy bridge manifest value is invalid.');
      return;
    }
    if (typeof item !== 'object') throw new Error('Legacy bridge manifest value is invalid.');
    if (ancestors.has(item)) throw new Error('Legacy bridge manifest value is invalid.');

    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        const ownKeys = Reflect.ownKeys(item);
        if (ownKeys.length !== item.length + 1 || !ownKeys.includes('length')) {
          throw new Error('Legacy bridge manifest value is invalid.');
        }
        for (let index = 0; index < item.length; index += 1) {
          const key = String(index);
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw new Error('Legacy bridge manifest value is invalid.');
          }
          visit(descriptor.value);
        }
        return;
      }

      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Legacy bridge manifest value is invalid.');
      }
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') throw new Error('Legacy bridge manifest value is invalid.');
        assertBoundedString(key, 256);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
          throw new Error('Legacy bridge manifest value is invalid.');
        }
        visit(descriptor.value);
      }
    } finally {
      ancestors.delete(item);
    }
  };
  visit(value);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function canonicalJson(value: unknown): string {
  validatePayloadShape(value, false);
  const serialize = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(serialize).join(',')}]`;
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(',')}}`;
  };
  return serialize(value);
}
