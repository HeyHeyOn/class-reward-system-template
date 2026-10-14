import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { QueryConfig } from 'pg';
import { cleanup, render, screen, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  headers: vi.fn(), connect: vi.fn(), query: vi.fn(), release: vi.fn(),
  fetch: vi.fn(), log: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ headers: boundary.headers }));
vi.mock('pg', async importOriginal => ({ ...await importOriginal<typeof import('pg')>(),
  Pool: class { connect = boundary.connect; on() {} },
}));
// Call through: the page, reader, Google verifier, tenant authorization and
// archive projection are real. Only the socket/HTTP request boundaries are fake.
vi.mock('@/app/api/migrations/status/readPreflightReport', { spy: true });

import { readPreflightReport } from '@/app/api/migrations/status/readPreflightReport';
import type { PreflightReportProjection } from '@/app/api/migrations/status/preflightReportProjection';
import { GET as downloadGET, HEAD as downloadHEAD } from '@/app/api/migrations/status/[slug]/preflight/download/route';
import HistoryPage, { dynamic, metadata, runtime } from './page';

type Query = Record<string, string | string[] | undefined>;
type Report = PreflightReportProjection['report'];
const TENANT = '10000000-0000-4000-8000-000000000001';
const FOREIGN = '20000000-0000-4000-8000-000000000002';
const MEMBER = '30000000-0000-4000-8000-000000000003';
const USER = '40000000-0000-4000-8000-000000000004';
const JOB = 'archive/job +%26?#';
const SUBJECT = 'synthetic-history-admin';
const SECRET = 'synthetic-history-session-secret-not-a-real-credential';
const PRIVATE = 'PRIVATE_HISTORY_CANARY_student-password-token-sheet-url';
const ROW_HASH = 'e'.repeat(64);
const LARGE = '999999999999999999999999999999';
const DOWNLOAD_LABEL = '과거 보고서 JSON 다운로드';
const ORIGIN = 'https://history.example.invalid';
const CATEGORIES: Report['metrics'][number]['category'][] = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES',
  'ORPHANED_CLAIMS', 'RECURRENCE',
];
function blockedReport(): Report {
  return {
    reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED',
    metrics: [
      { category: 'BALANCES', expected: '-9007199254740993', actual: '0', delta: '9007199254740993', status: 'MISMATCH' },
      { category: 'TRANSACTION_AMOUNT', expected: LARGE, actual: '0', delta: `-${LARGE}`, status: 'MISMATCH' },
    ],
    diagnostics: [{ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: ROW_HASH }],
    omittedDiagnostics: 0,
  };
}
function archived(report = blockedReport(), jobId = JOB, tenantId = TENANT) {
  const details = {
    report: { ...report, authority: 'SHEETS_AND_REDIS', cutoverAllowed: false },
    comparisonInstant: '2026-09-25T00:00:00.000Z' as string | null,
    manifestDigest: 'a'.repeat(64), currentManifestDigest: 'a'.repeat(64) as string | null,
    sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE',
  };
  return {
    tenant_id: tenantId, job_id: jobId,
    event_id: reportId(tenantId, jobId, details),
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details,
  };
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
}
function reportId(tenant: string, job: string, details: unknown) {
  return `reconciliation:${createHash('sha256').update(canonical([tenant, job, details])).digest('hex')}`;
}
// Encrypt synthetic cookies with the application's format; no credentials or
// real Google/DB/source/service calls. Expiry and integrity are verified for real.
function cookie(options: { expired?: boolean; subject?: string } = {}) {
  const nonce = Buffer.alloc(12, 3);
  const key = createHash('sha256').update(SECRET).digest();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const payload = Buffer.from(JSON.stringify({
    subject: options.subject ?? SUBJECT, email: `${PRIVATE}@example.invalid`, name: PRIVATE,
    issuedAt: options.expired ? 1 : Date.now(),
  }));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return `class_store_google_auth=v2.${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
let event: ReturnType<typeof archived>;
let selectedTenant: string;
let selectedSlug: string;
let member: Record<string, string> | null;
let finalMember: Record<string, string> | null;
let foundJob: boolean;
let foundEvent: boolean;
let requestHeaders: Headers;
const reply = (rows: Record<string, unknown>[], fields: [string, number][]) => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const reportCalls = () => boundary.query.mock.calls.filter(([config]) => config.text.includes('public.audit_events'));

function selectors(): Query { return { jobId: event.job_id, reportId: event.event_id }; }
function invariant(html: string) {
  for (const value of ['HISTORICAL_ONLY', 'NOT_EVALUATED', 'UNKNOWN', 'cutoverAllowed: false']) {
    expect(html).toContain(value);
  }
  for (const value of [PRIVATE, SECRET, SUBJECT, TENANT, FOREIGN, 'google_auth=', 'source_descriptor', 'raw_data',
    'SHEETS_AND_REDIS', 'CURRENT_PREFLIGHT', 'NOT_PERSISTED']) expect(html).not.toContain(value);
  expect(html).not.toMatch(/<(?:form|input|button|select|textarea|script|iframe|img|link)\b/i);
  expect(html).not.toContain('dangerouslySetInnerHTML');
  // Narrow the old all-anchor ban to one inert, fixed-route attachment link.
  // Encoded opaque selectors can contain words like "onerror", but not DOM handlers.
  const template = document.createElement('template');
  template.innerHTML = html;
  const links = template.content.querySelectorAll('a');
  expect(links.length).toBeLessThanOrEqual(1);
  for (const element of template.content.querySelectorAll('*')) {
    expect(element.getAttributeNames().some(name => /^on/i.test(name))).toBe(false);
  }
  for (const link of links) {
    const href = link.getAttribute('href')!;
    const url = new URL(href, ORIGIN);
    expect(href.startsWith('/api/migrations/status/')).toBe(true);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toMatch(/^\/api\/migrations\/status\/[a-z0-9]+(?:-[a-z0-9]+)*\/preflight\/download$/);
    expect(url.hash).toBe('');
    expect([...url.searchParams.keys()]).toEqual(['jobId', 'reportId']);
    expect(link.textContent).toBe(DOWNLOAD_LABEL);
    expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(link.getAttributeNames().sort()).toEqual(['class', 'href', 'referrerpolicy']);
  }
}
function expectDownloadLink(jobId = event.job_id, selectedReportId = event.event_id, slug = 'alpha') {
  expect(screen.getAllByRole('link')).toHaveLength(1);
  const link = screen.getByRole('link', { name: DOWNLOAD_LABEL });
  const href = link.getAttribute('href')!;
  expect(href).toBe(`/api/migrations/status/${slug}/preflight/download?${new URLSearchParams({ jobId, reportId: selectedReportId })}`);
  const url = new URL(href, ORIGIN);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(`/api/migrations/status/${slug}/preflight/download`);
  expect(url.hash).toBe('');
  expect([...url.searchParams.entries()]).toEqual([['jobId', jobId], ['reportId', selectedReportId]]);
  expect(link.textContent).not.toContain(jobId);
  expect(link.textContent).not.toContain(selectedReportId);
  return href;
}
function expectPrivateResponse(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('vary')).toBe('Cookie');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  for (const name of ['etag', 'last-modified', 'content-range', 'location', 'set-cookie']) {
    expect(response.headers.has(name)).toBe(false);
  }
  const headers = JSON.stringify([...response.headers]);
  for (const secret of [PRIVATE, SECRET, SUBJECT, TENANT, FOREIGN, 'google_auth=']) expect(headers).not.toContain(secret);
}
async function expectDownloadRefused(response: Response, status: number, error: string, head = false) {
  expect(response.status).toBe(status);
  expectPrivateResponse(response);
  expect(response.headers.has('content-disposition')).toBe(false);
  expect(await response.text()).toBe(head ? '' : JSON.stringify({ error }));
}
async function view(query: Query | undefined = selectors(), slug = 'alpha') {
  const element = await HistoryPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query ?? {}) });
  const html = renderToStaticMarkup(element);
  invariant(html);
  return { html, ...render(element) };
}
function expectRefused(title: string) {
  expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  expect(screen.queryByRole('table')).toBeNull();
  expect(document.querySelector('a')).toBeNull();
  expect(document.body.textContent).not.toContain(event.event_id);
  expect(document.body.textContent).not.toContain(event.job_id);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('DATABASE_URL', 'postgresql://synthetic:synthetic@invalid.invalid/history_unit_only');
  vi.stubEnv('DIRECT_DATABASE_URL', '');
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
  vi.stubEnv('ADMIN_PASSWORD', '');
  vi.stubGlobal('fetch', boundary.fetch);
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(boundary.log);
  boundary.fetch.mockImplementation(() => { throw new Error(`unexpected source/network ${PRIVATE}`); });
  event = archived();
  selectedTenant = TENANT;
  selectedSlug = 'alpha';
  member = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
  finalMember = member;
  foundJob = true;
  foundEvent = true;
  requestHeaders = new Headers({ cookie: cookie() });
  boundary.headers.mockImplementation(async () => requestHeaders);
  boundary.connect.mockResolvedValue(Object.assign(new EventEmitter(), {
    query: boundary.query, release: boundary.release, end: vi.fn(async () => {}),
  }));
  boundary.query.mockImplementation(async ({ text, values }: QueryConfig) => {
    if (text.includes('public.audit_events')) {
      const authorized = finalMember && finalMember.tenant_id === selectedTenant
        && finalMember.google_subject === SUBJECT && ['OWNER', 'ADMIN'].includes(finalMember.role)
        && finalMember.id === values![3] && finalMember.user_id === values![4] && selectedSlug === values![5];
      return reply(!authorized ? [] : [{ found: foundJob && foundEvent, oversized: false,
        envelope_text: foundJob && foundEvent ? JSON.stringify(event) : null }], REPORT_FIELDS);
    }
    if (text.includes('public.platform_find_tenant')) return reply([{ id: selectedTenant, slug: selectedSlug,
      display_name: PRIVATE, lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' }], TENANT_FIELDS);
    if (text.includes('public.platform_find_membership')) return reply(member ? [member] : [], MEMBER_FIELDS);
    if (text === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' || text === 'ROLLBACK'
      || text.startsWith('SET LOCAL') || text.includes('set_config')) return reply([], []);
    throw new Error(`unexpected query ${PRIVATE}`);
  });
});
afterEach(() => {
  cleanup();
  expect(boundary.fetch).not.toHaveBeenCalled();
  expect(boundary.log).not.toHaveBeenCalled();
  // Read-only transaction setup is allowed; DML/DDL, writers and producers are not.
  for (const [query] of boundary.query.mock.calls) {
    expect(query.text).toMatch(/^(?:BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |SELECT |ROLLBACK$)/);
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('standalone historical page through the real read/auth/projection boundary (synthetic DB)', () => {
  it.each(['OWNER', 'ADMIN'])('renders only archived aggregates for current %s membership', async role => {
    member!.role = role;
    const { container } = await view();
    expect(screen.getByRole('heading', { name: '과거 사전검사 보고서 — 현재 상태/전환 승인 아님' })).toBeTruthy();
    const table = screen.getByRole('table', { name: '과거 비교 지표' });
    expect(within(table).getByText('-9007199254740993').textContent).toBe('-9007199254740993');
    expect(within(table).getByText(LARGE).textContent).toBe(LARGE);
    expect(within(table).getByText(`-${LARGE}`).textContent).toBe(`-${LARGE}`);
    expect(container.textContent).toContain('ROW_MISMATCH');
    expect(container.textContent).toContain(ROW_HASH);
    expect(container.textContent).toContain('생략된 과거 진단 수: 0');
    expect(container.textContent).toContain('2026-09-25T00:00:00.000Z');
    expect(container.textContent).toContain('BLOCKED');
    expect(container.textContent).not.toMatch(/(?:NOT_PERSISTED|CURRENT_PREFLIGHT|ACTIVE)/);
    expectDownloadLink();
    expect(container.textContent).toContain('원본 조회, 사전검사 실행, 동결, 전환, 재개, 재시도를 실행하지 않아요.');
    expect(container.textContent).toContain('다운로드 요청 시 로그인과 접근 권한을 다시 확인해요.');
    expect(container.textContent).not.toContain('보고서 다운로드를 실행하지 않아요.');
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    const [slug, request] = vi.mocked(readPreflightReport).mock.calls[0];
    expect(slug).toBe('alpha');
    expect(request.method).toBe('GET');
    expect(request.cache).toBe('no-store');
    expect(request.url).toBe(`http://tenant.internal/api/migrations/status/alpha/preflight?${new URLSearchParams(selectors() as Record<string, string>)}`);
    expect([...request.headers.entries()]).toEqual([['cookie', requestHeaders.get('cookie')]]);
    expect(boundary.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY' }));
    expect(boundary.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'ROLLBACK' }));
    expect(reportCalls()).toHaveLength(1);
    expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'compatibility-only', 'malformed', 'expired', 'tampered', 'duplicate'])('refuses %s sessions', async kind => {
    const valid = cookie();
    const cookies: Record<string, string> = {
      missing: '', 'compatibility-only': 'class_store_tenant_admin=synthetic',
      malformed: 'class_store_google_auth=invalid', expired: cookie({ expired: true }),
      tampered: valid.replace('=v2.', '=v2.x'), duplicate: `${valid}; ${valid}`,
    };
    requestHeaders = new Headers({ cookie: cookies[kind] });
    await view();
    expectRefused('로그인 필요');
    expect(boundary.connect).not.toHaveBeenCalled();
  });

  it.each(['nonmember', 'foreign-tenant', 'foreign-subject', 'unsupported-role'])('refuses %s membership', async kind => {
    if (kind === 'nonmember') member = null;
    if (kind === 'foreign-tenant') member!.tenant_id = FOREIGN;
    if (kind === 'foreign-subject') member!.google_subject = 'different-subject';
    if (kind === 'unsupported-role') member!.role = 'STUDENT';
    await view();
    expectRefused('접근할 수 없음');
    expect(reportCalls()).toHaveLength(0);
    expect(boundary.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'ROLLBACK' }));
  });

  it('rejects a valid foreign path even with a spoofed tenant header', async () => {
    selectedSlug = 'beta';
    selectedTenant = FOREIGN;
    requestHeaders.set('x-tenant-id', TENANT);
    await view(selectors(), 'beta');
    expectRefused('접근할 수 없음');
    expect(boundary.query).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('public.platform_find_membership'), values: [FOREIGN, SUBJECT],
    }));
    expect(reportCalls()).toHaveLength(0);
  });

  it.each(['revoked', 'tenant', 'subject', 'role', 'id', 'user', 'slug'])('rechecks membership before projecting: %s', async kind => {
    finalMember = kind === 'revoked' ? null : { ...member! };
    if (kind === 'tenant') finalMember!.tenant_id = FOREIGN;
    if (kind === 'subject') finalMember!.google_subject = 'other';
    if (kind === 'role') finalMember!.role = 'STUDENT';
    if (kind === 'id') finalMember!.id = FOREIGN;
    if (kind === 'user') finalMember!.user_id = FOREIGN;
    if (kind === 'slug') {
      const query = boundary.query.getMockImplementation()!;
      boundary.query.mockImplementation(async config => {
        if (config.text.includes('public.audit_events')) selectedSlug = 'beta';
        return query(config);
      });
    }
    await view();
    expectRefused('접근할 수 없음');
    expect(boundary.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'ROLLBACK' }));
  });

  it('does not reuse the authorized result after logout or membership revocation', async () => {
    await view();
    cleanup();
    requestHeaders.delete('cookie');
    await view();
    expectRefused('로그인 필요');
    cleanup();
    requestHeaders.set('cookie', cookie());
    member = null;
    await view();
    expectRefused('접근할 수 없음');
    expect(readPreflightReport).toHaveBeenCalledTimes(3);
    expect(boundary.connect).toHaveBeenCalledTimes(2);
  });

  it.each(['job', 'report'])('uses the same safe not-found view for %s', async kind => {
    if (kind === 'job') foundJob = false;
    if (kind === 'report') foundEvent = false;
    await view();
    expectRefused('보고서를 찾을 수 없음');
  });

  it.each(['job', 'digest', 'tenant', 'private-details'])('does not display malformed/misbound archive data: %s', async kind => {
    const query = selectors();
    if (kind === 'job') event.job_id = 'foreign-job';
    if (kind === 'digest') event.event_id = `reconciliation:${'f'.repeat(64)}`;
    if (kind === 'tenant') event.tenant_id = FOREIGN;
    if (kind === 'private-details') event.redacted_details = { ...event.redacted_details, password: PRIVATE } as typeof event.redacted_details;
    await view(query);
    expectRefused('보고서 확인 불가');
  });

  it('shows MATCHED_PREFLIGHT as history, never as current approval', async () => {
    event = archived({ reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT',
      metrics: CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
      diagnostics: [], omittedDiagnostics: 0 });
    const { container } = await view();
    expect(container.textContent).toContain('MATCHED_PREFLIGHT');
    expect(container.textContent).toContain('현재 사전검사 통과나 전환, 쓰기 권한을 뜻하지 않아요.');
    expect(container.textContent).toContain('보관된 진단 항목이 없어요. 현재 검사 결과를 뜻하지 않아요.');
    expect(within(screen.getByRole('table', { name: '과거 비교 지표' })).getAllByRole('row')).toHaveLength(CATEGORIES.length + 1);
    expect(container.textContent).not.toContain('ACTIVE');
    const disclosure = container.querySelector('details')!;
    expect(disclosure.querySelector('summary')!.textContent).toBe('과거 스냅샷 식별 정보 확인 (읽기 전용)');
    expect(disclosure.textContent).toContain('INTEGRITY_ONLY');
    expect(disclosure.textContent).toContain('BOUND_SNAPSHOT_NOT_LIVE_FREEZE');
    expect(disclosure.textContent).toContain('보관된 비교 매니페스트 해시 (현재 조회 아님)');
    expect(disclosure.textContent).toContain(event.event_id);
    expectDownloadLink();
  });

  it.each(['different', 'missing'])('preserves the archived comparison digest without substituting a current snapshot: %s', async kind => {
    event.redacted_details.currentManifestDigest = kind === 'missing' ? null : 'c'.repeat(64);
    event.redacted_details.report.diagnostics = [...event.redacted_details.report.diagnostics,
      { category: 'INTEGRITY', code: kind === 'missing' ? 'INVALID_CURRENT_MANIFEST' : 'SOURCE_MUTATION' }];
    event.event_id = reportId(TENANT, JOB, event.redacted_details);
    const { container } = await view();
    const disclosure = container.querySelector('details')!;
    expect(disclosure).not.toBeNull();
    const fields = Object.fromEntries([...disclosure.querySelectorAll('dt')]
      .map(dt => [dt.textContent, dt.nextElementSibling!.textContent]));
    expect(fields['보관된 원본 매니페스트 해시']).toBe('a'.repeat(64));
    expect(fields['보관된 비교 매니페스트 해시 (현재 조회 아님)']).toBe(
      kind === 'missing' ? '보관된 비교 매니페스트 해시 없음' : 'c'.repeat(64));
    expect(disclosure.hasAttribute('open')).toBe(false);
    expect(reportCalls()).toHaveLength(1);
    expectDownloadLink();
  });

  it('displays empty metrics and a missing comparison clock without manufacturing a result', async () => {
    event = archived({ reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED', metrics: [],
      diagnostics: [{ category: 'INTEGRITY', code: 'INVALID_COMPARISON_INSTANT' }], omittedDiagnostics: 0 });
    event.redacted_details.comparisonInstant = null;
    event.event_id = reportId(TENANT, JOB, event.redacted_details);
    const { container } = await view();
    expect(container.textContent).toContain('보관된 비교 지표가 없어요. 현재 비교 결과가 아니에요.');
    expect(container.textContent).toContain('보관된 비교 시각 없음');
    expect(container.textContent).toContain('생략된 과거 진단 수: 0');
    expect(screen.queryByRole('table', { name: '과거 비교 지표' })).toBeNull();
  });

  it('renders bounded diagnostics with and without opaque row references, preserving duplicates', async () => {
    event = archived({ ...blockedReport(), diagnostics: [
      { category: 'SOURCES', code: 'UNSUPPORTED_HISTORY' },
      { category: 'SOURCES', code: 'UNSUPPORTED_HISTORY' },
      { category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: ROW_HASH },
    ] });
    await view();
    const table = screen.getByRole('table', { name: '과거 진단' });
    expect(within(table).getAllByText('UNSUPPORTED_HISTORY')).toHaveLength(2);
    expect(within(table).getAllByText('보관된 참조 없음')).toHaveLength(2);
    expect(within(table).getByText(ROW_HASH)).toBeTruthy();
  });

  it('shows the archived omitted count without inventing the omitted diagnostics', async () => {
    event = archived({ ...blockedReport(), diagnostics: Array.from({ length: 100 }, () => ({
      category: 'SOURCES', code: 'UNSUPPORTED_HISTORY',
    })), omittedDiagnostics: 11 });
    const { container } = await view();
    expect(container.textContent).toContain('생략된 과거 진단 수: 11');
    expect(within(screen.getByRole('table', { name: '과거 진단' })).getAllByRole('row')).toHaveLength(101);
    expect(screen.getAllByText('UNSUPPORTED_HISTORY')).toHaveLength(100);
  });

  it('escapes literal selectors and forwards cookie only, ignoring spoofed host/authority headers', async () => {
    event = archived(blockedReport(), `<img src=x onerror=alert(1)> +/%2F?#&=한글`);
    requestHeaders.set('host', 'attacker.invalid');
    requestHeaders.set('x-forwarded-host', 'attacker.invalid');
    requestHeaders.set('x-tenant-id', FOREIGN);
    requestHeaders.set('authorization', PRIVATE);
    requestHeaders.set('origin', 'https://attacker.invalid');
    requestHeaders.set('x-forwarded-proto', 'http');
    const { html, container } = await view();
    expect(container.querySelector('img, script, iframe, [onerror], [onclick]')).toBeNull();
    expect(new URL(expectDownloadLink(), ORIGIN).searchParams.get('jobId')).toBe(event.job_id);
    expect(html).not.toContain('attacker.invalid');
    const [, request] = vi.mocked(readPreflightReport).mock.calls[0];
    expect(new URL(request.url).searchParams.get('jobId')).toBe(event.job_id);
    expect([...request.headers.keys()]).toEqual(['cookie']);
    expect(new URL(request.url).host).toBe('tenant.internal');
  });

  it.each(['a+b', 'a%2Fb', 'a/b?x=y#frag', 'a&reportId=other job', '한글-한', 'https://attacker.invalid/a',
    '//attacker.invalid', 'javascript:alert(1)', 'j'.repeat(1024)])('preserves an opaque job selector exactly: %s', async job => {
    event = archived(blockedReport(), job);
    await view();
    expect(screen.getByRole('table', { name: '과거 비교 지표' })).toBeTruthy();
    expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, job, MEMBER, USER, 'alpha', event.event_id]);
    expectDownloadLink();
  });
});

