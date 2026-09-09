// @vitest-environment node
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { Gaxios } from 'gaxios';
import { google } from 'googleapis';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createRegisteredBridgeClient } from './registeredBridgeClient';
import { signBridgeRequest, type BridgeRegistration } from './registeredBridgeProducer';
import { openLegacyBridgeManifest } from './legacyBridgeManifest';
import { sha256 } from './validators';

vi.mock('server-only', () => ({}));
const io = vi.hoisted(() => ({ connect: vi.fn(), google: vi.fn(), poolOptions: [] as unknown[] }));
vi.mock('pg', () => ({ Pool: class {
  constructor(options: unknown) { io.poolOptions.push(options); }
  connect = io.connect;
  on() {} end = async () => {};
} }));
vi.mock('@vercel/functions', () => ({ attachDatabasePool: () => {} }));
const sdkPrototype: Gaxios = Object.getPrototypeOf(new google.auth.OAuth2().transporter);
const sdkRequest = sdkPrototype.request;
const requestKeys = generateKeyPairSync('ed25519'), manifestKeys = generateKeyPairSync('ed25519'), writerKeys = generateKeyPairSync('ed25519');
const pem = (key: typeof requestKeys.publicKey) => String(key.export({ type: key.type === 'private' ? 'pkcs8' : 'spki', format: 'pem' }));
const encryptionKey = randomBytes(32);
let db: PGlite; let server: Server; let endpoint: string;
let events: string[]; let fault: 'ack' | 'insert' | 'expire' | 'cancel' | undefined;
let controller: AbortController; let disabledAt: number;
const nativeFetch = globalThis.fetch;
const registration = (): BridgeRegistration => ({ endpoint, deploymentId: 'legacy-1', registrationVersion: '1',
  registrationDigest: 'c'.repeat(64), approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING',
  tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-1',
  requestKeyId: 'request-1', requestPublicKey: pem(requestKeys.publicKey),
  manifestPublicKey: pem(manifestKeys.publicKey), writerPublicKey: pem(writerKeys.publicKey) });
