import { createHmac, timingSafeEqual } from 'node:crypto';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

const TOKEN_VERSION = 'csq1';
const TENANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Za-z0-9_-]{1,24}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const MAX_STUDENT_ID_BYTES = 128;
const MAX_TOKEN_BYTES = 512;
const MAX_KEYS = 8;

export type StudentQrEnv = Readonly<{
  [key: string]: string | undefined;
  STUDENT_QR_ACTIVE_KEY_ID?: string;
  STUDENT_QR_SIGNING_KEYS?: string;
}>;

/** Which configuration check failed; carries no key material, so it is safe to log. */
export type StudentQrConfigurationProblem =
  | 'ACTIVE_KEY_ID' | 'KEYS_MISSING' | 'KEYS_JSON' | 'KEYS_COUNT' | 'KEY_ID' | 'KEY_FORMAT' | 'ACTIVE_KEY_MISSING';

export class StudentQrConfigurationError extends Error {
  constructor(readonly problem?: StudentQrConfigurationProblem) {
    super(problem ? `Student QR signing configuration is invalid (${problem}).` : 'Student QR signing configuration is invalid.');
    this.name = 'StudentQrConfigurationError';
  }
}

export class StudentQrValidationError extends Error {
  constructor() {
    super('Student QR is invalid.');
    this.name = 'StudentQrValidationError';
  }
}

type SigningConfiguration = Readonly<{
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}>;

export function createSignedStudentQr(
  input: Readonly<{ tenantId: string; studentId: string }>,
  env: StudentQrEnv = process.env,
): string {
  const configuration = parseConfiguration(env);
  if (!TENANT_ID.test(input.tenantId)) throw new StudentQrValidationError();
  const studentId = validateStudentId(input.studentId, false);
  const payload = Buffer.from(JSON.stringify([input.tenantId.toLowerCase(), studentId]), 'utf8').toString('base64url');
  const signedValue = `${TOKEN_VERSION}.${configuration.activeKeyId}.${payload}`;
  const key = configuration.keys.get(configuration.activeKeyId);
  if (!key) throw new StudentQrConfigurationError();
  return `${signedValue}.${sign(signedValue, key)}`;
}

export function resolveStudentQr(
  value: unknown,
  trustedTenantId: string | undefined,
  env: StudentQrEnv = process.env,
): Readonly<{ studentId: string; format: 'SIGNED' | 'LEGACY' }> {
  if (typeof value !== 'string' || !trustedTenantId || !TENANT_ID.test(trustedTenantId)) {
    throw new StudentQrValidationError();
  }
  const trimmed = value.trim();
  if (trimmed.startsWith(`${TOKEN_VERSION}.`)) {
    return { studentId: verifySignedStudentQr(trimmed, trustedTenantId, env), format: 'SIGNED' };
  }
  if (/^csq\d+(?:\.|$)/.test(trimmed)) throw new StudentQrValidationError();
  return { studentId: validateStudentId(trimmed, false), format: 'LEGACY' };
}

export function resolveStudentQrForCurrentTenant(
  value: unknown,
  env: StudentQrEnv & Readonly<{ CLASS_STORE_STORAGE?: string }> = process.env,
): Readonly<{ studentId: string; format: 'SIGNED' | 'LEGACY' }> {
  const context = getOptionalTrustedTenantRequestContext();
  if (context) return resolveStudentQr(value, context.tenant.id, env);

  // A single-deployment Sheets install is itself the selected compatibility scope.
  // Signed values and PostgreSQL requests always require URL-derived trusted context.
  if (env.CLASS_STORE_STORAGE === 'postgresql' || typeof value !== 'string'
    || /^csq\d+(?:\.|$)/.test(value.trim())) {
    throw new StudentQrValidationError();
  }
  return { studentId: validateStudentId(value.trim(), false), format: 'LEGACY' };
}

