// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassMembership } from '@/server/repositories/database/classMemberships';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  store: { begin: vi.fn(), endSessions: vi.fn(), accountDeleted: vi.fn(), profile: vi.fn(), profileUpdated: vi.fn(), verificationUpdated: vi.fn() },
  listByGoogleSubject: vi.fn(),
  endRequestTeacherSessions: vi.fn(),
}));
vi.mock('@/server/ddanssaem/hubAccounts', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/ddanssaem/hubAccounts')>(),
  getProductionHubAccountStore: () => mocks.store,
}));
vi.mock('@/server/repositories/database/classDashboard', () => ({
  getProductionClassDashboardRepository: () => ({ listByGoogleSubject: mocks.listByGoogleSubject }),
}));
vi.mock('@/server/teacherSession', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/teacherSession')>(),
  endRequestTeacherSessions: mocks.endRequestTeacherSessions,
}));

import { NextResponse } from 'next/server';
import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import { HUB_LOGIN_COOKIE } from '@/server/ddanssaem/hub';
import { defaultAvatarFor } from '@/components/profile/avatar';
import { hubSummary } from '@/server/ddanssaem/hubAccounts';
import { GET as start } from './start/route';
import { GET as callback } from './callback/route';
import { POST as events } from './events/route';
import { POST as summary } from '@/app/api/ddanssaem/summary/route';

const SECRET = 's'.repeat(40);
const ORIGIN = 'https://class-beta.example';
const PROFILE = { sub: '1234567890', account_id: 'acc', email: 'teacher@example.com', name: '별빛쌤', terms_version: '2026-12-05', sid: 'hub-sid-1' };
const BINDING = { accountGeneration: '50000000-0000-4000-8000-000000000001', sessionId: '50000000-0000-4000-8000-000000000002' };
const fetchMock = vi.fn();

function cookieFrom(response: Response, name: string): string | undefined {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const at = pair.indexOf('=');
    if (pair.slice(0, at) === name) return pair.slice(at + 1);
  }
  return undefined;
}
const signed = (path: string, payload: unknown, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-ddanssaem-signature': createHmac('sha256', secret).update(body).digest('hex') },
  });
};
const iat = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.stubEnv('DDANSSAEM_LOGIN', '1');
  vi.stubEnv('DDANSSAEM_HUB_URL', 'https://beta.ddanssaem.com');
  vi.stubEnv('DDANSSAEM_CLIENT_SECRET', SECRET);
  vi.stubEnv('AUTH_SECRET', 'test-secret-that-is-long-enough-for-cookies-0123456789');
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.store.begin.mockResolvedValue(BINDING);
  mocks.store.profile.mockResolvedValue(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  for (const mock of [mocks.store.begin, mocks.store.endSessions, mocks.store.accountDeleted, mocks.store.profile, mocks.store.profileUpdated, mocks.store.verificationUpdated,
    mocks.listByGoogleSubject, mocks.endRequestTeacherSessions]) mock.mockReset();
});

async function startLogin(next = '/c/alpha/admin') {
  const response = await start(new Request(`${ORIGIN}/api/auth/ddanssaem/start?next=${encodeURIComponent(next)}`));
  const authorize = new URL(response.headers.get('location')!);
  return { response, state: authorize.searchParams.get('state')!, cookie: cookieFrom(response, HUB_LOGIN_COOKIE)! };
}
const back = (query: string, cookie?: string) => callback(new Request(`${ORIGIN}/api/auth/ddanssaem/callback?${query}`,
  cookie ? { headers: { cookie: `${HUB_LOGIN_COOKIE}=${cookie}` } } : {}));

