// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync, hkdfSync, sign, type KeyObject } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
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
let oldNonce: string, priorCandidateNonce: string;
let sqlStatements: string[] = [], databaseClocks: number[] = [];
let responseMutation: (() => Promise<void>) | undefined;
let lastWire: { auth: { issuedAt: number; expiresAt: number }; wrapper: unknown; challenge: import('./freezingReacquisitionContract').FreezingReacquisitionChallenge } | undefined;
const clients: InstanceType<typeof OAuth2>[] = [];
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
  sqlStatements = []; databaseClocks = []; responseMutation = undefined; lastWire = undefined;
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
  loseStartAck = false; connections = 0; discarded = 0; lostAcks = 0; fault = undefined; expireAt = 0; oldNonce = ''; priorCandidateNonce = '';
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
      oldNonce = (await response.clone().json()).nonce;
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

async function candidateFixture(upgrade = false, skipStart = false, registrationVersion = '1') {
  const tenantId = fixtureTenant, jobId = JOB, fixtureSourceId = sourceId, fixtureSlug = slug, sheetId = spreadsheetId;
  if (!skipStart) {
    const { callback } = await ceremony();
    const fixed = await import('@/app/api/migrations/google-sheets/callback/route');
    expect((await fixed.GET(callback)).status).toBe(200);
    if (upgrade) {
      const tables=(await h.database.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename);
      const prior=await Promise.all(tables.map(t=>h.database.query(`SELECT * FROM ${t}`)));
      expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toHaveLength(1);
      await h.database.exec(await readFile(resolve('src/server/db/migrations/0023_freezing_reacquisition_intake.sql'),'utf8'));
      const after=await Promise.all(tables.map(t=>h.database.query(t==='migration_bridge_consumptions'?'SELECT nonce_digest,tenant_id,challenge_id FROM migration_bridge_consumptions':`SELECT * FROM ${t}`)));
      expect(after.map(r=>r.rows)).toEqual(prior.map(r=>r.rows));
    }
  }
  const implementation = await import('./freezingReacquisitionIntake');
  await h.database.exec('GRANT SELECT,INSERT ON migration_reacquisition_challenges,migration_reacquisition_dispatches,migration_reacquisition_candidates TO app_runtime');
  const { createFreezingProducerReservations } = await import('./freezingProducerReservations');
  const { createRegisteredFreezingReacquisition } = await import('./registeredFreezingReacquisition');
  const { createTenantTransactionRunner } = await import('@/server/db/transaction');
  const { getDatabaseClient } = await import('@/server/db/client');
  const requestKeys = generateKeyPairSync('ed25519'), manifestKeys = generateKeyPairSync('ed25519'), writerKeys = generateKeyPairSync('ed25519');
  const registration = { tenantId: tenantId, sourceId: fixtureSourceId, spreadsheetId: sheetId, deploymentId: 'local-companion',
    registrationVersion, registrationDigest: hash('independent-read-registration:'+registrationVersion), approvedScope: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE' as const,
    endpoint: 'https://local.example/api/internal/migrations/freezing-reacquisition', requestKeyId: 'read-1',
    requestPublicKey: requestKeys.publicKey, manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writerKeys.publicKey };
  const reservations = createFreezingProducerReservations({ connect: async () => ({ query: async <T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> => {
    const result = await h.database.query(text, values ? [...values] : undefined);
    if (text.startsWith('BEGIN')) await h.database.exec('SET LOCAL ROLE "local-companion"');
    return { rows: result.rows as T[], rowCount: result.affectedRows ?? null, command: '', oid: 0, fields: [] };
  }, release: () => {} }) }, 'local-companion');
  const sheets = fixtureSheets();
  const producer = createRegisteredFreezingReacquisition({ registration, reservations,
    sheets: { listSheetNames: async () => { events.push('candidate-sheets'); return Object.keys(sheets.tabs); }, getRevision: async () => 'candidate-new-revision',
      getRows: async name => [sheets.tabs[name].headers, ...sheets.tabs[name].rows.map(r => r.cells), ...(name === 'Products' ? [['P2','New eraser','10','8','TRUE','','school','1']] : [])] },
    manifest: { keyId: 'candidate-key', signingPrivateKey: manifestKeys.privateKey, encryptionKey: Buffer.alloc(32, 8) } });
  const priorFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
    expect(active).toBe(0);
    if (String(url) === registration.endpoint) {
      events.push('candidate-send'); const r = await producer(new Request(url, init));
      if (fault === 'transport') throw Error('Synthetic lost companion response');
      if (fault === 'membership-response') await h.database.query('DELETE FROM tenant_memberships');
      expect(r.status).toBe(200);
      const wrapper = await r.clone().json();
      lastWire = { auth: JSON.parse(Buffer.from(new Headers(init.headers).get('x-class-store-freezing-reacquisition')!, 'base64url').toString()), wrapper, challenge: JSON.parse(String(init.body)).challenge };
      if (responseMutation) await responseMutation();
      if (fault === 'crossphase-nonce' || fault === 'samephase-nonce') {
        const {openFreezingReacquisitionEnvelope} = await import('./registeredFreezingReacquisition');
        const {sealLegacyBridgeManifest} = await import('./legacyBridgeManifest');
        const payload = await openFreezingReacquisitionEnvelope(wrapper,{encryptionKey:Buffer.alloc(32,8),signingPublicKey:manifestKeys.publicKey,expectedChallenge:JSON.parse(String(init.body)).challenge,nonceConsumer:{consumeOnce:async()=>true}});
        const sealAt = Date.now();
        const envelope = sealLegacyBridgeManifest(payload,{keyId:'candidate-key',signingPrivateKey:manifestKeys.privateKey,
          encryptionKey:Buffer.from(hkdfSync('sha256',Buffer.alloc(32,8),'CLASS_STORE_FREEZING_REACQUISITION','encrypted-candidate:v1',32)),
          nonce:()=>Buffer.from(fault==='crossphase-nonce'?oldNonce:priorCandidateNonce,'base64url'),now:()=>sealAt,ttlMs:payload.challenge.expiresAt-sealAt});
        return Response.json({...wrapper,envelope});
      }
      priorCandidateNonce=wrapper.envelope.nonce;
      return r;
    }
    return priorFetch(url, init);
  });
  const intake = implementation.createFreezingReacquisitionIntake({ tenantId: tenantId, migrationJobId: jobId,
    origin: ORIGIN, canonicalPath: `/api/c/${fixtureSlug}/migrations/${jobId}/freezing/reacquisition`, env,
    registration, requestPrivateKey: requestKeys.privateKey, encryptionKey: Buffer.alloc(32, 8), manifestKeyId: 'candidate-key',
    runTransaction: createTenantTransactionRunner({ pool: getDatabaseClient().pool }, { maxAttempts: 1 }) });
  const path = `${ORIGIN}/api/c/${fixtureSlug}/migrations/${jobId}/freezing/reacquisition`;
  const request = (method: string, suffix = '', body?: unknown, extra: Record<string,string> = {}) => new Request(path + suffix, {
    method, headers: { cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { intake, request, registration, producer, requestKeys, manifestKeys };
}
it('actual authenticated bootstrap and confirmation reach real signed producer and immutable SQL candidate without changing FREEZING', async () => {
  const { intake, request, registration } = await candidateFixture();
  expect((await h.database.query<{version:string}>("SELECT state_version::text AS version FROM migration_jobs WHERE job_id=$1",[JOB])).rows[0].version).toBe(String(BigInt(version)+BigInt(1)));
  expect(connections).toBeGreaterThan(0);
  await h.database.exec("UPDATE migration_sources SET grant_expires_at=now()+interval '1 hour'");
  await h.database.query("INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'unrelated-claim','MIGRATION_IMPORT',$2)", [h.tenantOneId, hash('unrelated')]);
  await h.database.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
    VALUES('PADLET','other-board','other-post',encode(digest(convert_to('other-board','UTF8')||decode('00','hex')||convert_to('other-post','UTF8'),'sha256'),'hex'),$1,'unrelated-claim',now(),'Other Student')`, [h.tenantOneId]);
  await h.database.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'unrelated-source')", [hash('unrelated-tuple'), hash('unrelated-owner')]);
  const tables = (await h.database.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename);
  const allowed = new Set(['migration_reacquisition_challenges','migration_reacquisition_dispatches','migration_reacquisition_candidates','migration_bridge_consumptions','migration_bridge_producer_reservations','audit_events']);
  const preserved = tables.filter(t => !allowed.has(t));
  const snapshot = await Promise.all(preserved.map(t => h.database.query(`SELECT * FROM ${t}`)));
  const beforeBootstrap = await Promise.all(tables.map(t => h.database.query(`SELECT * FROM ${t}`)));
  const bootstrap = await intake.bootstrap(request('GET', '/bootstrap')); expect(bootstrap.status).toBe(200);
  expect(bootstrap.headers.get('cache-control')).toBe('no-store');
  expect(await Promise.all(tables.map(t => h.database.query(`SELECT * FROM ${t}`)))).toEqual(beforeBootstrap);
  const bootstrapBody = await bootstrap.json(); const bootstrapCookie = bootstrap.headers.get('set-cookie')!;
  expect(bootstrapCookie).toContain('HttpOnly'); expect(bootstrapCookie).toContain('Secure'); expect(bootstrapCookie).toContain('SameSite=Strict'); expect(bootstrapCookie).not.toContain('Domain=');
  const challenge = await intake.challenge(request('POST', '/challenge', {}, { cookie: `${cookie}; ${bootstrapCookie.split(';')[0]}`, 'x-csrf-token': bootstrapBody.csrfToken }));
  expect(challenge.status).toBe(200); const issued = await challenge.json();
  expect(issued.display).toMatchObject({ action: registration.approvedScope, spreadsheetId: 'sheet-1', exclusion: 'NOT_PROVEN', automaticRetry: false, automaticEnable: false });
  const confirm = () => intake.confirm(request('POST', '', { challengeId: issued.challengeId, display: issued.display }, { 'x-csrf-token': issued.csrfToken }));
  const before = events.length; const result = await confirm(); expect(result.status).toBe(200);
  const fact = await result.json(); expect(fact).toMatchObject({ status: 'AUTHENTIC_FREEZING_ACQUISITION', authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', finalImportEligible: false });
  expect(events.slice(before).filter(e => e === 'candidate-send')).toHaveLength(1); expect(events.slice(before)).not.toContain('disable');
  expect(events.slice(before).filter(e => e === 'readback')).toHaveLength(2);
  expect(await Promise.all(preserved.map(t => h.database.query(`SELECT * FROM ${t}`)))).toEqual(snapshot);
  const rows = (await h.database.query<{binding: Record<string,unknown>}>('SELECT binding FROM migration_reacquisition_candidates')).rows;
  expect(rows).toHaveLength(1); expect(rows[0].binding.candidateDigest).toBe(fact.candidateDigest);
  const audits = (await h.database.query<{redacted_details: {payload: {sheetsSnapshot: {digest:string}}}}>("SELECT redacted_details FROM audit_events WHERE event_type='AUTHENTIC_FREEZING_ACQUISITION'")).rows;
  expect(audits).toHaveLength(1); expect(audits[0].redacted_details.payload.sheetsSnapshot.digest).not.toBe(issued.display.sourceAcquisitionDigest);
  expect(JSON.stringify(audits)).toContain('New eraser');
  expect((await h.database.query('SELECT * FROM products WHERE tenant_id=$1',[h.tenantTwoId])).rows).toHaveLength(1);
  const sent = [...events]; expect((await confirm()).status).not.toBe(200); expect(events).toEqual(sent);
  const archive = await intake.status(request('GET', `/${issued.challengeId}`, undefined, { 'x-reacquisition-intent-digest': issued.intentDigest }));
  expect(archive.status).toBe(200); expect(await archive.json()).toMatchObject({ scope: 'ARCHIVAL_ONLY', candidateDigest: fact.candidateDigest }); expect(events).toEqual(sent);
});

async function candidateChallenge(fixture = undefined as Awaited<ReturnType<typeof candidateFixture>> | undefined) {
  fixture ??= await candidateFixture();
  const bootstrap = await fixture.intake.bootstrap(fixture.request('GET','/bootstrap')); expect(bootstrap.status).toBe(200);
  const boot = await bootstrap.json(); const bootCookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const challenge = await fixture.intake.challenge(fixture.request('POST','/challenge',{}, { cookie: `${cookie}; ${bootCookie}`, 'x-csrf-token': boot.csrfToken }));
  expect(challenge.status).toBe(200); const issued = await challenge.json();
  return { ...fixture, boot, bootCookie, issued, challenge };
}
it.each(['missing','duplicate','forged','session','token','origin','fetch-site','expired','wrong-purpose'])('bootstrap challenge rejection without SQL issuance or send: %s', async mode => {
  const {intake,request} = await candidateFixture();
  const bootstrap = await intake.bootstrap(request('GET','/bootstrap')); expect(bootstrap.status).toBe(200);
  const boot = await bootstrap.json(); let bootCookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const headers: Record<string,string> = {cookie:`${cookie}; ${bootCookie}`,'x-csrf-token':boot.csrfToken};
  if (mode==='missing') headers.cookie=cookie;
  if (mode==='duplicate') headers.cookie+=`; ${bootCookie}`;
  if (mode==='forged' || mode==='wrong-purpose') {
    const [name,encoded] = bootCookie.split('='); const [bytes,signature] = encoded.split('.');
    const data=JSON.parse(Buffer.from(bytes,'base64url').toString());
    data[mode==='forged'?'tenantId':'purpose']=mode==='forged'?h.tenantOneId:'CLASS_STORE_FREEZING_CONSENT_SESSION_V1';
    bootCookie=`${name}=${Buffer.from(JSON.stringify(data)).toString('base64url')}.${signature}`;
    headers.cookie=`${cookie}; ${bootCookie}`;
  }
  if (mode==='session') { const r=NextResponse.json({}); setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()}); headers.cookie=`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}; ${bootCookie}`; }
  if (mode==='token') headers['x-csrf-token']='0'.repeat(64);
  if (mode==='origin') headers.origin='https://store.example.evil.invalid';
  if (mode==='fetch-site') headers['sec-fetch-site']='cross-site';
  if (mode==='expired') vi.spyOn(Date,'now').mockReturnValue(boot.expiresAt);
  const before=[...events];
  expect((await intake.challenge(request('POST','/challenge',{},headers))).status).toBe(403);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_challenges')).rows).toHaveLength(0); expect(events).toEqual(before);
});
it.each(['no-origin','foreign-origin','no-fetch-site','cross-site','compat','nonmember'])('bootstrap GET requires real same-origin authenticated membership: %s',async mode=>{
  const {intake,request}=await candidateFixture(); const headers:Record<string,string>={};
  if(mode==='foreign-origin') headers.origin='https://evil.invalid';
  if(mode==='cross-site') headers['sec-fetch-site']='cross-site';
  if(mode==='compat') headers.cookie='class_store_tenant_admin=synthetic';
  if(mode==='nonmember') await h.database.query('DELETE FROM tenant_memberships');
  const r=request('GET','/bootstrap',undefined,headers);
  if(mode==='no-origin') { r.headers.delete('origin'); r.headers.delete('sec-fetch-site'); }
  if(mode==='no-fetch-site') r.headers.delete('sec-fetch-site');
  const before=[...events]; expect((await intake.bootstrap(r)).status).toBe(403); expect(events).toEqual(before);
});
it.each(['csrf','bootstrap-token','display','extra','origin','membership','session','expired'])('confirmation refuses wrong authority before reservation: %s',async mode=>{
  const {intake,request,issued,boot}=await candidateChallenge();
  const headers:Record<string,string>={'x-csrf-token':issued.csrfToken};
  const body:Record<string,unknown>={challengeId:issued.challengeId,display:issued.display};
  if(mode==='csrf') headers['x-csrf-token']='0'.repeat(64);
  if(mode==='bootstrap-token') headers['x-csrf-token']=boot.csrfToken;
  if(mode==='display') body.display={...issued.display,action:'FINAL_IMPORT'};
  if(mode==='extra') body.endpoint='https://evil.invalid';
  if(mode==='origin') headers.origin='https://evil.invalid';
  if(mode==='membership') await h.database.query('DELETE FROM tenant_memberships');
  if(mode==='session') { const r=NextResponse.json({}); setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()}); headers.cookie=`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`; }
  if(mode==='expired') vi.spyOn(Date,'now').mockReturnValue(issued.display.expiresAt);
  const before=[...events]; const result=await intake.confirm(request('POST','',body,headers)); expect(result.status).toBe(403);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_dispatches')).rows).toHaveLength(0); expect(events).toEqual(before);
});
it('new SQL relations have matching ORM shapes and reject owner mutation and runtime tenant escape',async()=>{
  const {intake,request,issued}=await candidateChallenge();
  expect((await intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}))).status).toBe(200);
  const schema=await import('@/server/db/schema');
  const {getTableConfig}=await import('drizzle-orm/pg-core');
  for(const name of ['migrationReacquisitionChallenges','migrationReacquisitionDispatches','migrationReacquisitionCandidates','migrationBridgeConsumptions'] as const){
    const table=schema[name]; expect(table, name).toBeDefined(); const config=getTableConfig(table);
    const columns=(await h.database.query<{column_name:string;is_nullable:string;data_type:string}>("SELECT column_name,is_nullable,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[config.name])).rows;
    expect(columns.map(c=>[c.column_name,c.is_nullable==='NO',c.data_type])).toEqual(config.columns.map(c=>[c.name,c.notNull,c.getSQLType()==='uuid'?'uuid':c.getSQLType()==='jsonb'?'jsonb':'text']));
    const constraints=(await h.database.query<{conname:string;contype:string;definition:string}>("SELECT conname,contype,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u','f','c') ORDER BY conname",[config.name])).rows;
    const expectedNames=[...config.primaryKeys.map(c=>c.getName()),...config.uniqueConstraints.map(c=>c.name),...config.foreignKeys.map(c=>c.getName()),...config.checks.map(c=>c.name)].sort();
    expect(constraints.map(c=>c.conname)).toEqual(expectedNames);
    const {getTableName}=await import('drizzle-orm'); const {PgDialect}=await import('drizzle-orm/pg-core');
    const compact=(text:string)=>text.replace(/[\s"]/g,'');
    for(const fk of config.foreignKeys){
      const reference=fk.reference(); const expected=`FOREIGN KEY (${reference.columns.map(c=>c.name).join(',')}) REFERENCES ${getTableName(reference.foreignTable)}(${reference.foreignColumns.map(c=>c.name).join(',')})`;
      expect(compact(constraints.find(c=>c.conname===fk.getName())!.definition)).toBe(compact(expected));
      expect(fk.onDelete??'no action').toBe('no action'); expect(fk.onUpdate??'no action').toBe('no action');
    }
    // Have PostgreSQL canonicalize independently compiled ORM CHECK expressions.
    const dialect=new PgDialect(); const parity=`parity_${config.name}`;
    const checkDDL=config.checks.map(c=>`CONSTRAINT ${c.name} CHECK (${dialect.sqlToQuery(c.value).sql.replaceAll('"'+config.name+'".','')})`);
    await h.database.exec(`CREATE TEMP TABLE ${parity} (${[...config.columns.map(c=>`${c.name} ${c.getSQLType()}`),...checkDDL].join(',')})`);
    const ormChecks=(await h.database.query<{conname:string;definition:string}>("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c' ORDER BY conname",[parity])).rows;
    expect(constraints.filter(c=>c.contype==='c').map(c=>({conname:c.conname,definition:c.definition}))).toEqual(ormChecks);
    const rls=(await h.database.query<{relrowsecurity:boolean;relforcerowsecurity:boolean}>('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1',[config.name])).rows[0]; expect(rls).toEqual({relrowsecurity:true,relforcerowsecurity:true});
    for(const statement of [`UPDATE ${config.name} SET tenant_id=tenant_id`,`DELETE FROM ${config.name}`,`TRUNCATE ${config.name} CASCADE`]) await expect(h.database.exec(statement)).rejects.toThrow();
  }
  const count=(await h.database.query('SELECT * FROM migration_reacquisition_candidates')).rows; expect(count).toHaveLength(1);
  const foreign=await h.runTenantTransaction(h.tenantOneId,async tx=>{
    const {sql}=await import('drizzle-orm'); return (await tx.execute(sql`SELECT * FROM migration_reacquisition_candidates`)).rows;
  }); expect(foreign).toHaveLength(0);
});

it.each(['dispatch-ack','candidate-ack','transport','membership-response','nonce-expiry','dispatch-expiry','candidate-expiry'])('actual SQL reservation and candidate uncertainty are terminal: %s',async mode=>{
  const {intake,request,issued}=await candidateChallenge(); fault=mode; expireAt=issued.display.expiresAt;
  const before=events.filter(e=>e==='candidate-send').length; const previousAcks=lostAcks; const previousDiscards=discarded;
  const confirm=()=>intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}));
  const result=await confirm(); expect(result.status).toBe(202); expect(await result.json()).toMatchObject({status:'UNKNOWN',automaticRetry:false,automaticEnable:false});
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(before+(mode.startsWith('dispatch-')?0:1));
  expect((await h.database.query('SELECT * FROM migration_reacquisition_dispatches')).rows).toHaveLength(1);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_candidates')).rows).toHaveLength(mode.startsWith('candidate-')?1:0);
  expect((await h.database.query('SELECT * FROM migration_bridge_consumptions WHERE freezing_challenge_id IS NOT NULL')).rows).toHaveLength(mode.startsWith('candidate-')?1:0);
  if(mode.endsWith('ack')) { expect(lostAcks).toBe(previousAcks+1); expect(discarded).toBe(previousDiscards+1); }
  const sent=[...events]; await confirm(); expect(events).toEqual(sent);
  if(mode==='candidate-ack'){
    const archive=await intake.status(request('GET',`/${issued.challengeId}`,undefined,{'x-reacquisition-intent-digest':issued.intentDigest}));
    expect(archive.status).toBe(200); expect(await archive.json()).toMatchObject({status:'AUTHENTIC_FREEZING_ACQUISITION',scope:'ARCHIVAL_ONLY'});
  }
});
it.each(['migration_reacquisition_candidates','audit_events','migration_bridge_consumptions'])('actual SQL INSERT suppression rolls back candidate and consumer nonce: %s',async table=>{
  const {intake,request,issued}=await candidateChallenge();
  await h.database.exec(`CREATE FUNCTION suppress_candidate_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_candidate_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION suppress_candidate_insert()`);
  const result=await intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}));
  expect(result.status).toBe(202);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_dispatches')).rows).toHaveLength(1);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_candidates')).rows).toHaveLength(0);
  expect((await h.database.query('SELECT * FROM migration_bridge_consumptions WHERE freezing_challenge_id IS NOT NULL')).rows).toHaveLength(0);
  expect((await h.database.query("SELECT * FROM audit_events WHERE event_type='AUTHENTIC_FREEZING_ACQUISITION'")).rows).toHaveLength(0);
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(1);
  expect((await h.database.query("SELECT * FROM migration_bridge_producer_reservations WHERE purpose='CLASS_STORE_REGISTERED_FREEZING_REACQUISITION_REQUEST'")).rows).toHaveLength(1);
});
it('candidate FK refuses a genuine old-phase nonce even when tenant and audit exist',async()=>{
  const {intake,request,issued}=await candidateChallenge(); fault='transport';
  expect((await intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}))).status).toBe(202);
  const nonce=(await h.database.query<{nonce_digest:string}>('SELECT nonce_digest FROM migration_bridge_consumptions WHERE challenge_id IS NOT NULL')).rows[0].nonce_digest;
  const audit=(await h.database.query<{event_id:string}>("SELECT event_id FROM audit_events WHERE event_type='AUTHENTIC_START_ACQUISITION'")).rows[0].event_id;
  const binding={purpose:'CLASS_STORE_FREEZING_REACQUISITION',tenantId:h.tenantTwoId,challengeId:issued.challengeId,nonceDigest:nonce,auditEventId:audit,
    candidateDigest:hash('forged-candidate'),authority:'NONAUTHORITY',exclusion:'NOT_PROVEN',finalImportEligible:false};
  await expect(h.database.query('INSERT INTO migration_reacquisition_candidates(tenant_id,challenge_id,nonce_digest,audit_event_id,binding) VALUES($1,$2,$3,$4,$5)',[h.tenantTwoId,issued.challengeId,nonce,audit,JSON.stringify(binding)])).rejects.toThrow();
});

it.each(['crossphase-nonce','samephase-nonce'])('actual signed candidate with reused global raw nonce is rejected atomically: %s',async mode=>{
  const {intake,request,issued}=await candidateChallenge();
  let second=issued;
  if(mode==='samephase-nonce') {
    expect((await intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}))).status).toBe(200);
    const bootstrap=await intake.bootstrap(request('GET','/bootstrap')); const boot=await bootstrap.json();
    const r=await intake.challenge(request('POST','/challenge',{}, {cookie:`${cookie}; ${bootstrap.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':boot.csrfToken}));
    expect(r.status).toBe(200); second=await r.json();
  }
  expect(oldNonce).toBeTruthy(); if(mode==='samephase-nonce') expect(priorCandidateNonce).toBeTruthy();
  const original=(await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows;
  fault=mode;
  const r=await intake.confirm(request('POST','',{challengeId:second.challengeId,display:second.display},{'x-csrf-token':second.csrfToken}));
  expect(r.status).toBe(202); expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toEqual(original);
  expect((await h.database.query('SELECT * FROM migration_reacquisition_candidates')).rows).toHaveLength(mode==='samephase-nonce'?1:0);
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(mode==='samephase-nonce'?2:1);
});
it('archival fact rejects wrong intent and renewed login without sends or capability mint',async()=>{
  const {intake,request,issued}=await candidateChallenge();
  expect((await intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}))).status).toBe(200);
  const before=[...events];
  expect((await intake.status(request('GET',`/${issued.challengeId}`,undefined,{'x-reacquisition-intent-digest':'0'.repeat(64)}))).status).toBe(403);
  const r=NextResponse.json({});setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()});
  expect((await intake.status(request('GET',`/${issued.challengeId}`,undefined,{'x-reacquisition-intent-digest':issued.intentDigest,cookie:`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`}))).status).toBe(403);
  await h.database.query('DELETE FROM tenant_memberships');
  expect((await intake.status(request('GET',`/${issued.challengeId}`,undefined,{'x-reacquisition-intent-digest':issued.intentDigest}))).status).toBe(403);
  expect(events).toEqual(before);
});

