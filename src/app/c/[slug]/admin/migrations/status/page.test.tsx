import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextResponse } from 'next/server';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  dependencies: vi.fn(),
  headers: vi.fn(),
  database: vi.fn(),
  redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
  notFound: vi.fn((): never => { throw new Error('not-found'); }),
}));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: mocks.dependencies }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: mocks.database }));
vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));

import { GOOGLE_AUTH_COOKIE, getGoogleSessionFromRequest, setGoogleSessionCookie } from '@/server/googleOAuth';
import Page, { dynamic } from './page';

const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha', displayName: 'private-class-name', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const session = { subject: 'private-subject', email: 'private@example.test', issuedAt: 1 };
const membership = { tenantId: tenant.id, googleSubject: session.subject, role: 'ADMIN', id: 'private-member-id', userId: 'private-user-id' };
const getSession = vi.fn<(request: Request) => typeof session | null>(() => session);
const findBySlug = vi.fn(async () => tenant);
const findByTenantAndSubject = vi.fn(async (): Promise<typeof membership | null> => membership);
const getCompatibilitySession = vi.fn(async () => ({ tenantId: tenant.id }));
let fetchSpy: ReturnType<typeof vi.spyOn>;
const page = (slug = 'alpha') => Page({ params: Promise.resolve({ slug }) });
const matchPagePath = getRouteMatcher(getRouteRegex('/c/[slug]/admin/migrations/status'));

