import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Student } from '@/domain/types';
import type { ConfirmedStudentLookup } from '@/server/studentLookup';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

/**
 * Personal bank login for one student on their own device.
 *
 * The cookie is sealed with the same construction the Google admin/generator cookies use
 * (src/server/googleOAuth.ts: AES-256-GCM, 96-bit IV, 128-bit tag, versioned
 * `version.iv.tag.ciphertext` wire format, a purpose-separated SHA-256 key derived from
 * AUTH_SECRET and purpose AAD). Those helpers are module-private there, so the construction
 * is repeated here with its own purpose label instead of reusing the admin key.
 *
 * The cookie is bound to one class: its tenant ID is both inside the authenticated payload
 * and part of the AAD, so another class's cookie fails authentication outright.
 */
export const STUDENT_BANK_SESSION_COOKIE = 'class_store_bank_session';
export const STUDENT_BANK_SESSION_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

const LIFETIME_MS = STUDENT_BANK_SESSION_LIFETIME_SECONDS * 1000;
const COOKIE_VERSION = 'bs1';
const PURPOSE = 'class-store:student-bank-session';
const MAX_COOKIE_LENGTH = 2048;
const MAX_STUDENT_ID_BYTES = 128;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MIN_SECRET_LENGTH = 16;
const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_STORE_HEADERS = { 'cache-control': 'private, no-store', vary: 'Cookie' } as const;

export type StudentBankSessionEnv = Readonly<{
  [key: string]: string | undefined;
  AUTH_SECRET?: string;
  CLASS_STORE_STORAGE?: string;
  NODE_ENV?: string;
}>;

/** Where a session is valid: one PostgreSQL class, or the single legacy Sheets deployment (null). */
export type StudentBankScope = Readonly<{ tenantId: string | null; cookiePath: string }>;

export type StudentBankSession = Readonly<{
  tenantId: string | null;
  studentId: string;
  issuedAt: number;
  expiresAt: number;
}>;

export class StudentBankSessionConfigurationError extends Error {
  constructor() {
    super('Student bank session secret is not configured.');
    this.name = 'StudentBankSessionConfigurationError';
  }
}

/**
 * The class this request belongs to. PostgreSQL requests must arrive through the tenant
 * dispatcher (URL-derived trusted context); the unscoped legacy Sheets install is its own scope.
 */
export function resolveStudentBankScope(env: StudentBankSessionEnv = process.env): StudentBankScope | null {
  const context = getOptionalTrustedTenantRequestContext();
  if (context) {
    const tenantId = context.tenant.id.toLowerCase();
    const { slug } = context.tenant;
    if (!TENANT_UUID.test(tenantId) || typeof slug !== 'string' || !SLUG.test(slug)) return null;
    return { tenantId, cookiePath: `/api/c/${slug}/bank` };
  }
  if (env.CLASS_STORE_STORAGE === 'postgresql') return null;
  return { tenantId: null, cookiePath: '/api/bank' };
}

/** Login refuses early (before any QR or data work) when no usable AUTH_SECRET exists. */
export function isStudentBankSessionConfigured(env: StudentBankSessionEnv = process.env): boolean {
  try {
    sessionKey(env);
    return true;
  } catch {
    return false;
  }
}

export function createStudentBankSession(scope: StudentBankScope, studentId: string, now = Date.now()): StudentBankSession {
  if (!isCanonicalStudentId(studentId) || !Number.isSafeInteger(now)) throw new Error('Invalid student bank session.');
  return { tenantId: scope.tenantId, studentId, issuedAt: now, expiresAt: now + LIFETIME_MS };
}