function verifySignedStudentQr(value: string, trustedTenantId: string, env: StudentQrEnv): string {
  if (Buffer.byteLength(value, 'utf8') > MAX_TOKEN_BYTES) throw new StudentQrValidationError();
  const parts = value.split('.');
  if (parts.length !== 4) throw new StudentQrValidationError();
  const [version, keyId, payload, signature] = parts;
  if (version !== TOKEN_VERSION || !KEY_ID.test(keyId) || !BASE64URL.test(payload) || !SIGNATURE.test(signature)) {
    throw new StudentQrValidationError();
  }

  const configuration = parseConfiguration(env);
  const key = configuration.keys.get(keyId);
  if (!key) throw new StudentQrValidationError();
  const signedValue = `${version}.${keyId}.${payload}`;
  if (!safeEqualBase64Url(signature, sign(signedValue, key))) throw new StudentQrValidationError();

  let decoded: string;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) throw new Error('non-canonical');
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new StudentQrValidationError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new StudentQrValidationError();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2
    || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
    || JSON.stringify(parsed) !== decoded
    || !TENANT_ID.test(parsed[0]) || parsed[0] !== parsed[0].toLowerCase()
    || parsed[0] !== trustedTenantId.toLowerCase()) {
    throw new StudentQrValidationError();
  }
  return validateStudentId(parsed[1], true);
}

/** Environment values are often pasted with surrounding whitespace or quotes; neither is part of the value. */
function unwrapEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return value;
  let unwrapped = value.trim();
  while (unwrapped.length >= 2 && ((unwrapped.startsWith("'") && unwrapped.endsWith("'"))
    || (unwrapped.startsWith('"') && unwrapped.endsWith('"') && !unwrapped.startsWith('"{')))) {
    unwrapped = unwrapped.slice(1, -1).trim();
  }
  return unwrapped;
}

/** A 32-byte key, written as base64url (canonical) or as standard/padded base64. */
function decodeSigningKey(encoded: string): Buffer | null {
  const trimmed = encoded.trim();
  if (!/^[A-Za-z0-9+/_-]{43}={0,1}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
  return key.length === 32 ? key : null;
}

function parseConfiguration(env: StudentQrEnv): SigningConfiguration {
  const activeKeyId = unwrapEnvValue(env.STUDENT_QR_ACTIVE_KEY_ID);
  const rawKeys = unwrapEnvValue(env.STUDENT_QR_SIGNING_KEYS);
  if (typeof activeKeyId !== 'string' || !KEY_ID.test(activeKeyId)) throw new StudentQrConfigurationError('ACTIVE_KEY_ID');
  if (typeof rawKeys !== 'string' || !rawKeys || rawKeys.length > 2048) throw new StudentQrConfigurationError('KEYS_MISSING');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
    // A JSON object stored as a JSON string (double-encoded) is the same configuration.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  } catch {
    throw new StudentQrConfigurationError('KEYS_JSON');
  }
  if (!isPlainRecord(parsed)) throw new StudentQrConfigurationError('KEYS_JSON');
  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > MAX_KEYS) throw new StudentQrConfigurationError('KEYS_COUNT');
  const keys = new Map<string, Buffer>();
  for (const [keyId, encoded] of entries) {
    if (!KEY_ID.test(keyId)) throw new StudentQrConfigurationError('KEY_ID');
    const key = typeof encoded === 'string' ? decodeSigningKey(encoded) : null;
    if (!key) throw new StudentQrConfigurationError('KEY_FORMAT');
    keys.set(keyId, key);
  }
  if (!keys.has(activeKeyId)) throw new StudentQrConfigurationError('ACTIVE_KEY_MISSING');
  return { activeKeyId, keys };
}

function validateStudentId(value: string, requireCanonical: boolean): string {
  const trimmed = value.trim();
  if (!trimmed || (requireCanonical && trimmed !== value)
    || Buffer.byteLength(trimmed, 'utf8') > MAX_STUDENT_ID_BYTES
    || /[\u0000-\u001f\u007f-\u009f]/u.test(trimmed)
    || /[\uD800-\uDFFF]/u.test(trimmed)) {
    throw new StudentQrValidationError();
  }
  return trimmed;
}

function sign(value: string, key: Buffer): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('base64url');
}

function safeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'base64url');
  const rightBuffer = Buffer.from(right, 'base64url');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
