import 'server-only';

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { verifyAdminPasswordHash } from '@/server/adminAuth';
import { withTenantSnapshot } from '@/server/db/transaction';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import type { TenantLifecycle } from '@/server/tenantContext';

const SESSION_VERSION = 'csa1';
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const QR_PREFIX = 'class-store-admin:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

type Env = Readonly<{
  [key: string]: string | undefined;
  CLASS_STORE_STORAGE?: string;
  AUTH_SECRET?: string;
  ADMIN_PASSWORD?: string;
}>;

export type TenantLegacyAdminCredential = Readonly<{
  tenantId: string;
  lifecycle: TenantLifecycle;
  credentialVersion: number;
  secretVersion: number;
  secretHash: string;
  hashAlgorithm: string;
  revokedAt: Date | null;
}>;

export type TenantLegacyAdminAuthDependencies = Readonly<{
  readCurrentCredential(tenantId: string): Promise<TenantLegacyAdminCredential | null>;
  createSession?(tenantId: string, credentialVersion: number, expiresAt: Date): Promise<Readonly<{
    token: string;
    sessionVersion: number;
  }>>;
  readSession?(tenantId: string, token: string): Promise<TenantLegacyAdminSession | null>;
  now?: () => number;
}>;

export type TenantLegacyAdminSession = Readonly<{
  tenantId: string;
  credentialVersion: number;
  sessionVersion: number;
  tokenSessionVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
}>;

export class TenantLegacyAdminAuthError extends Error {
  constructor() {
    super('Tenant admin credential is invalid.');
    this.name = 'TenantLegacyAdminAuthError';
  }
}

export function createTenantLegacyAdminAuth(
  dependencies: TenantLegacyAdminAuthDependencies,
  env: Env = process.env,
) {
  const now = dependencies.now ?? Date.now;
  const secret = signingSecret(env);

  return {
    async login(input: unknown): Promise<Readonly<{
      sessionToken: string;
      credentialVersion: number;
      sessionVersion: number;
    }>> {
      if (env.CLASS_STORE_STORAGE !== 'postgresql') throw new TenantLegacyAdminAuthError();
      const context = getOptionalTrustedTenantRequestContext();
      if (!context) throw new TenantLegacyAdminAuthError();
      const password = parseCredentialInput(input);
      const credential = await dependencies.readCurrentCredential(context.tenant.id);
      if (!isUsableCredential(credential, context.tenant.id, context.tenant.lifecycle)
        || !verifyAdminPasswordHash(password, credential.secretHash)) {
        throw new TenantLegacyAdminAuthError();
      }
      if (dependencies.createSession) {
        const persisted = await dependencies.createSession(
          context.tenant.id,
          credential.credentialVersion,
          new Date(now() + SESSION_LIFETIME_MS),
        );
        return {
          sessionToken: persisted.token,
          credentialVersion: credential.credentialVersion,
          sessionVersion: persisted.sessionVersion,
        };
      }
      const sessionVersion = 1;
      return {
        sessionToken: createSessionToken({
          tenantId: context.tenant.id,
          credentialVersion: credential.credentialVersion,
          sessionVersion,
          issuedAt: now(),
        }, secret),
        credentialVersion: credential.credentialVersion,
        sessionVersion,
      };
    },

    async verifySession(token: string | undefined, tenantId: string): Promise<boolean> {
      if (dependencies.readSession) {
        if (typeof token !== 'string') return false;
        const session = await dependencies.readSession(tenantId, token);
        if (!session || session.tenantId !== tenantId || session.revokedAt !== null
          || session.expiresAt.getTime() <= now()
          || session.sessionVersion !== session.tokenSessionVersion) return false;
        const credential = await dependencies.readCurrentCredential(tenantId);
        return isUsableCredential(credential, tenantId, credential?.lifecycle)
          && credential.credentialVersion === session.credentialVersion;
      }
      const payload = parseSessionToken(token, secret, now());
      if (!payload || payload.tenantId !== tenantId) return false;
      const credential = await dependencies.readCurrentCredential(tenantId);
      return isUsableCredential(credential, tenantId, credential?.lifecycle)
        && credential.credentialVersion === payload.credentialVersion
        && payload.sessionVersion === 1;
    },
  };
}