// This bridge invokes existing handlers in-process, not browser navigation,
// actual Next HTTP, or a PostgreSQL connection/revocation lease.
describe('historical anchor to the existing attachment route (real reader, fake transport)', () => {
  it.each(['OWNER', 'ADMIN'])('reauthorizes the exact rendered selection for %s without a second display read', async role => {
    member!.role = role;
    await view();
    const href = expectDownloadLink();
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    const displayed = await vi.mocked(readPreflightReport).mock.results[0].value;
    if (displayed.kind !== 'HISTORICAL_REPORT') throw new Error('fixture did not project');
    const request = new Request(new URL(href, ORIGIN), { headers: requestHeaders });
    const response = await downloadGET(request, { params: Promise.resolve({ slug: 'alpha' }) });
    expect(response.status).toBe(200);
    expectPrivateResponse(response);
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="historical-preflight-${event.event_id.slice('reconciliation:'.length)}.json"`);
    const body = await response.text();
    expect(body).toBe(`${JSON.stringify(displayed.projection)}\n`);
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(65_536);
    for (const secret of [PRIVATE, SECRET, SUBJECT, TENANT, FOREIGN, JOB, 'google_auth=', 'raw_data', 'source_descriptor']) {
      expect(body).not.toContain(secret);
    }
    expect(readPreflightReport).toHaveBeenCalledTimes(2);
    expect(readPreflightReport).toHaveBeenLastCalledWith('alpha', request);
    expect(reportCalls()).toHaveLength(2);
    expect(boundary.connect).toHaveBeenCalledTimes(2);
    expect(boundary.release).toHaveBeenCalledTimes(2);
  });

  it.each(['missing', 'expired', 'tampered', 'duplicate'])('refuses an old anchor with a %s cookie on GET and HEAD', async kind => {
    await view();
    const href = expectDownloadLink();
    const valid = cookie();
    const changed: Record<string, string> = { missing: '', expired: cookie({ expired: true }),
      tampered: valid.replace('=v2.', '=v2.x'), duplicate: `${valid}; ${valid}` };
    for (const method of ['GET', 'HEAD'] as const) {
      const request = new Request(new URL(href, ORIGIN), { method, headers: { cookie: changed[kind] } });
      const response = await (method === 'GET' ? downloadGET : downloadHEAD)(request, { params: Promise.resolve({ slug: 'alpha' }) });
      await expectDownloadRefused(response, 401, 'AUTHENTICATION_REQUIRED', method === 'HEAD');
    }
    expect(readPreflightReport).toHaveBeenCalledTimes(3);
    expect(boundary.connect).toHaveBeenCalledTimes(1);
    expect(reportCalls()).toHaveLength(1);
    cleanup();
    requestHeaders.set('cookie', changed[kind]);
    await view();
    expectRefused('로그인 필요');
    expect(readPreflightReport).toHaveBeenCalledTimes(4);
    expect(boundary.connect).toHaveBeenCalledTimes(1);
  });

  it.each(['removed', 'downgraded', 'replaced', 'final-id', 'final-user'])('refuses an old anchor after %s membership', async kind => {
    await view();
    const href = expectDownloadLink();
    if (kind === 'removed') member = finalMember = null;
    if (kind === 'downgraded') member!.role = 'STUDENT';
    if (kind === 'replaced') member!.google_subject = 'another-subject';
    if (kind === 'final-id') finalMember = { ...member!, id: FOREIGN };
    if (kind === 'final-user') finalMember = { ...member!, user_id: FOREIGN };
    for (const method of ['GET', 'HEAD'] as const) {
      const request = new Request(new URL(href, ORIGIN), { method, headers: requestHeaders });
      const response = await (method === 'GET' ? downloadGET : downloadHEAD)(request, { params: Promise.resolve({ slug: 'alpha' }) });
      await expectDownloadRefused(response, 403, 'ACCESS_DENIED', method === 'HEAD');
    }
    expect(readPreflightReport).toHaveBeenCalledTimes(3);
    expect(boundary.connect).toHaveBeenCalledTimes(3);
    expect(boundary.release).toHaveBeenCalledTimes(3);
    cleanup();
    await view();
    expectRefused('접근할 수 없음');
    expect(readPreflightReport).toHaveBeenCalledTimes(4);
    expect(boundary.release).toHaveBeenCalledTimes(4);
  });

  it.each(['foreign-same-job', 'other-job', 'event-type', 'missing-job', 'missing-event', 'corrupt-digest'])('has no link or direct attachment for %s', async kind => {
    // Deliberately return a found but malformed envelope for the first three
    // faults (503); the existing SQL suite proves filtered foreign rows are 404.
    const query = selectors() as { jobId: string; reportId: string };
    if (kind === 'foreign-same-job') event = archived(blockedReport(), JOB, FOREIGN);
    if (kind === 'other-job') event = archived(blockedReport(), 'another-job');
    if (kind === 'event-type') event.event_type = 'MIGRATION_FREEZING_CANDIDATE';
    if (kind === 'missing-job') foundJob = false;
    if (kind === 'missing-event') foundEvent = false;
    if (kind === 'corrupt-digest') event.redacted_details.sourceFingerprint = 'c'.repeat(64);
    const missing = kind === 'missing-job' || kind === 'missing-event';
    await view(query);
    expectRefused(missing ? '보고서를 찾을 수 없음' : '보고서 확인 불가');
    const request = new Request(`${ORIGIN}/api/migrations/status/alpha/preflight/download?${new URLSearchParams(query)}`, { headers: requestHeaders });
    const response = await downloadGET(request, { params: Promise.resolve({ slug: 'alpha' }) });
    await expectDownloadRefused(response, missing ? 404 : 503, missing ? 'PREFLIGHT_REPORT_NOT_FOUND' : 'PREFLIGHT_REPORT_UNAVAILABLE');
    expect(readPreflightReport).toHaveBeenCalledTimes(2);
    expect(reportCalls()).toHaveLength(2);
  });

  it.each(['tenant', 'job', 'report'])('does not retain the old link when a subsequent %s selection fails', async kind => {
    await view();
    const href = expectDownloadLink();
    cleanup();
    const query = selectors();
    if (kind === 'tenant') { selectedSlug = 'beta'; selectedTenant = FOREIGN; }
    if (kind === 'job') { query.jobId = 'missing-job'; foundJob = false; }
    if (kind === 'report') { query.reportId = `reconciliation:${'f'.repeat(64)}`; foundEvent = false; }
    const { html } = await view(query, kind === 'tenant' ? 'beta' : 'alpha');
    expectRefused(kind === 'tenant' ? '접근할 수 없음' : '보고서를 찾을 수 없음');
    expect(html).not.toContain(href);
    expect(readPreflightReport).toHaveBeenCalledTimes(2);
  });

  it('uses the admitted primitive selection even when props mutate while awaiting headers', async () => {
    const query = selectors();
    const params = { slug: 'alpha' };
    boundary.headers.mockImplementationOnce(async () => {
      params.slug = 'beta';
      query.jobId = 'different-job';
      query.reportId = `reconciliation:${'f'.repeat(64)}`;
      return requestHeaders;
    });
    const element = await HistoryPage({ params: Promise.resolve(params), searchParams: Promise.resolve(query) });
    invariant(renderToStaticMarkup(element));
    render(element);
    expectDownloadLink();
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
  });

  it('does not reread params or searchParams to build a link', async () => {
    const params = vi.fn(resolve => resolve({ slug: 'alpha' }));
    const query = vi.fn(resolve => resolve(selectors()));
    const element = await HistoryPage({
      params: { then: params } as unknown as Promise<{ slug: string }>,
      searchParams: { then: query } as unknown as Promise<Query>,
    });
    invariant(renderToStaticMarkup(element));
    render(element);
    expectDownloadLink();
    expect(params).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
  });

  it('validates and uses each selector property once rather than rereading mutable getters', async () => {
    const jobId = vi.fn().mockReturnValueOnce(JOB).mockReturnValue('different-job');
    const reportId = vi.fn().mockReturnValueOnce(event.event_id).mockReturnValue(`reconciliation:${'f'.repeat(64)}`);
    const query = Object.defineProperties({}, {
      jobId: { enumerable: true, get: jobId }, reportId: { enumerable: true, get: reportId },
    });
    await view(query);
    expectDownloadLink();
    expect(jobId).toHaveBeenCalledTimes(1);
    expect(reportId).toHaveBeenCalledTimes(1);
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, 'alpha', event.event_id]);
  });

  it.each(['alpha-room-1', 'a'.repeat(63)])('uses the admitted canonical slug %s, not a hardcoded tenant', async slug => {
    selectedSlug = slug;
    await view(selectors(), slug);
    expectDownloadLink(event.job_id, event.event_id, slug);
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    expect(reportCalls()[0][0].values).toEqual([TENANT, SUBJECT, JOB, MEMBER, USER, slug, event.event_id]);
  });

  it('does not authorize another tenant by replaying an old href with the same job ID', async () => {
    await view();
    const href = expectDownloadLink();
    selectedTenant = FOREIGN;
    selectedSlug = 'beta';
    const foreignHref = href.replace('/alpha/', '/beta/');
    const request = new Request(new URL(foreignHref, ORIGIN), { headers: requestHeaders });
    const response = await downloadGET(request, { params: Promise.resolve({ slug: 'beta' }) });
    await expectDownloadRefused(response, 403, 'ACCESS_DENIED');
    expect(readPreflightReport).toHaveBeenCalledTimes(2);
    expect(reportCalls()).toHaveLength(1);
    expect(boundary.release).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a mismatched projected report ID, even after a genuine authenticated read', async () => {
    await view();
    const result = await vi.mocked(readPreflightReport).mock.results[0].value;
    if (result.kind !== 'HISTORICAL_REPORT') throw new Error('fixture did not project');
    cleanup();
    vi.mocked(readPreflightReport).mockResolvedValueOnce({ ...result,
      projection: { ...result.projection, reportId: `reconciliation:${'f'.repeat(64)}` } });
    await view();
    expectRefused('보고서 확인 불가');
    expect(readPreflightReport).toHaveBeenCalledTimes(2);
  });

  it.each(['unknown-kind', 'missing-projection', 'missing-report-id'])('withholds a link for a malformed reader contract: %s', async kind => {
    await view();
    const result = await vi.mocked(readPreflightReport).mock.results[0].value;
    if (result.kind !== 'HISTORICAL_REPORT') throw new Error('fixture did not project');
    cleanup();
    const malformed = kind === 'unknown-kind' ? { ...result, kind: 'FUTURE_RESULT', privateData: PRIVATE }
      : kind === 'missing-projection' ? { kind: result.kind }
        : { ...result, projection: { ...result.projection, reportId: undefined } };
    vi.mocked(readPreflightReport).mockResolvedValueOnce(malformed as unknown as typeof result);
    await view();
    expectRefused('보고서 확인 불가');
    expect(readPreflightReport).toHaveBeenCalledTimes(2);
  });

  it('fails closed if the href builder throws after successful reader cleanup', async () => {
    const build = vi.fn();
    boundary.release.mockImplementationOnce(() => {
      vi.stubGlobal('URLSearchParams', class {
        constructor(input: unknown) { build(input); throw new Error(PRIVATE); }
      });
    });
    await view();
    expectRefused('보고서 확인 불가');
    expect(build).toHaveBeenCalledExactlyOnceWith({ jobId: JOB, reportId: event.event_id });
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    expect(reportCalls()).toHaveLength(1);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });

  it.each(['rollback', 'release'])('does not offer a link when %s cleanup fails', async stage => {
    if (stage === 'release') boundary.release.mockImplementationOnce(() => { throw new Error(PRIVATE); });
    else {
      const query = boundary.query.getMockImplementation()!;
      boundary.query.mockImplementation(async config => {
        if (config.text === 'ROLLBACK') throw new Error(PRIVATE);
        return query(config);
      });
    }
    await view();
    expectRefused('보고서 확인 불가');
    expect(readPreflightReport).toHaveBeenCalledTimes(1);
    expect(reportCalls()).toHaveLength(1);
    expect(boundary.release).toHaveBeenCalledTimes(1);
  });
});

describe('strict decoded page selectors (no normalization, defaults or query forwarding)', () => {
  const invalidQueries: [string, (valid: Query) => Query][] = [
    ['none', () => ({})], ['missing job', v => ({ reportId: v.reportId })], ['missing report', v => ({ jobId: v.jobId })],
    ['undefined job', v => ({ ...v, jobId: undefined })], ['empty job', v => ({ ...v, jobId: '' })],
    ['space job', v => ({ ...v, jobId: ' job' })], ['trailing space job', v => ({ ...v, jobId: 'job ' })],
    ['control job', v => ({ ...v, jobId: 'a\nb' })], ['format job', v => ({ ...v, jobId: 'a\u200db' })],
    ['line separator job', v => ({ ...v, jobId: 'a\u2028b' })], ['unpaired surrogate', v => ({ ...v, jobId: '\ud800' })],
    ['overlong job', v => ({ ...v, jobId: 'j'.repeat(1025) })],
    ['duplicate job', v => ({ ...v, jobId: [JOB, JOB] })], ['single array job', v => ({ ...v, jobId: [JOB] })],
    ['empty array job', v => ({ ...v, jobId: [] })], ['duplicate report', v => ({ ...v, reportId: [v.reportId as string, v.reportId as string] })],
    ['single array report', v => ({ ...v, reportId: [v.reportId as string] })], ['empty report', v => ({ ...v, reportId: '' })],
    ['uppercase report', v => ({ ...v, reportId: `reconciliation:${'A'.repeat(64)}` })],
    ['short report', v => ({ ...v, reportId: `reconciliation:${'a'.repeat(63)}` })],
    ['long report', v => ({ ...v, reportId: `reconciliation:${'a'.repeat(65)}` })],
    ['newline report', v => ({ ...v, reportId: `${v.reportId}\n` })],
    ['space report', v => ({ ...v, reportId: ` ${v.reportId}` })],
    ['wrong case key', v => ({ JobId: v.jobId, reportId: v.reportId })],
    ['encoded key is not decoded twice', v => ({ '%6AobId': v.jobId, reportId: v.reportId })],
    ...['tenantId', 'slug', 'source', 'status', 'authority', 'cutoverAllowed', 'download'].map(key =>
      [key, (v: Query) => ({ ...v, [key]: PRIVATE })] as [string, (v: Query) => Query]),
    ['unknown undefined field', v => ({ ...v, extra: undefined })],
  ];
  it.each(invalidQueries)('refuses %s before invoking the reader', async (_name, query) => {
    await view(query(selectors()));
    expectRefused('잘못된 보고서 선택');
    expect(readPreflightReport).not.toHaveBeenCalled();
    expect(boundary.connect).not.toHaveBeenCalled();
  });
  it('has no default report when searchParams is absent', async () => {
    const element = await HistoryPage({ params: Promise.resolve({ slug: 'alpha' }) });
    invariant(renderToStaticMarkup(element));
    render(element);
    expectRefused('잘못된 보고서 선택');
    expect(readPreflightReport).not.toHaveBeenCalled();
  });
  it.each(['', 'ALPHA', 'Alpha', '-alpha', 'alpha-', 'alpha--beta', 'a/b', '../alpha', 'a?x', 'a#x', 'a%2fb', 'a\n', 'a'.repeat(64)])(
    'rejects a noncanonical slug without normalizing: %j', async slug => {
      await view(selectors(), slug);
      expectRefused('잘못된 보고서 선택');
      expect(readPreflightReport).not.toHaveBeenCalled();
      expect(boundary.connect).not.toHaveBeenCalled();
    },
  );
});

describe('safe failure and server-only rendering contracts', () => {
  it.each(['headers', 'connect', 'query', 'reader'])('sanitizes %s failure without retry', async location => {
    const error = new Error(PRIVATE);
    if (location === 'headers') boundary.headers.mockRejectedValueOnce(error);
    if (location === 'connect') boundary.connect.mockRejectedValueOnce(error);
    if (location === 'query') boundary.query.mockRejectedValueOnce(error);
    if (location === 'reader') vi.mocked(readPreflightReport).mockRejectedValueOnce(error);
    await view();
    expectRefused('보고서 확인 불가');
    expect(boundary.headers).toHaveBeenCalledTimes(1);
    expect(boundary.connect.mock.calls.length).toBeLessThanOrEqual(1);
    expect(vi.mocked(readPreflightReport).mock.calls.length).toBeLessThanOrEqual(1);
  });
  it.each(['params', 'searchParams'])('sanitizes rejected %s', async key => {
    const element = await HistoryPage({
      params: key === 'params' ? Promise.reject(new Error(PRIVATE)) : Promise.resolve({ slug: 'alpha' }),
      searchParams: key === 'searchParams' ? Promise.reject(new Error(PRIVATE)) : Promise.resolve(selectors()),
    });
    invariant(renderToStaticMarkup(element));
    render(element);
    expectRefused('보고서 확인 불가');
    expect(readPreflightReport).not.toHaveBeenCalled();
  });
  it('renders no raw extra DTO fields or authority assertions even if the reader contract expands', async () => {
    const result = await readPreflightReport('alpha', new Request(
      `http://tenant.internal/api/migrations/status/alpha/preflight?${new URLSearchParams(selectors() as Record<string, string>)}`,
      { headers: requestHeaders },
    ));
    if (result.kind !== 'HISTORICAL_REPORT') throw new Error('synthetic fixture did not project');
    vi.mocked(readPreflightReport).mockResolvedValueOnce({
      ...result, projection: { ...result.projection, operationalAuthority: 'POSTGRES', currentPreflight: 'PASSED',
        freshness: 'CURRENT', cutoverAllowed: true, privateData: PRIVATE },
    } as unknown as typeof result);
    const { html } = await view();
    expect(html).not.toContain('POSTGRES');
    expect(html).not.toContain('PASSED');
    expect(html).not.toContain('cutoverAllowed: true');
  });
  it('declares request-time rendering and no-referrer/no-index metadata, without a client or action surface', () => {
    expect(dynamic).toBe('force-dynamic');
    expect(runtime).toBe('nodejs');
    expect(metadata).toMatchObject({ referrer: 'no-referrer', robots: { index: false, follow: false } });
    const source = readFileSync('src/app/c/[slug]/admin/migrations/history/page.tsx', 'utf8');
    expect(source).not.toMatch(/['"]use (?:client|server|cache)['"]|dangerouslySetInnerHTML|\bfetch\s*\(|\bset(?:Timeout|Interval)\s*\(/);
    expect(source).not.toMatch(/next\/link|useState|useEffect|createObjectURL|\bBlob\b|window\.|document\.|onClick|onMouse|prefetch/);
    const imports = [...source.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => match[1]);
    expect(imports.sort()).toEqual(['next', 'next/headers', '@/app/api/migrations/status/readPreflightReport'].sort());
  });
});
