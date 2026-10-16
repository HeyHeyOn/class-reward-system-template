import 'server-only';

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// The 딴쌤 hub protocol (ddanssaem-hub/docs/account-protocol.md) from the class's side: sign-in through the
// hub with a one-time code and PKCE (1), the hub's signed logout and account-deleted events (2, 3) and the
// summary of a teacher's classes (4). DDANSSAEM_HUB_URL and DDANSSAEM_CLIENT_SECRET answer the hub's calls (2, 3, 4);
// DDANSSAEM_LOGIN=1 then moves sign-in to the hub (1). Until then the Google sign-in stays.

type Env = Readonly<Record<string, string | undefined>>;

export const HUB_CLIENT_ID = 'class';
/** The agreement a hub session carries: any hub agreement (the hub asked for the terms in force). */
export const HUB_AGREEMENT = 'hub';
export const HUB_CALLBACK_PATH = '/api/auth/ddanssaem/callback';
export const HUB_LOGIN_COOKIE = 'class_store_dd_login';
export const HUB_LOGIN_MAX_AGE_SECONDS = 600;
export const HUB_SIGNATURE_HEADER = 'x-ddanssaem-signature';
const EVENT_WINDOW_SECONDS = 300;
const LOGIN_COOKIE_VERSION = 'd1';

export class HubError extends Error {
  constructor(readonly code: 'CONFIG' | 'INVALID_GRANT' | 'INVALID_PROFILE' | 'UNAVAILABLE', message: string) {
    super(message);
    this.name = 'HubError';
  }
}

/** The hub address and the shared secret are set: the hub's signed events and summary calls are answered. */
export function hubConnected(env: Env = process.env): boolean {
  return Boolean(env.DDANSSAEM_HUB_URL?.trim() && env.DDANSSAEM_CLIENT_SECRET?.trim());
}

/** DDANSSAEM_LOGIN=1 on a connected app: teachers sign in, agree and sign out through the hub. */
export function hubLoginEnabled(env: Env = process.env): boolean {
  return env.DDANSSAEM_LOGIN === '1' && hubConnected(env);
}

/** The hub's origin: https, or http on localhost for development. */
export function hubOrigin(env: Env = process.env): string {
  const raw = env.DDANSSAEM_HUB_URL?.trim();
  if (!raw) throw new HubError('CONFIG', 'DDANSSAEM_HUB_URL is not set.');
  const url = new URL(raw);
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !local) throw new HubError('CONFIG', 'DDANSSAEM_HUB_URL must be https.');
  return url.origin;
}

function clientSecret(env: Env): string {
  const secret = env.DDANSSAEM_CLIENT_SECRET?.trim();
  if (!secret || secret.length < 32) throw new HubError('CONFIG', 'DDANSSAEM_CLIENT_SECRET is not set.');
  return secret;
}

const b64url = (bytes: Buffer) => bytes.toString('base64url');

/** A path inside this app to return to after sign-in; anything else becomes the class list. */
export function safeNextPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !value.startsWith('/') || value.startsWith('//')
    || /[\\\u0000-\u001f]/.test(value)) return '/classes';
  return value;
}

/** `silent`: asked with prompt=none; a login_required or consent_required answer then asks once with a prompt. */
export type HubLoginState = Readonly<{ state: string; verifier: string; next: string; issuedAt: number; silent: boolean }>;

function loginCookieKey(env: Env): Buffer {
  const secret = env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) throw new HubError('CONFIG', 'AUTH_SECRET is not set.');
  return createHash('sha256').update('class-store:ddanssaem-login:').update(secret).digest();
}

/** 1-1: the state and PKCE verifier go into a short cookie; the browser goes to the hub's /authorize. */
export function startHubLogin(origin: string, next: string, env: Env = process.env, now = Date.now(),
  options: Readonly<{ silent?: boolean }> = {}): { authorizeUrl: string; cookie: string } {
  const login: HubLoginState = {
    state: b64url(randomBytes(16)), verifier: b64url(randomBytes(32)), next: safeNextPath(next), issuedAt: now, silent: options.silent === true,
  };
  const authorize = new URL('/authorize', hubOrigin(env));
  authorize.searchParams.set('client_id', HUB_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', `${origin}${HUB_CALLBACK_PATH}`);
  authorize.searchParams.set('state', login.state);
  authorize.searchParams.set('code_challenge', b64url(createHash('sha256').update(login.verifier).digest()));
  authorize.searchParams.set('code_challenge_method', 'S256');
  if (login.silent) authorize.searchParams.set('prompt', 'none');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loginCookieKey(env), iv);
  cipher.setAAD(Buffer.from(`class-store:ddanssaem-login:${LOGIN_COOKIE_VERSION}`));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(login), 'utf8'), cipher.final()]);
  return { authorizeUrl: authorize.toString(), cookie: [LOGIN_COOKIE_VERSION, b64url(iv), b64url(cipher.getAuthTag()), b64url(sealed)].join('.') };
}

