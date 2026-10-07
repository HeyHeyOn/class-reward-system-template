// @vitest-environment node
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_AUTH_COOKIE,
  consumeGeneratorConsentStateCookie,
  getGoogleSessionFromRequest,
  isGoogleOAuthEnabled,
  setGeneratorConsentStateCookie,
  type GeneratorConsentState,
  type GoogleSession,
} from '@/server/googleOAuth';

/**
 * Synthetic characterization of the CURRENT ordinary-session key boundary.
 * The real ordinary verifier (including its default-env path) is compared with
 * the real AUTH_SECRET-only generator-state key gate. That stricter gate is NOT
 * an ordinary-identity guarantee, and a green test does not approve fallback.
 * Removing fallback or changing credential behavior requires separate owner
 * review; no future policy or production compromise is asserted here.
 *
 * All keys, identities and env values are synthetic. Run with an allowlisted
 * process environment and Vite env-file loading disabled. Do not copy/read real
 * process.env, credential files or provider configuration to construct fixtures.
 * Crypto is real; provider access fails closed. No route, membership, DB, Sheets,
 * Redis, OAuth exchange or deployed-key security is exercised/proven.
 */
type IdentityEnv = NonNullable<Parameters<typeof getGoogleSessionFromRequest>[1]>;
type KeyCase = {
  label: string;
  env: IdentityEnv;
  selectedKey: string;
  generatorAccepts: boolean;
};

const external = vi.hoisted(() => ({
  provider: vi.fn(() => { throw new Error('Provider access is outside this synthetic test'); }),
  fetch: vi.fn(() => { throw new Error('Network access is outside this synthetic test'); }),
}));
vi.mock('googleapis', () => ({
  google: { auth: { OAuth2: external.provider }, oauth2: external.provider },
}));

const AUTH_KEY = 'synthetic-ordinary-auth-key-not-a-production-secret';
const CLIENT_KEY = 'synthetic-ordinary-client-key-not-a-production-secret';
const ADMIN_KEY = 'synthetic-ordinary-admin-key-not-a-production-secret';
const WRONG_KEY = 'synthetic-unselected-key-not-a-production-secret';
const GENERATOR_CLIENT_ID = 'synthetic-generator-client-id';
const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);
const SESSION: GoogleSession = {
  subject: 'synthetic-ordinary-subject-not-a-tenant-member',
  email: 'ordinary-identity@example.invalid',
  issuedAt: NOW,
};
const GENERATOR_STATE: GeneratorConsentState = {
  purpose: 'generator',
  state: 'synthetic-generator-state',
  subject: SESSION.subject,
  email: SESSION.email,
  clientFingerprint: createHash('sha256').update(GENERATOR_CLIENT_ID).digest('hex'),
  issuedAt: NOW,
};
const GENERATOR_STATE_COOKIE = 'class_store_generator_state';
const ENV_KEYS = [
  'AUTH_SECRET', 'GOOGLE_CLIENT_SECRET', 'ADMIN_PASSWORD',
  'GOOGLE_CLIENT_ID', 'GOOGLE_REFRESH_TOKEN',
  'GENERATOR_GOOGLE_CLIENT_ID', 'GENERATOR_GOOGLE_CLIENT_SECRET',
] as const;

function installSyntheticEnv(env: IdentityEnv) {
  for (const key of ENV_KEYS) vi.stubEnv(key, env[key]);
}

beforeEach(() => {
  installSyntheticEnv({});
  vi.stubEnv('NODE_ENV', 'test');
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubGlobal('fetch', external.fetch);
  vi.clearAllMocks();
});

