import { createCipheriv, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { QueryConfig } from 'pg';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const transport = vi.hoisted(() => {
  const forbidden = vi.fn(() => { throw new Error('Unexpected operational transport'); });
  vi.stubGlobal('fetch', forbidden);
  return { forbidden, database: vi.fn(), config: vi.fn(), archiveConnect: vi.fn(), headers: vi.fn(),
    redirect: vi.fn((path: string): never => { throw new Error(`redirect:${path}`); }),
    notFound: vi.fn((): never => { throw new Error('not-found'); }) };
});
vi.mock('@/server/db/client', () => ({ getDatabaseClient: transport.database }));
vi.mock('@/server/db/config', () => ({ getDatabaseConfig: transport.config }));
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof import('pg')>();
  class Pool { connect = transport.archiveConnect; on() {} }
  const replacements = { Pool, Client: transport.forbidden };
  return { ...actual, ...replacements, default: { ...actual.default, ...replacements } };
});
vi.mock('googleapis', () => ({ google: new Proxy({}, { get() { return transport.forbidden(); } }) }));
vi.mock('next/headers', () => ({ headers: transport.headers }));
vi.mock('next/navigation', () => ({ redirect: transport.redirect, notFound: transport.notFound }));
// Call-through observations, NOT invented status/report return values.
vi.mock('@/app/api/migrations/status/readStatus', { spy: true });
vi.mock('@/app/api/migrations/status/readPreflightReport', { spy: true });

import { readMigrationStatus } from '@/app/api/migrations/status/readStatus';
import { readPreflightReport } from '@/app/api/migrations/status/readPreflightReport';
import type { PreflightReportProjection } from '@/app/api/migrations/status/preflightReportProjection';
import StatusPage, { dynamic, metadata } from './page';
import HistoryPage from '../history/page';

