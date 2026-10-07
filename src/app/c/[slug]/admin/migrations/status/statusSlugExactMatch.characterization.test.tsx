import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRouteMatcher } from 'next/dist/shared/lib/router/utils/route-matcher';
import { getRouteRegex } from 'next/dist/shared/lib/router/utils/route-regex';

vi.mock('server-only', () => ({}));
const boundary = vi.hoisted(() => {
  const forbidden = vi.fn(function forbiddenTransport(): never {
    throw new Error('Unexpected external I/O in synthetic slug characterization');
  });
  vi.stubGlobal('fetch', forbidden);
  return { forbidden, headers: vi.fn(),
    redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
    notFound: vi.fn((): never => { throw new Error('not-found'); }) };
});
vi.mock('@/server/db/client', () => ({ getDatabaseClient: boundary.forbidden }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: boundary.forbidden }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  const blocked = { Pool: boundary.forbidden, Client: boundary.forbidden };
  return { ...actual, ...blocked, default: { ...actual.default, ...blocked } };
});
vi.mock('googleapis', () => ({ google: new Proxy({}, { get() { return boundary.forbidden(); } }) }));
vi.mock('next/headers', () => ({ headers: boundary.headers }));
vi.mock('next/navigation', () => ({ redirect: boundary.redirect, notFound: boundary.notFound }));
// Call-through spies only: no canned page, reader, parser or identity outcome.
vi.mock('@/app/api/migrations/status/readStatus', { spy: true });
vi.mock('@/app/api/migrations/status/readPreflightReport', { spy: true });
vi.mock('@/server/tenantAccess', { spy: true });
vi.mock('@/server/googleOAuth', { spy: true });

import { parseTenantSlug, resolveTenantContext, TenantContextError } from '@/server/tenantContext';
import { getProductionTenantAccessDependencies } from '@/server/tenantAccess';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { readMigrationStatus } from '@/app/api/migrations/status/readStatus';
import { readPreflightReport } from '@/app/api/migrations/status/readPreflightReport';
import StatusPage from './page';
import HistoryPage from '../history/page';

