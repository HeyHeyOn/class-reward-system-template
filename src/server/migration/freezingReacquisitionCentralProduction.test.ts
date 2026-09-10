// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import type { Gaxios } from 'gaxios';
import type { QueryResult, QueryResultRow } from 'pg';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { makeSupportedSheets, finalizeSheetsSnapshot } from './__fixtures__/normalization';
import { createLegacyNormalizationManifest } from './manifest';
import { importLegacyNormalizationManifest } from './importer';
import { prepareLegacyImportReady } from './reconcile';
import { canonicalJson } from './validators';
import { createRegisteredBridgeProducer } from './registeredBridgeProducer';
import { createBridgeProducerReservations } from './bridgeProducerReservations';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: {
  connect: async () => {
    connections++;
    const c = await h.runtimePool.connect(); let execution = false, dispatch = false, candidate = false;
    return { query: async (text: string, values?: unknown[]) => {
      const statement = typeof text === 'string' ? text : (text as { text: string }).text;
      sqlStatements.push(statement);
      const r = await c.query(text, values);
      if (statement.includes('clock_timestamp()') && statement.includes('AS ms')) databaseClocks.push(Number((r.rows[0] as { ms: string }).ms));
      if (statement.startsWith('BEGIN')) active++;
      if (statement.includes('INSERT INTO migration_start_executions')) execution = true;
      if (statement.includes('INSERT INTO migration_reacquisition_dispatches')) dispatch = true;
      if (statement.includes('INSERT INTO migration_reacquisition_candidates')) candidate = true;
      if (statement.includes('INSERT INTO migration_bridge_consumptions') && statement.includes('freezing_challenge_id') && fault === 'nonce-expiry') vi.spyOn(Date,'now').mockReturnValue(expireAt);
      if (statement === 'COMMIT' || statement === 'ROLLBACK') active = Math.max(0, active - 1);
      if (statement === 'COMMIT' && execution && loseStartAck) { lostAcks++; throw Error('Synthetic lost start COMMIT ACK'); }
      if (statement === 'COMMIT' && ((dispatch && fault === 'dispatch-expiry') || (candidate && fault === 'candidate-expiry'))) vi.spyOn(Date,'now').mockReturnValue(expireAt);
      if (statement === 'COMMIT' && ((dispatch && fault === 'dispatch-ack') || (candidate && fault === 'candidate-ack'))) { lostAcks++; throw Error('Synthetic lost central COMMIT ACK'); }
      return r;
    }, release: (discard?: boolean) => { if (discard) discarded++; c.release(discard); } };
  },
  query: async (text: string, values: unknown[]) => {
    const c = await h.runtimePool.connect(); await c.query('BEGIN');
    try { const r = await c.query(text, values); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  },
} }) }));
const OAuth2 = google.auth.OAuth2;
const ORIGIN = 'https://store.example';
const USER = '20000000-0000-4000-8000-000000000019';
let JOB = '40000000-0000-4000-8000-000000000029';
let fixtureTenant: string, spreadsheetId = 'sheet-1';
const fixtureSheets = () => finalizeSheetsSnapshot({ ...makeSupportedSheets(3), spreadsheetId });
const env = { AUTH_SECRET: 'synthetic-auth-secret-with-at-least-32-characters', MIGRATION_GOOGLE_CLIENT_ID: 'migration.apps.googleusercontent.com', MIGRATION_GOOGLE_CLIENT_SECRET: 'local-client-secret', MIGRATION_GOOGLE_OAUTH_ORIGIN: ORIGIN };
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const pem = (k: KeyObject) => String(k.export({ type: k.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }));
const oidc = generateKeyPairSync('rsa', { modulusLength: 2048 });
let h: PgliteDatabaseHarness;
let cookie: string, nonce: string, slug: string, sourceId: string, version: string;
let active: number, disabledAt: number;
let events: string[], providerCalls: string[];
let bridgeUnknown: boolean;
let loseStartAck = false, connections = 0, discarded = 0, lostAcks = 0;
let configuration: Record<string, unknown>;
let fault: string | undefined, expireAt: number;
let sqlStatements: string[] = [], databaseClocks: number[] = [];
const clients: InstanceType<typeof OAuth2>[] = [];
const companionIO = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('pg', () => ({ Pool: class { connect = companionIO.connect; on() {} end = async () => {}; } }));
vi.mock('@vercel/functions', () => ({ attachDatabasePool: () => {} }));
function provider() {
  const client = new OAuth2(env.MIGRATION_GOOGLE_CLIENT_ID, env.MIGRATION_GOOGLE_CLIENT_SECRET, `${ORIGIN}/api/migrations/google-sheets/callback`);
  const sheets = fixtureSheets(); const access = 'local-access-token';
  client.transporter.request = (async (options: { url: string | URL }) => {
    expect(active).toBe(0); const url = String(options.url); providerCalls.push(url); let data: unknown;
    if (url.endsWith('/token')) {
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: 'https://accounts.google.com', aud: env.MIGRATION_GOOGLE_CLIENT_ID, azp: env.MIGRATION_GOOGLE_CLIENT_ID, sub: 'owner', email: 'owner@example.invalid', email_verified: true, iat: now, exp: now + 300, nonce, at_hash: createHash('sha256').update(access).digest().subarray(0, 16).toString('base64url') };
      const unsigned = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'local-key' })).toString('base64url'), Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
      data = { access_token: access, id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), oidc.privateKey).toString('base64url')}`, expires_in: 300, token_type: 'Bearer' };
    } else if (url.includes('/tokeninfo')) data = { aud: env.MIGRATION_GOOGLE_CLIENT_ID, sub: 'owner', email: 'owner@example.invalid', email_verified: 'true', expires_in: 300, scope: 'openid email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.file' };
    else if (url.includes('/certs')) data = { 'local-key': pem(oidc.publicKey) };
    else if (url.includes('/revoke')) data = {};
    else if (url.includes('/drive/v3/files/')) data = { id: spreadsheetId, mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, version: '42' };
    else if (url.includes('/values/')) {
      const name = decodeURIComponent(new URL(url).pathname.split('/values/')[1]).slice(1, -1).replace(/''/g, "'");
      const tab = sheets.tabs[name]; data = { values: [tab.headers, ...tab.rows.map(r => r.cells)] };
    } else if (url.includes(`/v4/spreadsheets/${spreadsheetId}`)) data = { spreadsheetId, sheets: Object.keys(sheets.tabs).map((title, sheetId) => ({ properties: { title, sheetId, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 100 } } })) };
    else throw Error('Unexpected synthetic OAuth URL');
    return { data: Readable.from([JSON.stringify(data)]), headers: new Headers({ 'cache-control': 'max-age=300' }), status: 200, statusText: 'OK', config: options };
  }) as typeof client.transporter.request;
  clients.push(client); return client;
}
async function prepareFixture(taskName: string, peer = false) {
  sqlStatements = []; databaseClocks = [];
  vi.spyOn(https, 'request').mockImplementation(() => { throw Error('Nonlocal HTTPS forbidden'); });
  vi.stubGlobal('fetch', () => { throw Error('Nonlocal HTTP forbidden'); });
  if (!peer) {
    h = await createPgliteDatabaseHarness();
    JOB = '40000000-0000-4000-8000-000000000029'; spreadsheetId = 'sheet-1';
  } else { JOB = '40000000-0000-4000-8000-000000000039'; spreadsheetId = 'sheet-peer'; }
  fixtureTenant = peer ? h.tenantOneId : h.tenantTwoId;
  const dir = resolve('src/server/db/migrations');
  if (!peer) for (const n of (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008' && !(taskName.startsWith('additive upgrade') && n.startsWith('0023_'))).sort()) await h.database.exec(await readFile(resolve(dir, n), 'utf8'));
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid') ON CONFLICT DO NOTHING", [USER]);
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [fixtureTenant, USER]);
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [fixtureTenant, JOB]);
  const manifest = createLegacyNormalizationManifest({ tenantId: fixtureTenant, migrationJobId: JOB, sheets: fixtureSheets() });
  await importLegacyNormalizationManifest({ tenantId: fixtureTenant, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  expect((await prepareLegacyImportReady({ tenantId: fixtureTenant, migrationJobId: JOB, manifest, currentManifest: manifest, comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: h.runTenantTransaction })).readiness).toBe('READY');
  expect(manifest.sourceFingerprint).not.toBe(manifest.sourceArtifacts.sheets.digest);
  const row = (await h.database.query<{ source_id: string; version: string; slug: string; external_source_id: string }>("SELECT s.source_id,j.state_version::text AS version,t.slug,s.external_source_id FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) JOIN tenants t ON t.id=j.tenant_id WHERE j.job_id=$1 AND s.provider='GOOGLE_SHEETS'", [JOB])).rows[0];
  sourceId = row.source_id; version = row.version; slug = row.slug;
  expect(row.external_source_id).toBe(hash(spreadsheetId)); expect(row.external_source_id).not.toBe(spreadsheetId);
  await h.database.exec('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
  await h.database.exec('GRANT SELECT,INSERT ON migration_consent_challenges,migration_consent_confirmations,migration_consent_attempts,migration_consent_captures,migration_start_intents,migration_start_confirmations,migration_start_dispatches,migration_start_executions,migration_bridge_challenges,migration_bridge_consumptions TO app_runtime');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS', JSON.stringify([{ tenantId: fixtureTenant, sourceId, spreadsheetId }]));
  const r = NextResponse.json({}); setGoogleSessionCookie(r, { subject: 'owner', email: 'owner@example.invalid', issuedAt: Date.now() - 1000 });
  cookie = `${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
  nonce = ''; active = 0; disabledAt = 0; events = []; providerCalls = []; clients.length = 0; bridgeUnknown = false;
  loseStartAck = false; connections = 0; discarded = 0; lostAcks = 0; fault = undefined; expireAt = 0;
  vi.spyOn(google.auth, 'OAuth2').mockImplementation(function () { return provider(); } as never);
  const request = generateKeyPairSync('ed25519'), manifestKeys = generateKeyPairSync('ed25519'), writer = generateKeyPairSync('ed25519');
  configuration = { tenantId: fixtureTenant, sourceId, spreadsheetId, deploymentId: 'local-companion', registrationVersion: '1', endpoint: 'https://local.example/api/internal/migrations/final-bridge', approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING', requestKeyId: 'request-1', requestPublicKey: pem(request.publicKey), requestPrivateKey: pem(request.privateKey), manifestKeyId: 'manifest-1', manifestPublicKey: pem(manifestKeys.publicKey), writerKeyId: 'writer-1', writerPublicKey: pem(writer.publicKey), encryptionKey: Buffer.alloc(32, 4).toString('base64') };
  vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', JSON.stringify([configuration]));
  // Producer registration will use the actual server configuration digest once
  // challenge issuance proves the production factory exists.
  if (!peer) await h.database.exec('CREATE ROLE "local-companion" NOSUPERUSER NOBYPASSRLS; GRANT SELECT,INSERT ON migration_bridge_producer_reservations TO "local-companion"');
  const reservations = createBridgeProducerReservations({ connect: async () => ({ query: async <T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> => {
    const result = await h.database.query(text, values ? [...values] : undefined);
    if (text.startsWith('BEGIN')) await h.database.exec('SET LOCAL ROLE "local-companion"');
    return { rows: result.rows as T[], rowCount: result.affectedRows ?? null, command: '', oid: 0, fields: [] };
  }, release: () => {} }) }, 'local-companion');
  const sheets = fixtureSheets();
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example'); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/control'); vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic-control');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID', 'writer-1'); vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', pem(writer.publicKey)); vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY', pem(writer.privateKey));
  const publicConfig = Object.fromEntries(Object.entries(configuration).filter(([k]) => !['requestPrivateKey', 'encryptionKey'].includes(k)));
  const registrationDigest = hash(canonicalJson({ purpose: 'CLASS_STORE_START_BRIDGE_CONFIGURATION_V1', ...publicConfig,
    requestPublicKey: request.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    manifestPublicKey: manifestKeys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    writerPublicKey: writer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    encryptionKeyDigest: hash(Buffer.alloc(32, 4).toString('base64')) }));
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
    expect(active).toBe(0);
    if (String(url) === configuration.endpoint) {
      events.push('dispatch');
      const producer = createRegisteredBridgeProducer({ registration: { endpoint: String(configuration.endpoint), tenantId: fixtureTenant, sourceId, spreadsheetId, deploymentId: 'local-companion', registrationVersion: '1', registrationDigest, approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING', requestKeyId: 'request-1', requestPublicKey: request.publicKey, manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writer.publicKey }, reservations,
        sheets: { listSheetNames: async () => { events.push('sheets'); return Object.keys(sheets.tabs); }, getRevision: async () => 'fresh-bridge-revision', getRows: async name => [sheets.tabs[name].headers, ...sheets.tabs[name].rows.map(r => r.cells)] }, manifest: { keyId: 'manifest-1', signingPrivateKey: manifestKeys.privateKey, encryptionKey: Buffer.alloc(32, 4) } });
      const response = await producer(new Request(url, init));
      if (bridgeUnknown) throw Error('Synthetic lost response ACK');
      return response;
    }
    if (String(url) === 'http://127.0.0.1:8787/control') {
      events.push(init.method === 'POST' ? 'disable' : 'readback'); if (init.method === 'POST') disabledAt = Date.now();
      return Response.json({ version: 1, deploymentId: 'local-companion', source: 'UPSTASH_REDIS_REST', status: 'DISABLED', disabled: true, generation: 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt: new Date(disabledAt).toISOString() });
    }
    if (String(url).startsWith('https://redis.example')) { events.push('redis'); return Response.json({ result: ['0', []] }); }
    throw Error('Nonlocal HTTP forbidden');
  });
}
beforeEach(async ({task}) => { await prepareFixture(task.name); }, 60000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); await h?.close(); });
async function call(method: 'GET' | 'POST', suffix: string, body?: unknown, headers: Record<string, string> = {}, routeSlug = slug) {
  const scoped = await import('@/app/api/c/[slug]/[...path]/route');
  const path = ['migrations', JOB, 'freezing', 'start', ...suffix.split('/').filter(Boolean)];
  return scoped[method](new Request(`${ORIGIN}/api/c/${routeSlug}/${path.join('/')}`, { method, headers: { cookie, ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), { params: Promise.resolve({ slug: routeSlug, path }) });
}
async function ceremony() {
  const issuance = await call('GET', 'challenge'); expect(issuance.status).toBe(200);
  expect(issuance.headers.get('cache-control')).toBe('no-store'); const issued = await issuance.json();
  expect(issued.startDisplay.action).toBe('DISABLE_LOCAL_WRITER_AND_START_FREEZING');
  const begin = await call('POST', '', { challengeId: issued.challengeId, display: issued.startDisplay }, { cookie: `${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`, 'x-csrf-token': issued.csrfToken });
  expect(begin.status).toBe(200); const url = new URL((await begin.json()).authorizationUrl); nonce = url.searchParams.get('nonce')!;
  return { issued, callback: new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`, { headers: { cookie: `${cookie}; ${begin.headers.get('set-cookie')!.split(';')[0]}` } }) };
}


async function joined() {
  const { callback } = await ceremony();
  const fixed = await import('@/app/api/migrations/google-sheets/callback/route');
  expect((await fixed.GET(callback)).status).toBe(200);
  await h.database.exec('GRANT SELECT,INSERT ON migration_reacquisition_challenges,migration_reacquisition_dispatches,migration_reacquisition_candidates TO app_runtime');
  const requestKeys = generateKeyPairSync('ed25519'), manifestKeys = generateKeyPairSync('ed25519'), writerKeys = generateKeyPairSync('ed25519');
  const readConfig = { tenantId: fixtureTenant, sourceId, spreadsheetId, deploymentId: 'local-companion', registrationVersion: '1',
    endpoint: 'https://local.example/api/internal/migrations/freezing-reacquisition', approvedScope: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE',
    requestKeyId: 'read-request', requestPublicKey: pem(requestKeys.publicKey), requestPrivateKey: pem(requestKeys.privateKey),
    manifestKeyId: 'read-manifest', manifestPublicKey: pem(manifestKeys.publicKey), writerKeyId: 'read-writer', writerPublicKey: pem(writerKeys.publicKey),
    encryptionKey: Buffer.alloc(32,8).toString('base64') };
  vi.stubEnv('MIGRATION_FREEZING_REACQUISITION_REGISTRATIONS', JSON.stringify([readConfig]));
  const publicConfig = Object.fromEntries(Object.entries(readConfig).filter(([k]) => !['requestPrivateKey','encryptionKey'].includes(k)));
  const registrationDigest = hash(canonicalJson({purpose:'CLASS_STORE_FREEZING_REACQUISITION_CONFIGURATION_V1', ...publicConfig,
    requestPublicKey: requestKeys.publicKey.export({type:'spki',format:'der'}).toString('base64'),
    manifestPublicKey: manifestKeys.publicKey.export({type:'spki',format:'der'}).toString('base64'),
    writerPublicKey: writerKeys.publicKey.export({type:'spki',format:'der'}).toString('base64'), encryptionKeyDigest:hash(readConfig.encryptionKey)}));
  const registration = { ...Object.fromEntries(Object.entries(publicConfig).filter(([k]) => !['manifestKeyId','writerKeyId'].includes(k))), registrationDigest };
  companionIO.connect.mockImplementation(async () => ({ query: async (text: string, values?: unknown[]) => {
    const result = await h.database.query(text,values);
    if (text.startsWith('BEGIN')) { expect(active).toBe(0); events.push('producer-begin'); await h.database.exec('SET LOCAL ROLE "local-companion"'); }
    if(text==='COMMIT') events.push('producer-ack');
    return result;
  }, release: () => {} }));
  const priorFetch = globalThis.fetch;
  const sdkPrototype: Gaxios = Object.getPrototypeOf(new OAuth2().transporter);
  const sdkRequest = sdkPrototype.request;
  const { Response: FetchResponse } = await import('node-fetch');
  const sdkFetch = vi.fn(async (url: string, options: {headers: Headers; body: string}) => {
      expect(active).toBe(0); const path = new URL(String(url)).pathname; let data: unknown; const sheets = fixtureSheets();
      if(path==='/token') { events.push('candidate-durable-token'); expect(String(options.body)).toContain('refresh_token=synthetic-durable-refresh'); data={access_token:'synthetic-durable-access',token_type:'Bearer',expires_in:3600}; }
      else {
        events.push('candidate-sdk'); expect(new Headers(options.headers).get('authorization')).toBe('Bearer synthetic-durable-access');
        if(path.includes('/drive/v3/files/')) data={id:spreadsheetId,mimeType:'application/vnd.google-apps.spreadsheet',trashed:false,version:'43'};
        else if(path.includes('/values/')) { const name=decodeURIComponent(path.split('/values/')[1]).slice(1,-1).replace(/''/g,"'"); const tab=sheets.tabs[name]; data={values:[tab.headers,...tab.rows.map(r=>r.cells),...(name==='Products'?[['P2','New eraser','10','8','TRUE','','school','1']]:[])]}; }
        else if(path===`/v4/spreadsheets/${spreadsheetId}`) data={spreadsheetId,sheets:Object.keys(sheets.tabs).map((title,sheetId)=>({properties:{title,sheetId,sheetType:'GRID',gridProperties:{rowCount:100,columnCount:100}}}))};
        else throw Error('Nonlocal SDK forbidden');
      }
      return new FetchResponse(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  });
  vi.spyOn(sdkPrototype,'request').mockImplementation(function(this: Gaxios, options) {
    return sdkRequest.call(this, {...options,fetchImplementation: sdkFetch as unknown as typeof fetch});
  });
  vi.stubGlobal('fetch',async (url: string|URL,init: RequestInit) => {
    if(String(url)!==readConfig.endpoint) return priorFetch(url,init);
    expect(active).toBe(0); events.push('candidate-send');
    // Separate deployment environment only at the low-level network seam. Central
    // dependencies already captured their immutable server configuration.
    const saved = {...process.env};
    try {
      Object.assign(process.env,{CLASS_STORE_STORAGE:'sheets', GOOGLE_SHEET_ID:spreadsheetId,
        CLASS_STORE_FREEZING_PRODUCER_REGISTRATION:JSON.stringify(registration),
        CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL:'postgresql://local-companion:synthetic@127.0.0.1/isolated',
        CLASS_STORE_BRIDGE_MANIFEST_KEY_ID:'read-manifest',CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY:pem(manifestKeys.privateKey),CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY:readConfig.encryptionKey,
        GOOGLE_CLIENT_ID:'durable-deployment-client',GOOGLE_CLIENT_SECRET:'synthetic-durable-secret',GOOGLE_REFRESH_TOKEN:'synthetic-durable-refresh'});
      vi.mocked(google.auth.OAuth2).mockImplementation(function(...args: ConstructorParameters<typeof OAuth2>) { return new OAuth2(...args); } as never);
      const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
      const response = await POST(new Request(url,init)); expect(response.status,JSON.stringify(events)).toBe(200); return response;
    } finally { for(const k of Object.keys(process.env)) if(!(k in saved)) delete process.env[k]; Object.assign(process.env,saved); }
  });
  events=[];
  const request = (method:string,suffix='',body?:unknown,headers:Record<string,string>={}) => new Request(`${ORIGIN}/api/c/${slug}/migrations/${JOB}/freezing/reacquisition${suffix}`,{
    method,headers:{cookie,origin:ORIGIN,'sec-fetch-site':'same-origin','content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const invoke = async (r:Request) => {
    const scoped=await import('@/app/api/c/[slug]/[...path]/route');
    const path=new URL(r.url).pathname.split('/').slice(4);
    return scoped[r.method as 'GET'|'POST'](r,{params:Promise.resolve({slug,path})});
  };
  return {request,invoke,readConfig};
}
async function issue(f: Awaited<ReturnType<typeof joined>>) {
  const bootstrap=await f.invoke(f.request('GET','/bootstrap')); expect(bootstrap.status).toBe(200);
  expect(events).toEqual([]); const b=await bootstrap.json();
  const cookieValue=bootstrap.headers.get('set-cookie')!;
  expect(cookieValue).toContain(`Path=/api/c/${slug}/migrations/${JOB}/freezing/reacquisition; HttpOnly; Secure; SameSite=Strict`);
  expect(cookieValue).not.toContain('Domain=');
  const challenge=await f.invoke(f.request('POST','/challenge',{}, {cookie:cookie+'; '+cookieValue.split(';')[0],'x-csrf-token':b.csrfToken}));
  expect(challenge.status).toBe(200); expect(challenge.headers.get('set-cookie')).toContain('Max-Age=0');
  const i=await challenge.json(); expect(i.csrfToken).not.toBe(b.csrfToken); expect(i.display.expiresAt-i.display.issuedAt).toBe(60000);
  return i;
}
it('canonical production roots join real READY start SQL ACK SDK capture crypto and immutable NONAUTHORITY candidate',async()=>{
  const f=await joined();
  // Missing module establishes the factory RED independently of HTTP refusal.
  const factory=await import('./freezingReacquisitionCentralProduction'); expect(factory.getProductionFreezingReacquisitionHandlers).toBeTypeOf('function');
  await h.database.exec("UPDATE migration_sources SET grant_expires_at=now()+interval '1 hour'");
  await h.database.query("INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'unrelated-claim','MIGRATION_IMPORT',$2)", [h.tenantOneId, hash('unrelated')]);
  await h.database.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
    VALUES('PADLET','other-board','other-post',encode(digest(convert_to('other-board','UTF8')||decode('00','hex')||convert_to('other-post','UTF8'),'sha256'),'hex'),$1,'unrelated-claim',now(),'Other Student')`, [h.tenantOneId]);
  await h.database.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'unrelated-source')", [hash('unrelated-tuple'), hash('unrelated-owner')]);
  const tables=(await h.database.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename).filter(t=>!['audit_events','migration_bridge_producer_reservations','migration_bridge_consumptions','migration_reacquisition_challenges','migration_reacquisition_dispatches','migration_reacquisition_candidates'].includes(t));
  const before=await Promise.all(tables.map(t=>h.database.query(`SELECT * FROM ${t}`)));
  expect(connections).toBeGreaterThan(0);
  const i=await issue(f);
  expect(i.display.expectedStateVersion).toBe(String(BigInt(version)+BigInt(1)));
  const confirm=f.request('POST','',{challengeId:i.challengeId,display:i.display},{'x-csrf-token':i.csrfToken});
  const json=JSON.stringify({challengeId:i.challengeId,display:i.display});
  const padded=json+' '.repeat(8192-Buffer.byteLength(json)); expect(Buffer.byteLength(padded)).toBe(8192);
  const result=await f.invoke(new Request(confirm,{body:padded}));
  expect(result.status,JSON.stringify(events)).toBe(200);
  const candidate=await result.json(); expect(candidate).toMatchObject({status:'AUTHENTIC_FREEZING_ACQUISITION',authority:'NONAUTHORITY',exclusion:'NOT_PROVEN',finalImportEligible:false});
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(1); expect(events.filter(e=>e==='readback')).toHaveLength(2); expect(events).not.toContain('disable');
  expect(events.indexOf('producer-ack')).toBeLessThan(events.indexOf('readback')); expect(events).toContain('candidate-durable-token'); expect(events).toContain('candidate-sdk'); expect(events.at(-1)).toBe('readback');
  const rows=(await h.database.query<{redacted_details: {payload:{sheetsSnapshot:{digest:string;sourceRevision:string;tabs:{Products:{rows:unknown[]}}}}}}>('SELECT redacted_details FROM audit_events WHERE event_id=$1',[candidate.auditEventId])).rows;
  expect(rows).toHaveLength(1); expect(hash(canonicalJson(rows[0].redacted_details))).toBe(candidate.candidateDigest);
  expect(rows[0].redacted_details.payload.sheetsSnapshot.sourceRevision).toBe('43');
  expect(rows[0].redacted_details.payload.sheetsSnapshot.digest).not.toBe(i.display.sourceAcquisitionDigest);
  expect(rows[0].redacted_details.payload.sheetsSnapshot.tabs.Products.rows).toHaveLength(fixtureSheets().tabs.Products.rows.length+1);
  const after=await Promise.all(tables.map(t=>h.database.query(`SELECT * FROM ${t}`))); expect(after.map(r=>r.rows)).toEqual(before.map(r=>r.rows));
  const archived=await f.invoke(f.request('GET','/'+i.challengeId,undefined,{'x-reacquisition-intent-digest':i.intentDigest}));
  expect(archived.status).toBe(200); expect(await archived.json()).toMatchObject({...candidate,scope:'ARCHIVAL_ONLY'});
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(1);
  const sent=[...events];
  const replay=await f.invoke(f.request('POST','',{challengeId:i.challengeId,display:i.display},{'x-csrf-token':i.csrfToken}));
  expect(replay.status).toBe(202); expect(events).toEqual(sent);
});

