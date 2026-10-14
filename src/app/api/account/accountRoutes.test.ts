// @vitest-environment node
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const store = vi.hoisted(() => ({
  recordAgreement: vi.fn<(subject: string, version: string) => Promise<string>>(async () => '2026-10-08T03:00:00.000Z'),
  saveProfile: vi.fn<(subject: string, profile: unknown) => Promise<void>>(async () => undefined),
  withdraw: vi.fn<(subject: string) => Promise<number>>(async () => 2),
}));
vi.mock('@/server/teacherAccounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/teacherAccounts')>()),
  getProductionTeacherAccountStore: () => store,
}));

vi.mock('@/server/teacherSession', async (original) => ({
  ...(await original<typeof import('@/server/teacherSession')>()),
  getProductionTeacherSessionStore: () => ({ valid: async () => true, end: async () => undefined,
    mutate: async (identity: { subject: string }, action: string, payload: { version: string }) => {
      if (action === 'AGREE') { await store.recordAgreement(identity.subject, payload.version); return {}; }
      return { closedClasses: await store.withdraw(identity.subject) };
    },
  }),
  getTeacherGoogleSessionFromRequest: async (request: Request) => getGoogleSessionFromRequest(request),
  saveTeacherProfile: async (identity: { subject: string }, profile: unknown) => store.saveProfile(identity.subject, profile),
}));

import { AVATAR_PRESETS } from '@/components/profile/avatar';
import { currentLegalRevision } from '@/lib/legalDocuments';
import {
  GOOGLE_AUTH_COOKIE, PENDING_AGREEMENT_COOKIE, getGoogleSessionFromRequest, getPendingAgreementFromRequest, setGoogleSessionCookie,
  setPendingAgreementCookie, type GoogleSession, type PendingAgreement,
} from '@/server/googleOAuth';
import { DELETE as cancelAgreement, POST as agree } from './agreement/route';
import { POST as saveProfile } from './profile/route';
import { POST as withdraw } from './withdraw/route';

const ORIGIN = 'https://class.schoolit.kr';
const version = currentLegalRevision().version;
const avatar = AVATAR_PRESETS[1].config;
const binding = { accountGeneration: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };

function cookieOf(response: NextResponse, name: string): string | undefined {
  return response.cookies.get(name)?.value;
}
function sessionCookie(session: GoogleSession) {
  const response = NextResponse.json({});
  setGoogleSessionCookie(response, { ...binding, ...session });
  return `${GOOGLE_AUTH_COOKIE}=${cookieOf(response, GOOGLE_AUTH_COOKIE)}`;
}
function pendingCookie(pending: Partial<PendingAgreement> = {}) {
  const response = NextResponse.json({});
  setPendingAgreementCookie(response, {
    ...binding, purpose: 'agreement', subject: 'google-new', email: 'new@example.com', name: '새선생', mode: 'signup', returnTo: '/classes', issuedAt: Date.now(), ...pending,
  });
  return `${PENDING_AGREEMENT_COOKIE}=${cookieOf(response, PENDING_AGREEMENT_COOKIE)}`;
}
function request(path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}) {
  const headers = new Headers({ host: 'class.schoolit.kr', origin: init.origin ?? ORIGIN, 'sec-fetch-site': 'same-origin' });
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.cookie) headers.set('cookie', init.cookie);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? 'POST', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}
const asRequest = (response: NextResponse, name: string) => new Request(ORIGIN, { headers: { cookie: `${name}=${cookieOf(response, name)}` } });
const ALL = { terms: true, privacy: true, age: true, expectedSessionId: binding.sessionId };