// Supervisor-reported 292/292 PASS did NOT reproduce the earlier audit's F1.
// These are new definitions, NOT that result or a new execution claim. Do not
// change production or existing tests to satisfy the disproven prediction.
// The current tenant regex has no `m` flag. A multiline example below is only
// an explanatory contrast, never a replacement parser or a claimed capability.
// Real pages/readers/context/verifier; synthetic Next headers/navigation and
// throwing transport canaries, following page.test.tsx / historicalConflictLink
// fixture conventions. No DB, archive, signed session, SQL engine or live source
// is needed. Library route matching is NOT real HTTP/Next dispatch or a browser.
// Run serially only after team CLIs cease and safe execution is authorized.
const JOB = 'synthetic-slug-characterization-job';
const REPORT = `reconciliation:${'a'.repeat(64)}`; // Syntax only, not an existing report.
const CANARY = 'SYNTHETIC_SLUG_HEADER_CANARY';
const LF_SLUG = 'alpha\n';
const LINE_ENDINGS = ['\n', '\r', '\r\n', '\u2028', '\u2029'] as const;
const selectors = () => ({ jobId: JOB, reportId: REPORT });
const props = (slug: string) => ({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(selectors()) });
const tenant = { id: '10000000-0000-4000-8000-000000000001', slug: 'alpha',
  displayName: 'Synthetic slug fixture', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' } as const;
const directory = { findBySlug: vi.fn<(slug: string) => Promise<typeof tenant | null>>() };

function decodedSlug(page: 'status' | 'history', segment: string): string {
  const match = getRouteMatcher(getRouteRegex(`/c/[slug]/admin/migrations/${page}`));
  const result = match(`/c/${segment}/admin/migrations/${page}`);
  if (!result || typeof result.slug !== 'string') throw new Error('Synthetic route did not yield one slug');
  return result.slug;
}
function assertHistoryFailure(container: HTMLElement, title: string) {
  expect(screen.getByRole('status').textContent).toContain(title);
  for (const value of ['HISTORICAL_ONLY', 'NOT_EVALUATED', 'UNKNOWN', 'cutoverAllowed: false']) {
    expect(container.textContent).toContain(value);
  }
  for (const value of [JOB, REPORT, CANARY, tenant.id, tenant.displayName]) {
    expect(container.innerHTML).not.toContain(value);
  }
  expect(container.querySelectorAll('a, table, form, button, input, iframe, script')).toHaveLength(0);
}
function assertNoIdentityOrStorageAdmission() {
  expect(getProductionTenantAccessDependencies).not.toHaveBeenCalled();
  expect(getGoogleSessionFromRequest).not.toHaveBeenCalled();
  expect(boundary.forbidden).not.toHaveBeenCalled();
}

beforeAll(() => { expect(boundary.forbidden).not.toHaveBeenCalled(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', boundary.forbidden);
  // No Cookie or credentials: canonical controls reach real unauthenticated
  // handling; malformed slugs must be rejected BEFORE identity/DB admission.
  boundary.headers.mockReset().mockResolvedValue(new Headers({ 'x-tenant-id': CANARY, 'x-role': 'OWNER' }));
  directory.findBySlug.mockReset().mockResolvedValue(tenant);
});
afterEach(() => {
  cleanup();
  expect(boundary.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('actual tenantContext slug parsing without multiline mode', () => {
  it('distinguishes non-multiline end-of-input from a multiline prefix match for a literal LF', () => {
    expect(LF_SLUG.endsWith('\n')).toBe(true);
    expect(LF_SLUG.charCodeAt(LF_SLUG.length - 1)).toBe(0x0a);
    expect(LF_SLUG).not.toBe('alpha\\n');
    const withoutMultiline = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const withMultiline = /^[a-z0-9]+(?:-[a-z0-9]+)*$/m;
    expect(withoutMultiline.multiline).toBe(false);
    expect(withoutMultiline.test(LF_SLUG)).toBe(false);
    expect(withoutMultiline.exec(LF_SLUG)).toBeNull();
    expect(withMultiline.exec(LF_SLUG)?.[0]).toBe('alpha');
    expect(withMultiline.exec(LF_SLUG)?.[0]).not.toBe(LF_SLUG);
    // The real export, not the contrast regex, is the regression contract.
    expect(() => parseTenantSlug(LF_SLUG)).toThrow(TenantContextError);
    assertNoIdentityOrStorageAdmission();
  });

  it.each(LINE_ENDINGS)('rejects trailing %j with the real error and no directory lookup', async ending => {
    const slug = `alpha${ending}`;
    let error: unknown;
    try { parseTenantSlug(slug); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TenantContextError);
    expect(error).toMatchObject({ code: 'INVALID_TENANT_SLUG', status: 400 });
    await expect(resolveTenantContext(slug, directory)).rejects.toMatchObject({
      code: 'INVALID_TENANT_SLUG', status: 400,
    });
    expect(directory.findBySlug).not.toHaveBeenCalled();
    assertNoIdentityOrStorageAdmission();
  });

  it.each([
    { slug: 'alpha', needsRedirect: false },
    { slug: 'Alpha', needsRedirect: true },
  ])('retains the real canonicalization contract for $slug', async ({ slug, needsRedirect }) => {
    expect(parseTenantSlug(slug)).toEqual({ slug: 'alpha', needsRedirect });
    await expect(resolveTenantContext(slug, directory)).resolves.toEqual({ tenant, needsRedirect });
    expect(directory.findBySlug.mock.calls).toEqual([['alpha']]);
    assertNoIdentityOrStorageAdmission();
  });
});

describe('real status vs history rejection boundary (synthetic request context)', () => {
  it.each(['literal', 'Next-decoded'] as const)('status rejects %s trailing LF through its reader before identity/DB lookup', async representation => {
    const slug = representation === 'literal' ? LF_SLUG : decodedSlug('status', 'alpha%0A');
    expect(slug).toBe(LF_SLUG);
    await expect(StatusPage(props(slug))).rejects.toThrow('not-found');
    expect(boundary.headers).toHaveBeenCalledTimes(1);
    expect(readMigrationStatus).toHaveBeenCalledExactlyOnceWith(slug, expect.any(Request), JOB);
    const request = vi.mocked(readMigrationStatus).mock.calls[0][1];
    // The slug is passed separately; Request URL normalization cannot explain
    // this refusal or silently turn the supplied slug into canonical "alpha".
    expect(request.url).toBe('http://tenant.internal/migration-status');
    expect(request.headers.get('x-tenant-id')).toBe(CANARY);
    await expect(vi.mocked(readMigrationStatus).mock.results[0].value).resolves.toEqual({ kind: 'FORBIDDEN' });
    expect(boundary.notFound).toHaveBeenCalledTimes(1);
    expect(boundary.redirect).not.toHaveBeenCalled();
    expect(readPreflightReport).not.toHaveBeenCalled();
    assertNoIdentityOrStorageAdmission();
  });

  it.each(['literal', 'Next-decoded'] as const)('history rejects %s trailing LF at its page exact-match gate without headers/reader', async representation => {
    const slug = representation === 'literal' ? LF_SLUG : decodedSlug('history', 'alpha%0A');
    expect(slug).toBe(LF_SLUG);
    const { container } = render(await HistoryPage(props(slug)));
    assertHistoryFailure(container, '잘못된 보고서 선택');
    expect(boundary.headers).not.toHaveBeenCalled();
    expect(readPreflightReport).not.toHaveBeenCalled();
    expect(readMigrationStatus).not.toHaveBeenCalled();
    expect(boundary.notFound).not.toHaveBeenCalled();
    expect(boundary.redirect).not.toHaveBeenCalled();
    assertNoIdentityOrStorageAdmission();
  });

  it('does not treat shared lowercase normalization as permission to redirect or admit uppercase page slugs', async () => {
    expect(parseTenantSlug('Alpha')).toEqual({ slug: 'alpha', needsRedirect: true });
    await expect(StatusPage(props('Alpha'))).rejects.toThrow('not-found');
    await expect(vi.mocked(readMigrationStatus).mock.results[0].value).resolves.toEqual({ kind: 'FORBIDDEN' });
    const headerReads = boundary.headers.mock.calls.length;
    const { container } = render(await HistoryPage(props('Alpha')));
    assertHistoryFailure(container, '잘못된 보고서 선택');
    expect(boundary.headers).toHaveBeenCalledTimes(headerReads);
    expect(readPreflightReport).not.toHaveBeenCalled();
    expect(boundary.redirect).not.toHaveBeenCalled();
    assertNoIdentityOrStorageAdmission();
  });

  it('canonical status is a distinct unauthenticated control, not the malformed-slug notFound path', async () => {
    const slug = decodedSlug('status', 'alpha');
    expect(slug).toBe('alpha');
    await expect(StatusPage(props(slug))).rejects.toThrow('redirect:/c/alpha/admin/login');
    expect(getProductionTenantAccessDependencies).toHaveBeenCalledTimes(1);
    expect(readMigrationStatus).toHaveBeenCalledExactlyOnceWith('alpha', expect.any(Request), JOB);
    const request = vi.mocked(readMigrationStatus).mock.calls[0][1];
    expect(request.headers.get('cookie')).toBeNull();
    expect(getGoogleSessionFromRequest).toHaveBeenCalledExactlyOnceWith(request);
    expect(vi.mocked(getGoogleSessionFromRequest).mock.results[0].value).toBeNull();
    await expect(vi.mocked(readMigrationStatus).mock.results[0].value).resolves.toEqual({ kind: 'UNAUTHENTICATED' });
    expect(boundary.redirect).toHaveBeenCalledExactlyOnceWith('/c/alpha/admin/login');
    expect(boundary.notFound).not.toHaveBeenCalled();
    expect(readPreflightReport).not.toHaveBeenCalled();
  });

  it('canonical history reaches its real no-Cookie reader guard, unlike page-level exact-match refusal', async () => {
    const slug = decodedSlug('history', 'alpha');
    expect(slug).toBe('alpha');
    const { container } = render(await HistoryPage(props(slug)));
    assertHistoryFailure(container, '로그인 필요');
    expect(boundary.headers).toHaveBeenCalledTimes(1);
    expect(readPreflightReport).toHaveBeenCalledExactlyOnceWith('alpha', expect.any(Request));
    const request = vi.mocked(readPreflightReport).mock.calls[0][1];
    const expectedQuery = new URLSearchParams(selectors()).toString();
    expect(request.url).toBe(`http://tenant.internal/api/migrations/status/alpha/preflight?${expectedQuery}`);
    expect(request.method).toBe('GET');
    expect(request.cache).toBe('no-store');
    expect([...request.headers.entries()]).toEqual([]);
    await expect(vi.mocked(readPreflightReport).mock.results[0].value).resolves.toEqual({ kind: 'UNAUTHENTICATED' });
    expect(readMigrationStatus).not.toHaveBeenCalled();
    expect(boundary.notFound).not.toHaveBeenCalled();
    expect(boundary.redirect).not.toHaveBeenCalled();
    // The archive reader's unambiguous-Cookie guard precedes the verifier.
    assertNoIdentityOrStorageAdmission();
  });
});