function parseCredentialInput(value: unknown): string {
  if (!isExactObject(value, ['kind', 'value'])
    || (value.kind !== 'password' && value.kind !== 'qr')
    || typeof value.value !== 'string'
    || value.value.length < 1
    || value.value.length > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value.value)) {
    throw new TenantLegacyAdminAuthError();
  }
  if (value.kind === 'qr') {
    if (!value.value.startsWith(QR_PREFIX)) throw new TenantLegacyAdminAuthError();
    const password = value.value.slice(QR_PREFIX.length);
    if (!password || password.startsWith(QR_PREFIX)) throw new TenantLegacyAdminAuthError();
    return password;
  }
  if (value.value.startsWith(QR_PREFIX)) throw new TenantLegacyAdminAuthError();
  return value.value;
}

function isUsableCredential(
  value: TenantLegacyAdminCredential | null,
  tenantId: string,
  trustedLifecycle: TenantLifecycle | undefined,
): value is TenantLegacyAdminCredential {
  if (!value || value.tenantId !== tenantId || value.lifecycle !== trustedLifecycle
    || !Number.isSafeInteger(value.credentialVersion) || value.credentialVersion < 1
    || !Number.isSafeInteger(value.secretVersion) || value.secretVersion !== value.credentialVersion
    || value.revokedAt !== null
    || (value.hashAlgorithm !== 'scrypt' && value.hashAlgorithm !== 'sha256')) return false;
  if (value.lifecycle !== 'READY' && value.lifecycle !== 'MIGRATION_READ_ONLY' && value.lifecycle !== 'ACTIVE') return false;
  return value.lifecycle !== 'ACTIVE' || value.credentialVersion > 1;
}

type SessionPayload = Readonly<{
  tenantId: string;
  credentialVersion: number;
  sessionVersion: number;
  issuedAt: number;
}>;

function createSessionToken(payload: SessionPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify([
    payload.tenantId.toLowerCase(), payload.credentialVersion, payload.sessionVersion, payload.issuedAt,
  ]), 'utf8').toString('base64url');
  return `${SESSION_VERSION}.${encoded}.${sign(`${SESSION_VERSION}.${encoded}`, secret)}`;
}

function parseSessionToken(token: string | undefined, secret: string, now: number): SessionPayload | null {
  if (typeof token !== 'string' || token.length > 512) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION || !SIGNATURE.test(parts[2])) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const bytes = Buffer.from(parts[1], 'base64url');
    if (bytes.toString('base64url') !== parts[1]) return null;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(decoded);
    if (!Array.isArray(parsed) || parsed.length !== 4 || JSON.stringify(parsed) !== decoded
      || typeof parsed[0] !== 'string' || !UUID.test(parsed[0]) || parsed[0] !== parsed[0].toLowerCase()
      || !Number.isSafeInteger(parsed[1]) || parsed[1] < 1
      || parsed[2] !== 1 || !Number.isSafeInteger(parsed[3])) return null;
    const age = now - parsed[3];
    if (age < 0 || age > SESSION_LIFETIME_MS) return null;
    return { tenantId: parsed[0], credentialVersion: parsed[1], sessionVersion: parsed[2], issuedAt: parsed[3] };
  } catch {
    return null;
  }
}

function signingSecret(env: Env): string {
  if (env.CLASS_STORE_STORAGE !== 'postgresql' || typeof env.AUTH_SECRET !== 'string' || env.AUTH_SECRET.trim().length < 16) {
    throw new TenantLegacyAdminAuthError();
  }
  return env.AUTH_SECRET.trim();
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'base64url');
  const rightBuffer = Buffer.from(right, 'base64url');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isExactObject<T extends string>(value: unknown, keys: readonly T[]): value is Record<T, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key as T));
}