function body() {
  const now = Date.now(); return { ceremonyId: randomUUID(), challenge: {
    purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE' as const, bindingVersion: 2 as const, challengeId: randomUUID(),
    tenantId: registration().tenantId, migrationJobId: randomUUID(), expectedStatus: 'READY' as const,
    expectedStateVersion: '1', sourceId: 'sheet', spreadsheetIdDigest: sha256('sheet-1'),
    jobSemanticFingerprint: 'a'.repeat(64), sourceAcquisitionDigest: 'b'.repeat(64), deploymentId: 'legacy-1',
    actorUserId: randomUUID(), actorSubject: 'owner', issuedAt: now, expiresAt: now + 60_000 } };
}
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  for (const f of (await readdir('src/server/db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(`src/server/db/migrations/${f}`, 'utf8'));
  await db.exec('CREATE ROLE "legacy-1" NOSUPERUSER NOBYPASSRLS; GRANT SELECT, INSERT ON migration_bridge_producer_reservations TO "legacy-1"');
  server = createServer(async (incoming, outgoing) => {
    const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
    const request = new Request(endpoint, { method: 'POST', headers: incoming.headers as HeadersInit,
      body: Readable.toWeb(incoming), duplex: 'half' } as RequestInit);
    const response = await POST(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/internal/migrations/final-bridge`;
}, 60_000);
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.close(); });
beforeEach(async () => {
  events = []; fault = undefined; controller = new AbortController();
  // A CJS/ESM mock-identity regression must never become real provider egress.
  vi.spyOn(https, 'request').mockImplementation(() => { throw Error('Nonlocal HTTPS forbidden in producer fixture'); });
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets'); vi.stubEnv('GOOGLE_SHEET_ID', 'sheet-1');
  vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION', JSON.stringify(registration()));
  vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL', 'postgresql://legacy-1:synthetic@127.0.0.1/isolated');
  vi.stubEnv('CLASS_STORE_BRIDGE_MANIFEST_KEY_ID', 'manifest-1');
  vi.stubEnv('CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY', pem(manifestKeys.privateKey));
  vi.stubEnv('CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY', encryptionKey.toString('base64'));
  vi.stubEnv('GOOGLE_CLIENT_ID', 'durable-deployment-client'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'synthetic-durable-secret');
  vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'synthetic-durable-refresh');
  vi.stubEnv('MIGRATION_GOOGLE_REFRESH_TOKEN', 'must-never-be-used');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example'); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/control'); vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic-control');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID', 'writer-1');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', pem(writerKeys.publicKey));
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY', pem(writerKeys.privateKey));
  io.connect.mockImplementation(async () => ({
    async query(text: string, values?: unknown[]) {
      if (text.startsWith('BEGIN')) { events.push('begin'); await db.exec(text); await db.exec('SET LOCAL ROLE "legacy-1"'); return { rows: [] }; }
      if (fault === 'insert' && text.startsWith('INSERT')) throw Error('DB unavailable');
      const result = await db.query(text, values);
      if (fault === 'expire' && text.includes('clock_timestamp')) return { rows: [{ now_ms: '9007199254740991' }] };
      if (text === 'COMMIT') { events.push('commit'); if (fault === 'ack') throw Error('ACK lost'); if (fault === 'cancel') controller.abort(); }
      return result;
    }, release(discard?: boolean) { events.push(discard ? 'discard' : 'release'); },
  }));
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value === endpoint) return nativeFetch(url, init);
    if (value.includes('/control')) {
      events.push(init?.method === 'POST' ? 'disable' : 'readback'); if (init?.method === 'POST') disabledAt = Date.now();
      return Response.json({ version: 1, deploymentId: 'legacy-1', source: 'UPSTASH_REDIS_REST', status: 'DISABLED',
        disabled: true, generation: 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt: new Date(disabledAt).toISOString() });
    }
    if (value.startsWith('https://redis.example')) { events.push('redis'); return Response.json({ result: ['0', []] }); }
    throw Error('Nonlocal transport prohibited');
  });
  vi.spyOn(sdkPrototype, 'request').mockImplementation(function (this: Gaxios, options) {
    return sdkRequest.call(this, { ...options, fetchImplementation: io.google });
  });
  const { Response: FetchResponse } = await import('node-fetch');
  io.google.mockImplementation(async (url: string | URL, options: { headers?: Headers; body?: string }) => {
    const path = new URL(String(url)).pathname; let data: unknown;
    if (path === '/token') {
      events.push('durable-token');
      expect(String(options.body)).toContain('refresh_token=synthetic-durable-refresh');
      expect(String(options.body)).not.toContain('must-never-be-used');
      data = { access_token: 'synthetic-durable-access', token_type: 'Bearer', expires_in: 3600 };
    } else {
      events.push('sheets'); expect(new Headers(options.headers).get('authorization')).toBe('Bearer synthetic-durable-access');
      const names = ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks'];
      if (path.includes('/drive/v3/files/')) data = { id: 'sheet-1', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, version: '42' };
      else if (path.includes('/values/')) data = { values: decodeURIComponent(path).endsWith("'Settings'") ? [['key', 'value'], ['schemaVersion', '1']] : [['id']] };
      else if (path === '/v4/spreadsheets/sheet-1') data = { spreadsheetId: 'sheet-1', sheets: names.map((title, sheetId) => ({ properties: { title, sheetId, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 20 } } })) };
      else throw Error('Nonlocal provider prohibited');
    }
    return new FetchResponse(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });

it('signed localhost client crosses fixed route, production factory, durable SQL, real producer and opens the seal', async () => {
  const b = body();
  const result = await createRegisteredBridgeClient({ registration: registration(), requestPrivateKey: requestKeys.privateKey }).prepare(b).send();
  expect(result.outcome, JSON.stringify(events)).toBe('RECEIVED');
  if (result.outcome !== 'RECEIVED') throw Error('Missing manifest');
  const payload = await openLegacyBridgeManifest(result.manifest, { encryptionKey, signingPublicKey: manifestKeys.publicKey, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload).toMatchObject({ finalIntakeBinding: b.challenge, writerDisableRequired: true });
  expect(events.slice(0, 5)).toEqual(['begin', 'commit', 'release', 'disable', 'readback']);
  expect(events.at(-1)).toBe('readback'); expect(events).toContain('durable-token');
  const rows = await db.query('SELECT challenge_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId]);
  expect(rows.rows).toEqual([{ challenge_id: b.challenge.challengeId }]);
});

it.each(['ack', 'insert', 'expire', 'cancel'] as const)('actual route refuses %s before disable', async failure => {
  fault = failure; const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body, signal: controller.signal }));
  expect(response.status).toBe(403); expect(events).not.toContain('disable'); expect(events).not.toContain('sheets');
  expect(events.filter(e => e === 'begin')).toHaveLength(1);
  expect(events.includes('discard')).toBe(failure === 'ack');
  const rows = await db.query('SELECT challenge_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId]);
  expect(rows.rows).toHaveLength(failure === 'ack' || failure === 'cancel' ? 1 : 0);
});

it('a new production factory refuses retained request and fresh-nonce same-challenge replay without disable', async () => {
  const b = body(); const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const send = (signed: ReturnType<typeof signBridgeRequest>) => POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  expect((await send(signed)).status).toBe(200);
  expect((await send(signed)).status).toBe(403);
  expect((await send(signBridgeRequest(registration(), requestKeys.privateKey, b))).status).toBe(403);
  expect(events.filter(e => e === 'disable')).toHaveLength(1);
});

it.each(['CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION', 'CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL', 'GOOGLE_REFRESH_TOKEN', 'CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY'])('missing %s fails closed without public configuration details or side effects', async name => {
  vi.stubEnv(name, ''); const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const response = await POST(new Request(endpoint, { method: 'POST', body: '{}' }));
  expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ outcome: 'REFUSED' }); expect(events).toEqual([]);
});

it.each(['sheet', 'scope', 'role', 'keys'])('rejects %s configuration mismatch before any connection or external call', async mismatch => {
  const r = registration();
  if (mismatch === 'sheet') vi.stubEnv('GOOGLE_SHEET_ID', 'other');
  if (mismatch === 'scope') Object.assign(r, { approvedScope: undefined });
  if (mismatch === 'role') vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL', 'postgresql://tenant_runtime:synthetic@127.0.0.1/isolated');
  if (mismatch === 'keys') Object.assign(r, { manifestPublicKey: r.requestPublicKey });
  vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION', JSON.stringify(r));
  const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const response = await POST(new Request(endpoint, { method: 'POST', body: '{}' }));
  expect(response.status).toBe(403); expect(events).toEqual([]);
});

it.each([undefined, '1'])('fixed route preserves bounded authenticated streaming with Content-Length %s', async length => {
  const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  let pulls = 0; let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(Buffer.alloc(4096, 32)); }, cancel() { cancelled = true; } });
  const headers = new Headers(signed.headers); if (length) headers.set('content-length', length);
  const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit));
  expect(response.status).toBe(403); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(4);
  expect(events).toEqual([]);
});

it.each(['body', 'cookie', 'query', 'purpose', 'path'])('fixed route refuses %s authentication confusion before SQL and side effects', async attack => {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  const headers = new Headers(signed.headers); let bytes = signed.body; let url = endpoint;
  if (attack === 'body') bytes += ' ';
  if (attack === 'cookie') headers.set('cookie', 'admin_session=synthetic');
  if (attack === 'query') url += '?source=other';
  if (attack === 'path') url += '/other';
  if (attack === 'purpose') {
    const auth = JSON.parse(Buffer.from(headers.get('x-class-store-bridge')!, 'base64url').toString());
    auth.purpose = 'CLASS_STORE_LEGACY_MANIFEST';
    headers.set('x-class-store-bridge', Buffer.from(JSON.stringify(auth)).toString('base64url'));
  }
  const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const response = await POST(new Request(url, { method: 'POST', headers, body: bytes }));
  expect(response.status).toBe(403); expect(events).toEqual([]);
});

it('bounds durable refresh-token JSON before allocation and never retries refresh or auto-enables after disable', async () => {
  const { Response: FetchResponse } = await import('node-fetch');
  let pulls = 0; let destroyed = false;
  const stream = new Readable({ read() { pulls++; this.push(Buffer.alloc(32_000, 32)); if (pulls === 64) this.push(null); }, destroy(error, done) { destroyed = true; done(error); } });
  io.google.mockImplementation(async () => { events.push('durable-token'); return new FetchResponse(stream, { status: 200 }); });
  const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const { POST } = await import('@/app/api/internal/migrations/final-bridge/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  expect(response.status).toBe(503); expect(events.filter(e => e === 'disable')).toHaveLength(1);
  expect(events.filter(e => e === 'durable-token')).toHaveLength(1);
  expect(destroyed).toBe(true); expect(pulls).toBeLessThan(10);
});