it('archival root survives absent read/start/provider signing credentials without sending or minting',async()=>{
  const f=await joined(); const i=await issue(f);
  expect((await f.invoke(f.request('POST','',{challengeId:i.challengeId,display:i.display},{'x-csrf-token':i.csrfToken}))).status).toBe(200);
  const before=[...events];
  for(const name of ['MIGRATION_FREEZING_REACQUISITION_REGISTRATIONS','MIGRATION_START_BRIDGE_REGISTRATIONS','MIGRATION_GOOGLE_SHEET_REGISTRATIONS','MIGRATION_GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY']) vi.stubEnv(name,'');
  const result=await f.invoke(f.request('GET','/'+i.challengeId,undefined,{'x-reacquisition-intent-digest':i.intentDigest}));
  expect(result.status).toBe(200); expect(await result.json()).toMatchObject({scope:'ARCHIVAL_ONLY',authority:'NONAUTHORITY',finalImportEligible:false});
  expect(events).toEqual(before);
});
it.each(['absent','duplicate','old-scope','old-path','keypair','rsa','encryption','extra','unregistered-sheet','same-keys'])('central %s configuration fails before intake SQL and all external effects',async attack=>{
  const f=await joined(); const config={...f.readConfig};
  if(attack==='old-scope') config.approvedScope='DISABLE_LOCAL_WRITER_AND_START_FREEZING';
  if(attack==='old-path') config.endpoint='https://local.example/api/internal/migrations/final-bridge';
  if(attack==='keypair') config.requestPrivateKey=pem(generateKeyPairSync('ed25519').privateKey);
  if(attack==='rsa') config.manifestPublicKey=pem(oidc.publicKey);
  if(attack==='encryption') config.encryptionKey=Buffer.alloc(31).toString('base64');
  if(attack==='extra') Object.assign(config,{maintained:true});
  if(attack==='unregistered-sheet') config.spreadsheetId='other';
  if(attack==='same-keys') config.manifestPublicKey=config.requestPublicKey;
  vi.stubEnv('MIGRATION_FREEZING_REACQUISITION_REGISTRATIONS',attack==='absent'?'':JSON.stringify(attack==='duplicate'?[config,config]:[config]));
  sqlStatements=[];
  const result=await f.invoke(f.request('GET','/bootstrap'));
  expect(result.status).toBe(403); expect(result.headers.get('cache-control')).toBe('no-store'); expect(events).toEqual([]);
  expect(sqlStatements.some(s=>s.includes('migration_reacquisition')||s.includes('FOR UPDATE'))).toBe(false);
});
it.each(['origin','fetch','cookie-duplicate','compat','query','endpoint','display','csrf-duplicate','bootstrap-token'])('canonical %s ambiguity refuses before dispatch',async attack=>{
  const f=await joined(); const i=await issue(f); const body={challengeId:i.challengeId,display:i.display};
  const headers:Record<string,string>={'x-csrf-token':i.csrfToken};
  if(attack==='origin') headers.origin='https://other.invalid';
  if(attack==='fetch') headers['sec-fetch-site']='cross-site';
  if(attack==='cookie-duplicate') headers.cookie=cookie+'; '+cookie;
  if(attack==='compat') headers.cookie='admin_session=synthetic';
  if(attack==='endpoint') Object.assign(body,{endpoint:'https://attacker.invalid'});
  if(attack==='display') body.display={...i.display,exclusion:'MAINTAINED'};
  if(attack==='csrf-duplicate') headers['x-csrf-token']=i.csrfToken+', '+i.csrfToken;
  if(attack==='bootstrap-token') headers['x-csrf-token']=(await (await f.invoke(f.request('GET','/bootstrap'))).json()).csrfToken;
  const result=await f.invoke(f.request('POST',attack==='query'?'?tenant=other':'',body,headers));
  expect(result.status).toBe(403); expect(result.headers.get('cache-control')).toBe('no-store'); expect(events).toEqual([]);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_dispatches')).rows).toHaveLength(0);
});
it.each([undefined,'1'])('canonical streaming overflow with Content-Length %s is bounded before JSON or dispatch',async length=>{
  const f=await joined(); const i=await issue(f); let pulls=0,cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(Buffer.alloc(4096,32));},cancel(){cancelled=true;}});
  const original=f.request('POST','',{}, {'x-csrf-token':i.csrfToken,...(length?{'content-length':length}:{})});
  const request=new Request(original,{body:stream,duplex:'half'} as RequestInit);
  const result=await f.invoke(request); expect(result.status).toBe(403); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(4); expect(events).toEqual([]);
});
it.each(['dispatch-ack','candidate-ack','dispatch-expiry','candidate-expiry'])('canonical %s stays UNKNOWN without resend after actual SQL ACK',async failure=>{
  const f=await joined(); const i=await issue(f); fault=failure; expireAt=i.display.expiresAt;
  const result=await f.invoke(f.request('POST','',{challengeId:i.challengeId,display:i.display},{'x-csrf-token':i.csrfToken}));
  expect(result.status).toBe(202); expect(await result.json()).toMatchObject({status:'UNKNOWN',automaticRetry:false});
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(failure.startsWith('candidate')?1:0);
  const rows=(await h.database.query('SELECT * FROM migration_reacquisition_candidates')).rows; expect(rows).toHaveLength(failure.startsWith('candidate')?1:0);
  if(failure.endsWith('-ack')) { expect(lostAcks).toBe(1); expect(discarded).toBe(1); }
});

