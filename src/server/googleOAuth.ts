import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { NextResponse } from 'next/server';

export const GOOGLE_AUTH_COOKIE = 'class_store_google_auth';
export const GENERATOR_GRANT_COOKIE = 'class_store_generator_grant';
const STATE_COOKIE = 'class_store_google_state';
const GENERATOR_STATE_COOKIE = 'class_store_generator_state';
const COOKIE_VERSION = 'v2';
const GENERATOR_COOKIE_VERSION = 'g1';
const IDENTITY_SCOPES = ['openid', 'email', 'profile'];
const GENERATOR_SCOPES = [...IDENTITY_SCOPES, 'https://www.googleapis.com/auth/drive.file'];
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const GENERATOR_MAX_AGE_SECONDS = 60 * 10;
const GENERATOR_CALLBACK_PATH = '/api/google/callback';
const GENERATOR_API_PATH = '/api/generator';

type GoogleAuthEnv = {
  [key: string]: string | undefined;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GENERATOR_GOOGLE_CLIENT_ID?: string;
  GENERATOR_GOOGLE_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
  ADMIN_PASSWORD?: string;
};

export type GoogleSession = {
  subject: string;
  email: string;
  name?: string;
  issuedAt: number;
};

export type GoogleIdentityState = Readonly<{
  state: string;
  returnTo?: '/classes';
}>;

export type GeneratorConsentState = {
  purpose: 'generator';
  state: string;
  subject: string;
  email: string;
  clientFingerprint: string;
  issuedAt: number;
};

export type GeneratorGrant = {
  purpose: 'generator';
  subject: string;
  email: string;
  refreshToken: string;
  grantId: string;
  expiresAt: number;
  clientFingerprint: string;
  issuedAt: number;
};

export function isGoogleOAuthEnabled(env: GoogleAuthEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function isDeploymentGoogleOAuthEnabled(env: GoogleAuthEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim() && env.GOOGLE_REFRESH_TOKEN?.trim());
}

export function createDeploymentSheetsAuth(env: GoogleAuthEnv = process.env) {
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim();
  if (!refreshToken) return null;

  const client = createGoogleOAuthClientWithoutRedirect(env);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export function createGoogleOAuthClient(origin: string, env: GoogleAuthEnv = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth 환경변수가 없습니다. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET를 설정해 주세요.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, getGoogleRedirectUri(origin));
}

export function createGoogleOAuthClientWithoutRedirect(env: GoogleAuthEnv = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth 환경변수가 없습니다. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET를 설정해 주세요.');
  }

  return new google.auth.OAuth2(clientId, clientSecret);
}

export function getGeneratorGoogleClientFingerprint(env: GoogleAuthEnv = process.env): string {
  const clientId = env.GENERATOR_GOOGLE_CLIENT_ID?.trim();
  if (!clientId || clientId.length > 1024) {
    throw new Error('생성기 Google OAuth 환경변수가 없습니다. GENERATOR_GOOGLE_CLIENT_ID를 설정해 주세요.');
  }
  return createHash('sha256').update(clientId).digest('hex');
}

export function createGeneratorGoogleOAuthClient(origin: string, env: GoogleAuthEnv = process.env) {
  const clientId = env.GENERATOR_GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GENERATOR_GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('생성기 Google OAuth 환경변수가 없습니다. GENERATOR_GOOGLE_CLIENT_ID, GENERATOR_GOOGLE_CLIENT_SECRET를 설정해 주세요.');
  }
  return new google.auth.OAuth2(clientId, clientSecret, getGoogleRedirectUri(origin));
}

