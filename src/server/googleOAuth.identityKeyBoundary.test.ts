import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_AUTH_COOKIE,
  getGoogleSessionFromRequest,
  isGoogleOAuthEnabled,
  setGoogleSessionCookie,
  type GoogleSession,
} from '@/server/googleOAuth';

/**
 * Current-behavior characterization, NOT approval of the current key policy.
 * Only synthetic keys/identities and in-memory Request/Response objects are used.
 * Crypto and both production identity-cookie helpers are real, not mocked.
 *
 * Audit P0 follow-up (not implemented here): for every [P0 FLIP] case, issuance
 * must throw without setting a cookie and verification of independently encoded
 * legacy v2 cookies must return null. [P0 KEEP] cases stay unchanged if P0 keeps
 * raw SHA256(AUTH_SECRET) and v2. Length checks do not prove key entropy/secrecy.
 *
 * A known selected key permits a synthetic identity claim here; this does not
 * prove knowledge of a deployed key, valid tenant membership, an accessible
 * production route, or authorization/data disclosure. No DB/provider is called.
 */
type IdentityEnv = NonNullable<Parameters<typeof getGoogleSessionFromRequest>[1]>;
type AcceptedKeyCase = {
  label: string;
  env: IdentityEnv;
  selectedKey: string;
};

const AUTH_KEY = 'synthetic-identity-auth-key-not-a-production-secret';
const CLIENT_KEY = 'synthetic-oauth-client-key-not-a-production-secret';
const ADMIN_KEY = 'synthetic-admin-password-not-a-production-secret';
const WRONG_KEY = 'synthetic-unselected-key-not-a-production-secret';
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION: GoogleSession = {
  subject: 'synthetic-identity-boundary-subject',
  email: 'synthetic-teacher@example.invalid',
  name: 'Synthetic Teacher',
  issuedAt: NOW,
};
const KEY_ERROR = 'OAuth 쿠키 암호화를 위한 AUTH_SECRET 또는 GOOGLE_CLIENT_SECRET 환경변수가 필요합니다.';
const ENV_KEYS = [
  'AUTH_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'ADMIN_PASSWORD',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_REFRESH_TOKEN',
  'GENERATOR_GOOGLE_CLIENT_ID',
  'GENERATOR_GOOGLE_CLIENT_SECRET',
] as const;

function installSyntheticEnv(env: IdentityEnv) {
  // Set every relevant name, including missing ones; never copy process.env.
  for (const key of ENV_KEYS) vi.stubEnv(key, env[key]);
}