async function readProductionCredential(tenantId: string): Promise<TenantLegacyAdminCredential | null> {
  return withTenantSnapshot(tenantId, async (transaction) => {
    const result = await transaction.execute(sql`
      SELECT t.id AS tenant_id, t.lifecycle, t.credential_version,
             s.version AS secret_version, s.secret_hash, s.hash_algorithm, s.revoked_at
      FROM public.tenants t
      LEFT JOIN public.tenant_auth_secrets s
        ON s.tenant_id = t.id
       AND s.kind = 'ADMIN_PASSWORD'
       AND s.version = t.credential_version
       AND s.revoked_at IS NULL
      WHERE t.id = ${tenantId}
      LIMIT 1
    `);
    const row = (result.rows as Record<string, unknown>[])[0];
    if (!row || typeof row.tenant_id !== 'string' || typeof row.lifecycle !== 'string'
      || typeof row.credential_version !== 'number' || typeof row.secret_version !== 'number'
      || typeof row.secret_hash !== 'string' || typeof row.hash_algorithm !== 'string') return null;
    return {
      tenantId: row.tenant_id,
      lifecycle: row.lifecycle as TenantLifecycle,
      credentialVersion: row.credential_version,
      secretVersion: row.secret_version,
      secretHash: row.secret_hash,
      hashAlgorithm: row.hash_algorithm,
      revokedAt: row.revoked_at instanceof Date ? row.revoked_at : null,
    };
  });
}

async function createProductionSession(
  tenantId: string,
  credentialVersion: number,
  expiresAt: Date,
): Promise<{ token: string; sessionVersion: number }> {
  return withTenantSnapshot(tenantId, async (transaction) => {
    const owner = await transaction.execute(sql`
      SELECT m.id AS membership_id, m.user_id
      FROM public.tenant_memberships m
      WHERE m.tenant_id = ${tenantId}
        AND m.role IN ('OWNER', 'ADMIN')
      ORDER BY CASE WHEN m.role = 'OWNER' THEN 0 ELSE 1 END, m.created_at, m.id
      LIMIT 1
    `);
    const row = (owner.rows as Record<string, unknown>[])[0];
    if (!row || typeof row.membership_id !== 'string' || typeof row.user_id !== 'string') {
      throw new TenantLegacyAdminAuthError();
    }
    const raw = randomBytes(32).toString('base64url');
    const sessionVersion = 1;
    await transaction.execute(sql`
      INSERT INTO public.tenant_sessions
        (tenant_id, membership_id, user_id, token_hash, credential_version, session_version, expires_at)
      VALUES
        (${tenantId}, ${row.membership_id}, ${row.user_id}, ${hashSessionToken(raw)},
         ${credentialVersion}, ${sessionVersion}, ${expiresAt})
    `);
    return { token: `${SESSION_VERSION}.${sessionVersion}.${raw}`, sessionVersion };
  });
}

async function readProductionSession(tenantId: string, token: string): Promise<TenantLegacyAdminSession | null> {
  const parsed = parseOpaqueSessionToken(token);
  if (!parsed) return null;
  return withTenantSnapshot(tenantId, async (transaction) => {
    const result = await transaction.execute(sql`
      SELECT s.tenant_id, s.credential_version, s.session_version, s.expires_at, s.revoked_at
      FROM public.tenant_sessions s
      WHERE s.tenant_id = ${tenantId}
        AND s.token_hash = ${hashSessionToken(parsed.raw)}
      LIMIT 1
    `);
    const row = (result.rows as Record<string, unknown>[])[0];
    if (!row || typeof row.tenant_id !== 'string'
      || typeof row.credential_version !== 'number' || typeof row.session_version !== 'number'
      || !(row.expires_at instanceof Date)) return null;
    return {
      tenantId: row.tenant_id,
      credentialVersion: row.credential_version,
      sessionVersion: row.session_version,
      tokenSessionVersion: parsed.sessionVersion,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at instanceof Date ? row.revoked_at : null,
    };
  });
}

function parseOpaqueSessionToken(token: string): { raw: string; sessionVersion: number } | null {
  const parts = token.split('.');
  const version = Number(parts[1]);
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION || !Number.isSafeInteger(version)
    || version < 1 || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return null;
  return { raw: parts[2], sessionVersion: version };
}

function hashSessionToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function getProductionTenantLegacyAdminAuth(env: Env = process.env) {
  return createTenantLegacyAdminAuth({
    readCurrentCredential: readProductionCredential,
    createSession: createProductionSession,
    readSession: readProductionSession,
  }, env);
}