// Definitions only until independently run. Real pages/readers, Google verifier,
// tenant access and archive projection; synthetic request context, clock and pg
// transport. SQL predicates are inspected, NOT executed. Calling HistoryPage
// explicitly below is NOT an HTTP/browser click, PostgreSQL/RLS proof, current
// preflight, source freshness, continuous revocation lease or cutover acceptance.
// Models: history/page.test.tsx and currentPreflight.acceptanceBoundary.test.ts.
// Run only serially after all workers cease, with operational egress/env loading
// disabled by the supervisor. No producer, live source or DB socket is needed.
type Query = Record<string, string | string[] | undefined>;
type Report = PreflightReportProjection['report'];
type Config = QueryConfig & { query_timeout?: number };
const NOW = Date.parse('2026-09-26T00:00:00.000Z');
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TENANT = '10000000-0000-4000-8000-000000000001';
const FOREIGN = '20000000-0000-4000-8000-000000000002';
const MEMBER = '30000000-0000-4000-8000-000000000003';
const USER = '40000000-0000-4000-8000-000000000004';
const SUBJECT = 'synthetic-link-admin';
const KEY = 'synthetic-link-test-key-not-a-real-credential';
const CANARY = 'SYNTHETIC_NON_SENSITIVE_DISCLOSURE_CANARY';
const JOB = 'archive/과거 job +%26?#';
const ROW_HASH = 'e'.repeat(64);
const LABEL = '선택한 과거 사전검사 보고서 보기';
const ORIGIN = 'https://link.example.invalid';
const baseTenant = { id: TENANT, slug: 'alpha', display_name: CANARY, lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const baseMember = { id: MEMBER, tenant_id: TENANT, user_id: USER, google_subject: SUBJECT, role: 'OWNER' };
const CATEGORIES: Report['metrics'][number]['category'][] = [
  'STUDENTS', 'PRODUCTS', 'TRANSACTIONS', 'ADJUSTMENTS', 'TASKS', 'ASSIGNMENTS',
  'COMPLETIONS', 'PROMOTIONS', 'PROMOTION_PRODUCTS', 'BALANCES', 'STOCK',
  'TRANSACTION_AMOUNT', 'TRANSACTION_DELTA', 'CANCELLATIONS', 'CANCELLATION_AMOUNT',
  'CANCELLATION_DELTA', 'PADLET_CLAIMS', 'OPERATION_BINDINGS', 'TOMBSTONES', 'ORPHANED_CLAIMS', 'RECURRENCE',
];
function blockedReport(): Report {
  return { reportVersion: 1, phase: 'PREFLIGHT', status: 'BLOCKED',
    metrics: [{ category: 'BALANCES', expected: '-9007199254740993', actual: '0', delta: '9007199254740993', status: 'MISMATCH' }],
    diagnostics: [{ category: 'STUDENTS', code: 'ROW_MISMATCH', rowReference: ROW_HASH }], omittedDiagnostics: 0 };
}
function matchedReport(): Report {
  return { reportVersion: 1, phase: 'PREFLIGHT', status: 'MATCHED_PREFLIGHT',
    metrics: CATEGORIES.map(category => ({ category, expected: '0', actual: '0', delta: '0', status: 'MATCH' })),
    diagnostics: [], omittedDiagnostics: 0 };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('Invalid synthetic archive');
  return text;
}
function archived(report = blockedReport(), jobId = JOB, tenantId = TENANT) {
  const details = { report: { ...report, authority: 'SHEETS_AND_REDIS', cutoverAllowed: false },
    comparisonInstant: '2026-09-25T00:00:00.000Z', manifestDigest: 'a'.repeat(64),
    currentManifestDigest: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), freshness: 'BOUND_SNAPSHOT_NOT_LIVE_FREEZE' };
  return { tenant_id: tenantId, job_id: jobId,
    event_id: `reconciliation:${createHash('sha256').update(canonical([tenantId, jobId, details])).digest('hex')}`,
    event_type: 'MIGRATION_RECONCILIATION_PREFLIGHT', operation_id: null, actor_user_id: null,
    entity_type: null, entity_id: null, redacted_details: details };
}
function cookie(subject = SUBJECT, issuedAt = NOW) {
  // Fixed nonce is for synthetic fixtures only; this is not encryption guidance.
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(KEY).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ subject, issuedAt, email: `${CANARY}@example.invalid` })), cipher.final()]);
  return `class_store_google_auth=v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}
const TENANT_FIELDS: [string, number][] = [['id', 2950], ['slug', 25], ['display_name', 25], ['lifecycle', 25], ['timezone', 25]];
const MEMBER_FIELDS: [string, number][] = [['id', 2950], ['tenant_id', 2950], ['user_id', 2950], ['google_subject', 25], ['role', 25]];
const REPORT_FIELDS: [string, number][] = [['found', 16], ['oversized', 16], ['envelope_text', 25]];
const reply = (rows: Record<string, unknown>[], fields: [string, number][] = []) => ({
  rows, fields: fields.map(([name, dataTypeID]) => ({ name, dataTypeID })),
});
const SETUP = ['BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY', "SET LOCAL statement_timeout = '1500ms'",
  "SET LOCAL lock_timeout = '500ms'", "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
  "SELECT set_config('app.tenant_id', $1, true)", 'ROLLBACK'];
let tenant: typeof baseTenant;
let member: typeof baseMember | null;
let event: ReturnType<typeof archived>;
let injectedEnvelope: ReturnType<typeof archived> | undefined;
let savedStatus: string | null;
let requestHeaders: Headers;
let now: number;
let beforeData: (() => void) | undefined;
let afterMembership: (() => void) | undefined;
let clients: ReturnType<typeof makeClient>[];
const directoryQuery = vi.fn<(text: string, values?: unknown[]) => Promise<ReturnType<typeof reply>>>();
const statusConnect = vi.fn();

// This is a model of transport responses, not an independent SQL engine. Tests
// separately assert the real statements' tenant/membership/selector predicates.
function bound(values: unknown[]) {
  return member !== null && tenant.id === values[0] && tenant.slug === values[5]
    && member.tenant_id === values[0] && member.google_subject === values[1]
    && member.id === values[3] && member.user_id === values[4] && ['OWNER', 'ADMIN'].includes(member.role);
}
function discovery(kind: 'tenant' | 'member', values: unknown[]) {
  const result = kind === 'tenant'
    ? reply(values[0] === tenant.slug ? [{ ...tenant }] : [], TENANT_FIELDS)
    : reply(member && member.tenant_id === values[0] && member.google_subject === values[1] ? [{ ...member }] : [], MEMBER_FIELDS);
  if (kind === 'member') afterMembership?.();
  return result;
}
function makeClient(kind: 'status' | 'history') {
  return Object.assign(new EventEmitter(), { kind,
    query: vi.fn(async ({ text, values = [] }: Config) => {
      if (text.includes('public.migration_jobs')) {
        beforeData?.();
        const historical = text.includes('public.audit_events');
        if (!bound(values)) return reply([], historical ? REPORT_FIELDS : []);
        if (historical) {
          const found = values[0] === event.tenant_id && values[2] === event.job_id && values[6] === event.event_id;
          return reply([{ found: Boolean(injectedEnvelope) || found, oversized: false,
            envelope_text: injectedEnvelope ? JSON.stringify(injectedEnvelope) : found ? JSON.stringify(event) : null }], REPORT_FIELDS);
        }
        return reply([{ status: values[2] === event.job_id ? savedStatus : null }]);
      }
      if (text.includes('public.platform_find_membership')) return discovery('member', values);
      if (text.includes('public.platform_find_tenant')) return discovery('tenant', values);
      if (!SETUP.includes(text)) return transport.forbidden();
      return reply([]);
    }),
    release: vi.fn(), end: vi.fn(async () => {}),
  });
}
const dataCalls = (kind: 'status' | 'history') => clients.filter(client => client.kind === kind)
  .flatMap(client => client.query.mock.calls.map(([config]) => config)).filter(config => config.text.includes('public.migration_jobs'));
const selectors = (): Query => ({ jobId: event.job_id, reportId: event.event_id });
const page = (query: Query = selectors(), slug = 'alpha') => StatusPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) });
function noDisclosure(container: HTMLElement) {
  for (const value of [CANARY, KEY, SUBJECT, TENANT, FOREIGN, MEMBER, USER, 'class_store_google_auth', 'SHEETS_AND_REDIS']) {
    expect(container.innerHTML).not.toContain(value);
  }
  expect(container.querySelectorAll('form, button, input, select, textarea, iframe, script, img')).toHaveLength(0);
}
function noHistoryRead() {
  expect(readPreflightReport).not.toHaveBeenCalled();
  expect(transport.archiveConnect).not.toHaveBeenCalled();
  expect(dataCalls('history')).toHaveLength(0);
}
function expectLink(jobId = event.job_id, reportId = event.event_id) {
  const link = screen.getByRole('link', { name: LABEL });
  const href = link.getAttribute('href')!;
  expect(href).toBe(`/c/alpha/admin/migrations/history?${new URLSearchParams({ jobId, reportId })}`);
  const url = new URL(href, ORIGIN);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe('/c/alpha/admin/migrations/history');
  expect(url.hash).toBe('');
  expect([...url.searchParams.entries()]).toEqual([['jobId', jobId], ['reportId', reportId]]);
  expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(link.getAttributeNames().sort()).toEqual(['class', 'href', 'referrerpolicy']);
  expect(link.textContent).not.toContain(jobId);
  expect(link.textContent).not.toContain(reportId);
  return href;
}
async function follow(href: string) {
  cleanup();
  const url = new URL(href, ORIGIN);
  const query = Object.fromEntries(url.searchParams.entries());
  // Explicit component invocation, never an automatic fetch or real browser.
  const result = render(await HistoryPage({ params: Promise.resolve({ slug: 'alpha' }), searchParams: Promise.resolve(query) }));
  for (const value of ['HISTORICAL_ONLY', 'NOT_EVALUATED', 'UNKNOWN', 'cutoverAllowed: false']) expect(result.container.textContent).toContain(value);
  noDisclosure(result.container);
  return result;
}
function assertDataBinding(kind: 'status' | 'history', jobId = event.job_id, reportId = event.event_id) {
  const calls = dataCalls(kind);
  expect(calls).toHaveLength(1);
  const config = calls[0];
  expect(config.values).toEqual([TENANT, SUBJECT, jobId, MEMBER, USER, 'alpha', ...(kind === 'history' ? [reportId] : [])]);
  for (const clause of ['platform_find_membership_by_tenant_and_google_subject($1, $2)',
    'platform_find_tenant_by_slug($6)', 'j.tenant_id = $1 AND j.job_id = $3',
    'm.tenant_id = $1 AND m.google_subject = $2', "m.id = $4 AND m.user_id = $5 AND m.role IN ('OWNER','ADMIN')",
    't.id = $1 AND t.slug = $6']) expect(config.text).toContain(clause);
  if (kind === 'history') {
    expect(config.text).toContain('e.tenant_id = j.tenant_id AND e.job_id = j.job_id');
    expect(config.text).toContain("e.event_id = $7 AND e.event_type = 'MIGRATION_RECONCILIATION_PREFLIGHT'");
  } else expect(config.text).not.toContain('audit_events');
}

beforeAll(() => { expect(transport.forbidden).not.toHaveBeenCalled(); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', transport.forbidden);
  vi.stubEnv('AUTH_SECRET', KEY);
  vi.stubEnv('GOOGLE_CLIENT_SECRET', '');
  vi.stubEnv('ADMIN_PASSWORD', '');
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  now = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  tenant = { ...baseTenant };
  member = { ...baseMember };
  event = archived();
  savedStatus = 'ACTIVE';
  injectedEnvelope = undefined;
  beforeData = undefined;
  afterMembership = undefined;
  clients = [];
  requestHeaders = new Headers({ cookie: cookie(), 'x-role': 'OWNER', 'x-tenant-id': FOREIGN, 'x-cutover-allowed': 'true' });
  transport.headers.mockReset().mockImplementation(async () => requestHeaders);
  transport.config.mockReset().mockReturnValue({ databaseUrl: 'postgresql://synthetic:unused@invalid.invalid/link_unit_only' });
  directoryQuery.mockReset().mockImplementation(async (text, values = []) => {
    if (text === 'SELECT * FROM public.platform_find_tenant_by_slug($1)') return discovery('tenant', values);
    if (text === 'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)') return discovery('member', values);
    return transport.forbidden();
  });
  statusConnect.mockReset().mockImplementation(async () => { const client = makeClient('status'); clients.push(client); return client; });
  transport.archiveConnect.mockReset().mockImplementation(async () => { const client = makeClient('history'); clients.push(client); return client; });
  transport.database.mockReset().mockReturnValue({ pool: { query: directoryQuery, connect: statusConnect }, database: {} });
});
afterEach(() => {
  cleanup();
  expect(transport.forbidden).not.toHaveBeenCalled();
  for (const client of clients) {
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.listenerCount('error')).toBe(0);
    for (const [config] of client.query.mock.calls) {
      expect(config.text.trim()).toMatch(/^(?:SELECT |BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$|SET LOCAL |ROLLBACK$)/);
      expect(config.text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COMMIT|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/i);
    }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(() => { vi.unstubAllGlobals(); });

describe('manual historical link through real status and historical page/readers (synthetic transport)', () => {
  it.each(['OWNER', 'ADMIN'])('offers only a neutral manual locator after real %s status authorization', async role => {
    member!.role = role;
    const { container } = render(await page());
    expectLink();
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: '관리 화면으로' }).getAttribute('href')).toBe('/c/alpha/admin');
    expect(screen.getByRole('status').textContent).toContain('저장된 작업 상태');
    expect(container.textContent).toContain('ACTIVE');
    expect(container.textContent).toContain('확인 불가 (UNKNOWN)');
    expect(container.textContent).toContain('과거 기록만 조회합니다. 현재 충돌·사전검사 통과·전환 권한을 뜻하지 않습니다.');
    expect(container.textContent).toContain('이동 시 로그인과 접근 권한을 다시 확인합니다.');
    expect(container.textContent).not.toMatch(/ROW_MISMATCH|HISTORICAL_ONLY|충돌 확인됨/);
    expect(screen.queryByRole('table')).toBeNull();
    expect(readMigrationStatus).toHaveBeenCalledWith('alpha', expect.any(Request), JOB);
    assertDataBinding('status');
    expect(directoryQuery.mock.calls.map(([, values]) => values)).toEqual([['alpha'], [TENANT, SUBJECT]]);
    expect(clients[0].query).toHaveBeenCalledWith(expect.objectContaining({ text: 'ROLLBACK' }));
    expect(clients[0].release).toHaveBeenCalledWith();
    expect(dynamic).toBe('force-dynamic');
    expect(metadata.referrer).toBe('no-referrer');
    noHistoryRead();
    noDisclosure(container);
  });

  it.each(['ACTIVE', 'READY', 'FAILED'])('keeps saved %s separate from a historical BLOCKED/MISMATCH after manual selection', async status => {
    savedStatus = status;
    render(await page());
    const href = expectLink();
    noHistoryRead();
    const { container } = await follow(href);
    const table = screen.getByRole('table', { name: '과거 비교 지표' });
    expect(within(table).getByText('-9007199254740993')).toBeTruthy();
    expect(within(table).getByText('9007199254740993')).toBeTruthy();
    expect(container.textContent).toContain('ROW_MISMATCH');
    expect(container.textContent).toContain(ROW_HASH);
    expect(container.textContent).toContain('BLOCKED');
    expect(container.textContent).toContain('NOT_VERIFIED');
    expect(container.textContent).not.toMatch(/ACTIVE|READY|CURRENT_PREFLIGHT/);
    assertDataBinding('history');
    const [slug, request] = vi.mocked(readPreflightReport).mock.calls[0];
    expect(slug).toBe('alpha');
    expect(request.cache).toBe('no-store');
    expect(request.method).toBe('GET');
    expect([...request.headers]).toEqual([['cookie', requestHeaders.get('cookie')]]);
    expect(transport.archiveConnect).toHaveBeenCalledTimes(1);
    expect(clients[1].query).toHaveBeenCalledWith(expect.objectContaining({ text: 'ROLLBACK' }));
    expect(clients[1].release).toHaveBeenCalledWith();
  });

  it('does not elevate a matched archive plus saved ACTIVE to live preflight or authority', async () => {
    event = archived(matchedReport());
    render(await page());
    const href = expectLink();
    noHistoryRead();
    const { container } = await follow(href);
    expect(container.textContent).toContain('MATCHED_PREFLIGHT');
    const result = await vi.mocked(readPreflightReport).mock.results[0].value;
    expect(result).toMatchObject({ kind: 'HISTORICAL_REPORT', projection: {
      scope: 'HISTORICAL_ONLY', verification: 'INTEGRITY_ONLY', originalBinding: 'NOT_VERIFIED',
      currentFreshness: 'NOT_VERIFIED', currentPreflight: 'NOT_EVALUATED', operationalAuthority: 'UNKNOWN', cutoverAllowed: false,
    } });
    expect(container.textContent).not.toMatch(/ACTIVE|READY|CURRENT_PREFLIGHT/);
  });

  it.each(['archive/과거 +%26?#', '//outside.example.invalid/a?x=1&y=2', '<img src=x onerror=fixture>', 'e\u0301', '🧪', 'x'.repeat(1024)])(
    'preserves the literal opaque job without decoding, normalization or path escape: %s', async jobId => {
      event = archived(blockedReport(), jobId);
      const { container } = render(await page());
      const href = expectLink();
      noDisclosure(container);
      noHistoryRead();
      await follow(href);
      expect(screen.getByRole('table', { name: '과거 비교 지표' })).toBeTruthy();
      assertDataBinding('status', jobId);
      assertDataBinding('history', jobId);
    },
  );

  it.each([
    ['job only', { jobId: JOB }], ['report only', { reportId: `reconciliation:${'a'.repeat(64)}` }], ['no selectors', {}],
    ['duplicate report', { jobId: JOB, reportId: ['one', 'two'] }],
    ['duplicate job', { jobId: [JOB, JOB], reportId: `reconciliation:${'a'.repeat(64)}` }],
    ['empty report', { jobId: JOB, reportId: '' }], ['undefined report', { jobId: JOB, reportId: undefined }],
    ['uppercase hash', { jobId: JOB, reportId: `reconciliation:${'A'.repeat(64)}` }],
    ['newline report', { jobId: JOB, reportId: `reconciliation:${'a'.repeat(64)}\n` }],
    ['short hash', { jobId: JOB, reportId: `reconciliation:${'a'.repeat(63)}` }],
    ['encoded report', { jobId: JOB, reportId: `reconciliation%3A${'a'.repeat(64)}` }],
    ['extra authority', { jobId: JOB, reportId: `reconciliation:${'a'.repeat(64)}`, authority: 'POSTGRESQL' }],
    ['extra undefined', { jobId: JOB, reportId: `reconciliation:${'a'.repeat(64)}`, extra: undefined }],
  ] satisfies [string, Query][])('suppresses only the link for %s; does not invent a report read', async (_label, query: Query) => {
    const { container } = render(await page(query));
    expect(screen.queryByRole('link', { name: LABEL })).toBeNull();
    expect(readMigrationStatus).toHaveBeenCalledWith('alpha', expect.any(Request), query.jobId);
    if (query.jobId === JOB) expect(container.textContent).toContain('저장된 작업 상태');
    else if (Array.isArray(query.jobId)) expect(container.textContent).toContain('잘못된 작업 선택');
    else expect(container.textContent).toContain('상태 조회 차단');
    noHistoryRead();
    noDisclosure(container);
  });

  it.each(['', ' padded', 'padded ', 'line\n', 'zero\u0000', 'hidden\u200b', 'line\u2028', 'paragraph\u2029', '\uD800', 'x'.repeat(1025)])(
    'suppresses malformed historical job %j without repairing it', async jobId => {
      event = archived(blockedReport(), jobId);
      render(await page());
      expect(screen.queryByRole('link', { name: LABEL })).toBeNull();
      expect(readMigrationStatus).toHaveBeenCalledWith('alpha', expect.any(Request), jobId);
      noHistoryRead();
    },
  );

  it.each(['jobId', 'reportId'])('rejects an inherited %s for the link without widening status admission', async key => {
    const query: Query = { ...selectors() };
    const value = query[key];
    delete query[key];
    Object.setPrototypeOf(query, { [key]: value });
    render(await page(query));
    expect(screen.queryByRole('link', { name: LABEL })).toBeNull();
    noHistoryRead();
  });

  it('captures selectors before awaiting headers and authorization, not mutable replacement props', async () => {
    const query = selectors();
    const original = { jobId: event.job_id, reportId: event.event_id };
    transport.headers.mockImplementationOnce(async () => {
      query.jobId = 'replacement-job';
      query.reportId = `reconciliation:${'f'.repeat(64)}`;
      query.returnTo = 'https://outside.example.invalid';
      return requestHeaders;
    });
    render(await page(query));
    expectLink(original.jobId, original.reportId);
    expect(readMigrationStatus).toHaveBeenCalledWith('alpha', expect.any(Request), original.jobId);
    assertDataBinding('status', original.jobId);
    noHistoryRead();
  });

  it.each(['not-found', 'unknown-status', 'connection-failure', 'access-unavailable'])('preserves the %s degraded status without a historical link', async state => {
    if (state === 'not-found') savedStatus = null;
    if (state === 'unknown-status') savedStatus = 'UNSUPPORTED';
    if (state === 'connection-failure') statusConnect.mockRejectedValueOnce(new Error(CANARY));
    if (state === 'access-unavailable') directoryQuery.mockRejectedValueOnce(new Error(CANARY));
    const { container } = render(await page());
    expect(screen.queryByRole('link', { name: LABEL })).toBeNull();
    expect(container.textContent).toContain(state === 'not-found' ? '작업을 찾을 수 없음'
      : state === 'access-unavailable' ? '접근 권한 확인 불가' : '작업 상태 확인 불가');
    noDisclosure(container);
    noHistoryRead();
  });

  it.each(['missing-cookie', 'expired-cookie', 'nonmember', 'foreign-tenant', 'student', 'revoked-at-statement', 'expired-during-membership'])(
    'does not render a link past real status denial: %s', async state => {
      if (state === 'missing-cookie') requestHeaders.delete('cookie');
      if (state === 'expired-cookie') requestHeaders.set('cookie', cookie(SUBJECT, 1));
      if (state === 'nonmember') member = null;
      if (state === 'foreign-tenant') member!.tenant_id = FOREIGN;
      if (state === 'student') member!.role = 'STUDENT';
      if (state === 'revoked-at-statement') beforeData = () => { member = null; };
      if (state === 'expired-during-membership') afterMembership = () => { now = NOW + MAX_AGE_MS + 1; };
      const unauthenticated = ['missing-cookie', 'expired-cookie', 'expired-during-membership'].includes(state);
      await expect(page()).rejects.toThrow(unauthenticated ? 'redirect:/c/alpha/admin/login' : 'not-found');
      if (state === 'revoked-at-statement') assertDataBinding('status');
      else expect(statusConnect).not.toHaveBeenCalled();
      noHistoryRead();
    },
  );

  it.each(['Alpha', 'alpha/other', 'alpha\n'])('retains canonical tenant refusal for %j', async slug => {
    await expect(page(selectors(), slug)).rejects.toThrow('not-found');
    expect(directoryQuery).not.toHaveBeenCalled();
    noHistoryRead();
  });

  it.each(['expiry', 'cookie-replacement'])('rejects %s during the status read before publishing a link', async state => {
    beforeData = () => {
      if (state === 'expiry') now = NOW + MAX_AGE_MS + 1;
      else vi.mocked(readMigrationStatus).mock.calls[0][1].headers.set('cookie', cookie('replacement-synthetic-subject'));
    };
    await expect(page()).rejects.toThrow('redirect:/c/alpha/admin/login');
    assertDataBinding('status');
    expect(clients[0].query).toHaveBeenCalledWith(expect.objectContaining({ text: 'ROLLBACK' }));
    expect(clients[0].release).toHaveBeenCalledWith();
    noHistoryRead();
  });

  it('reauthorizes another status render instead of retaining the first link after revocation', async () => {
    render(await page());
    expectLink();
    cleanup();
    member = null;
    await expect(page()).rejects.toThrow('not-found');
    expect(readMigrationStatus).toHaveBeenCalledTimes(2);
    expect(statusConnect).toHaveBeenCalledTimes(1);
    noHistoryRead();
  });

  it.each(['logout', 'expiry', 'revoked', 'foreign-tenant', 'different-subject', 'student', 'revoked-at-statement'])(
    'reauthorizes the manually selected destination after %s instead of reusing status access', async state => {
      render(await page());
      const href = expectLink();
      noHistoryRead();
      if (state === 'logout') requestHeaders = new Headers();
      if (state === 'expiry') now = NOW + MAX_AGE_MS + 1;
      if (state === 'revoked') member = null;
      if (state === 'foreign-tenant') member!.tenant_id = FOREIGN;
      if (state === 'different-subject') requestHeaders = new Headers({ cookie: cookie('other-synthetic-subject') });
      if (state === 'student') member!.role = 'STUDENT';
      if (state === 'revoked-at-statement') beforeData = () => { member = null; };
      await follow(href);
      expect(screen.getByRole('heading', { name: ['logout', 'expiry'].includes(state) ? '로그인 필요' : '접근할 수 없음' })).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
      if (state === 'revoked-at-statement') assertDataBinding('history');
      else expect(dataCalls('history')).toHaveLength(0);
      expect(readMigrationStatus).toHaveBeenCalledTimes(1);
      expect(readPreflightReport).toHaveBeenCalledTimes(1);
    },
  );

  it('permits a different independently authorized destination identity, not a status-session lease', async () => {
    render(await page());
    const href = expectLink();
    const subject = 'other-authorized-synthetic-admin';
    member = { ...baseMember, google_subject: subject };
    requestHeaders = new Headers({ cookie: cookie(subject) });
    await follow(href);
    expect(screen.getByRole('table', { name: '과거 비교 지표' })).toBeTruthy();
    expect(dataCalls('history')[0].values).toEqual([TENANT, subject, JOB, MEMBER, USER, 'alpha', event.event_id]);
  });

  it.each(['absent-report', 'reader-failure', 'rehashed-foreign-envelope'])(
    'does not promise report existence/validity from the link: %s', async state => {
      const query = selectors();
      if (state === 'absent-report') query.reportId = `reconciliation:${'f'.repeat(64)}`;
      if (state === 'rehashed-foreign-envelope') {
        // Simulate a corrupt transport returning a fully rehashed foreign row;
        // this specifically tests the real projection, not SQL/RLS enforcement.
        injectedEnvelope = archived(blockedReport(), JOB, FOREIGN);
        query.reportId = injectedEnvelope.event_id;
      }
      render(await page(query));
      const href = expectLink(JOB, query.reportId as string);
      noHistoryRead();
      if (state === 'reader-failure') transport.archiveConnect.mockRejectedValueOnce(new Error(CANARY));
      await follow(href);
      expect(screen.getByRole('heading', { name: state === 'absent-report' ? '보고서를 찾을 수 없음' : '보고서 확인 불가' })).toBeTruthy();
      expect(screen.queryByRole('table')).toBeNull();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );
});
