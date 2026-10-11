// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { NextResponse } from 'next/server';

vi.mock('server-only', () => ({}));
const boundary = vi.hoisted(() => ({ query: vi.fn(), factory: vi.fn(), downstream: vi.fn(), network: vi.fn() }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: { query: boundary.query } }) }));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: () => ({
  findBySlug: async () => ({ id: '10000000-0000-4000-8000-000000000001', slug: 'synthetic-migration',
    displayName: 'Synthetic migration', lifecycle: 'IMPORTING', timezone: 'Asia/Seoul' }),
  getSession: () => null, findByTenantAndSubject: async () => null,
}) }));
vi.mock('./freezingConsentProduction', () => ({ getProductionFreezingConsentHandlers: () => {
  boundary.factory(); return { challenge: boundary.downstream, begin: boundary.downstream };
} }));
vi.mock('./startFreezingProduction', () => ({
  getProductionStartFreezingHandlers: () => { boundary.factory(); return { challenge: boundary.downstream, begin: boundary.downstream }; },
  getProductionStartFreezingStatus: () => { boundary.factory(); return boundary.downstream; },
}));
vi.mock('./freezingReacquisitionCentralProduction', () => ({
  getProductionFreezingReacquisitionHandlers: () => {
    boundary.factory(); return { bootstrap: boundary.downstream, challenge: boundary.downstream, confirm: boundary.downstream };
  },
  getProductionFreezingReacquisitionStatus: () => { boundary.factory(); return boundary.downstream; },
}));

import { currentLegalRevision } from '@/lib/legalDocuments';
import { issueTeacherTestSession } from '@/server/db/testing/teacherIdentity';
import { createTeacherSessionStore } from '@/server/teacherSession';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { logoutAdministrator } from '@/server/adminLogout';
import { GOOGLE_AUTH_COOKIE, PENDING_AGREEMENT_COOKIE, setGoogleSessionCookie, setPendingAgreementCookie,
  type GoogleSession } from '@/server/googleOAuth';
import { POST as consentChallenge } from '@/app/api/migrations/[jobId]/freezing/consent/challenge/route';
import { POST as consent } from '@/app/api/migrations/[jobId]/freezing/consent/route';
import { GET as startChallenge } from '@/app/api/migrations/[jobId]/freezing/start/challenge/route';
import { POST as start } from '@/app/api/migrations/[jobId]/freezing/start/route';
import { GET as startStatus } from '@/app/api/migrations/[jobId]/freezing/start/[attemptId]/route';
import { GET as bootstrap } from '@/app/api/migrations/[jobId]/freezing/reacquisition/bootstrap/route';
import { POST as reacquireChallenge } from '@/app/api/migrations/[jobId]/freezing/reacquisition/challenge/route';
import { POST as reacquire } from '@/app/api/migrations/[jobId]/freezing/reacquisition/route';
import { GET as reacquireStatus } from '@/app/api/migrations/[jobId]/freezing/reacquisition/[attemptId]/route';
import { GET as canonicalGet, POST as canonicalPost } from '@/app/api/c/[slug]/[...path]/route';

const ORIGIN = 'https://synthetic.example.test';
const JOB = '20000000-0000-4000-8000-000000000002';
const ATTEMPT = '30000000-0000-4000-8000-000000000003';
const SLUG = 'synthetic-migration';
const TENANT = { id: '10000000-0000-4000-8000-000000000001', slug: SLUG,
  displayName: 'Synthetic migration', lifecycle: 'IMPORTING' as const, timezone: 'Asia/Seoul' as const };