beforeEach(() => {
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('AUTH_SECRET', 'test-secret-that-is-long-enough-for-cookies-0123456789');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('POST /api/account/agreement', () => {
  it('starts the session of a waiting sign-up only after every required item is agreed', async () => {
    const refused = await agree(request('/api/account/agreement', { body: { terms: true, privacy: true, age: false }, cookie: pendingCookie() }));
    expect(refused.status).toBe(400);
    expect(store.recordAgreement).not.toHaveBeenCalled();

    const response = await agree(request('/api/account/agreement', { body: ALL, cookie: pendingCookie({ returnTo: '/c/alpha/admin' }) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version, redirectTo: '/c/alpha/admin' });
    expect(store.recordAgreement).toHaveBeenCalledWith('google-new', version);
    const session = getGoogleSessionFromRequest(asRequest(response, GOOGLE_AUTH_COOKIE));
    expect(session).toMatchObject({ subject: 'google-new', email: 'new@example.com', name: '새선생', agreement: version });
    expect(cookieOf(response, PENDING_AGREEMENT_COOKIE)).toBe('');
  });

  it('renews a signed-in session with the version in force', async () => {
    const cookie = sessionCookie({ subject: 'google-1', email: 'kim@example.com', issuedAt: Date.now() });
    const response = await agree(request('/api/account/agreement', { body: ALL, cookie }));
    expect(response.status).toBe(200);
    expect((await response.json()).redirectTo).toBeNull();
    expect(getGoogleSessionFromRequest(asRequest(response, GOOGLE_AUTH_COOKIE))?.agreement).toBe(version);
  });

  it('refuses requests without an identity, from another site, or when the agreement cannot be stored', async () => {
    expect((await agree(request('/api/account/agreement', { body: ALL }))).status).toBe(401);
    expect((await agree(request('/api/account/agreement', { body: ALL, cookie: pendingCookie(), origin: 'https://evil.example' }))).status).toBe(403);
    store.recordAgreement.mockRejectedValueOnce(new Error('down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failed = await agree(request('/api/account/agreement', { body: ALL, cookie: pendingCookie() }));
    expect(failed.status).toBe(503);
    expect(failed.cookies.get(GOOGLE_AUTH_COOKIE)).toBeUndefined();
    spy.mockRestore();
  });

  it('does not exist outside the PostgreSQL service', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', '');
    expect((await agree(request('/api/account/agreement', { body: ALL, cookie: pendingCookie() }))).status).toBe(404);
  });
});

describe('DELETE /api/account/agreement', () => {
  it('discards a waiting sign-in without making an account', async () => {
    const response = await cancelAgreement(request('/api/account/agreement', { method: 'DELETE', cookie: pendingCookie() }));
    expect(response.status).toBe(200);
    expect(cookieOf(response, PENDING_AGREEMENT_COOKIE)).toBe('');
    expect(store.recordAgreement).not.toHaveBeenCalled();
  });
});

describe('POST /api/account/withdraw', () => {
  it('withdraws after the explicit confirmation and signs this browser out', async () => {
    const cookie = sessionCookie({ subject: 'google-1', email: 'kim@example.com', issuedAt: Date.now(), agreement: version });
    expect((await withdraw(request('/api/account/withdraw', { body: { confirm: false }, cookie }))).status).toBe(400);
    expect(store.withdraw).not.toHaveBeenCalled();

    const response = await withdraw(request('/api/account/withdraw', { body: { confirm: true, expectedSessionId: binding.sessionId }, cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, closedClasses: 2, redirectTo: '/classes?withdrawn=1' });
    expect(store.withdraw).toHaveBeenCalledWith('google-1');
    expect(cookieOf(response, GOOGLE_AUTH_COOKIE)).toBe('');
  });

  it('lets a teacher who declines a new version withdraw from the agreement step', async () => {
    const response = await withdraw(request('/api/account/withdraw', { body: { confirm: true, expectedSessionId: binding.sessionId }, cookie: pendingCookie({ subject: 'google-old', mode: 'update' }) }));
    expect(response.status).toBe(200);
    expect(store.withdraw).toHaveBeenCalledWith('google-old');
    expect(getPendingAgreementFromRequest(asRequest(response, PENDING_AGREEMENT_COOKIE))).toBeNull();
  });
});

describe('POST /api/account/profile', () => {
  it('saves a valid profile for a session that agreed to the version in force', async () => {
    const cookie = sessionCookie({ subject: 'google-1', email: 'kim@example.com', issuedAt: Date.now(), agreement: version });
    const response = await saveProfile(request('/api/account/profile', { body: { nickname: ' 햇살쌤 ', avatar, expectedSessionId: binding.sessionId }, cookie }));
    expect(response.status).toBe(200);
    expect(store.saveProfile).toHaveBeenCalledWith('google-1', { nickname: '햇살쌤', avatar });
    expect((await saveProfile(request('/api/account/profile', { body: { nickname: '', avatar, expectedSessionId: binding.sessionId }, cookie }))).status).toBe(400);
  });

  it('asks for the new agreement first, and refuses a waiting sign-in', async () => {
    const outdated = sessionCookie({ subject: 'google-1', email: 'kim@example.com', issuedAt: Date.now() });
    const response = await saveProfile(request('/api/account/profile', { body: { nickname: '햇살쌤', avatar }, cookie: outdated }));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('AGREEMENT_REQUIRED');
    expect((await saveProfile(request('/api/account/profile', { body: { nickname: '햇살쌤', avatar }, cookie: pendingCookie() }))).status).toBe(401);
    expect(store.saveProfile).not.toHaveBeenCalled();
  });
});