beforeEach(() => {
  installSyntheticEnv({});
  vi.stubEnv('NODE_ENV', 'production');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function requestWithCookie(value: string): Request {
  // This URL is only an in-memory envelope, not an HTTP request.
  return new Request('https://identity-boundary.example.invalid/api/google/session', {
    headers: { cookie: `${GOOGLE_AUTH_COOKIE}=${encodeURIComponent(value)}` },
  });
}

function issueCookie(env: IdentityEnv): string {
  installSyntheticEnv(env);
  const response = NextResponse.json({ ok: true });
  setGoogleSessionCookie(response, SESSION);
  const cookie = response.cookies.get(GOOGLE_AUTH_COOKIE);
  expect(cookie).toBeDefined();
  if (!cookie) throw new Error('Synthetic identity cookie was not issued');
  return cookie.value;
}

// Independent v2 fixture encoder: deliberately no production key resolver and
// no fallback logic. The caller must supply the exact synthetic raw key.
function encodeV2(rawKey: string, payload: unknown = SESSION): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(rawKey).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

// Independent decryption checks the issuer's key/wire format, rather than
// accepting an issuer/verifier round trip that could share the same mistake.
function decodeV2(value: string, rawKey: string): unknown {
  const parts = value.split('.');
  expect(parts).toHaveLength(4);
  const [version, ivPart, tagPart, ciphertextPart] = parts;
  expect(version).toBe('v2');
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  expect(iv).toHaveLength(12);
  expect(tag).toHaveLength(16);
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(rawKey).digest(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8')) as unknown;
}

const selectedKeyCases: AcceptedKeyCase[] = [
  {
    label: '[P0 KEEP] AUTH_SECRET alone without OAuth provider configuration',
    env: { AUTH_SECRET: AUTH_KEY },
    selectedKey: AUTH_KEY,
  },
  {
    label: '[P0 KEEP] AUTH_SECRET wins over distinct client/admin keys',
    env: { AUTH_SECRET: AUTH_KEY, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: AUTH_KEY,
  },
  {
    label: '[P0 FLIP] missing AUTH_SECRET selects client secret before admin password',
    env: { GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: CLIENT_KEY,
  },
  {
    label: '[P0 FLIP] empty AUTH_SECRET selects client secret before admin password',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: CLIENT_KEY,
  },
  {
    label: '[P0 FLIP] missing AUTH_SECRET and client secret select admin password without client ID',
    env: { ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: ADMIN_KEY,
  },
  {
    label: '[P0 FLIP] empty AUTH_SECRET and client secret select admin password without client ID',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: '', ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: ADMIN_KEY,
  },
  {
    label: '[P0 FLIP] short truthy AUTH_SECRET wins over longer fallback keys',
    env: { AUTH_SECRET: 'x', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: 'x',
  },
];

const authFormatCases = [
  { label: '[P0 FLIP] one character', key: 'x' },
  { label: '[P0 FLIP] 31 characters', key: 'a'.repeat(31) },
  { label: '[P0 KEEP] 32 characters (format only, not an entropy claim)', key: 'a'.repeat(32) },
  { label: '[P0 KEEP] 1024 characters (format only, not an entropy claim)', key: 'a'.repeat(1024) },
  { label: '[P0 FLIP] 1025 characters', key: 'a'.repeat(1025) },
  { label: '[P0 FLIP] leading space', key: ` ${AUTH_KEY}` },
  { label: '[P0 FLIP] trailing space', key: `${AUTH_KEY} ` },
  { label: '[P0 FLIP] tab/newline padding', key: `\t${AUTH_KEY}\n` },
];

const rejectedKeyCases: { label: string; env: IdentityEnv }[] = [
  { label: 'all keys absent', env: {} },
  { label: 'all keys empty', env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: '', ADMIN_PASSWORD: '' } },
  {
    label: 'whitespace AUTH_SECRET blocks otherwise usable client/admin keys',
    env: { AUTH_SECRET: ' \t\n', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
  },
  {
    label: 'missing AUTH_SECRET and whitespace client secret block admin password',
    env: { GOOGLE_CLIENT_SECRET: ' \t\n', ADMIN_PASSWORD: ADMIN_KEY },
  },
  {
    label: 'empty AUTH_SECRET and whitespace client secret block admin password',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: ' \t\n', ADMIN_PASSWORD: ADMIN_KEY },
  },
  { label: 'whitespace admin password is rejected', env: { ADMIN_PASSWORD: ' \t\n' } },
];

describe('ordinary identity key boundary: current behavior, not a security-policy approval', () => {
  describe('issuer key selection verified by independent AES-GCM decryption', () => {
    it.each(selectedKeyCases)('$label', ({ env, selectedKey }) => {
      const cookie = issueCookie(env);
      expect(decodeV2(cookie, selectedKey)).toEqual(SESSION);
      for (const unselectedKey of [AUTH_KEY, CLIENT_KEY, ADMIN_KEY, WRONG_KEY]) {
        if (unselectedKey !== selectedKey) expect(() => decodeV2(cookie, unselectedKey)).toThrow();
      }
    });
  });

  describe('verifier key selection checked with independently encoded cookies', () => {
    it.each(selectedKeyCases)('$label', ({ env, selectedKey }) => {
      expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(selectedKey)), env)).toEqual(SESSION);
      for (const unselectedKey of [AUTH_KEY, CLIENT_KEY, ADMIN_KEY, WRONG_KEY]) {
        if (unselectedKey !== selectedKey) {
          expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(unselectedKey)), env)).toBeNull();
        }
      }
    });
  });

  describe('AUTH_SECRET format acceptance in both issuance and verification', () => {
    it.each(authFormatCases)('$label', ({ key }) => {
      const env = { AUTH_SECRET: key, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY };
      expect(decodeV2(issueCookie(env), key)).toEqual(SESSION);
      expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(key)), env)).toEqual(SESSION);
      expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(CLIENT_KEY)), env)).toBeNull();
      expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(ADMIN_KEY)), env)).toBeNull();
    });
  });

  it.each([
    { label: 'AUTH_SECRET', env: { AUTH_SECRET: ` ${AUTH_KEY} ` }, rawKey: ` ${AUTH_KEY} `, trimmedKey: AUTH_KEY },
    { label: 'client-secret fallback', env: { GOOGLE_CLIENT_SECRET: ` ${CLIENT_KEY} ` }, rawKey: ` ${CLIENT_KEY} `, trimmedKey: CLIENT_KEY },
    { label: 'admin-password fallback', env: { ADMIN_PASSWORD: ` ${ADMIN_KEY} ` }, rawKey: ` ${ADMIN_KEY} `, trimmedKey: ADMIN_KEY },
  ])('[P0 FLIP] $label hashes the untrimmed raw key, not its trimmed form', ({ env, rawKey, trimmedKey }) => {
    const cookie = issueCookie(env);
    expect(decodeV2(cookie, rawKey)).toEqual(SESSION);
    expect(() => decodeV2(cookie, trimmedKey)).toThrow();
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(rawKey)), env)).toEqual(SESSION);
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(trimmedKey)), env)).toBeNull();
  });

  it.each(rejectedKeyCases)('[P0 KEEP] $label: issuance throws without Set-Cookie; verification returns null', ({ env }) => {
    installSyntheticEnv(env);
    const response = NextResponse.json({ ok: true });
    expect(() => setGoogleSessionCookie(response, SESSION)).toThrow(KEY_ERROR);
    expect(response.cookies.get(GOOGLE_AUTH_COOKIE)).toBeUndefined();
    expect(response.headers.has('set-cookie')).toBe(false);
    // Include the selected whitespace itself as well as plausible fallback keys.
    for (const candidate of [AUTH_KEY, CLIENT_KEY, ADMIN_KEY, ' \t\n']) {
      expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(candidate)), env)).toBeNull();
    }
  });

  it('[P0 KEEP] the default verifier reads the same fully synthetic environment as the issuer', () => {
    const env = { AUTH_SECRET: AUTH_KEY, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY };
    const issued = issueCookie(env);
    expect(getGoogleSessionFromRequest(requestWithCookie(issued))).toEqual(SESSION);
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(CLIENT_KEY)))).toBeNull();
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(ADMIN_KEY)))).toBeNull();
  });

  it('[P0 FLIP] admin-key-only issuance and verification do not require an enabled OAuth provider', () => {
    const env = { ADMIN_PASSWORD: ADMIN_KEY };
    expect(isGoogleOAuthEnabled(env)).toBe(false);
    expect(decodeV2(issueCookie(env), ADMIN_KEY)).toEqual(SESSION);
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(ADMIN_KEY)), env)).toEqual(SESSION);
  });

  it('[P0 KEEP] provider-enabled means client configuration, not identity-key readiness', () => {
    for (const authSecret of [undefined, '', ' ', 'x', AUTH_KEY]) {
      expect(isGoogleOAuthEnabled({
        GOOGLE_CLIENT_ID: 'synthetic-client-id',
        GOOGLE_CLIENT_SECRET: CLIENT_KEY,
        AUTH_SECRET: authSecret,
      })).toBe(true);
    }
    expect(isGoogleOAuthEnabled({ AUTH_SECRET: AUTH_KEY })).toBe(false);
  });

  it('[P0 KEEP] accepting a locally constructed identity is conditional on the selected key, not tenant authorization', () => {
    const env = { AUTH_SECRET: AUTH_KEY, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY };
    const claimedIdentity: GoogleSession = {
      subject: 'synthetic-other-subject-not-a-real-member',
      email: 'synthetic-other@example.invalid',
      issuedAt: NOW,
    };
    const request = requestWithCookie(encodeV2(AUTH_KEY, claimedIdentity));
    expect(getGoogleSessionFromRequest(request, env)).toEqual(claimedIdentity);
    expect(getGoogleSessionFromRequest(request, { AUTH_SECRET: WRONG_KEY })).toBeNull();
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(WRONG_KEY, claimedIdentity)), env)).toBeNull();
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(ADMIN_KEY, claimedIdentity)), env)).toBeNull();
    // P0 cannot make a known, format-compliant selected key secret again.
    // These assertions do not establish any OWNER/ADMIN membership or DB access.
  });

  it.each([2, 3])('[P0 KEEP] rejects tampering with authenticated v2 segment %s', (segment) => {
    const env = { AUTH_SECRET: AUTH_KEY };
    const parts = issueCookie(env).split('.');
    const bytes = Buffer.from(parts[segment], 'base64url');
    bytes[0] ^= 1;
    parts[segment] = bytes.toString('base64url');
    expect(getGoogleSessionFromRequest(requestWithCookie(parts.join('.')), env)).toBeNull();
  });

  it.each([
    { label: 'empty subject', payload: { ...SESSION, subject: '' } },
    { label: 'malformed email', payload: { ...SESSION, email: 'not-an-email' } },
    { label: 'non-identity refreshToken field', payload: { ...SESSION, refreshToken: 'synthetic-unused-token' } },
    { label: 'expired session', payload: { ...SESSION, issuedAt: NOW - MAX_AGE_MS - 1 } },
    { label: 'future-issued session', payload: { ...SESSION, issuedAt: NOW + 1 } },
  ])('[P0 KEEP] even a correctly keyed cookie rejects $label', ({ payload }) => {
    expect(getGoogleSessionFromRequest(requestWithCookie(encodeV2(AUTH_KEY, payload)), { AUTH_SECRET: AUTH_KEY })).toBeNull();
  });
});
