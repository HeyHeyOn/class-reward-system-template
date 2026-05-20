import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';
import type { NextResponse } from 'next/server';

export const GOOGLE_AUTH_COOKIE = 'class_store_google_auth';
const STATE_COOKIE = 'class_store_google_state';
const COOKIE_VERSION = 'v1';
const SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/spreadsheets'];
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

type GoogleAuthEnv = {
  [key: string]: string | undefined;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
  ADMIN_PASSWORD?: string;
};

export type GoogleSession = {
  email: string;
  name?: string;
  refreshToken: string;
  issuedAt: number;
};

export function isGoogleOAuthEnabled(env: GoogleAuthEnv = process.env): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function createGoogleOAuthClient(origin: string, env: GoogleAuthEnv = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth 환경변수가 없습니다. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET를 설정해 주세요.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, getGoogleRedirectUri(origin));
}

export function getGoogleRedirectUri(origin: string): string {
  return `${origin.replace(/\/$/, '')}/api/google/callback`;
}

export function createGoogleAuthUrl(origin: string, state: string): string {
  const client = createGoogleOAuthClient(origin);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
  });
}

export function setGoogleStateCookie(response: NextResponse, state: string) {
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 10,
  });
}

export function consumeGoogleStateCookie(request: Request, response: NextResponse, submittedState: string): boolean {
  const savedState = getCookieValue(request, STATE_COOKIE);
  response.cookies.set(STATE_COOKIE, '', { path: '/', maxAge: 0 });
  return Boolean(savedState && submittedState && safeEqual(savedState, submittedState));
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

export function getGoogleSessionFromRequest(request: Request): GoogleSession | null {
  const cookieValue = getCookieValue(request, GOOGLE_AUTH_COOKIE);
  if (!cookieValue) return null;
  return decryptSession(cookieValue);
}

export function createUserSheetsAuth(request: Request, origin: string) {
  const session = getGoogleSessionFromRequest(request);
  if (!session?.refreshToken) return null;

  const client = createGoogleOAuthClient(origin);
  client.setCredentials({ refresh_token: session.refreshToken });
  return { auth: client, session };
}

export async function exchangeGoogleCodeForSession(origin: string, code: string): Promise<GoogleSession> {
  const client = createGoogleOAuthClient(origin);
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error('Google refresh token을 받지 못했습니다. 로그인 화면에서 권한을 다시 승인해 주세요.');
  }

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const profile = await oauth2.userinfo.get();
  const email = profile.data.email?.trim();

  if (!email) {
    throw new Error('Google 계정 이메일을 확인하지 못했습니다.');
  }

  return {
    email,
    name: profile.data.name ?? undefined,
    refreshToken: tokens.refresh_token,
    issuedAt: Date.now(),
  };
}

export function makeState(): string {
  return randomBytes(24).toString('base64url');
}

function encryptSession(session: GoogleSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getCookieKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [COOKIE_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function decryptSession(value: string): GoogleSession | null {
  try {
    const [version, ivPart, tagPart, ciphertextPart] = value.split('.');
    if (version !== COOKIE_VERSION || !ivPart || !tagPart || !ciphertextPart) return null;

    const decipher = createDecipheriv('aes-256-gcm', getCookieKey(), Buffer.from(ivPart, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    const parsed = JSON.parse(plaintext) as Partial<GoogleSession>;

    if (!parsed.email || !parsed.refreshToken || typeof parsed.issuedAt !== 'number') return null;
    return { email: parsed.email, name: parsed.name, refreshToken: parsed.refreshToken, issuedAt: parsed.issuedAt };
  } catch {
    return null;
  }
}

function getCookieKey(): Buffer {
  const secret = process.env.AUTH_SECRET || process.env.GOOGLE_CLIENT_SECRET || process.env.ADMIN_PASSWORD;
  if (!secret?.trim()) {
    throw new Error('OAuth 쿠키 암호화를 위한 AUTH_SECRET 또는 GOOGLE_CLIENT_SECRET 환경변수가 필요합니다.');
  }
  return createHash('sha256').update(secret).digest();
}

function getCookieValue(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const cookies = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
  const prefix = `${name}=`;
  const cookie = cookies.find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
