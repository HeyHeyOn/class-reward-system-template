import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { SheetsReader, SheetsStore } from '@/server/sheetsRepository';
import { getSheetSettings, saveSheetSetting } from '@/server/sheetsRepository';

export const ADMIN_SESSION_COOKIE = 'class_store_admin';
const SESSION_VERSION = 'v1';
const SIGNED_SESSION_VERSION = 'v2';
const ADMIN_PASSWORD_HASH_KEY = 'adminPasswordHash';

type AdminAuthEnv = { [key: string]: string | undefined; ADMIN_PASSWORD?: string; AUTH_SECRET?: string };

export function isAdminAuthEnabled(env: AdminAuthEnv = process.env): boolean {
  return Boolean(env.ADMIN_PASSWORD?.trim() || env.AUTH_SECRET?.trim());
}

export function verifyAdminPassword(password: string, env: AdminAuthEnv = process.env): boolean {
  const configured = env.ADMIN_PASSWORD?.trim();
  if (!configured) return true;

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

  if (!reader) return !configured;

  try {
    const settings = await getSheetSettings(reader);
    const savedHash = settings[ADMIN_PASSWORD_HASH_KEY]?.trim();
    if (savedHash && safeEqual(submittedHash, savedHash)) return true;
    const recoveryCodeHash = settings.recoveryCodeHash?.trim();
    if (recoveryCodeHash && safeEqual(hashRecoveryCode(password), recoveryCodeHash)) return true;
  } catch {
    // Fall back to env-only auth when Settings is unavailable.
  }

  return !configured;
}

export async function saveAdminPassword(store: SheetsStore, password: string): Promise<void> {
  const trimmed = password.trim();
  if (trimmed.length < 4) throw new Error('관리자 암호는 4자 이상으로 입력해 주세요.');
  await saveSheetSetting(store, { key: ADMIN_PASSWORD_HASH_KEY, value: hashValue(trimmed) });
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
  if (token === createAdminSessionToken(env)) return true;
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

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
