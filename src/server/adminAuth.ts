import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { SheetsReader, SheetsStore } from '@/server/sheetsRepository';
import { getSheetSettings, saveSheetSetting } from '@/server/sheetsRepository';

export const ADMIN_SESSION_COOKIE = 'class_store_admin';
const SESSION_VERSION = 'v1';
const SIGNED_SESSION_VERSION = 'v2';
const ADMIN_PASSWORD_HASH_KEY = 'adminPasswordHash';
const PASSWORD_HASH_VERSION = 'scrypt';
const SCRYPT_COST = 16_384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const PASSWORD_HASH_BYTES = 32;
const PASSWORD_SALT_BYTES = 16;

type AdminAuthEnv = { [key: string]: string | undefined; ADMIN_PASSWORD?: string; AUTH_SECRET?: string };

export function isAdminAuthEnabled(env: AdminAuthEnv = process.env): boolean {
  return Boolean(env.ADMIN_PASSWORD?.trim() || env.AUTH_SECRET?.trim());
}

export function verifyAdminPassword(password: string, env: AdminAuthEnv = process.env): boolean {
  const configured = env.ADMIN_PASSWORD?.trim();
  if (!configured) return !isAdminAuthEnabled(env);

  return safeEqual(hashValue(password), hashValue(configured));
}

export async function verifyAdminPasswordWithSettings(
  password: string,
  reader?: SheetsReader,
  env: AdminAuthEnv = process.env,
): Promise<boolean> {
  const submittedHash = hashValue(password);
  const configured = env.ADMIN_PASSWORD?.trim();
  if (configured && safeEqual(submittedHash, hashValue(configured))) return true;

  if (!reader) return !isAdminAuthEnabled(env);

  try {
    const settings = await getSheetSettings(reader);
    const savedHash = settings[ADMIN_PASSWORD_HASH_KEY]?.trim();
    const recoveryCodeHash = settings.recoveryCodeHash?.trim();
    if (recoveryCodeHash && safeEqual(hashRecoveryCode(password), recoveryCodeHash)) return true;
    if (savedHash && verifyAdminPasswordHash(password, savedHash)) return true;
    if (savedHash || recoveryCodeHash) return false;
  } catch {
    return false;
  }

  return !isAdminAuthEnabled(env);
}

export async function saveAdminPassword(store: SheetsStore, password: string): Promise<void> {
  await saveSheetSetting(store, { key: ADMIN_PASSWORD_HASH_KEY, value: createAdminPasswordHash(password) });
}

export function createAdminPasswordHash(password: string): string {
  const trimmed = password.trim();
  if (trimmed.length < 4) throw new Error('관리자 암호는 4자 이상으로 입력해 주세요.');
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = derivePasswordHash(trimmed, salt);
  return [
    PASSWORD_HASH_VERSION,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString('hex'),
    hash.toString('hex'),
  ].join('$');
}

export function verifyAdminPasswordHash(password: string, savedHash: string): boolean {
  if (/^[a-f0-9]{64}$/.test(savedHash)) {
    return safeEqual(hashValue(password), savedHash);
  }

  const [version, cost, blockSize, parallelization, saltHex, hashHex, ...extra] = savedHash.split('$');
  if (version !== PASSWORD_HASH_VERSION
    || cost !== String(SCRYPT_COST)
    || blockSize !== String(SCRYPT_BLOCK_SIZE)
    || parallelization !== String(SCRYPT_PARALLELIZATION)
    || !new RegExp(`^[a-f0-9]{${PASSWORD_SALT_BYTES * 2}}$`).test(saltHex ?? '')
    || !new RegExp(`^[a-f0-9]{${PASSWORD_HASH_BYTES * 2}}$`).test(hashHex ?? '')
    || extra.length > 0) return false;

  try {
    const actual = derivePasswordHash(password, Buffer.from(saltHex, 'hex'));
    return safeEqual(actual.toString('hex'), hashHex);
  } catch {
    return false;
  }
}

export function createAdminSessionToken(env: AdminAuthEnv = process.env): string {
  const configured = env.ADMIN_PASSWORD?.trim();
  if (!configured) return 'dev-no-password';
  return `${SESSION_VERSION}.${hashValue(configured)}`;
}

export function createSignedAdminSessionToken(password: string, env: AdminAuthEnv = process.env): string {
  const issuedAt = String(Date.now());
  const passwordHash = hashValue(password);
  const payload = `${SIGNED_SESSION_VERSION}.${issuedAt}.${passwordHash}`;
  return `${payload}.${signPayload(payload, env)}`;
}

export function isValidAdminSession(token: string | undefined, env: AdminAuthEnv = process.env): boolean {
  if (!isAdminAuthEnabled(env)) return true;
  if (!token) return false;
  if (env.ADMIN_PASSWORD?.trim() && token === createAdminSessionToken(env)) return true;
  return isValidSignedAdminSession(token, env);
}

export function isValidSignedAdminSession(token: string, env: AdminAuthEnv = process.env): boolean {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== SIGNED_SESSION_VERSION) return false;
  const [version, issuedAt, passwordHash, signature] = parts;
  if (!/^\d+$/.test(issuedAt) || !/^[a-f0-9]{64}$/.test(passwordHash)) return false;
  const ageMs = Date.now() - Number(issuedAt);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 1000 * 60 * 60 * 12) return false;
  const payload = `${version}.${issuedAt}.${passwordHash}`;
  return safeEqual(signature, signPayload(payload, env));
}

export function getAdminQrValue(password: string): string {
  return `class-store-admin:${password}`;
}

function signPayload(payload: string, env: AdminAuthEnv): string {
  const secret = env.AUTH_SECRET?.trim() || env.ADMIN_PASSWORD?.trim() || 'class-store-dev-secret';
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashRecoveryCode(value: string): string {
  return hashValue(value.trim().toUpperCase());
}

function derivePasswordHash(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, PASSWORD_HASH_BYTES, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
