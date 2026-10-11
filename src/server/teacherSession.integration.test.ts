// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { NextResponse } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const shared = vi.hoisted(() => ({ query: vi.fn(), exchange: vi.fn() }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: { query: shared.query } }) }));
vi.mock('@/server/googleOAuth', async original => ({
  ...(await original<typeof import('@/server/googleOAuth')>()), exchangeGoogleCodeForSession: shared.exchange,
}));
import { currentLegalRevision } from '@/lib/legalDocuments';
import { createClassCreationCommand } from '@/server/repositories/database/classCreation';
import { handleClassCreation } from '@/server/classCreation';
import { createTenantAccessDependencies } from '@/server/tenantAccess';
import { createTenantApiDispatcher } from '@/server/tenantApiDispatcher';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { readAccountRequest } from '@/server/accountRequest';
import { logoutAdministrator } from '@/server/adminLogout';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { GET as callback } from '@/app/api/google/callback/route';
import { POST as profile } from '@/app/api/account/profile/route';
import { POST as withdraw } from '@/app/api/account/withdraw/route';
import { POST as agree, DELETE as cancel } from '@/app/api/account/agreement/route';
import { GOOGLE_AUTH_COOKIE, PENDING_AGREEMENT_COOKIE, getGoogleSessionFromRequest, getPendingAgreementFromRequest,
  setGoogleSessionCookie, setGoogleStateCookie } from '@/server/googleOAuth';

