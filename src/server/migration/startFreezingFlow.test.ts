// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import https from 'node:https';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import type { QueryResult, QueryResultRow } from 'pg';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { makeSupportedSheets } from './__fixtures__/normalization';
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
    const c = await h.runtimePool.connect(); let execution = false;
    return { query: async (text: string, values?: unknown[]) => {
      const r = await c.query(text, values);
      const statement = typeof text === 'string' ? text : (text as { text: string }).text;
      if (statement.startsWith('BEGIN')) active++;
      if (statement.includes('INSERT INTO migration_start_executions')) execution = true;
      if (statement === 'COMMIT' || statement === 'ROLLBACK') active = Math.max(0, active - 1);
      if (statement === 'COMMIT' && execution && loseStartAck) { lostAcks++; throw Error('Synthetic lost start COMMIT ACK'); }
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
const JOB = '40000000-0000-4000-8000-000000000029';
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
const clients: InstanceType<typeof OAuth2>[] = [];
function provider() {
  const client = new OAuth2(env.MIGRATION_GOOGLE_CLIENT_ID, env.MIGRATION_GOOGLE_CLIENT_SECRET, `${ORIGIN}/api/migrations/google-sheets/callback`);
  const sheets = makeSupportedSheets(3); const access = 'local-access-token';
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
    else if (url.includes('/drive/v3/files/')) data = { id: 'sheet-1', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, version: '42' };
    else if (url.includes('/values/')) {
      const name = decodeURIComponent(new URL(url).pathname.split('/values/')[1]).slice(1, -1).replace(/''/g, "'");
      const tab = sheets.tabs[name]; data = { values: [tab.headers, ...tab.rows.map(r => r.cells)] };
    } else if (url.includes('/v4/spreadsheets/sheet-1')) data = { spreadsheetId: 'sheet-1', sheets: Object.keys(sheets.tabs).map((title, sheetId) => ({ properties: { title, sheetId, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 100 } } })) };
    else throw Error('Unexpected synthetic OAuth URL');
    return { data: Readable.from([JSON.stringify(data)]), headers: new Headers({ 'cache-control': 'max-age=300' }), status: 200, statusText: 'OK', config: options };
  }) as typeof client.transporter.request;
  clients.push(client); return client;
}
beforeEach(async () => {
  vi.spyOn(https, 'request').mockImplementation(() => { throw Error('Nonlocal HTTPS forbidden'); });
  vi.stubGlobal('fetch', () => { throw Error('Nonlocal HTTP forbidden'); });
  h = await createPgliteDatabaseHarness();
  const dir = resolve('src/server/db/migrations');
  for (const n of (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0, 4) > '0008').sort()) await h.database.exec(await readFile(resolve(dir, n), 'utf8'));
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')", [USER]);
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [h.tenantTwoId, USER]);
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantTwoId, JOB]);
  const manifest = createLegacyNormalizationManifest({ tenantId: h.tenantTwoId, migrationJobId: JOB, sheets: makeSupportedSheets(3) });
  await importLegacyNormalizationManifest({ tenantId: h.tenantTwoId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  expect((await prepareLegacyImportReady({ tenantId: h.tenantTwoId, migrationJobId: JOB, manifest, currentManifest: manifest, comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: h.runTenantTransaction })).readiness).toBe('READY');
  expect(manifest.sourceFingerprint).not.toBe(manifest.sourceArtifacts.sheets.digest);
  const row = (await h.database.query<{ source_id: string; version: string; slug: string; external_source_id: string }>("SELECT s.source_id,j.state_version::text AS version,t.slug,s.external_source_id FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) JOIN tenants t ON t.id=j.tenant_id WHERE j.job_id=$1 AND s.provider='GOOGLE_SHEETS'", [JOB])).rows[0];
  sourceId = row.source_id; version = row.version; slug = row.slug;
  expect(row.external_source_id).toBe(hash('sheet-1')); expect(row.external_source_id).not.toBe('sheet-1');
  await h.database.exec('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
  await h.database.exec('GRANT SELECT,INSERT ON migration_consent_challenges,migration_consent_confirmations,migration_consent_attempts,migration_consent_captures,migration_start_intents,migration_start_confirmations,migration_start_dispatches,migration_start_executions,migration_bridge_challenges,migration_bridge_consumptions TO app_runtime');
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS', JSON.stringify([{ tenantId: h.tenantTwoId, sourceId, spreadsheetId: 'sheet-1' }]));
  const r = NextResponse.json({}); setGoogleSessionCookie(r, { subject: 'owner', email: 'owner@example.invalid', issuedAt: Date.now() - 1000 });
  cookie = `${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
  nonce = ''; active = 0; disabledAt = 0; events = []; providerCalls = []; clients.length = 0; bridgeUnknown = false;
  loseStartAck = false; connections = 0; discarded = 0; lostAcks = 0;
  vi.spyOn(google.auth, 'OAuth2').mockImplementation(function () { return provider(); } as never);
  const request = generateKeyPairSync('ed25519'), manifestKeys = generateKeyPairSync('ed25519'), writer = generateKeyPairSync('ed25519');
  configuration = { tenantId: h.tenantTwoId, sourceId, spreadsheetId: 'sheet-1', deploymentId: 'local-companion', registrationVersion: '1', endpoint: 'https://local.example/api/internal/migrations/final-bridge', approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING', requestKeyId: 'request-1', requestPublicKey: pem(request.publicKey), requestPrivateKey: pem(request.privateKey), manifestKeyId: 'manifest-1', manifestPublicKey: pem(manifestKeys.publicKey), writerKeyId: 'writer-1', writerPublicKey: pem(writer.publicKey), encryptionKey: Buffer.alloc(32, 4).toString('base64') };
  vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', JSON.stringify([configuration]));
  // Producer registration will use the actual server configuration digest once
  // challenge issuance proves the production factory exists.
  await h.database.exec('CREATE ROLE "local-companion" NOSUPERUSER NOBYPASSRLS; GRANT SELECT,INSERT ON migration_bridge_producer_reservations TO "local-companion"');
  const reservations = createBridgeProducerReservations({ connect: async () => ({ query: async <T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> => {
    const result = await h.database.query(text, values ? [...values] : undefined);
    if (text.startsWith('BEGIN')) await h.database.exec('SET LOCAL ROLE "local-companion"');
    return { rows: result.rows as T[], rowCount: result.affectedRows ?? null, command: '', oid: 0, fields: [] };
  }, release: () => {} }) }, 'local-companion');
  const sheets = makeSupportedSheets(3);
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
      const producer = createRegisteredBridgeProducer({ registration: { endpoint: String(configuration.endpoint), tenantId: h.tenantTwoId, sourceId, spreadsheetId: 'sheet-1', deploymentId: 'local-companion', registrationVersion: '1', registrationDigest, approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING', requestKeyId: 'request-1', requestPublicKey: request.publicKey, manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writer.publicKey }, reservations,
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
}, 60000);
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
it('real canonical production factory callback reaches authentic atomic FREEZING once and status is archival only', async () => {
  const { issued, callback } = await ceremony();
  await h.database.exec("UPDATE migration_sources SET grant_expires_at=now()+interval '1 hour'");
  await h.database.query("INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'unrelated-claim','MIGRATION_IMPORT',$2)", [h.tenantOneId, hash('unrelated')]);
  await h.database.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
    VALUES('PADLET','other-board','other-post',encode(digest(convert_to('other-board','UTF8')||decode('00','hex')||convert_to('other-post','UTF8'),'sha256'),'hex'),$1,'unrelated-claim',now(),'Other Student')`, [h.tenantOneId]);
  await h.database.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'unrelated-source')", [hash('unrelated-tuple'), hash('unrelated-owner')]);
  const changed = new Set(['migration_jobs', 'migration_consent_attempts', 'migration_consent_captures', 'migration_bridge_challenges', 'migration_bridge_consumptions', 'migration_start_dispatches', 'migration_start_executions', 'migration_bridge_producer_reservations', 'audit_events']);
  const preserved = (await h.database.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r => r.tablename).filter(t => !changed.has(t));
  const snapshot = await Promise.all(preserved.map(t => h.database.query(`SELECT * FROM ${t}`)));
  const fixed = await import('@/app/api/migrations/google-sheets/callback/route');
  const r = await fixed.GET(callback); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ status: 'STARTED', exclusion: 'NOT_PROVEN' });
  expect(await Promise.all(preserved.map(t => h.database.query(`SELECT * FROM ${t}`)))).toEqual(snapshot);
  expect(events.filter(e => e === 'dispatch')).toHaveLength(1); expect(events.filter(e => e === 'disable')).toHaveLength(1);
  const job = (await h.database.query<Record<string, unknown>>('SELECT status,state_version::text AS version,freeze_started_at,freeze_verified_at,final_fingerprint FROM migration_jobs WHERE job_id=$1', [JOB])).rows[0];
  expect(job).toMatchObject({ status: 'FREEZING', version: String(BigInt(version) + BigInt(1)), freeze_verified_at: null, final_fingerprint: null }); expect(job.freeze_started_at).toBeTruthy();
  expect((await h.database.query<{ lifecycle: string }>('SELECT lifecycle FROM tenants WHERE id=$1', [h.tenantTwoId])).rows[0].lifecycle).toBe('IMPORTING');
  const executions = (await h.database.query<{ binding: Record<string, unknown> }>('SELECT binding FROM migration_start_executions')).rows;
  expect(executions).toHaveLength(1);
  expect(executions[0].binding).toMatchObject({ ceremonyId: issued.challengeId, intentDigest: issued.startIntentDigest,
    jobSemanticFingerprint: issued.jobSemanticFingerprint, sourceAcquisitionDigest: issued.sourceAcquisitionDigest, exclusion: 'NOT_PROVEN' });
  expect(executions[0].binding.consentAcquisitionDigest).not.toBe(issued.sourceAcquisitionDigest);
  expect(executions[0].binding.bridgeSheetsDigest).not.toBe(executions[0].binding.consentAcquisitionDigest);
  const producer = (await h.database.query<{ request_digest: string; registration_digest: string }>('SELECT request_digest,registration_digest FROM migration_bridge_producer_reservations')).rows;
  expect(producer).toHaveLength(1); expect(executions[0].binding).toMatchObject({ requestDigest: producer[0].request_digest, registrationDigest: producer[0].registration_digest });
  const retained = JSON.stringify((await h.database.query('SELECT redacted_details FROM audit_events')).rows);
  for (const secret of ['local-access-token', env.MIGRATION_GOOGLE_CLIENT_SECRET, configuration.requestPrivateKey, configuration.encryptionKey]) expect(retained.includes(String(secret))).toBe(false);
  expect(events.indexOf('disable')).toBeLessThan(events.indexOf('sheets')); expect(events.at(-1)).toBe('readback');
  const archive = await call('GET', issued.challengeId, undefined, { 'x-start-intent-digest': issued.startIntentDigest }); expect(archive.status).toBe(200); expect(await archive.json()).toMatchObject({ status: 'STARTED', scope: 'ARCHIVAL_ONLY', exclusion: 'NOT_PROVEN' });
  expect((await call('GET', issued.challengeId, undefined, { 'x-start-intent-digest': '0'.repeat(64) })).status).toBe(403);
  const before = [...events]; expect((await fixed.GET(callback)).status).toBe(403); expect(events).toEqual(before);
  const renewed = NextResponse.json({}); setGoogleSessionCookie(renewed, { subject: 'owner', email: 'owner@example.invalid', issuedAt: Date.now() });
  expect((await call('GET', issued.challengeId, undefined, { 'x-start-intent-digest': issued.startIntentDigest, cookie: `${GOOGLE_AUTH_COOKIE}=${renewed.cookies.get(GOOGLE_AUTH_COOKIE)!.value}` })).status).toBe(403);
  expect(providerCalls.filter(u => u.endsWith('/token'))).toHaveLength(1); expect(providerCalls.at(-1)).toContain('/revoke'); for (const c of clients) expect(c.credentials).toEqual({});
});
it('uncertain registered response retains durable dispatch and never retries or auto-enables', async () => {
  const { callback } = await ceremony(); bridgeUnknown = true;
  const fixed = await import('@/app/api/migrations/google-sheets/callback/route'); const r = await fixed.GET(callback);
  expect(r.status).toBe(202); expect(await r.json()).toMatchObject({ status: 'UNKNOWN', automaticRetry: false, automaticEnable: false });
  expect((await fixed.GET(callback)).status).toBe(403); expect(events.filter(e => e === 'disable')).toHaveLength(1);
  expect((await h.database.query('SELECT * FROM migration_start_dispatches')).rows).toHaveLength(1);
  expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toHaveLength(0);
});
it.each(['missing', 'unregistered', 'scope', 'endpoint', 'nonmember', 'cross-tenant', 'compat', 'key-reuse', 'private-mismatch', 'bad-encryption', 'duplicate', 'extra', 'sql-unprovisioned'])('canonical challenge fails closed before effects: %s', async mode => {
  if (mode === 'missing') vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', '');
  if (mode === 'unregistered') configuration.sourceId = 'not-registered';
  if (mode === 'scope') configuration.approvedScope = 'CONSENT_ONLY';
  if (mode === 'endpoint') configuration.endpoint = 'https://evil.invalid/api/internal/migrations/final-bridge?key=synthetic';
  if (mode === 'key-reuse') configuration.writerPublicKey = configuration.manifestPublicKey;
  if (mode === 'private-mismatch') configuration.requestPrivateKey = pem(generateKeyPairSync('ed25519').privateKey);
  if (mode === 'bad-encryption') configuration.encryptionKey = Buffer.alloc(31).toString('base64');
  if (mode === 'extra') configuration.reader = 'browser-supplied';
  if (!['missing', 'nonmember', 'cross-tenant', 'compat', 'sql-unprovisioned'].includes(mode)) vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', JSON.stringify(mode === 'duplicate' ? [configuration, configuration] : [configuration]));
  if (mode === 'sql-unprovisioned') await h.database.exec('REVOKE INSERT ON migration_start_intents FROM app_runtime');
  if (mode === 'nonmember') await h.database.query('DELETE FROM tenant_memberships');
  const other = (await h.database.query<{ slug: string }>('SELECT slug FROM tenants WHERE id=$1', [h.tenantOneId])).rows[0].slug;
  const r = await call('GET', 'challenge', undefined, mode === 'compat' ? { cookie: 'class_store_tenant_admin=synthetic' } : {}, mode === 'cross-tenant' ? other : slug);
  expect(r.status).toBe(403); expect(r.headers.get('cache-control')).toBe('no-store'); expect(events).toEqual([]); expect(providerCalls).toEqual([]);
  expect((await h.database.query('SELECT * FROM migration_consent_challenges')).rows).toHaveLength(0);
});
it('another registered READY tenant remains inaccessible to a real nonmember identity', async () => {
  const { finalizeSheetsSnapshot } = await import('./__fixtures__/normalization');
  const sheets = finalizeSheetsSnapshot({ ...makeSupportedSheets(3), spreadsheetId: 'foreign-sheet' });
  await h.database.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1", [h.tenantOneId]);
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [h.tenantOneId, JOB]);
  const manifest = createLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, sheets });
  await importLegacyNormalizationManifest({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, runTransaction: h.runTenantTransaction });
  expect((await prepareLegacyImportReady({ tenantId: h.tenantOneId, migrationJobId: JOB, manifest, currentManifest: manifest, comparisonInstant: '2026-08-31T03:00:00.000Z', runTransaction: h.runTenantTransaction })).readiness).toBe('READY');
  const row = (await h.database.query<{ source_id: string; slug: string }>("SELECT s.source_id,t.slug FROM migration_sources s JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=$1 AND s.provider='GOOGLE_SHEETS'", [h.tenantOneId])).rows[0];
  const foreign = { ...configuration, tenantId: h.tenantOneId, sourceId: row.source_id, spreadsheetId: 'foreign-sheet' };
  vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', JSON.stringify([configuration, foreign]));
  vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS', JSON.stringify([configuration, foreign].map(r => ({ tenantId: r.tenantId, sourceId: r.sourceId, spreadsheetId: r.spreadsheetId }))));
  const refused = await call('GET', 'challenge', undefined, {}, row.slug);
  expect(refused.status).toBe(403); expect(events).toEqual([]); expect(providerCalls).toEqual([]);
  expect((await h.database.query('SELECT * FROM migration_consent_challenges')).rows).toHaveLength(0);
  // Same exact registration/job is demonstrably eligible once OWNER is granted.
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [h.tenantOneId, USER]);
  expect((await call('GET', 'challenge', undefined, {}, row.slug)).status).toBe(200);
});
it.each(['csrf', 'display', 'endpoint', 'origin'])('actual confirmation rejects %s without dispatch', async mode => {
  const issuance = await call('GET', 'challenge'); expect(issuance.status).toBe(200); const issued = await issuance.json();
  const display = { ...issued.startDisplay, ...(mode === 'display' ? { action: 'ACTIVATE' } : {}) };
  const r = await call('POST', '', { challengeId: issued.challengeId, display, ...(mode === 'endpoint' ? { endpoint: 'https://evil.invalid' } : {}) }, {
    cookie: `${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`,
    'x-csrf-token': mode === 'csrf' ? '0'.repeat(64) : issued.csrfToken, ...(mode === 'origin' ? { origin: 'https://evil.invalid' } : {}),
  });
  expect(r.status).toBe(403); expect(events).toEqual([]); expect(providerCalls).toEqual([]);
  expect((await h.database.query('SELECT * FROM migration_start_confirmations')).rows).toHaveLength(0);
});
it('ordinary production consent stays CAPTURED and its authenticated cookie cannot authorize start', async () => {
  const scoped = await import('@/app/api/c/[slug]/[...path]/route');
  const path = ['migrations', JOB, 'freezing', 'consent'];
  const post = (challenge: boolean, body: unknown, headers: Record<string, string> = {}) => {
    const p = [...path, ...(challenge ? ['challenge'] : [])];
    return scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/${p.join('/')}`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), { params: Promise.resolve({ slug, path: p }) });
  };
  const issuance = await post(true, { sourceId, expectedStateVersion: version }); expect(issuance.status).toBe(200); const issued = await issuance.json();
  const headers = { cookie: `${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`, 'x-csrf-token': issued.csrfToken };
  expect((await call('POST', '', { challengeId: issued.challengeId, display: {} }, headers)).status).toBe(403);
  const begin = await post(false, { challengeId: issued.challengeId }, headers); expect(begin.status).toBe(200);
  const url = new URL((await begin.json()).authorizationUrl); nonce = url.searchParams.get('nonce')!;
  vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', ''); // Ordinary consent never needs start provisioning.
  const fixed = await import('@/app/api/migrations/google-sheets/callback/route');
  const r = await fixed.GET(new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`, { headers: { cookie: `${cookie}; ${begin.headers.get('set-cookie')!.split(';')[0]}` } }));
  expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ status: 'CAPTURED', scope: 'CONSENT_AND_SHEET_CAPTURE_ONLY' });
  expect(events).toEqual([]); expect((await h.database.query<{ status: string }>('SELECT status FROM migration_jobs WHERE job_id=$1', [JOB])).rows[0].status).toBe('READY');
  expect((await h.database.query('SELECT * FROM migration_start_dispatches')).rows).toEqual([]);
});
it.each(['route-hint', 'membership', 'registration-drift'])('fixed callback rejects %s before provider exchange', async mode => {
  const { callback } = await ceremony(); const url = new URL(callback.url);
  if (mode === 'route-hint') url.searchParams.set('purpose', 'start');
  if (mode === 'membership') await h.database.query('DELETE FROM tenant_memberships');
  if (mode === 'registration-drift') { configuration.registrationVersion = '2'; vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', JSON.stringify([configuration])); }
  const fixed = await import('@/app/api/migrations/google-sheets/callback/route');
  expect((await fixed.GET(new Request(url, { headers: callback.headers }))).status).toBe(403);
  expect(events).toEqual([]); expect(providerCalls).toEqual([]);
});
it('lost actual start SQL COMMIT ACK returns UNKNOWN once and read-only status recovers only the fact', async () => {
  const { issued, callback } = await ceremony(); loseStartAck = true;
  const fixed = await import('@/app/api/migrations/google-sheets/callback/route'); const response = await fixed.GET(callback);
  expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ status: 'UNKNOWN', automaticRetry: false, automaticEnable: false });
  expect(lostAcks).toBe(1); expect(discarded).toBe(1);
  expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toHaveLength(1);
  const before = [...events];
  vi.stubEnv('MIGRATION_START_BRIDGE_REGISTRATIONS', '');
  const status = await call('GET', issued.challengeId, undefined, { 'x-start-intent-digest': issued.startIntentDigest });
  expect(status.status).toBe(200); expect(await status.json()).toMatchObject({ scope: 'ARCHIVAL_ONLY', status: 'STARTED' });
  expect((await fixed.GET(callback)).status).toBe(403); expect(events).toEqual(before); expect(lostAcks).toBe(1);
});
it('unscoped concrete exports refuse even a real identity before SQL or effects', async () => {
  const challenge = await import('@/app/api/migrations/[jobId]/freezing/start/challenge/route');
  const begin = await import('@/app/api/migrations/[jobId]/freezing/start/route');
  const status = await import('@/app/api/migrations/[jobId]/freezing/start/[attemptId]/route');
  const params = Promise.resolve({ jobId: JOB, attemptId: USER }); const before = connections;
  for (const [method, suffix, handler] of [['GET', '/challenge', challenge.GET], ['POST', '', begin.POST], ['GET', `/${USER}`, status.GET]] as const) {
    const response = await handler(new Request(`${ORIGIN}/api/migrations/${JOB}/freezing/start${suffix}`, { method, headers: { cookie } }), { params });
    expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(connections).toBe(before); expect(events).toEqual([]);
});
it.each(['absent', 'false'])('canonical start body cap cancels overflow before SQL regardless of %s Content-Length', async mode => {
  const scoped = await import('@/app/api/c/[slug]/[...path]/route'); const path = ['migrations', JOB, 'freezing', 'start'];
  let pulled = 0, cancelled = false; const before = connections;
  const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`, { method: 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...(mode === 'false' ? { 'content-length': '1' } : {}) }, body, duplex: 'half' } as RequestInit);
  const response = await scoped.POST(request, { params: Promise.resolve({ slug, path }) });
  expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store'); expect(pulled).toBe(5); expect(cancelled).toBe(true);
  expect(connections).toBe(before); expect(events).toEqual([]); expect(providerCalls).toEqual([]);
});