describe('딴쌤 sign-in routes', () => {
  it('sign in through the hub only with DDANSSAEM_LOGIN=1, and answer the hub once it is connected', async () => {
    vi.stubEnv('DDANSSAEM_LOGIN', '');
    expect((await start(new Request(`${ORIGIN}/api/auth/ddanssaem/start`))).status).toBe(404);
    expect((await back('code=c&state=s')).status).toBe(404);
    mocks.store.endSessions.mockResolvedValue(0);
    mocks.listByGoogleSubject.mockResolvedValue([]);
    expect((await events(signed('/api/auth/ddanssaem/events', { type: 'logout', sid: 'x', iat: iat() }))).status).toBe(200);
    expect((await summary(signed('/api/ddanssaem/summary', { sub: '1', iat: iat() }))).status).toBe(200);
    vi.stubEnv('DDANSSAEM_CLIENT_SECRET', '');
    vi.stubEnv('DDANSSAEM_LOGIN', '1');
    expect((await start(new Request(`${ORIGIN}/api/auth/ddanssaem/start`))).status).toBe(404);
    expect((await events(signed('/api/auth/ddanssaem/events', { type: 'logout', sid: 'x', iat: iat() }))).status).toBe(404);
    expect((await summary(signed('/api/ddanssaem/summary', { sub: '1', iat: iat() }))).status).toBe(404);
  });

  it('sends the browser to the hub and keeps the login in a cookie only the callback receives', async () => {
    const { response } = await startLogin();
    expect(response.headers.get('location')).toMatch(/^https:\/\/beta\.ddanssaem\.com\/authorize\?client_id=class&/);
    const line = response.headers.getSetCookie().find((value) => value.startsWith(`${HUB_LOGIN_COOKIE}=`))!;
    expect(line).toMatch(/Path=\/api\/auth\/ddanssaem\/callback/);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/Max-Age=600/);
  });

  it('starts a hub-agreed class session for the teacher the hub vouched for and returns to where they were', async () => {
    const { state, cookie } = await startLogin();
    fetchMock.mockResolvedValue(Response.json(PROFILE));
    const response = await back(`code=code-1&state=${state}`, cookie);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/c/alpha/admin`);
    expect(mocks.endRequestTeacherSessions).toHaveBeenCalledOnce();
    const fallback = defaultAvatarFor('1234567890');
    expect(mocks.store.begin).toHaveBeenCalledWith({ sub: '1234567890', email: 'teacher@example.com', name: '별빛쌤', termsVersion: '2026-12-05', sid: 'hub-sid-1', icon: null, verification: null },
      { avatar: fallback, avatarUrl: `https://beta.ddanssaem.com/api/avatar/${[fallback.background, fallback.face, fallback.eyes, fallback.mouth, fallback.accessory].join('.')}.svg`, fromHub: false },
      expect.any(Date));
    // When the sign-in began: before the code was traded, so a sign-out the hub reports after it wins.
    expect((mocks.store.begin.mock.calls[0][2] as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(cookieFrom(response, HUB_LOGIN_COOKIE)).toBe('');
    const session = getGoogleSessionFromRequest(new Request(ORIGIN, { headers: { cookie: `${GOOGLE_AUTH_COOKIE}=${cookieFrom(response, GOOGLE_AUTH_COOKIE)}` } }));
    expect(session).toMatchObject({ subject: '1234567890', email: 'teacher@example.com', name: '별빛쌤', agreement: 'hub', ...BINDING, hubSid: 'hub-sid-1' });
    expect(response.headers.getSetCookie().some((line) => /^class_store_dd_tried=;.*Max-Age=0/i.test(line))).toBe(true);
  });

  it('keeps the 딴쌤 account icon, handing an icon picked in the class to the hub once first (9-3, 9-4)', async () => {
    const hubIcon = { v: 1, background: 'mint', face: 'cat', eyes: 'basic', mouth: 'smile', accessory: 'none' };
    const picked = { v: 1 as const, background: 'yellow', face: 'bear', eyes: 'basic', mouth: 'smile', accessory: 'glasses' };
    const withIcon = { ...PROFILE, avatar: JSON.stringify(hubIcon), avatar_url: 'https://beta.ddanssaem.com/api/avatar/mint.cat.basic.smile.none.svg' };
    // A teacher whose icon already follows the hub: the hub's icon, nothing sent.
    mocks.store.profile.mockResolvedValueOnce({ nickname: '별빛쌤', avatar: picked, avatarUrl: 'https://x.example/a.svg', avatarFromHub: true });
    let login = await startLogin();
    fetchMock.mockResolvedValueOnce(Response.json(withIcon));
    await back(`code=c1&state=${login.state}`, login.cookie);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mocks.store.begin.mock.calls[0][1]).toEqual({ avatar: hubIcon, avatarUrl: withIcon.avatar_url, fromHub: true });
    // An icon picked in the class that has not reached the hub: sent signed, and kept when the hub stored it.
    mocks.store.profile.mockResolvedValueOnce({ nickname: '별빛쌤', avatar: picked, avatarUrl: null, avatarFromHub: false });
    login = await startLogin();
    fetchMock.mockResolvedValueOnce(Response.json(withIcon)).mockResolvedValueOnce(Response.json({ stored: true }));
    await back(`code=c2&state=${login.state}`, login.cookie);
    const [url, init] = fetchMock.mock.calls[2] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://beta.ddanssaem.com/api/ddanssaem/avatar-import');
    expect(init.headers['x-ddanssaem-client']).toBe('class');
    expect(init.headers['x-ddanssaem-signature']).toBe(createHmac('sha256', SECRET).update(String(init.body)).digest('hex'));
    expect(JSON.parse(String(init.body))).toMatchObject({ sub: '1234567890', avatar: JSON.stringify(picked), iat: expect.any(Number) });
    expect(mocks.store.begin.mock.calls[1][1]).toEqual({ avatar: picked,
      avatarUrl: 'https://beta.ddanssaem.com/api/avatar/yellow.bear.basic.smile.glasses.svg', fromHub: true });
    // The hub already had its own icon: that one wins. The hub unreachable: the class's stays, to send next time.
    mocks.store.profile.mockResolvedValueOnce({ nickname: '별빛쌤', avatar: picked, avatarUrl: null, avatarFromHub: false });
    login = await startLogin();
    fetchMock.mockResolvedValueOnce(Response.json(withIcon)).mockResolvedValueOnce(Response.json({ stored: false }));
    await back(`code=c3&state=${login.state}`, login.cookie);
    expect(mocks.store.begin.mock.calls[2][1]).toEqual({ avatar: hubIcon, avatarUrl: withIcon.avatar_url, fromHub: true });
    mocks.store.profile.mockResolvedValueOnce({ nickname: '별빛쌤', avatar: picked, avatarUrl: null, avatarFromHub: false });
    login = await startLogin();
    fetchMock.mockResolvedValueOnce(Response.json(withIcon)).mockResolvedValueOnce(new Response('', { status: 503 }));
    const response = await back(`code=c4&state=${login.state}`, login.cookie);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/c/alpha/admin`);
    expect(mocks.store.begin.mock.calls[3][1]).toMatchObject({ avatar: picked, fromHub: false });
  });

  it('keeps the 교사 인증 values each sign-in (10-4), and none when the hub sends none', async () => {
    const login = await startLogin();
    fetchMock.mockResolvedValueOnce(Response.json({ ...PROFILE,
      teacher_verification: { verified_until: '2027-10-27T03:00:00.000Z', required: false, required_from: '2026-11-25T15:00:00.000Z' } }));
    const response = await back(`code=v1&state=${login.state}`, login.cookie);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/c/alpha/admin`);
    expect(mocks.store.verificationUpdated).toHaveBeenCalledWith('1234567890', { verifiedUntil: '2027-10-27T03:00:00.000Z', requiredFrom: '2026-11-25T15:00:00.000Z' });
    expect(mocks.store.begin.mock.invocationCallOrder[0]).toBeLessThan(mocks.store.verificationUpdated.mock.invocationCallOrder[0]);
    mocks.store.verificationUpdated.mockClear();
    const again = await startLogin();
    fetchMock.mockResolvedValueOnce(Response.json(PROFILE));
    await back(`code=v2&state=${again.state}`, again.cookie);
    expect(mocks.store.verificationUpdated).not.toHaveBeenCalled();
  });

  it('asks the hub quietly with prompt=none, and once with a prompt when the hub answers that it cannot', async () => {
    const response = await start(new Request(`${ORIGIN}/api/auth/ddanssaem/start?prompt=none&next=%2Fprofile`));
    expect(new URL(response.headers.get('location')!).searchParams.get('prompt')).toBe('none');
    expect(response.headers.getSetCookie().find((line) => line.startsWith('class_store_dd_tried=1'))).toMatch(/Max-Age=60/);
    const authorize = new URL(response.headers.get('location')!);
    for (const answer of ['login_required', 'consent_required']) {
      const back = await callback(new Request(`${ORIGIN}/api/auth/ddanssaem/callback?error=${answer}&state=${authorize.searchParams.get('state')}`,
        { headers: { cookie: `${HUB_LOGIN_COOKIE}=${cookieFrom(response, HUB_LOGIN_COOKIE)}` } }));
      expect(back.headers.get('location')).toBe(`${ORIGIN}/api/auth/ddanssaem/start?next=%2Fprofile`);
    }
    const { state, cookie } = await startLogin('/profile');
    expect((await back(`error=login_required&state=${state}`, cookie)).headers.get('location')).toBe(`${ORIGIN}/classes?login_error=login_required`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ends this browser\'s class session first when the hub hint says it signed out or another hub session is in', async () => {
    vi.stubEnv('DDANSSAEM_HINT_COOKIE', 'dd_hub');
    const sealed = NextResponse.json({});
    setGoogleSessionCookie(sealed, { subject: '1234567890', email: 'teacher@example.com', issuedAt: Date.now(), agreement: 'hub', ...BINDING, hubSid: 'hub-sid-1' });
    const classSession = `${GOOGLE_AUTH_COOKIE}=${cookieFrom(sealed, GOOGLE_AUTH_COOKIE)}`;
    const startWith = (cookie: string) => start(new Request(`${ORIGIN}/api/auth/ddanssaem/start?next=%2Fclasses`, { headers: { cookie } }));
    const cleared = (response: Response) => response.headers.getSetCookie().some((line) => line.startsWith(`${GOOGLE_AUTH_COOKIE}=;`));

    expect(cleared(await startWith(`${classSession}; dd_hub=hub-sid-1`))).toBe(false);
    expect(mocks.endRequestTeacherSessions).not.toHaveBeenCalled();
    expect(cleared(await startWith(classSession))).toBe(true);
    expect(cleared(await startWith(`${classSession}; dd_hub=hub-sid-2`))).toBe(true);
    expect(mocks.endRequestTeacherSessions).toHaveBeenCalledTimes(2);
    vi.stubEnv('DDANSSAEM_HINT_COOKIE', '');
    expect(cleared(await startWith(classSession))).toBe(false);
  });

  it('refuses a callback without its own login, with another state, or that the hub refused', async () => {
    const { state, cookie } = await startLogin();
    expect((await back(`code=c&state=${state}`)).headers.get('location')).toBe(`${ORIGIN}/classes?login_error=state`);
    expect((await back('code=c&state=other', cookie)).headers.get('location')).toBe(`${ORIGIN}/classes?login_error=state`);
    expect((await back(`error=access_denied&state=${state}`, cookie)).headers.get('location')).toBe(`${ORIGIN}/classes?login_error=access_denied`);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const refused = await back(`code=c&state=${state}`, cookie);
    expect(refused.headers.get('location')).toBe(`${ORIGIN}/classes?login_error=exchange`);
    expect(cookieFrom(refused, GOOGLE_AUTH_COOKIE)).toBeUndefined();
    expect(mocks.store.begin).not.toHaveBeenCalled();
  });
});