const VERSION = currentLegalRevision().version;
let db: PGlite;
const owner = { query: (text: string, values: unknown[]) => db.query(text, values) };
const routes = [
  { method: 'POST', suffix: 'consent/challenge', handler: consentChallenge },
  { method: 'POST', suffix: 'consent', handler: consent },
  { method: 'GET', suffix: 'start/challenge', handler: startChallenge },
  { method: 'POST', suffix: 'start', handler: start },
  { method: 'GET', suffix: `start/${ATTEMPT}`, handler: startStatus },
  { method: 'GET', suffix: 'reacquisition/bootstrap', handler: bootstrap },
  { method: 'POST', suffix: 'reacquisition/challenge', handler: reacquireChallenge },
  { method: 'POST', suffix: 'reacquisition', handler: reacquire },
  { method: 'GET', suffix: `reacquisition/${ATTEMPT}`, handler: reacquireStatus },
] as const;
function cookie(session: GoogleSession) {
  const response = NextResponse.json({}); setGoogleSessionCookie(response, session);
  return `${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
}
function request(path: string, login: string, method: string) {
  return new Request(ORIGIN + path, { method, headers: { cookie: login, origin: ORIGIN,
    'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
  ...(method === 'POST' ? { body: '{}' } : {}) });
}
async function call(route: typeof routes[number], login: string, entry: 'raw' | 'trusted' | 'canonical') {
  const path = ['migrations', JOB, 'freezing', ...route.suffix.split('/')];
  if (entry === 'canonical') return (route.method === 'GET' ? canonicalGet : canonicalPost)(
    request(`/api/c/${SLUG}/${path.join('/')}`, login, route.method), { params: Promise.resolve({ slug: SLUG, path }) });
  const invoke = () => route.handler(request(`/api/${path.join('/')}`, login, route.method),
    { params: Promise.resolve({ jobId: JOB, attemptId: ATTEMPT }) });
  return entry === 'trusted' ? runWithTrustedTenantRequestContext({ tenant: TENANT }, invoke) : invoke();
}

beforeAll(async () => {
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql'); vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  vi.stubEnv('AUTH_SECRET', 'synthetic-test-only-secret-with-at-least-32-characters');
  vi.stubGlobal('fetch', boundary.network.mockImplementation(() => { throw new Error('Live network forbidden'); }));
  db = new PGlite({ extensions: { pgcrypto } });
  for (const file of (await readdir('src/server/db/migrations')).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
    await db.exec(await readFile(`src/server/db/migrations/${file}`, 'utf8'));
  }
  await db.exec(`CREATE ROLE freezing_session_runtime NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO freezing_session_runtime;
    GRANT EXECUTE ON FUNCTION public.platform_validate_teacher_session(text,uuid,uuid,boolean,text),
      public.platform_end_teacher_session(text,uuid,uuid) TO freezing_session_runtime;`);
  boundary.query.mockImplementation(async (text: string, values: unknown[]) => {
    await db.exec('BEGIN; SET LOCAL ROLE freezing_session_runtime;');
    try { const result = await db.query(text, values); await db.exec('COMMIT'); return result; }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
  });
}, 60000);
beforeEach(() => {
  vi.clearAllMocks(); boundary.downstream.mockImplementation(() => Response.json({ reached: true }));
});
afterAll(async () => { await db?.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each(['logged-out', 'missing-agreement', 'outdated-agreement', 'legacy-cookie', 'conflicting-pending',
  'expired-session', 'pending-only', 'absent'] as const)(
  'refuses %s at all nine trusted and canonical route entries before migration factory or IO', async kind => {
    const subject = randomUUID();
    const session = await issueTeacherTestSession(owner, { subject, email: 'teacher@example.invalid' });
    let login = cookie(session);
    if (kind === 'logged-out') {
      expect((await logoutAdministrator(request('/api/google/logout', login, 'POST'))).status).toBe(200);
      expect((await db.query('SELECT session_id FROM teacher_auth_sessions WHERE session_id=$1', [session.sessionId])).rows).toEqual([]);
    }
    if (kind === 'missing-agreement') await db.query('DELETE FROM user_agreements WHERE google_subject=$1', [subject]);
    if (kind === 'outdated-agreement') login = cookie({ ...session, agreement: '2000-01-01' });
    if (kind === 'legacy-cookie') login = cookie({ subject, email: session.email, issuedAt: session.issuedAt, agreement: VERSION });
    if (kind === 'expired-session') await db.query(`UPDATE teacher_auth_sessions
      SET authenticated_at=clock_timestamp()-interval '31 days',expires_at=clock_timestamp()-interval '1 day' WHERE session_id=$1`, [session.sessionId]);
    if (kind === 'conflicting-pending' || kind === 'pending-only') {
      const pendingSubject = randomUUID();
      const pending = await createTeacherSessionStore(owner).begin(pendingSubject, VERSION);
      const response = NextResponse.json({});
      setPendingAgreementCookie(response, { subject: pendingSubject, email: 'pending@example.invalid', purpose: 'agreement',
        mode: 'signup', issuedAt: Date.now(), accountGeneration: pending.accountGeneration, sessionId: pending.sessionId });
      const pendingCookie = `${PENDING_AGREEMENT_COOKIE}=${response.cookies.get(PENDING_AGREEMENT_COOKIE)!.value}`;
      login = kind === 'pending-only' ? pendingCookie : `${login}; ${pendingCookie}`;
    }
    if (kind === 'absent') login = '';
    boundary.query.mockClear();
    for (const route of routes) for (const entry of ['trusted', 'canonical'] as const) {
      const response = await call(route, login, entry);
      expect(response.status, `${route.method} ${route.suffix} entry=${entry}`).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(boundary.factory).not.toHaveBeenCalled(); expect(boundary.downstream).not.toHaveBeenCalled();
    expect(boundary.network).not.toHaveBeenCalled();
    // Session validation is the only allowed SQL; no migration/domain query can be admitted.
    expect(boundary.query.mock.calls.every(([text]) => text.startsWith('SELECT public.platform_validate_teacher_session('))).toBe(true);
  });

it('refuses unscoped raw exports with a live session before any SQL, factory, or IO', async () => {
  const session = await issueTeacherTestSession(owner, { subject: randomUUID(), email: 'teacher@example.invalid' });
  for (const route of routes) {
    const response = await call(route, cookie(session), 'raw');
    expect(response.status, `${route.method} ${route.suffix}`).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.factory).not.toHaveBeenCalled();
  expect(boundary.downstream).not.toHaveBeenCalled(); expect(boundary.network).not.toHaveBeenCalled();
});

it('admits a live current-agreement session to the existing downstream guards on all nine entries', async () => {
  const session = await issueTeacherTestSession(owner, { subject: randomUUID(), email: 'teacher@example.invalid' });
  for (const route of routes) for (const entry of ['trusted', 'canonical'] as const) expect((await call(route, cookie(session), entry)).status).toBe(200);
  expect(boundary.factory).toHaveBeenCalledTimes(18); expect(boundary.downstream).toHaveBeenCalledTimes(18);
  expect(boundary.network).not.toHaveBeenCalled();
});

it('keeps Sheets cookie compatibility without PostgreSQL session validation', async () => {
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
  try {
    const login = cookie({ subject: 'legacy-sheets', email: 'teacher@example.invalid', issuedAt: Date.now() });
    for (const route of routes) expect((await call(route, login, 'trusted')).status).toBe(200);
    expect(boundary.query).not.toHaveBeenCalled(); expect(boundary.factory).toHaveBeenCalledTimes(9);
  } finally { vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql'); }
});