/** The login started in this browser, or null when the cookie is missing, altered or older than ten minutes. */
export function openHubLogin(cookie: string | undefined, env: Env = process.env, now = Date.now()): HubLoginState | null {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 4 || parts[0] !== LOGIN_COOKIE_VERSION) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', loginCookieKey(env), Buffer.from(parts[1], 'base64url'));
    decipher.setAAD(Buffer.from(`class-store:ddanssaem-login:${LOGIN_COOKIE_VERSION}`));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8'));
    if (!value || typeof value !== 'object') return null;
    const login = value as Record<string, unknown>;
    if (typeof login.state !== 'string' || typeof login.verifier !== 'string' || typeof login.next !== 'string'
      || typeof login.issuedAt !== 'number' || now - login.issuedAt < 0 || now - login.issuedAt > HUB_LOGIN_MAX_AGE_SECONDS * 1000) return null;
    return { state: login.state, verifier: login.verifier, next: safeNextPath(login.next), issuedAt: login.issuedAt, silent: login.silent === true };
  } catch {
    return null;
  }
}

/** What the hub tells the class about the teacher who signed in (1-3). */
export type HubProfile = Readonly<{ sub: string; email: string; name: string; termsVersion: string; sid: string }>;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= max ? value : null;
}

export function parseHubProfile(value: unknown): HubProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const sub = text(body.sub, 255);
  const email = text(body.email, 320);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
  const termsVersion = typeof body.terms_version === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.terms_version) ? body.terms_version : null;
  const sid = text(body.sid, 200);
  if (!sub || sub.startsWith('withdrawn:') || !email || !email.includes('@') || !termsVersion || !sid) return null;
  return { sub, email, name, termsVersion, sid };
}

/** 1-3: the server trades the one-time code (with the PKCE verifier) for the teacher's profile. */
export async function exchangeHubCode(input: Readonly<{ origin: string; code: string; verifier: string }>, env: Env = process.env,
  fetchImpl: typeof fetch = fetch): Promise<HubProfile> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: `${input.origin}${HUB_CALLBACK_PATH}`,
    client_id: HUB_CLIENT_ID,
    client_secret: clientSecret(env),
    code_verifier: input.verifier,
  });
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/token', hubOrigin(env)).toString(), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HubError('UNAVAILABLE', 'The hub did not answer.');
  }
  if (!response.ok) throw new HubError('INVALID_GRANT', `The hub refused the code (${response.status}).`);
  const profile = parseHubProfile(await response.json().catch(() => null));
  if (!profile) throw new HubError('INVALID_PROFILE', 'The hub answered with an invalid profile.');
  return profile;
}

/** 2-2, 4: the hub signs each server call with hex(HMAC-SHA256(client_secret, body bytes)). */
export function verifyHubSignature(body: string, signature: string | null, env: Env = process.env): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', clientSecret(env)).update(body, 'utf8').digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function recent(iat: unknown, now: number): boolean {
  return typeof iat === 'number' && Number.isFinite(iat) && Math.abs(now / 1000 - iat) <= EVENT_WINDOW_SECONDS;
}

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export type HubEvent = Readonly<{ type: 'logout'; sid: string }> | Readonly<{ type: 'account_deleted'; sub: string }>;

/** 2-2, 3: a signed event less than five minutes old. */
export function parseHubEvent(body: string, now = Date.now()): HubEvent | null {
  const event = parseObject(body);
  if (!event || !recent(event.iat, now)) return null;
  if (event.type === 'logout') {
    const sid = text(event.sid, 200);
    return sid ? { type: 'logout', sid } : null;
  }
  if (event.type === 'account_deleted') {
    const sub = text(event.sub, 255);
    return sub && !sub.startsWith('withdrawn:') ? { type: 'account_deleted', sub } : null;
  }
  return null;
}

/** 4: whose classes the hub asks about. */
export function parseSummaryRequest(body: string, now = Date.now()): { sub: string } | null {
  const request = parseObject(body);
  if (!request || !recent(request.iat, now)) return null;
  const sub = text(request.sub, 255);
  return sub && !sub.startsWith('withdrawn:') ? { sub } : null;
}

/** 2-1: after the class session ends, the browser signs out of the hub too and comes back here. */
export function hubLogoutUrl(origin: string, env: Env = process.env): string {
  const url = new URL('/logout', hubOrigin(env));
  url.searchParams.set('client_id', HUB_CLIENT_ID);
  url.searchParams.set('return_to', `${origin}/classes`);
  return url.toString();
}

/** 3: the account (name, terms, withdrawal) lives on the hub. */
export function hubAccountUrl(env: Env = process.env): string {
  return new URL('/account', hubOrigin(env)).toString();
}