describe('the hub signed events', () => {
  it('end the class sessions of a hub session that signed out', async () => {
    mocks.store.endSessions.mockResolvedValue(2);
    const response = await events(signed('/api/auth/ddanssaem/events', { type: 'logout', sid: 'hub-sid-1', iat: iat() }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ended: 2 });
    expect(mocks.store.endSessions).toHaveBeenCalledWith('hub-sid-1');
  });

  it('withdraw the teacher whose 딴쌤 account was deleted', async () => {
    mocks.store.accountDeleted.mockResolvedValue(1);
    const response = await events(signed('/api/auth/ddanssaem/events', { type: 'account_deleted', sub: '1234567890', iat: iat() }));
    expect(await response.json()).toEqual({ ok: true, closedClasses: 1 });
    expect(mocks.store.accountDeleted).toHaveBeenCalledWith('1234567890');
  });

  it('take the new name and icon of a 딴쌤 account the class keeps (9-3)', async () => {
    const icon = { v: 1, background: 'mint', face: 'cat', eyes: 'basic', mouth: 'smile', accessory: 'none' };
    const event = { type: 'profile_updated', sub: '1234567890', name: '새이름쌤', avatar: JSON.stringify(icon),
      avatar_url: 'https://beta.ddanssaem.com/api/avatar/mint.cat.basic.smile.none.svg', iat: iat() };
    mocks.store.profile.mockResolvedValueOnce(null);
    expect(await (await events(signed('/api/auth/ddanssaem/events', event))).json()).toEqual({ ok: true, updated: false });
    expect(mocks.store.profileUpdated).not.toHaveBeenCalled();
    mocks.store.profile.mockResolvedValueOnce({ nickname: '별빛쌤', avatar: icon, avatarUrl: null, avatarFromHub: true });
    mocks.store.profileUpdated.mockResolvedValueOnce(true);
    expect(await (await events(signed('/api/auth/ddanssaem/events', event))).json()).toEqual({ ok: true, updated: true });
    expect(mocks.store.profileUpdated).toHaveBeenCalledWith('1234567890', '새이름쌤', { avatar: icon, avatarUrl: event.avatar_url, fromHub: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keep the new 교사 인증 values of a teacher, leaving the sessions alone (10-3)', async () => {
    mocks.store.verificationUpdated.mockResolvedValueOnce(true);
    const event = { type: 'verification_updated', sub: '1234567890', account_id: 'acc',
      teacher_verification: { verified_until: '2027-10-27T03:00:00.000Z', required: false, required_from: null }, iat: iat() };
    const response = await events(signed('/api/auth/ddanssaem/events', event));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, updated: true });
    expect(mocks.store.verificationUpdated).toHaveBeenCalledWith('1234567890', { verifiedUntil: '2027-10-27T03:00:00.000Z', requiredFrom: null });
    expect(mocks.store.endSessions).not.toHaveBeenCalled();
    expect((await events(signed('/api/auth/ddanssaem/events', event, 'w'.repeat(40)))).status).toBe(401);
  });

  it('refuse unsigned, stale or unknown events, and ask the hub to retry when the database fails', async () => {
    expect((await events(signed('/api/auth/ddanssaem/events', { type: 'logout', sid: 'x', iat: iat() }, 'w'.repeat(40)))).status).toBe(401);
    expect((await events(signed('/api/auth/ddanssaem/events', { type: 'logout', sid: 'x', iat: iat() - 600 }))).status).toBe(400);
    expect((await events(signed('/api/auth/ddanssaem/events', { type: 'renamed', iat: iat() }))).status).toBe(400);
    expect(mocks.store.endSessions).not.toHaveBeenCalled();
    mocks.store.accountDeleted.mockRejectedValue(new Error('down'));
    expect((await events(signed('/api/auth/ddanssaem/events', { type: 'account_deleted', sub: '1', iat: iat() }))).status).toBe(503);
  });
});