// Coverage additions exercise existing guards; an initially green assertion is
// regression evidence, never an invented behavior RED.
async function safetyRows() {
  return Promise.all(['migration_reacquisition_dispatches','migration_reacquisition_candidates','migration_bridge_consumptions','audit_events']
    .map(async table => (await h.database.query(`SELECT * FROM ${table} ORDER BY 1,2`)).rows));
}
async function drift(kind: string) {
  const before = (await h.database.query<{semantic:string;acquisition:string}>(`SELECT j.source_fingerprint AS semantic,s.source_fingerprint AS acquisition
    FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1`,[JOB])).rows[0];
  expect(before.semantic).not.toBe(before.acquisition);
  if (kind === 'semantic') await h.database.query('UPDATE migration_jobs SET source_fingerprint=$1 WHERE job_id=$2',[hash('independent-semantic-drift'),JOB]);
  if (kind === 'acquisition') await h.database.query('UPDATE migration_sources SET source_fingerprint=$1 WHERE job_id=$2',[hash('independent-acquisition-drift'),JOB]);
  if (kind === 'preflight-zero') await h.withMigrationSnapshotTampering(async () => {
    // Preserve the referenced identity; only remove membership in PREFLIGHT.
    await h.database.query("UPDATE migration_snapshots SET phase='ROLLBACK_EXPORT' WHERE job_id=$1 AND phase='PREFLIGHT'",[JOB]);
  });
  if (kind === 'preflight-two') await h.database.query(`INSERT INTO migration_snapshots(tenant_id,snapshot_id,job_id,source_id,phase,artifact_digest,redacted_manifest,row_count)
    SELECT tenant_id,'independent-extra-preflight',job_id,source_id,phase,$1,redacted_manifest,row_count FROM migration_snapshots WHERE job_id=$2 AND phase='PREFLIGHT'`,[hash('extra-preflight'),JOB]);
  const after = (await h.database.query<{semantic:string;acquisition:string}>(`SELECT j.source_fingerprint AS semantic,s.source_fingerprint AS acquisition
    FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1`,[JOB])).rows[0];
  expect(after.semantic).toBe(kind==='semantic'?hash('independent-semantic-drift'):before.semantic);
  expect(after.acquisition).toBe(kind==='acquisition'?hash('independent-acquisition-drift'):before.acquisition);
  expect((await h.database.query("SELECT * FROM migration_snapshots WHERE job_id=$1 AND phase='PREFLIGHT'",[JOB])).rows)
    .toHaveLength(kind==='preflight-zero'?0:kind==='preflight-two'?2:1);
  expect((await h.database.query<{tgenabled:string}>("SELECT tgenabled FROM pg_trigger WHERE tgrelid='migration_snapshots'::regclass AND NOT tgisinternal")).rows.every(t=>t.tgenabled==='O')).toBe(true);
}
it.each(['semantic','acquisition','preflight-zero','preflight-two'].flatMap(kind=>['issuance','presend','response'].map(stage=>({kind,stage}))))(
  'independent current-binding drift rejects $kind at $stage',async({kind,stage})=>{
    const f=await candidateChallenge();
    expect(f.issued.display.jobSemanticFingerprint).not.toBe(f.issued.display.sourceAcquisitionDigest);
    const rows=await safetyRows(); const sent=[...events]; const trace=sqlStatements.length;
    if(stage==='response') responseMutation=()=>drift(kind); else await drift(kind);
    const r=stage==='issuance'
      ? await f.intake.challenge(f.request('POST','/challenge',{}, {cookie:`${cookie}; ${f.bootCookie}`,'x-csrf-token':f.boot.csrfToken}))
      : await f.intake.confirm(f.request('POST','',{challengeId:f.issued.challengeId,display:f.issued.display},{'x-csrf-token':f.issued.csrfToken}));
    expect(r.status).toBe(stage==='response'?202:403);
    const after=await safetyRows(); expect(after.slice(1)).toEqual(rows.slice(1));
    expect(after[0]).toHaveLength(stage==='response'?1:0);
    expect(sqlStatements.slice(trace).filter(s=>s.includes('INSERT INTO migration_reacquisition_candidates'))).toHaveLength(0);
    expect(sqlStatements.slice(trace).filter(s=>s.includes('INSERT INTO migration_reacquisition_dispatches'))).toHaveLength(stage==='response'?1:0);
    if(stage==='response') {
      expect(lastWire).toBeDefined(); expect(events.filter(e=>e==='candidate-send')).toHaveLength(1);
      const {openFreezingReacquisitionEnvelope}=await import('./registeredFreezingReacquisition');
      const consume=vi.fn(async()=>true);
      await openFreezingReacquisitionEnvelope(lastWire!.wrapper,{encryptionKey:Buffer.alloc(32,8),signingPublicKey:f.manifestKeys.publicKey,expectedChallenge:lastWire!.challenge,nonceConsumer:{consumeOnce:consume}});
      expect(consume).toHaveBeenCalledOnce();
    } else expect(events).toEqual(sent);
    expect((await h.database.query('SELECT * FROM migration_reacquisition_challenges')).rows).toHaveLength(1);
  });