export function sealStudentBankSession(session: StudentBankSession, env: StudentBankSessionEnv = process.env): string {
  if (!isSessionShape(session)) throw new Error('Invalid student bank session.');
  const key = sessionKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(session.tenantId));
  const plaintext = Buffer.from(JSON.stringify({
    v: 1, tenantId: session.tenantId, studentId: session.studentId,
    issuedAt: session.issuedAt, expiresAt: session.expiresAt,
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [COOKIE_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url')].join('.');
}

/** Returns the session only when it is authentic, unexpired and bound to this scope. */
export function openStudentBankSession(
  value: string,
  scope: StudentBankScope,
  env: StudentBankSessionEnv = process.env,
  now = Date.now(),
): StudentBankSession | null {
  try {
    if (typeof value !== 'string' || value.length > MAX_COOKIE_LENGTH) return null;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== COOKIE_VERSION) return null;
    const [, ivPart, tagPart, ciphertextPart] = parts;
    const iv = canonicalBase64Url(ivPart);
    const tag = canonicalBase64Url(tagPart);
    const ciphertext = canonicalBase64Url(ciphertextPart);
    if (!iv || !tag || !ciphertext || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) return null;
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(env), iv);
    decipher.setAAD(associatedData(scope.tenantId));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const parsed: unknown = JSON.parse(plaintext);
    if (!isExactRecord(parsed, ['v', 'tenantId', 'studentId', 'issuedAt', 'expiresAt']) || parsed.v !== 1) return null;
    const session = {
      tenantId: parsed.tenantId as string | null,
      studentId: parsed.studentId as string,
      issuedAt: parsed.issuedAt as number,
      expiresAt: parsed.expiresAt as number,
    };
    if (!isSessionShape(session) || session.tenantId !== scope.tenantId) return null;
    if (!Number.isSafeInteger(now) || session.issuedAt > now + CLOCK_SKEW_MS || now >= session.expiresAt) return null;
    return session;
  } catch {
    return null;
  }
}

export type StudentBankSessionRead =
  | Readonly<{ status: 'NONE' }>
  | Readonly<{ status: 'INVALID' }>
  | Readonly<{ status: 'VALID'; session: StudentBankSession }>;

export function readStudentBankSession(
  request: Request,
  scope: StudentBankScope,
  env: StudentBankSessionEnv = process.env,
  now = Date.now(),
): StudentBankSessionRead {
  const values = cookieValues(request, STUDENT_BANK_SESSION_COOKIE);
  if (values.length === 0) return { status: 'NONE' };
  for (const value of values) {
    const session = openStudentBankSession(value, scope, env, now);
    if (session) return { status: 'VALID', session };
  }
  return { status: 'INVALID' };
}

export function studentBankSessionCookie(
  session: StudentBankSession,
  scope: StudentBankScope,
  env: StudentBankSessionEnv = process.env,
): string {
  const value = sealStudentBankSession(session, env);
  return serializeCookie(value, scope.cookiePath, STUDENT_BANK_SESSION_LIFETIME_SECONDS, new Date(session.expiresAt), env);
}

export function clearedStudentBankSessionCookie(scope: StudentBankScope, env: StudentBankSessionEnv = process.env): string {
  return serializeCookie('', scope.cookiePath, 0, new Date(0), env);
}

/* ------------------------------------------------------------------ */
/* Route helpers                                                       */
/* ------------------------------------------------------------------ */

export const STUDENT_BANK_SESSION_REQUIRED = Object.freeze({
  error: '다시 로그인해 주세요.',
  code: 'BANK_SESSION_REQUIRED',
});

export function studentBankJson(body: unknown, init: { status?: number; setCookie?: string } = {}): Response {
  const headers = new Headers(NO_STORE_HEADERS);
  if (init.setCookie) headers.append('set-cookie', init.setCookie);
  return Response.json(body, { status: init.status ?? 200, headers });
}

export function studentBankUnavailable(): Response {
  return studentBankJson({
    error: '은행 정보를 잠시 불러오지 못했어요. 잠시 후 다시 시도해 주세요.',
    code: 'BANK_DATA_UNAVAILABLE',
    retryable: true,
  }, { status: 503 });
}

export function studentBankScopeUnavailable(): Response {
  return studentBankJson({ error: '이 주소에서는 은행을 사용할 수 없어요.', code: 'BANK_SCOPE_UNAVAILABLE' }, { status: 404 });
}

export function studentBankSessionRequired(scope: StudentBankScope, clear: boolean, env: StudentBankSessionEnv = process.env): Response {
  return studentBankJson(STUDENT_BANK_SESSION_REQUIRED, {
    status: 401,
    ...(clear ? { setCookie: clearedStudentBankSessionCookie(scope, env) } : {}),
  });
}

export type StudentBankRequestAuth =
  | Readonly<{ ok: false; response: Response }>
  | Readonly<{ ok: true; scope: StudentBankScope; session: StudentBankSession }>;

/**
 * First step of every session-authenticated bank route. Identity comes only from the
 * sealed cookie; request bodies and query strings never name the student.
 */
export function authenticateStudentBankRequest(
  request: Request,
  env: StudentBankSessionEnv = process.env,
  now = Date.now(),
): StudentBankRequestAuth {
  const scope = resolveStudentBankScope(env);
  if (!scope) return { ok: false, response: studentBankScopeUnavailable() };
  const read = readStudentBankSession(request, scope, env, now);
  if (read.status !== 'VALID') {
    return { ok: false, response: studentBankSessionRequired(scope, read.status === 'INVALID', env) };
  }
  return { ok: true, scope, session: read.session };
}

export type StudentBankStudentCheck =
  | Readonly<{ ok: false; response: Response }>
  | Readonly<{ ok: true; student: Student }>;

/** Every request re-checks the student: a removed or deactivated student is logged out. */
export async function confirmStudentBankStudent(
  auth: Readonly<{ scope: StudentBankScope; session: StudentBankSession }>,
  reader: Readonly<{ confirmStudent(studentId: string): Promise<ConfirmedStudentLookup> }>,
  env: StudentBankSessionEnv = process.env,
): Promise<StudentBankStudentCheck> {
  const lookup = await reader.confirmStudent(auth.session.studentId);
  if (lookup.status === 'FOUND' && lookup.student.studentId === auth.session.studentId
    && lookup.student.status === 'ACTIVE') {
    return { ok: true, student: lookup.student };
  }
  if (lookup.status === 'UNAVAILABLE') return { ok: false, response: studentBankUnavailable() };
  return { ok: false, response: studentBankSessionRequired(auth.scope, true, env) };
}

export function studentBankProfile(student: Student, session: StudentBankSession) {
  return {
    student: { studentId: student.studentId, name: student.name, balance: student.balance },
    session: { expiresAt: new Date(session.expiresAt).toISOString() },
  };
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function sessionKey(env: StudentBankSessionEnv): Buffer {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < MIN_SECRET_LENGTH || secret.length > 1024) {
    throw new StudentBankSessionConfigurationError();
  }
  return createHash('sha256').update(`${PURPOSE}:`).update(secret).digest();
}

function associatedData(tenantId: string | null): Buffer {
  return Buffer.from(`${PURPOSE}:${COOKIE_VERSION}:${tenantId ?? 'legacy-sheets'}`, 'utf8');
}

function isSessionShape(value: StudentBankSession): boolean {
  return (value.tenantId === null || (typeof value.tenantId === 'string' && TENANT_UUID.test(value.tenantId)))
    && isCanonicalStudentId(value.studentId)
    && Number.isSafeInteger(value.issuedAt) && value.issuedAt > 0
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt - value.issuedAt === LIFETIME_MS;
}

function isCanonicalStudentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    && Buffer.byteLength(value, 'utf8') <= MAX_STUDENT_ID_BYTES
    && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
    && !/[\uD800-\uDFFF]/u.test(value);
}

function canonicalBase64Url(value: string): Buffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function cookieValues(request: Request, name: string): string[] {
  const header = request.headers.get('cookie') ?? '';
  const values: string[] = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0 || trimmed.slice(0, separator) !== name) continue;
    const raw = trimmed.slice(separator + 1);
    if (raw) values.push(raw);
  }
  return values.slice(0, 4);
}

function serializeCookie(value: string, path: string, maxAge: number, expires: Date, env: StudentBankSessionEnv): string {
  return [
    `${STUDENT_BANK_SESSION_COOKIE}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    `Expires=${expires.toUTCString()}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(env.NODE_ENV === 'production' ? ['Secure'] : []),
  ].join('; ');
}