it.each(['/challenge',''])('unauthenticated canonical %s overflow is cancelled before any directory or intake SQL',async suffix=>{
  const f=await joined(); let pulls=0,cancelled=false;
  const stream=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(Buffer.alloc(4096,32));},cancel(){cancelled=true;}});
  const headers=new Headers(f.request('POST',suffix).headers); headers.delete('cookie'); headers.set('content-length','1');
  connections=0; sqlStatements=[];
  const result=await f.invoke(new Request(f.request('POST',suffix).url,{method:'POST',headers,body:stream,duplex:'half'} as RequestInit));
  expect(result.status).toBe(403); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(4); expect(connections).toBe(0); expect(sqlStatements).toEqual([]); expect(events).toEqual([]);
});
it.each(['digest','session','membership','job','tenant'])('key-independent archival %s mismatch remains refused without candidate mint or sends',async attack=>{
  const f=await joined(); const i=await issue(f);
  const headers:Record<string,string>={'x-reacquisition-intent-digest':attack==='digest'?'a'.repeat(64):i.intentDigest};
  if(attack==='session') { const r=NextResponse.json({});setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()});headers.cookie=`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`; }
  if(attack==='membership') await h.database.query('DELETE FROM tenant_memberships');
  let request=f.request('GET','/'+i.challengeId,undefined,headers);
  if(attack==='job') request=new Request(request.url.replace(JOB,USER),request);
  if(attack==='tenant') { const other=(await h.database.query<{slug:string}>('SELECT slug FROM tenants WHERE id=$1',[h.tenantOneId])).rows[0].slug;request=new Request(request.url.replace('/'+slug+'/','/'+other+'/'),request); }
  vi.stubEnv('MIGRATION_FREEZING_REACQUISITION_REGISTRATIONS','');
  const result=await f.invoke(request);expect(result.status).toBe(403);expect(events).toEqual([]);
});