type ChallengeFixture = Awaited<ReturnType<typeof candidateChallenge>>;
const confirmation = (f: ChallengeFixture, login = cookie, issued = f.issued) => f.intake.confirm(f.request('POST','',
  {challengeId:issued.challengeId,display:issued.display},{cookie:login,'x-csrf-token':issued.csrfToken}));
function genuineLogin(subject='owner', email='owner@example.invalid', issuedAt=Date.now()-1000) {
  const r=NextResponse.json({}); setGoogleSessionCookie(r,{subject,email,issuedAt});
  return `${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
}
it.each(['bootstrap-to-confirmation','confirmation-to-bootstrap','cross-challenge-token','actor','original-session','registration'])(
  'genuine independent authority swap reaches central rejection: %s',async mode=>{
    const f=await candidateChallenge(); const originalLogin=cookie;
    let other=f;
    if(mode==='actor') {
      const actor='20000000-0000-4000-8000-000000000099';
      await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'other-owner','other@example.invalid')",[actor]);
      await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[fixtureTenant,actor]);
      cookie=genuineLogin('other-owner','other@example.invalid');
    }
    if(mode==='original-session') cookie=genuineLogin();
    if(['cross-challenge-token','actor','original-session'].includes(mode)) other=await candidateChallenge(f);
    if(mode==='registration') other=await candidateChallenge(await candidateFixture(false,true,'2'));
    if(mode==='actor') expect(other.issued.display.actorUserId).not.toBe(f.issued.display.actorUserId);
    if(mode==='original-session') {
      expect(other.issued.display.actorUserId).toBe(f.issued.display.actorUserId);
      expect(other.issued.display.sessionBinding).not.toBe(f.issued.display.sessionBinding);
    }
    if(mode==='registration') {
      expect(other.issued.display.registrationVersion).toBe('2');
      expect(other.issued.display.registrationDigest).not.toBe(f.issued.display.registrationDigest);
    }
    const before=await safetyRows(); const sent=[...events]; const trace=sqlStatements.length;
    let r:Response;
    if(mode==='confirmation-to-bootstrap') r=await f.intake.challenge(f.request('POST','/challenge',{},
      {cookie:`${originalLogin}; ${f.bootCookie}`,'x-csrf-token':f.issued.csrfToken}));
    else {
      const consumer=mode==='registration'?other:f;
      r=await consumer.intake.confirm(consumer.request('POST','',{challengeId:f.issued.challengeId,display:f.issued.display},
        {cookie,'x-csrf-token':mode==='bootstrap-to-confirmation'?f.boot.csrfToken:mode==='cross-challenge-token'?other.issued.csrfToken:f.issued.csrfToken}));
    }
    expect(r.status).toBe(403);
    expect(events).toEqual(sent); expect(await safetyRows()).toEqual(before);
    expect(sqlStatements.slice(trace).filter(s=>/INSERT INTO migration_reacquisition_(dispatches|candidates)/.test(s))).toHaveLength(0);
    // Positive issuance for the swapped actor/session/challenge already proves
    // membership and login validity independently of the refused old intent.
  });
it.each(['bootstrap-tenant','bootstrap-job','bootstrap-purpose','bootstrap-actor','bootstrap-session'])('proper-MAC bootstrap rejects independently valid binding substitution: %s',async mode=>{
  const target=await candidateChallenge(); const targetLogin=cookie;
  let donor=target;
  if(mode==='bootstrap-tenant'||mode==='bootstrap-job') {
    await prepareFixture('independent-bootstrap-peer',true); donor=await candidateChallenge();
  } else if(mode==='bootstrap-actor') {
    const actor='20000000-0000-4000-8000-000000000099';
    await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'other-owner','other@example.invalid')",[actor]);
    await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[fixtureTenant,actor]);
    cookie=genuineLogin('other-owner','other@example.invalid'); donor=await candidateChallenge(target);
  } else if(mode==='bootstrap-session') { cookie=genuineLogin(); donor=await candidateChallenge(target); }
  const {createHmac}=await import('node:crypto');
  const [name,encoded]=target.bootCookie.split('='); const [originalBytes,originalMac]=encoded.split('.');
  const path=new URL(target.request('POST','/challenge').url).pathname.replace(/\/challenge$/,'');
  const mac=(bytes:string)=>createHmac('sha256',env.AUTH_SECRET).update(canonicalJson(['CLASS_STORE_FREEZING_REACQUISITION_BOOTSTRAP_V1',ORIGIN,path,bytes])).digest('hex');
  expect(mac(originalBytes)).toBe(originalMac);
  const b=JSON.parse(Buffer.from(originalBytes,'base64url').toString());
  const foreign=JSON.parse(Buffer.from(donor.bootCookie.split('=')[1].split('.')[0],'base64url').toString());
  const field=mode==='bootstrap-tenant'?'tenantId':mode==='bootstrap-job'?'migrationJobId':mode==='bootstrap-purpose'?'purpose':mode==='bootstrap-actor'?'actorUserId':'sessionBinding';
  const value=mode==='bootstrap-purpose'?'CLASS_STORE_FREEZING_CONSENT_SESSION_V1':foreign[field];
  expect(value).not.toBe(b[field]); b[field]=value;
  // Preserve every other original binding and the original valid synchronizer.
  const bytes=Buffer.from(canonicalJson(b)).toString('base64url'); const signedCookie=`${name}=${bytes}.${mac(bytes)}`;
  const before=await safetyRows(); const sent=[...events]; const trace=sqlStatements.length;
  const r=await target.intake.challenge(target.request('POST','/challenge',{}, {cookie:`${targetLogin}; ${signedCookie}`,'x-csrf-token':target.boot.csrfToken}));
  expect(r.status).toBe(403); expect(await safetyRows()).toEqual(before); expect(events).toEqual(sent);
  expect(sqlStatements.slice(trace).filter(s=>/INSERT INTO migration_reacquisition_(challenges|dispatches|candidates)/.test(s))).toHaveLength(0);
});
it.each(['bootstrap','challenge','signed-envelope','registration-envelope','challenge-envelope'])('genuine eligible tenant job source start swap: %s',async mode=>{
  const target=await candidateChallenge(); const targetLogin=cookie;
  const independent=mode!=='registration-envelope'&&mode!=='challenge-envelope';
  if(independent) await prepareFixture('independent-peer',true);
  const donor=independent?await candidateChallenge():await candidateChallenge(mode==='registration-envelope'?await candidateFixture(false,true,'2'):target);
  const donorLogin=cookie;
  if(independent) for(const key of ['tenantId','migrationJobId','sourceId','startCeremonyId','executionDigest','preflightSnapshotId','spreadsheetIdDigest'])
    expect(donor.issued.display[key],key).not.toBe(target.issued.display[key]);
  expect(donor.issued.challengeId).not.toBe(target.issued.challengeId);
  if(mode==='registration-envelope') expect(donor.issued.display.registrationDigest).not.toBe(target.issued.display.registrationDigest);
  const starts=(await h.database.query('SELECT * FROM migration_start_executions')).rows; expect(starts).toHaveLength(independent?2:1);
  expect((await h.database.query("SELECT * FROM migration_jobs WHERE status='FREEZING'")).rows).toHaveLength(independent?2:1);
  const before=await safetyRows(); const sent=[...events]; const trace=sqlStatements.length;
  if(mode==='bootstrap') {
    // Both payload and synchronizer are genuinely issued. Re-MAC for the target
    // path with the test server key so rejection cannot be a path-MAC mismatch.
    const {createHmac}=await import('node:crypto');
    const [name,encoded]=donor.bootCookie.split('='); const bytes=encoded.split('.')[0];
    const path=new URL(target.request('POST','/challenge').url).pathname.replace(/\/challenge$/,'');
    const mac=createHmac('sha256',env.AUTH_SECRET).update(canonicalJson(['CLASS_STORE_FREEZING_REACQUISITION_BOOTSTRAP_V1',ORIGIN,path,bytes])).digest('hex');
    const r=await target.intake.challenge(target.request('POST','/challenge',{}, {cookie:`${donorLogin}; ${name}=${bytes}.${mac}`,'x-csrf-token':donor.boot.csrfToken}));
    expect(r.status).toBe(403);
  } else if(mode==='challenge') expect((await confirmation(target,targetLogin,donor.issued)).status).toBe(403);
  else {
    const {signFreezingReacquisitionRequest,openFreezingReacquisitionEnvelope}=await import('./registeredFreezingReacquisition');
    const binding=(await h.database.query<{binding:{challenge:import('./freezingReacquisitionContract').FreezingReacquisitionChallenge}}>('SELECT binding FROM migration_reacquisition_challenges WHERE challenge_id=$1',[donor.issued.challengeId])).rows[0].binding;
    const signed=signFreezingReacquisitionRequest(donor.registration,donor.requestKeys.privateKey,{challenge:binding.challenge});
    const produced=await donor.producer(new Request(donor.registration.endpoint,{method:'POST',headers:signed.headers,body:signed.body}));
    expect(produced.status).toBe(200);
    const payload=await openFreezingReacquisitionEnvelope(await produced.json(),{encryptionKey:Buffer.alloc(32,8),signingPublicKey:donor.manifestKeys.publicKey,expectedChallenge:binding.challenge,nonceConsumer:{consumeOnce:async()=>true}});
    // Trust the recipient's signing key intentionally: the valid foreign binding,
    // not a different key/signature or outer TTL, must cause central refusal.
    const {sealLegacyBridgeManifest,openLegacyBridgeManifest}=await import('./legacyBridgeManifest');
    const sealAt=Date.now(); const phaseKey=Buffer.from(hkdfSync('sha256',Buffer.alloc(32,8),'CLASS_STORE_FREEZING_REACQUISITION','encrypted-candidate:v1',32));
    const envelope=sealLegacyBridgeManifest(payload,{keyId:'candidate-key',signingPrivateKey:target.manifestKeys.privateKey,encryptionKey:phaseKey,now:()=>sealAt,ttlMs:Math.min(target.issued.display.expiresAt,donor.issued.display.expiresAt)-sealAt});
    const wrapper={purpose:payload.purpose,bindingVersion:1,envelope};
    expect(await openLegacyBridgeManifest(envelope,{encryptionKey:phaseKey,signingPublicKey:target.manifestKeys.publicKey,nonceConsumer:{consumeOnce:async()=>true}})).toEqual(payload);
    await openFreezingReacquisitionEnvelope(wrapper,{encryptionKey:Buffer.alloc(32,8),signingPublicKey:target.manifestKeys.publicKey,expectedChallenge:binding.challenge,nonceConsumer:{consumeOnce:async()=>true}});
    const prior=globalThis.fetch;
    vi.stubGlobal('fetch',async(url:string|URL,init:RequestInit)=>{
      if(String(url)===target.registration.endpoint) { expect(active).toBe(0); events.push('candidate-send'); return Response.json(wrapper); }
      return prior(url,init);
    });
    expect((await confirmation(target,targetLogin)).status).toBe(202);
  }
  const after=await safetyRows(); expect(after.slice(1)).toEqual(before.slice(1));
  expect(after[0]).toHaveLength(mode.endsWith('envelope')?1:0);
  expect(sqlStatements.slice(trace).filter(s=>s.includes('INSERT INTO migration_reacquisition_dispatches'))).toHaveLength(mode.endsWith('envelope')?1:0);
  expect(sqlStatements.slice(trace).filter(s=>s.includes('INSERT INTO migration_reacquisition_candidates'))).toHaveLength(0);
  if(!mode.endsWith('envelope')) expect(events).toEqual(sent); else expect(events.filter(e=>e==='candidate-send')).toHaveLength(1);
});
it.each(['dispatch-expiry','nonce-expiry','candidate-expiry'])('isolated genuine thirty-day session expiry: %s',async mode=>{
  const start=Date.now(); const sessionIssuedAt=start-30*24*60*60*1000+20_000; const sessionExpiresAt=sessionIssuedAt+30*24*60*60*1000;
  const login=NextResponse.json({}); setGoogleSessionCookie(login,{subject:'owner',email:'owner@example.invalid',issuedAt:sessionIssuedAt});
  cookie=`${GOOGLE_AUTH_COOKIE}=${login.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
  const f=await candidateChallenge();
  const {readFreezingConsentSession}=await import('./freezingConsentSession');
  expect(readFreezingConsentSession(f.request('GET','/bootstrap'),ORIGIN,env).issuedAt).toBe(sessionIssuedAt);
  expect(Date.now()).toBeLessThan(sessionExpiresAt);
  expect(databaseClocks.length).toBeGreaterThan(0);
  expect(Math.max(...databaseClocks)).toBeLessThan(sessionExpiresAt);
  expect(f.boot.expiresAt).toBeGreaterThan(sessionExpiresAt);
  expect(f.issued.display.issuedAt).toBeLessThan(sessionExpiresAt);
  expect(f.issued.display.expiresAt).toBeGreaterThan(sessionExpiresAt);
  const rows=await safetyRows(); const trace=sqlStatements.length;
  fault=mode; expireAt=sessionExpiresAt;
  const confirm=()=>f.intake.confirm(f.request('POST','',{challengeId:f.issued.challengeId,display:f.issued.display},{'x-csrf-token':f.issued.csrfToken}));
  const r=await confirm(); expect(r.status).toBe(202);
  expect(await r.json()).toMatchObject({status:'UNKNOWN',automaticRetry:false,automaticEnable:false});
  expect(Date.now()).toBe(sessionExpiresAt);
  expect(()=>readFreezingConsentSession(f.request('GET','/bootstrap'),ORIGIN,env)).toThrow('Freezing consent session refused');
  expect(events.filter(e=>e==='candidate-send')).toHaveLength(mode==='dispatch-expiry'?0:1);
  const committed=mode==='candidate-expiry'?1:0;
  const after=await safetyRows(); expect(after[0]).toHaveLength(1); expect(after[1]).toHaveLength(committed);
  if(!committed) expect(after.slice(1)).toEqual(rows.slice(1));
  expect(sqlStatements.slice(trace).filter(s=>s.includes('INSERT INTO migration_reacquisition_dispatches'))).toHaveLength(1);
  expect(after[2]).toHaveLength(rows[2].length+committed); expect(after[3]).toHaveLength(rows[3].length+committed);
  expect(sqlStatements.slice(trace).filter(s=>s.includes('INSERT INTO migration_reacquisition_candidates'))).toHaveLength(mode==='dispatch-expiry'?0:1);
  if(mode!=='dispatch-expiry') {
    expect(lastWire!.auth.issuedAt).toBeLessThan(sessionExpiresAt); expect(lastWire!.auth.expiresAt).toBeGreaterThan(sessionExpiresAt);
    const {openFreezingReacquisitionEnvelope}=await import('./registeredFreezingReacquisition'); const consume=vi.fn(async()=>true);
    // At the exact expired-login clock, the actual signed request/challenge and
    // actual producer envelope remain independently valid, including their TTL.
    await openFreezingReacquisitionEnvelope(lastWire!.wrapper,{encryptionKey:Buffer.alloc(32,8),signingPublicKey:f.manifestKeys.publicKey,expectedChallenge:lastWire!.challenge,nonceConsumer:{consumeOnce:consume}});
    expect(consume).toHaveBeenCalledOnce();
  }
  if(committed) expect(after[1][0]).toMatchObject({binding:{authority:'NONAUTHORITY',exclusion:'NOT_PROVEN',finalImportEligible:false}});
  const sent=[...events]; expect((await confirm()).status).toBe(403); expect(events).toEqual(sent); expect(await safetyRows()).toEqual(after);
  expect((await f.intake.status(f.request('GET',`/${f.issued.challengeId}`,undefined,{'x-reacquisition-intent-digest':f.issued.intentDigest}))).status).toBe(403);
});

it('additive upgrade retains every old producer and central nonce row then accepts a new candidate',async()=>{
  const {intake,request}=await candidateFixture(true);
  const r=await intake.bootstrap(request('GET','/bootstrap'));expect(r.status).toBe(200);const boot=await r.json();
  const challenge=await intake.challenge(request('POST','/challenge',{}, {cookie:`${cookie}; ${r.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':boot.csrfToken}));
  expect(challenge.status).toBe(200);const issued=await challenge.json();
  expect((await intake.confirm(request('POST','',{challengeId:issued.challengeId,display:issued.display},{'x-csrf-token':issued.csrfToken}))).status).toBe(200);
  expect((await h.database.query('SELECT * FROM migration_bridge_consumptions WHERE challenge_id IS NOT NULL')).rows).toHaveLength(1);
  expect((await h.database.query('SELECT * FROM migration_bridge_consumptions WHERE freezing_challenge_id IS NOT NULL')).rows).toHaveLength(1);
});