const membership = (slug: string, lifecycle: ClassMembership['lifecycle'], createdAt: string, extra: Partial<NonNullable<ClassMembership['dashboard']>> = {}): ClassMembership => ({
  slug, displayName: `${slug} 반`, role: 'OWNER', lifecycle,
  dashboard: { deletedAt: null, managementVersion: '1', createdAt, studentCount: 24, productCount: 0, taskCount: 0, ...extra },
});

describe('the summary for the hub', () => {
  it('lists the live classes newest first with links, without student information', () => {
    const result = hubSummary([
      membership('old', 'ACTIVE', '2026-03-02T00:00:00Z'),
      membership('draft', 'DRAFT', '2026-10-01T00:00:00Z'),
      membership('trashed', 'ACTIVE', '2026-10-10T00:00:00Z', { deletedAt: '2026-10-11T00:00:00Z' }),
      membership('paused', 'SUSPENDED', '2026-09-01T00:00:00Z', { studentCount: 3 }),
    ], ORIGIN);
    expect(result).toEqual({
      total: 3,
      items: [
        { title: 'draft 반', detail: '준비 중', url: `${ORIGIN}/classes/draft/start`, pending: 0 },
        { title: 'paused 반', detail: '학생 3명', url: `${ORIGIN}/classes`, pending: 0 },
        { title: 'old 반', detail: '학생 24명', url: `${ORIGIN}/c/old/admin`, pending: 0 },
      ],
    });
    const many = hubSummary(Array.from({ length: 12 }, (_, index) => membership(`c${index}`, 'ACTIVE', `2026-01-${String(index + 10)}T00:00:00Z`)), ORIGIN);
    expect(many.items).toHaveLength(10);
    expect(many.total).toBe(12);
    expect(many.items[0].title).toBe('c11 반');
  });

  it('answers only a signed request about one teacher', async () => {
    mocks.listByGoogleSubject.mockResolvedValue([membership('alpha', 'ACTIVE', '2026-03-02T00:00:00Z')]);
    const response = await summary(signed('/api/ddanssaem/summary', { sub: '1234567890', iat: iat() }));
    expect(await response.json()).toEqual({ total: 1, items: [{ title: 'alpha 반', detail: '학생 24명', url: `${ORIGIN}/c/alpha/admin`, pending: 0 }] });
    expect(mocks.listByGoogleSubject).toHaveBeenCalledWith('1234567890');
    expect((await summary(signed('/api/ddanssaem/summary', { sub: '1234567890', iat: iat() }, 'w'.repeat(40)))).status).toBe(401);
    mocks.listByGoogleSubject.mockRejectedValue(new Error('down'));
    expect((await summary(signed('/api/ddanssaem/summary', { sub: '1234567890', iat: iat() }))).status).toBe(503);
  });
});
