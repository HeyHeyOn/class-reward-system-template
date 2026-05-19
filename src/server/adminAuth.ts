import { createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_SESSION_COOKIE = 'class_store_admin';
const SESSION_VERSION = 'v1';

type AdminAuthEnv = { [key: string]: string | undefined; ADMIN_PASSWORD?: string };

export function isAdminAuthEnabled(env: AdminAuthEnv = process.env): boolean {
  return Boolean(env.ADMIN_PASSWORD?.trim());
}

export function verifyAdminPassword(password: string, env: AdminAuthEnv = process.env): boolean {
  const configured = env.ADMIN_PASSWORD?.trim();
  if (!configured) return true;

  const submittedHash = hashValue(password);
  const configuredHash = hashValue(configured);

  return timingSafeEqual(Buffer.from(submittedHash), Buffer.from(configuredHash));
}

export function createAdminSessionToken(env: AdminAuthEnv = process.env): string {
  const configured = env.ADMIN_PASSWORD?.trim();
  if (!configured) return 'dev-no-password';
  return `${SESSION_VERSION}.${hashValue(configured)}`;
}

export function isValidAdminSession(token: string | undefined, env: AdminAuthEnv = process.env): boolean {
  if (!isAdminAuthEnabled(env)) return true;
  if (!token) return false;
  return token === createAdminSessionToken(env);
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