const ORIGIN = 'https://synthetic.example.test';
const VERSION = currentLegalRevision().version;
const ALL = { terms: true, privacy: true, age: true };
let db: PGlite;
const queryable = { query: (text: string, values?: unknown[]) => shared.query(text, values) };
const create = createClassCreationCommand(queryable);
function request(path: string, cookie: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`${ORIGIN}${path}`, { method, headers: {
    host: 'synthetic.example.test', origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function apply(jar: Map<string,string>, response: NextResponse) {
  for (const c of response.cookies.getAll()) { if (c.maxAge === 0) jar.delete(c.name); else jar.set(c.name,c.value); }
}
const header = (jar: Map<string,string>) => [...jar].map(([k,v]) => `${k}=${v}`).join('; ');
const sessionId = (cookie: string) => (getGoogleSessionFromRequest(request('/profile',cookie)) ?? getPendingAgreementFromRequest(request('/signup',cookie)))!.sessionId!;
async function signIn(subject: string, jar = new Map<string,string>()) {
  const state = randomUUID(); const start = NextResponse.json({}); setGoogleStateCookie(start,state,'/classes'); apply(jar,start);
  shared.exchange.mockResolvedValueOnce({ subject, email: `${subject}@example.test`, issuedAt: Date.now() });
  const response = await callback(request(`/api/google/callback?code=synthetic&state=${state}`,header(jar)));
  expect(response.status).toBe(307); apply(jar,response); return jar;
}
async function consent(jar: Map<string,string>) {
  const cookie = header(jar); const response = await agree(request('/api/account/agreement',cookie,{ ...ALL,expectedSessionId:sessionId(cookie) }));
  expect(response.status).toBe(200); apply(jar,response); return header(jar);
}
async function createClass(cookie: string) {
  const response = await handleClassCreation(request('/api/classes',cookie,{ operationId:randomUUID(),displayName:'Synthetic class' }),create);
  expect(response.status).toBe(201); return (await response.json()).slug as string;
}
const dispatch = createTenantApiDispatcher(createTenantAccessDependencies(queryable,getGoogleSessionFromRequest), [{
  method:'GET',pattern:'audit',access:'admin',handler:r=>Response.json({ authorized:isAuthorizedAdminRequest(r) }),
}]);
const admin = (slug:string,cookie:string) => dispatch(request(`/api/c/${slug}/audit`,cookie),{ slug,path:['audit'] });
const deletion = (cookie:string,expectedSessionId = sessionId(cookie)) => withdraw(request('/api/account/withdraw',cookie,{ confirm:true,expectedSessionId }));

beforeAll(async () => {
  vi.stubEnv('CLASS_STORE_STORAGE','postgresql'); vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT','system');
  vi.stubEnv('AUTH_SECRET','synthetic-test-only-secret-with-at-least-32-characters');
  db = new PGlite({ extensions:{ pgcrypto } });
  for (const file of (await readdir('src/server/db/migrations')).filter(f=>/^\d{4}_.*\.sql$/.test(f)).sort()) {
    await db.exec(await readFile(`src/server/db/migrations/${file}`,'utf8'));
  }
  await db.exec(`CREATE ROLE teacher_test_runtime NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO teacher_test_runtime;
    GRANT EXECUTE ON FUNCTION public.platform_begin_teacher_session(text,text),
      public.platform_validate_teacher_session(text,uuid,uuid,boolean,text),
      public.platform_mutate_teacher_account(text,text,uuid,uuid,jsonb),
      public.platform_end_teacher_session(text,uuid,uuid),public.platform_latest_user_agreement(text),
      public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text),public.platform_find_tenant_by_slug(text),
      public.platform_find_membership_by_tenant_and_google_subject(uuid,text),public.platform_list_memberships_by_google_subject(text)
      TO teacher_test_runtime;`);
  shared.query.mockImplementation(async (text:string,values?:unknown[]) => {
    await db.exec('BEGIN; SET LOCAL ROLE teacher_test_runtime;');
    try { const result = await db.query(text,values); await db.exec('COMMIT'); return result; }
    catch(error) { await db.exec('ROLLBACK'); throw error; }
  });
},60000);
afterAll(async () => { await db?.close(); vi.unstubAllEnvs(); });

describe('durable teacher sessions and account lifecycle',()=>{
  it('withdraws atomically and rejects both old Google and pending cookies after fresh registration',async()=>{
    const first = await signIn('withdrawal'); const oldPending = header(first);
    const old = await consent(first); const oldId = sessionId(old); const original = await createClass(old);
    expect((await admin(original,old)).status).toBe(200);
    expect((await deletion(old)).status).toBe(200);
    expect(await getTeacherGoogleSessionFromRequest(request('/classes',old))).toBeNull();
    expect((await agree(request('/api/account/agreement',oldPending,{ ...ALL,expectedSessionId:sessionId(oldPending) }))).status).toBe(401);
    expect((await handleClassCreation(request('/api/classes',old,{ operationId:randomUUID(),displayName:'Denied' }),create)).status).toBe(401);
    const next = await signIn('withdrawal'); expect(next.has(PENDING_AGREEMENT_COOKIE)).toBe(true);
    const current = await consent(next); const freshClass = await createClass(current);
    expect((await admin(freshClass,old)).status).toBe(401);
    expect((await deletion(old,oldId)).status).toBe(401);
    expect((await admin(freshClass,current)).status).toBe(200);
  });

  it('replaces pending A with signed-in B and rejects conflicting cookies or a stale confirmation screen',async()=>{
    const b = await consent(await signIn('switch-b')); const classB = await createClass(b);
    // Existing pre-agreement account A owns a class, as at the original feature rollout.
    const { rows:[aClass] } = await db.query<{ slug:string }>('SELECT * FROM platform_create_draft_class($1,$2,$3,$4)',
      [randomUUID(),'switch-a','switch-a@example.test','A class']);
    const jar = await signIn('switch-a'); const pendingA = header(jar); const idA = sessionId(pendingA);
    await signIn('switch-b',jar); const switched = header(jar);
    expect(jar.has(PENDING_AGREEMENT_COOKIE)).toBe(false);
    expect(getGoogleSessionFromRequest(request('/profile',switched))?.subject).toBe('switch-b');
    expect((await deletion(`${pendingA}; ${switched}`,idA)).status).toBe(401);
    expect((await deletion(switched,idA)).status).toBe(409);
    expect((await profile(request('/api/account/profile',switched,{ nickname:'Stale screen',expectedSessionId:idA }))).status).toBe(409);
    expect((await agree(request('/api/account/agreement',pendingA,{ ...ALL,expectedSessionId:idA }))).status).toBe(401);
    expect((await deletion(switched)).status).toBe(200);
    expect((await admin(classB,b)).status).toBe(404); // Withdrawal also removes the old public slug.
    expect(await getTeacherGoogleSessionFromRequest(request('/classes',b))).toBeNull();
    const rows = (await db.query('SELECT * FROM platform_list_memberships_by_google_subject($1)',['switch-a'])).rows;
    expect(rows).toEqual([expect.objectContaining({ slug:aClass.slug,role:'OWNER' })]);
  });

  it('logout and cancellation revoke copied pending identities; logout keeps another device signed in',async()=>{
    const pending = header(await signIn('logout-pending'));
    const response = await logoutAdministrator(request('/api/google/logout',pending,undefined,'POST'));
    expect(response.status).toBe(200); expect(response.cookies.get(PENDING_AGREEMENT_COOKIE)?.maxAge).toBe(0);
    expect((await agree(request('/api/account/agreement',pending,{ ...ALL,expectedSessionId:sessionId(pending) }))).status).toBe(401);
    const canceled = header(await signIn('cancel-pending'));
    expect((await cancel(request('/api/account/agreement',canceled,undefined,'DELETE'))).status).toBe(200);
    expect((await agree(request('/api/account/agreement',canceled,{ ...ALL,expectedSessionId:sessionId(canceled) }))).status).toBe(401);
    const one = await consent(await signIn('two-devices')); const two = header(await signIn('two-devices'));
    expect((await logoutAdministrator(request('/api/google/logout',one,undefined,'POST'))).status).toBe(200);
    expect(await getTeacherGoogleSessionFromRequest(request('/classes',one))).toBeNull();
    expect(await getTeacherGoogleSessionFromRequest(request('/classes',two))).not.toBeNull();
  });

  it('requires current persisted agreement, rejects pre-versioned sessions and never renews the authentication time',async()=>{
    const jar = await signIn('agreement'); const pending = header(jar);
    const originalTime = getPendingAgreementFromRequest(request('/signup',pending))!.issuedAt;
    const cookie = await consent(jar); expect(getGoogleSessionFromRequest(request('/profile',cookie))!.issuedAt).toBe(originalTime);
    const slug = await createClass(cookie);
    await db.query('DELETE FROM user_agreements WHERE google_subject=$1',['agreement']);
    expect(await getTeacherGoogleSessionFromRequest(request('/classes',cookie))).toBeNull();
    expect((await admin(slug,cookie)).status).toBe(401);
    expect((await handleClassCreation(request('/api/classes',cookie,{ operationId:randomUUID(),displayName:'Denied' }),create)).status).toBe(401);
    const renewed = await agree(request('/api/account/agreement',cookie,{ ...ALL,expectedSessionId:sessionId(cookie) }));
    expect(renewed.status).toBe(200); apply(jar,renewed);
    expect(getGoogleSessionFromRequest(request('/profile',header(jar)))!.issuedAt).toBe(originalTime);
    expect((await admin(slug,header(jar))).status).toBe(200);
    const legacy = NextResponse.json({}); setGoogleSessionCookie(legacy,{ subject:'agreement',email:'agreement@example.test',issuedAt:Date.now(),agreement:VERSION });
    const old = `${GOOGLE_AUTH_COOKIE}=${legacy.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    expect(await getTeacherGoogleSessionFromRequest(request('/classes',old))).toBeNull();
    expect((await admin(slug,old)).status).toBe(401);
    expect((await admin(slug,header(await signIn('other-pending')))).status).toBe(401);
    await expect(shared.query('SELECT * FROM teacher_auth_sessions',[])).rejects.toThrow();
    await expect(shared.query('SELECT * FROM teacher_identity_generations',[])).rejects.toThrow();
  });

  it('preserves the legacy Sheets identity behavior without requesting a database session',async()=>{
    const legacy = NextResponse.json({});
    setGoogleSessionCookie(legacy,{ subject:'legacy-sheets',email:'legacy@example.test',issuedAt:Date.now() });
    const cookie = `${GOOGLE_AUTH_COOKIE}=${legacy.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
    const calls = shared.query.mock.calls.length;
    vi.stubEnv('CLASS_STORE_STORAGE','sheets');
    try { expect(await getTeacherGoogleSessionFromRequest(request('/admin',cookie))).toMatchObject({ subject:'legacy-sheets' }); }
    finally { vi.stubEnv('CLASS_STORE_STORAGE','postgresql'); }
    expect(shared.query.mock.calls).toHaveLength(calls);
  });

  it('cancels an over-limit stream immediately without consuming its remainder',async()=>{
    const canceled = vi.fn(); let pulls=0;
    const body = new ReadableStream<Uint8Array>({ pull(controller){ pulls++; controller.enqueue(new Uint8Array(1025)); },cancel:canceled },{ highWaterMark:0 });
    const req = new Request(`${ORIGIN}/api/account/agreement`,{ method:'POST',headers:{ origin:ORIGIN,'sec-fetch-site':'same-origin','content-type':'application/json' },body,duplex:'half' } as RequestInit);
    const result = await readAccountRequest(req); expect(result).toBeInstanceOf(Response); expect((result as Response).status).toBe(413);
    expect(pulls).toBe(1); expect(canceled).toHaveBeenCalledOnce();
  });
});