function decodedSlug(segment: string) {
  const params = matchPagePath(`/c/${segment}/admin/migrations/status`);
  if (!params || typeof params.slug !== 'string') throw new Error('Unexpected page test path');
  return params.slug;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockReset().mockReturnValue(session);
  findBySlug.mockReset().mockResolvedValue(tenant);
  findByTenantAndSubject.mockReset().mockResolvedValue(membership);
  mocks.dependencies.mockReset().mockReturnValue({ getSession, findBySlug, findByTenantAndSubject, getCompatibilitySession });
  mocks.headers.mockResolvedValue(new Headers({ cookie: 'test-only-cookie' }));
  mocks.database.mockImplementation(() => { throw new Error('No production database'); });
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
});
afterEach(() => {
  cleanup();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(mocks.database).not.toHaveBeenCalled();
  expect(getCompatibilitySession).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('independent read-only migration status page', () => {
  it.each(['OWNER', 'ADMIN'])('shows only blocked/unknown information for %s without mutation controls', async role => {
    findByTenantAndSubject.mockResolvedValue({ ...membership, role });
    const { container } = render(await page());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('마이그레이션 상태');
    expect(screen.getByRole('status').textContent).toContain('상태 조회 차단');
    expect(container.textContent).toContain('검증된 이전 상태 조회가 연결되지 않아 진행 상태와 운영 권한을 확인할 수 없어요.');
    expect(container.textContent).toContain('UNKNOWN');
    expect(container.textContent).toContain('TRUSTED_STATUS_READER_UNAVAILABLE');
    expect(container.textContent).toContain('읽기 전용');
    expect(container.textContent).toContain('원본 조회, 사전검사, 동결, 전환, 재개, 보고서 다운로드를 실행하지 않아요.');
    expect(container.querySelectorAll('form, button, input, select, textarea, iframe, script')).toHaveLength(0);
    for (const link of container.querySelectorAll('a')) {
      expect(link.getAttribute('href')).toBe('/c/alpha/admin');
    }
    for (const secret of [tenant.id, tenant.displayName, session.email, session.subject, membership.userId]) {
      expect(container.innerHTML).not.toContain(secret);
    }
    expect(findBySlug).toHaveBeenCalledWith('alpha');
    expect(findByTenantAndSubject).toHaveBeenCalledWith(tenant.id, session.subject);
    const request = getSession.mock.calls[0]?.[0] as Request | undefined;
    expect(request?.headers.get('cookie')).toBe('test-only-cookie');
    expect(dynamic).toBe('force-dynamic');
  });

  it('redirects an unauthenticated user to the scoped login without directory reads', async () => {
    getSession.mockReturnValue(null);
    await expect(page()).rejects.toThrow('redirect:/c/alpha/admin/login');
    expect(findBySlug).not.toHaveBeenCalled();
    expect(findByTenantAndSubject).not.toHaveBeenCalled();
  });

  it.each([
    ['nonmember', null],
    ['different tenant', { ...membership, tenantId: '20000000-0000-4000-8000-000000000002' }],
    ['different identity', { ...membership, googleSubject: 'someone-else' }],
    ['student', { ...membership, role: 'STUDENT' }],
  ])('refuses %s instead of showing a status or compatibility fallback', async (_label, member) => {
    findByTenantAndSubject.mockResolvedValue(member);
    await expect(page()).rejects.toThrow('not-found');
  });

  it.each([
    'Alpha', 'bad_slug', 'a'.repeat(64), '', 'alpha--beta', '-alpha', 'alpha-',
    'alpha\n', 'alpha\r', 'alpha\r\n', 'alpha\u2028', 'alpha\u2029',
  ])('refuses noncanonical slug %j before identity or tenant lookup', async slug => {
    await expect(page(slug)).rejects.toThrow('not-found');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(findBySlug).not.toHaveBeenCalled();
    expect(findByTenantAndSubject).not.toHaveBeenCalled();
  });

  it('ignores caller status/authority and does not turn tenant ACTIVE into migration success', async () => {
    const props = {
      params: Promise.resolve({ slug: 'alpha' }),
      searchParams: Promise.resolve({ status: 'ACTIVE', authority: 'POSTGRESQL', cutoverAllowed: 'true', token: 'private-token' }),
    };
    const { container } = render(await Page(props));
    expect(screen.getByRole('status').textContent).toContain('상태 조회 차단');
    expect(container.innerHTML).not.toContain('private-token');
    expect(container.textContent).not.toContain('ACTIVE');
    expect(container.textContent).not.toContain('POSTGRESQL');
  });

  it('does not cache authorization across a membership revocation', async () => {
    await page();
    findByTenantAndSubject.mockResolvedValue(null);
    await expect(page()).rejects.toThrow('not-found');
    expect(findByTenantAndSubject).toHaveBeenCalledTimes(2);
  });

  it.each(['composition', 'session', 'directory', 'membership'])('renders a generic unavailable view on %s failure without disclosing errors', async point => {
    const error = new Error('private-source-row private-sheet-id private-token private-password');
    if (point === 'composition') mocks.dependencies.mockImplementationOnce(() => { throw error; });
    if (point === 'session') getSession.mockImplementationOnce(() => { throw error; });
    if (point === 'directory') findBySlug.mockRejectedValueOnce(error);
    if (point === 'membership') findByTenantAndSubject.mockRejectedValueOnce(error);
    const { container } = render(await page());
    expect(screen.getByRole('status').textContent).toContain('접근 권한 확인 불가');
    expect(container.textContent).toContain('상태 정보를 표시하지 않아요.');
    expect(container.innerHTML).not.toContain('private-');
    expect(container.textContent).not.toContain('TRUSTED_STATUS_READER_UNAVAILABLE');
    expect(container.querySelectorAll('form, button, input, script')).toHaveLength(0);
  });

  it.each([
    '%2561lpha', 'alpha%2Fbeta', 'alpha%252Fbeta', 'alpha%5Cbeta',
    'alpha%3Ftoken=private-token', 'alpha%23private-token', 'alpha%00', 'alpha%0A', 'alpha%20', '%41lpha',
  ])('denies decoded path %s without normalizing it into a login redirect', async segment => {
    await expect(page(decodedSlug(segment))).rejects.toThrow('not-found');
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.dependencies).not.toHaveBeenCalled();
    expect(findBySlug).not.toHaveBeenCalled();
  });

  it.each(['valid', 'expired', 'tampered', 'corrupted-ciphertext', 'wrong-key', 'legacy-only', 'malformed'])(
    'checks a %s encrypted Google cookie in the server page even with forged authority headers', async state => {
      const env = { AUTH_SECRET: 'task20-page-test-only-secret-not-a-production-credential' };
      vi.stubEnv('AUTH_SECRET', env.AUTH_SECRET);
      const issued = NextResponse.json({ ok: true });
      const issuedSession = { ...session, issuedAt: state === 'expired' ? 1 : Date.now() };
      setGoogleSessionCookie(issued, issuedSession);
      const token = issued.cookies.get(GOOGLE_AUTH_COOKIE)?.value;
      expect(token).toBeTruthy();
      if (!token) throw new Error('Test cookie was not issued');
      const parts = token.split('.');
      if (state === 'corrupted-ciphertext') {
        parts[3] = `${parts[3][0] === 'A' ? 'B' : 'A'}${parts[3].slice(1)}`;
      }
      const cookie = state === 'legacy-only' ? 'class_store_tenant_admin=private-forged-cookie'
        : `${GOOGLE_AUTH_COOKIE}=${state === 'malformed' ? '%GG' : `${parts.join('.')}${state === 'tampered' ? '.extra' : ''}`}`;
      mocks.headers.mockResolvedValue(new Headers({
        cookie, 'x-role': 'OWNER', 'x-tenant-id': tenant.id, 'x-tenant-slug': 'alpha',
        'x-migration-status': 'ACTIVE', 'x-cutover-allowed': 'true',
      }));
      const accessTrace: string[] = [];
      const checkedCookies: (string | null)[] = [];
      getSession.mockImplementation(request => {
        checkedCookies.push(request.headers.get('cookie'));
        const verified = getGoogleSessionFromRequest(request,
          state === 'wrong-key' ? { AUTH_SECRET: 'task20-different-test-only-key' } : env);
        accessTrace.push(verified ? 'session:verified' : 'session:denied');
        return verified;
      });

      // The page receives Next's decoded slug, not the original encoded URL.
      const slug = decodedSlug('%61lpha');
      expect(slug).toBe('alpha');
      if (state !== 'valid') {
        await expect(page(slug)).rejects.toThrow('redirect:/c/alpha/admin/login');
        expect(findBySlug).not.toHaveBeenCalled();
        expect(findByTenantAndSubject).not.toHaveBeenCalled();
        return;
      }
      findByTenantAndSubject.mockImplementationOnce(async () => {
        await Promise.resolve();
        accessTrace.push('membership:resolved');
        return membership;
      });
      const html = renderToStaticMarkup(await page(slug));
      expect(html).toContain('TRUSTED_STATUS_READER_UNAVAILABLE');
      expect(html).toContain('UNKNOWN');
      expect(html).not.toContain('ACTIVE');
      expect(html).not.toContain('private-');
      expect(html).not.toContain(token);
      expect(findBySlug).toHaveBeenCalledWith('alpha');
      expect(findByTenantAndSubject).toHaveBeenCalledWith(tenant.id, session.subject);

      // Admission and post-membership publication must verify the same request,
      // Cookie bytes and issued identity; two calls alone do not prove ordering.
      expect(getSession).toHaveBeenCalledTimes(2);
      const admittedRequest = getSession.mock.calls[0][0];
      expect(admittedRequest).toBeInstanceOf(Request);
      expect(getSession.mock.calls[1][0]).toBe(admittedRequest);
      expect(checkedCookies).toEqual([cookie, cookie]);
      expect(getSession.mock.results).toEqual([
        { type: 'return', value: issuedSession },
        { type: 'return', value: issuedSession },
      ]);
      expect(getSession.mock.invocationCallOrder[0]).toBeLessThan(findBySlug.mock.invocationCallOrder[0]);
      expect(findBySlug.mock.invocationCallOrder[0]).toBeLessThan(findByTenantAndSubject.mock.invocationCallOrder[0]);
      expect(accessTrace).toEqual(['session:verified', 'membership:resolved', 'session:verified']);
      expect(mocks.redirect).not.toHaveBeenCalled();
      expect(mocks.notFound).not.toHaveBeenCalled();

      // A previously rendered, authenticated page must not authorize logout.
      mocks.headers.mockResolvedValue(new Headers({ 'x-role': 'OWNER' }));
      await expect(page(slug)).rejects.toThrow('redirect:/c/alpha/admin/login');
      expect(getSession).toHaveBeenCalledTimes(3);
      const loggedOutRequest = getSession.mock.calls[2][0];
      expect(loggedOutRequest).not.toBe(admittedRequest);
      expect(loggedOutRequest.headers.get('cookie')).toBeNull();
      expect(loggedOutRequest.headers.get('x-role')).toBe('OWNER');
      expect(checkedCookies).toEqual([cookie, cookie, null]);
      expect(getSession.mock.results[2]).toEqual({ type: 'return', value: null });
      expect(accessTrace).toEqual(['session:verified', 'membership:resolved', 'session:verified', 'session:denied']);
      expect(findBySlug).toHaveBeenCalledTimes(1);
      expect(findByTenantAndSubject).toHaveBeenCalledTimes(1);
      expect(mocks.redirect).toHaveBeenCalledTimes(1);
      expect(mocks.redirect).toHaveBeenCalledWith('/c/alpha/admin/login');
      expect(mocks.notFound).not.toHaveBeenCalled();
    },
  );

  it('does not reuse the first tenant membership during server navigation to another tenant', async () => {
    await page();
    const beta = { ...tenant, id: '20000000-0000-4000-8000-000000000002', slug: 'beta' };
    findBySlug.mockResolvedValue(beta);
    await expect(page('beta')).rejects.toThrow('not-found');
    expect(findBySlug.mock.calls).toEqual([['alpha'], ['beta']]);
    expect(findByTenantAndSubject.mock.calls).toEqual([[tenant.id, session.subject], [beta.id, session.subject]]);
  });
});