afterEach(() => {
  try {
    expect(external.provider).not.toHaveBeenCalled();
    expect(external.fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});

function cookieRequest(value: string, name = GOOGLE_AUTH_COOKIE): Request {
  // An in-memory envelope only; no HTTP dispatch or protected route invocation.
  return new Request('https://ordinary-identity.example.invalid/', {
    headers: { cookie: `${name}=${encodeURIComponent(value)}` },
  });
}

function encodeOrdinary(rawKey: string, payload: unknown = SESSION): string {
  // Independent fixture encoder with ONE explicit key, not a copied resolver.
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(rawKey).digest(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return ['v2', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

function issuedGeneratorState(): string {
  const response = NextResponse.json({ ok: true });
  setGeneratorConsentStateCookie(response, GENERATOR_STATE);
  const cookie = response.cookies.get(GENERATOR_STATE_COOKIE);
  expect(cookie).toBeDefined();
  if (!cookie) throw new Error('Synthetic generator state was not issued');
  return cookie.value;
}

const keyCases: KeyCase[] = [
  {
    label: 'AUTH_SECRET wins over both distinct fallback keys',
    env: { AUTH_SECRET: AUTH_KEY, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: AUTH_KEY,
    generatorAccepts: true,
  },
  {
    label: 'absent AUTH_SECRET selects client before admin',
    env: { GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: CLIENT_KEY,
    generatorAccepts: false,
  },
  {
    label: 'empty AUTH_SECRET selects client before admin',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: CLIENT_KEY,
    generatorAccepts: false,
  },
  {
    label: 'absent AUTH_SECRET and client select admin',
    env: { ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: ADMIN_KEY,
    generatorAccepts: false,
  },
  {
    label: 'empty AUTH_SECRET and client select admin',
    env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: '', ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: ADMIN_KEY,
    generatorAccepts: false,
  },
  {
    label: 'one-character AUTH_SECRET shadows longer fallback keys',
    env: { AUTH_SECRET: 'x', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: 'x',
    generatorAccepts: false,
  },
  {
    label: 'over-1024-character AUTH_SECRET shadows fallback keys',
    env: { AUTH_SECRET: 'a'.repeat(1025), GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY },
    selectedKey: 'a'.repeat(1025),
    generatorAccepts: false,
  },
];

describe('ordinary identity fallback versus stricter generator key assumptions (synthetic only)', () => {
  it.each(keyCases)('$label', ({ env, selectedKey, generatorAccepts }) => {
    installSyntheticEnv(env);
    // Neither provider-enabled status nor generator readiness gates ordinary
    // cookie verification. Accepting SESSION proves no actual Google login.
    expect(isGoogleOAuthEnabled()).toBe(false);
    for (const key of new Set([AUTH_KEY, CLIENT_KEY, ADMIN_KEY, WRONG_KEY, selectedKey])) {
      const request = cookieRequest(encodeOrdinary(key));
      const expected = key === selectedKey ? SESSION : null;
      expect(getGoogleSessionFromRequest(request)).toEqual(expected);
      expect(getGoogleSessionFromRequest(request, env)).toEqual(expected);
    }
    // Rejected candidates also prove this is selection, not trial decryption
    // with each fallback after an authentication-tag failure.
    if (generatorAccepts) {
      const value = issuedGeneratorState();
      expect(consumeGeneratorConsentStateCookie(
        cookieRequest(value, GENERATOR_STATE_COOKIE), NextResponse.json({}), GENERATOR_STATE.state,
        { ...env, GENERATOR_GOOGLE_CLIENT_ID: GENERATOR_CLIENT_ID },
      )).toEqual(GENERATOR_STATE);
      expect(getGoogleSessionFromRequest(cookieRequest(value))).toBeNull();
    } else {
      const response = NextResponse.json({});
      expect(() => setGeneratorConsentStateCookie(response, GENERATOR_STATE)).toThrow(/AUTH_SECRET/);
      expect(response.headers.has('set-cookie')).toBe(false);
    }
  });

  it.each<{ label: string; env: IdentityEnv }>([
    { label: 'all keys absent', env: {} },
    { label: 'all keys empty', env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: '', ADMIN_PASSWORD: '' } },
    { label: 'truthy whitespace AUTH_SECRET blocks client/admin', env: { AUTH_SECRET: ' \t\n', GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY } },
    { label: 'truthy whitespace client blocks admin', env: { AUTH_SECRET: '', GOOGLE_CLIENT_SECRET: ' \t\n', ADMIN_PASSWORD: ADMIN_KEY } },
    { label: 'whitespace admin alone', env: { ADMIN_PASSWORD: ' \t\n' } },
  ])('$label: ordinary verification returns null rather than searching for a usable key', ({ env }) => {
    installSyntheticEnv(env);
    for (const key of [AUTH_KEY, CLIENT_KEY, ADMIN_KEY, ' \t\n']) {
      const request = cookieRequest(encodeOrdinary(key));
      expect(getGoogleSessionFromRequest(request)).toBeNull();
      expect(getGoogleSessionFromRequest(request, env)).toBeNull();
    }
  });

  it('ordinary hashes padded AUTH_SECRET raw bytes while the generator key gate trims it', () => {
    installSyntheticEnv({ AUTH_SECRET: ` ${AUTH_KEY} `, GOOGLE_CLIENT_SECRET: CLIENT_KEY, ADMIN_PASSWORD: ADMIN_KEY });
    expect(getGoogleSessionFromRequest(cookieRequest(encodeOrdinary(` ${AUTH_KEY} `)))).toEqual(SESSION);
    expect(getGoogleSessionFromRequest(cookieRequest(encodeOrdinary(AUTH_KEY)))).toBeNull();
    const value = issuedGeneratorState();
    expect(consumeGeneratorConsentStateCookie(
      cookieRequest(value, GENERATOR_STATE_COOKIE), NextResponse.json({}), GENERATOR_STATE.state,
      { AUTH_SECRET: AUTH_KEY, GENERATOR_GOOGLE_CLIENT_ID: GENERATOR_CLIENT_ID },
    )).toEqual(GENERATOR_STATE);
  });

  it.each([
    { label: 'empty subject', payload: { ...SESSION, subject: '' } },
    { label: 'future-issued identity', payload: { ...SESSION, issuedAt: NOW + 1 } },
    { label: 'expired identity', payload: { ...SESSION, issuedAt: NOW - 30 * 24 * 60 * 60 * 1000 - 1 } },
  ])('admin fallback still rejects $label; fallback is not unconditional authentication', ({ payload }) => {
    installSyntheticEnv({ ADMIN_PASSWORD: ADMIN_KEY });
    expect(getGoogleSessionFromRequest(cookieRequest(encodeOrdinary(ADMIN_KEY)))).toEqual(SESSION);
    expect(getGoogleSessionFromRequest(cookieRequest(encodeOrdinary(ADMIN_KEY, payload)))).toBeNull();
  });

  it('admin fallback still rejects an altered authentication tag', () => {
    installSyntheticEnv({ ADMIN_PASSWORD: ADMIN_KEY });
    const value = encodeOrdinary(ADMIN_KEY);
    expect(getGoogleSessionFromRequest(cookieRequest(value))).toEqual(SESSION);
    const parts = value.split('.');
    const tag = Buffer.from(parts[2], 'base64url');
    tag[0] ^= 1;
    parts[2] = tag.toString('base64url');
    expect(getGoogleSessionFromRequest(cookieRequest(parts.join('.')))).toBeNull();
  });
});