it('unscoped target exports and canonical absent directory refuse with no-store and no sends',async()=>{
  const f=await joined(); const targets=[
    [await import('@/app/api/migrations/[jobId]/freezing/reacquisition/bootstrap/route'),'GET','/bootstrap'],
    [await import('@/app/api/migrations/[jobId]/freezing/reacquisition/challenge/route'),'POST','/challenge'],
    [await import('@/app/api/migrations/[jobId]/freezing/reacquisition/route'),'POST',''],
    [await import('@/app/api/migrations/[jobId]/freezing/reacquisition/[attemptId]/route'),'GET','/'+JOB],
  ] as const;
  for(const [target,method,suffix] of targets) {
    const handler=(target as unknown as Record<string,(r:Request,c:{params:Promise<Record<string,string>>})=>Promise<Response>>)[method];
    const result=await handler(new Request(`${ORIGIN}/api/migrations/${JOB}/freezing/reacquisition${suffix}`,{method,headers:{cookie}}),{params:Promise.resolve({jobId:JOB,attemptId:JOB})});
    expect(result.status).toBe(403); expect(result.headers.get('cache-control')).toBe('no-store');
  }
  const scoped=await import('@/app/api/c/[slug]/[...path]/route');
  const request=f.request('GET','/bootstrap');
  const result=await scoped.GET(new Request(request.url.replace('/'+slug+'/','/absent/'),request),{params:Promise.resolve({slug:'absent',path:['migrations',JOB,'freezing','reacquisition','bootstrap']})});
  expect(result.status).toBe(403); expect(result.headers.get('cache-control')).toBe('no-store'); expect(events).toEqual([]);
});