export function getGoogleRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/google/callback`;
}

export function createGoogleAuthUrl(origin: string, state: string): string {
  const client = createGoogleOAuthClient(origin);
  return client.generateAuthUrl({
    access_type: 'online',
    scope: IDENTITY_SCOPES,
    state,
  });
}

export function createGeneratorConsentAuthUrl(origin: string, state: string): string {
  const client = createGeneratorGoogleOAuthClient(origin);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GENERATOR_SCOPES,
    state,
  });
}

export function setGoogleStateCookie(response: NextResponse, state: string, returnTo?: '/classes') {
  const value = returnTo ? JSON.stringify({ state, returnTo } satisfies GoogleIdentityState) : state;
  response.cookies.set(STATE_COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 10,
  });
}

export function consumeGoogleStateCookie(
  request: Request,
  response: NextResponse,
  submittedState: string,
): GoogleIdentityState | null {
  const savedValue = getCookieValue(request, STATE_COOKIE);
  response.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 });
  if (!savedValue || !submittedState) return null;
  let saved: GoogleIdentityState = { state: savedValue };
  if (savedValue.startsWith('{')) {
    try {
      const parsed = JSON.parse(savedValue) as unknown;
      if (!isRecord(parsed)
        || Object.keys(parsed).some((key) => key !== 'state' && key !== 'returnTo')
        || typeof parsed.state !== 'string'
        || (parsed.returnTo !== undefined && parsed.returnTo !== '/classes')) return null;
      saved = { state: parsed.state, ...(parsed.returnTo === '/classes' ? { returnTo: '/classes' } : {}) };
    } catch {
      return null;
    }
  }
  return safeEqual(saved.state, submittedState) ? saved : null;
}

export function setGeneratorConsentStateCookie(response: NextResponse, state: GeneratorConsentState) {
  assertGeneratorConsentState(state);
  response.cookies.set(GENERATOR_STATE_COOKIE, encryptGeneratorPayload(state, 'state'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: GENERATOR_CALLBACK_PATH,
    maxAge: GENERATOR_MAX_AGE_SECONDS,
  });
}

export function hasGeneratorConsentStateCookie(request: Request): boolean {
  return Boolean(getCookieValue(request, GENERATOR_STATE_COOKIE));
}

export function consumeGeneratorConsentStateCookie(
  request: Request,
  response: NextResponse,
  submittedState: string,
  env: GoogleAuthEnv = process.env,
): GeneratorConsentState | null {
  const encrypted = getCookieValue(request, GENERATOR_STATE_COOKIE);
  clearGeneratorConsentStateCookie(response);
  if (!encrypted || !submittedState) return null;
  const state = decryptGeneratorPayload(encrypted, 'state', env);
  if (!isGeneratorConsentState(state) || !safeEqual(state.state, submittedState)) return null;
  if (!safeEqual(state.clientFingerprint, getGeneratorGoogleClientFingerprint(env))) return null;
  return state;
}

export function setGoogleSessionCookie(response: NextResponse, session: GoogleSession) {
  response.cookies.set(GOOGLE_AUTH_COOKIE, encryptSession(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export function clearGoogleSessionCookie(response: NextResponse) {
  response.cookies.set(GOOGLE_AUTH_COOKIE, '', { path: '/', maxAge: 0 });
}

export function getGoogleSessionFromRequest(
  request: Request,
  env: GoogleAuthEnv = process.env,
): GoogleSession | null {
  const cookieValue = getCookieValue(request, GOOGLE_AUTH_COOKIE);
  if (!cookieValue) return null;
  return decryptSession(cookieValue, env);
}

export function setGeneratorGrantCookie(response: NextResponse, grant: GeneratorGrant) {
  assertGeneratorGrant(grant);
  response.cookies.set(GENERATOR_GRANT_COOKIE, encryptGeneratorPayload(grant, 'grant'), {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: GENERATOR_API_PATH,
    maxAge: GENERATOR_MAX_AGE_SECONDS,
  });
}

export function clearGeneratorGrantCookie(response: NextResponse) {
  response.cookies.set(GENERATOR_GRANT_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: GENERATOR_API_PATH,
    maxAge: 0,
  });
}

export function getGeneratorGrantFromRequest(
  request: Request,
  session: GoogleSession,
  env: GoogleAuthEnv = process.env,
): GeneratorGrant | null {
  const encrypted = getCookieValue(request, GENERATOR_GRANT_COOKIE);
  if (!encrypted) return null;
  const grant = decryptGeneratorPayload(encrypted, 'grant', env);
  if (!isGeneratorGrant(grant)) return null;
  if (!safeEqual(grant.subject, session.subject) || !safeEqual(normalizeEmail(grant.email), normalizeEmail(session.email))) return null;
  if (!safeEqual(grant.clientFingerprint, getGeneratorGoogleClientFingerprint(env))) return null;
  return grant;
}

export async function exchangeGoogleCodeForSession(origin: string, code: string): Promise<GoogleSession> {
  const client = createGoogleOAuthClient(origin);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  const profile = await fetchVerifiedGoogleProfile(client);

  return {
    subject: profile.subject,
    email: profile.email,
    name: profile.name,
    issuedAt: Date.now(),
  };
}

export async function exchangeGoogleCodeForGeneratorGrant(
  origin: string,
  code: string,
  binding: GeneratorConsentState,
): Promise<GeneratorGrant> {
  assertGeneratorConsentState(binding);
  if (!safeEqual(binding.clientFingerprint, getGeneratorGoogleClientFingerprint())) {
    throw new Error('생성기 Google OAuth 클라이언트 구성이 변경되었습니다. 권한을 다시 승인해 주세요.');
  }
  const client = createGeneratorGoogleOAuthClient(origin);
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);
  try {
    const refreshToken = tokens.refresh_token?.trim();
    if (!refreshToken || refreshToken.length > 4096) {
      throw new Error('Google refresh token을 받지 못했습니다. 권한 동의 화면에서 다시 승인해 주세요.');
    }
    const profile = await fetchVerifiedGoogleProfile(client);
    if (!safeEqual(profile.subject, binding.subject) || !safeEqual(normalizeEmail(profile.email), normalizeEmail(binding.email))) {
      throw new Error('로그인한 Google 계정과 시트 권한을 승인한 계정이 다릅니다. 같은 계정으로 다시 시도해 주세요.');
    }

    const issuedAt = Date.now();
    return {
      purpose: 'generator',
      subject: binding.subject,
      email: binding.email,
      refreshToken,
      grantId: randomBytes(32).toString('base64url'),
      expiresAt: issuedAt + GENERATOR_MAX_AGE_SECONDS * 1000,
      clientFingerprint: binding.clientFingerprint,
      issuedAt,
    };
  } catch (error) {
    const revocationTarget = tokens.refresh_token?.trim() || tokens.access_token?.trim();
    if (revocationTarget) await client.revokeToken(revocationTarget).catch(() => undefined);
    client.setCredentials({});
    throw error;
  }
}

export async function revokeGeneratorGrant(grant: GeneratorGrant): Promise<void> {
  assertGeneratorGrant(grant);
  const client = createGeneratorGoogleOAuthClient('http://localhost');
  await client.revokeToken(grant.refreshToken);
  client.setCredentials({});
}

export function makeState(): string {
  return randomBytes(24).toString('base64url');
}

async function fetchVerifiedGoogleProfile(client: InstanceType<typeof google.auth.OAuth2>) {
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();
  const subject = profile.data.id?.trim();
  const email = profile.data.email?.trim();
  if (!subject || !email) {
    throw new Error('Google 계정 식별자와 이메일을 확인하지 못했습니다.');
  }
  if (profile.data.verified_email !== true) {
    throw new Error('확인되지 않은 Google 이메일은 사용할 수 없습니다.');
  }
  return { subject, email, name: profile.data.name ?? undefined };
}

function encryptSession(session: GoogleSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getCookieKey(process.env), iv);
  const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [COOKIE_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptSession(value: string, env: GoogleAuthEnv): GoogleSession | null {
  try {
    if (value.length > 8192) return null;
    const [version, ivPart, tagPart, ciphertextPart, extra] = value.split('.');
    if (version !== COOKIE_VERSION || !ivPart || !tagPart || !ciphertextPart || extra) return null;
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', getCookieKey(env), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as unknown;
    if (!isGoogleSession(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function encryptGeneratorPayload(payload: GeneratorConsentState | GeneratorGrant, kind: 'state' | 'grant'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getStrongGeneratorCookieKey(process.env, kind), iv);
  cipher.setAAD(Buffer.from(`class-store:${kind}:${GENERATOR_COOKIE_VERSION}`));
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [GENERATOR_COOKIE_VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptGeneratorPayload(value: string, kind: 'state' | 'grant', env: GoogleAuthEnv): unknown {
  try {
    if (value.length > 8192) return null;
    const [version, ivPart, tagPart, ciphertextPart, extra] = value.split('.');
    if (version !== GENERATOR_COOKIE_VERSION || !ivPart || !tagPart || !ciphertextPart || extra) return null;
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 6144) return null;
    const decipher = createDecipheriv('aes-256-gcm', getStrongGeneratorCookieKey(env, kind), iv);
    decipher.setAAD(Buffer.from(`class-store:${kind}:${GENERATOR_COOKIE_VERSION}`));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function getCookieKey(env: GoogleAuthEnv): Buffer {
  const secret = env.AUTH_SECRET || env.GOOGLE_CLIENT_SECRET || env.ADMIN_PASSWORD;
  if (!secret?.trim()) {
    throw new Error('OAuth 쿠키 암호화를 위한 AUTH_SECRET 또는 GOOGLE_CLIENT_SECRET 환경변수가 필요합니다.');
  }
  return createHash('sha256').update(secret).digest();
}

function getStrongGeneratorCookieKey(env: GoogleAuthEnv, kind: 'state' | 'grant'): Buffer {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32 || secret.length > 1024) {
    throw new Error('생성기 OAuth 보호를 위해 32자 이상의 강한 AUTH_SECRET 환경변수가 필요합니다.');
  }
  return createHash('sha256').update(`class-store:${kind}:`).update(secret).digest();
}

function isGoogleSession(value: unknown): value is GoogleSession {
  if (!isRecord(value) || Object.keys(value).some((key) => !['subject', 'email', 'name', 'issuedAt'].includes(key))) return false;
  if (!validSubject(value.subject) || !validEmail(value.email) || (value.name !== undefined && !validString(value.name, 1, 200))) return false;
  return validIssuedAt(value.issuedAt, MAX_AGE_SECONDS);
}

function assertGeneratorConsentState(value: GeneratorConsentState): void {
  if (!isGeneratorConsentState(value)) throw new Error('생성기 OAuth 상태값이 올바르지 않습니다.');
}

function isGeneratorConsentState(value: unknown): value is GeneratorConsentState {
  if (!isRecord(value) || Object.keys(value).some((key) => !['purpose', 'state', 'subject', 'email', 'clientFingerprint', 'issuedAt'].includes(key))) return false;
  return value.purpose === 'generator'
    && validString(value.state, 8, 256)
    && validSubject(value.subject)
    && validEmail(value.email)
    && validSha256(value.clientFingerprint)
    && validIssuedAt(value.issuedAt, GENERATOR_MAX_AGE_SECONDS);
}

function assertGeneratorGrant(value: GeneratorGrant): void {
  if (!isGeneratorGrant(value)) throw new Error('생성기 Google 권한이 올바르지 않습니다.');
}

function isGeneratorGrant(value: unknown): value is GeneratorGrant {
  if (!isRecord(value) || Object.keys(value).some((key) => !['purpose', 'subject', 'email', 'refreshToken', 'grantId', 'expiresAt', 'clientFingerprint', 'issuedAt'].includes(key))) return false;
  return value.purpose === 'generator'
    && validSubject(value.subject)
    && validEmail(value.email)
    && validString(value.refreshToken, 10, 4096)
    && validString(value.grantId, 32, 128)
    && validSha256(value.clientFingerprint)
    && validIssuedAt(value.issuedAt, GENERATOR_MAX_AGE_SECONDS)
    && typeof value.expiresAt === 'number'
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > Date.now()
    && value.expiresAt === value.issuedAt + GENERATOR_MAX_AGE_SECONDS * 1000;
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validIssuedAt(value: unknown, maxAgeSeconds: number): value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  const ageMs = Date.now() - value;
  return ageMs >= 0 && ageMs <= maxAgeSeconds * 1000;
}

function validSubject(value: unknown): value is string {
  return validString(value, 1, 255);
}

function validEmail(value: unknown): value is string {
  return validString(value, 3, 320) && /^[^\s@]+@[^\s@]+$/.test(value);
}

function validString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && value.trim() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function clearGeneratorConsentStateCookie(response: NextResponse) {
  response.cookies.set(GENERATOR_STATE_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: true,
    path: GENERATOR_CALLBACK_PATH,
    maxAge: 0,
  });
}

function getCookieValue(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const cookies = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  const prefix = `${name}=`;
  const cookie = cookies.find((part) => part.startsWith(prefix));
  if (!cookie) return undefined;
  try {
    return decodeURIComponent(cookie.slice(prefix.length));
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
