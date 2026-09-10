// @vitest-environment node
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import type { Gaxios } from 'gaxios';
import { google } from 'googleapis';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { signFreezingReacquisitionRequest as signBridgeRequest, openFreezingReacquisitionEnvelope, type FreezingReacquisitionRegistration as BridgeRegistration } from './registeredFreezingReacquisition';
import { getProductionFreezingReacquisitionProducer } from './freezingReacquisitionProduction';
import { sha256, canonicalJson } from './validators';
import { REQUIRED_SHEETS } from '@/generator/config/schema';
import { signBridgeRequest as signOldRequest } from './registeredBridgeProducer';

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
let extraRow: boolean; let revision: string; let expiry: number;
let expireAt: 'ack' | 'firstGET' | 'capture' | 'secondGET' | undefined;
let controlFault: 'timeout' | 'overflow' | 'drift' | undefined;
const nativeFetch = globalThis.fetch;
const registration = (): BridgeRegistration => ({ endpoint, deploymentId: 'legacy-1', registrationVersion: '1',
  registrationDigest: 'c'.repeat(64), approvedScope: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE',
  tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-1',
  requestKeyId: 'request-1', requestPublicKey: pem(requestKeys.publicKey),
  manifestPublicKey: pem(manifestKeys.publicKey), writerPublicKey: pem(writerKeys.publicKey) });
function body() {
  const now = Date.now(); return { challenge: {
    purpose: 'CLASS_STORE_FREEZING_REACQUISITION' as const, bindingVersion: 1 as const, challengeId: randomUUID(),
    tenantId: registration().tenantId, migrationJobId: randomUUID(), expectedStatus: 'FREEZING' as const,
    expectedStateVersion: '1', sourceId: 'sheet', spreadsheetIdDigest: sha256('sheet-1'),
    jobSemanticFingerprint: 'a'.repeat(64), sourceAcquisitionDigest: 'b'.repeat(64), deploymentId: 'legacy-1',
    actorUserId: randomUUID(), actorSubject: 'owner', sessionBinding: 'd'.repeat(64),
    startCeremonyId: randomUUID(), executionDigest: 'e'.repeat(64), preflightSnapshotId: randomUUID(),
    preflightSnapshotDigest: 'f'.repeat(64), registrationDigest: registration().registrationDigest, registrationVersion: '1', issuedAt: now, expiresAt: now + 60_000 } };
}
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  for (const f of (await readdir('src/server/db/migrations')).filter(f => f.endsWith('.sql')).sort()) await db.exec(await readFile(`src/server/db/migrations/${f}`, 'utf8'));
  await db.exec('CREATE ROLE "legacy-1" NOSUPERUSER NOBYPASSRLS; GRANT SELECT, INSERT ON migration_bridge_producer_reservations TO "legacy-1"');
  server = createServer(async (incoming, outgoing) => {
    const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
    const request = new Request(endpoint, { method: 'POST', headers: incoming.headers as HeadersInit,
      body: Readable.toWeb(incoming), duplex: 'half' } as RequestInit);
    const response = await POST(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/internal/migrations/freezing-reacquisition`;
}, 60_000);
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.close(); });
beforeEach(async () => {
  extraRow = false; revision = '42'; expireAt = undefined; controlFault = undefined;
  events = []; disabledAt = Date.now() - 86_400_000; fault = undefined; controller = new AbortController();
  // A CJS/ESM mock-identity regression must never become real provider egress.
  vi.spyOn(https, 'request').mockImplementation(() => { throw Error('Nonlocal HTTPS forbidden in producer fixture'); });
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets'); vi.stubEnv('GOOGLE_SHEET_ID', 'sheet-1');
  vi.stubEnv('CLASS_STORE_FREEZING_PRODUCER_REGISTRATION', JSON.stringify(registration()));
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
      if (text === 'COMMIT') { events.push('commit'); if (expireAt === 'ack') vi.spyOn(Date, 'now').mockReturnValue(expiry); if (fault === 'ack') throw Error('ACK lost'); if (fault === 'cancel') controller.abort(); }
      return result;
    }, release(discard?: boolean) { events.push(discard ? 'discard' : 'release'); },
  }));
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const value = String(url);
    if (value === endpoint) return nativeFetch(url, init);
    if (value.includes('/control')) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit' });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-control');
      events.push(init?.method === 'POST' ? 'disable' : 'readback');
      const count = events.filter(e => e === 'readback').length;
      if ((expireAt === 'firstGET' && count === 1) || (expireAt === 'secondGET' && count === 2)) vi.spyOn(Date, 'now').mockReturnValue(expiry);
      if (controlFault === 'timeout') throw Error('Synthetic transport timeout');
      if (controlFault === 'overflow') return new Response(' '.repeat(8193), { headers: { 'content-type': 'application/json' } });
      return Response.json({ version: 1, deploymentId: 'legacy-1', source: 'UPSTASH_REDIS_REST', status: 'DISABLED',
        disabled: true, generation: controlFault === 'drift' && count === 2 ? 2 : 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt: new Date(disabledAt).toISOString() });
    }
    if (value === 'https://redis.example') {
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit' });
      const command = JSON.parse(String(init?.body)); expect(['HSCAN', 'SCAN', 'GET']).toContain(command[0]);
      events.push('redis');
      return Response.json({ result: command[0] === 'SCAN' ? ['0', [`padlet:evidence-claim:v1:${'d'.repeat(64)}`]]
        : command[0] === 'GET' ? 'synthetic-old-owner' : ['0', []] });
    }
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
      if (path.includes('/drive/v3/files/')) data = { id: 'sheet-1', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, version: revision };
      else if (path.includes('/values/')) {
        const name = decodeURIComponent(path).split('/values/')[1].replace(/^'|'$/g, '');
        data = { values: name === 'Settings' ? [['key', 'value'], ['schemaVersion', '1'], ['classTimeZone', 'Asia/Seoul'], ['adminPassword', 'synthetic-redact-me']]
          : name === 'Students' ? [[...REQUIRED_SHEETS.Students], ['S1', 'Alice', '100', 'ACTIVE'], ...(extraRow ? [['S2', 'Bob', '0', 'ACTIVE']] : [])]
            : [[...REQUIRED_SHEETS[name as keyof typeof REQUIRED_SHEETS]]] };
        if (expireAt === 'capture') vi.spyOn(Date, 'now').mockReturnValue(expiry);
      }
      else if (path === '/v4/spreadsheets/sheet-1') data = { spreadsheetId: 'sheet-1', sheets: names.map((title, sheetId) => ({ properties: { title, sheetId, sheetType: 'GRID', gridProperties: { rowCount: 100, columnCount: 20 } } })) };
      else throw Error('Nonlocal provider prohibited');
    }
    return new FetchResponse(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.restoreAllMocks(); });

it('production factory executes durable SQL then GET Redis Sheets GET and opens a NONAUTHORITY complete candidate', async () => {
  const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  // Direct factory invocation establishes behavioral RED at the missing module seam,
  // not a route-level HTTP refusal sentinel standing in for absent production code.
  const handler = getProductionFreezingReacquisitionProducer();
  const response = await handler(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  expect(response.status, JSON.stringify(events)).toBe(200);
  const payload = await openFreezingReacquisitionEnvelope(await response.json(), { encryptionKey,
    signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload).toMatchObject({ challenge: b.challenge, authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN',
    finalImportEligible: false, localWriterObservation: { disabledAt: new Date(disabledAt).toISOString() } });
  expect(payload.sheetsSnapshot.tabs.Students.rows).toHaveLength(1);
  expect(payload.sheetsSnapshot.sourceRevision).toBe('42'); expect(payload.redisSnapshot.v1Tombstones).toHaveLength(1);
  expect(JSON.stringify(payload)).not.toMatch(/synthetic-redact-me|synthetic-old-owner|FINAL_FROZEN/);
  expect(events.slice(0, 4)).toEqual(['begin', 'commit', 'release', 'readback']);
  expect(events.at(-1)).toBe('readback'); expect(events).toContain('durable-token');
  expect(events).not.toContain('disable');
  const rows = await db.query('SELECT challenge_id, start_ceremony_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId]);
  expect(rows.rows).toEqual([{ challenge_id: b.challenge.challengeId, start_ceremony_id: b.challenge.startCeremonyId }]);
});

it('signed localhost HTTP crosses the actual exported route and opens the real capture', async () => {
  const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const response = await nativeFetch(endpoint, { method: 'POST', headers: signed.headers, body: signed.body });
  expect(response.status, JSON.stringify(events)).toBe(200);
  const payload = await openFreezingReacquisitionEnvelope(await response.json(), { encryptionKey,
    signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload.outcome).toBe('AUTHENTIC_FREEZING_ACQUISITION');
  expect(events.filter(e => e === 'readback')).toHaveLength(2); expect(events).not.toContain('disable');
});

it.each(['ack', 'insert', 'expire', 'cancel'] as const)('actual route refuses %s before any control/source GET', async failure => {
  fault = failure; const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body, signal: controller.signal }));
  expect(response.status).toBe(403); expect(events).not.toContain('disable'); expect(events).not.toContain('readback'); expect(events).not.toContain('redis'); expect(events).not.toContain('sheets');
  expect(events.filter(e => e === 'begin')).toHaveLength(1);
  expect(events.includes('discard')).toBe(failure === 'ack');
  const rows = await db.query('SELECT challenge_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId]);
  expect(rows.rows).toHaveLength(failure === 'ack' || failure === 'cancel' ? 1 : 0);
});

it('a new production factory refuses retained request and fresh-nonce same-challenge replay without disable', async () => {
  const b = body(); const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const send = (signed: ReturnType<typeof signBridgeRequest>) => POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  expect((await send(signed)).status).toBe(200);
  expect((await send(signed)).status).toBe(403);
  expect((await send(signBridgeRequest(registration(), requestKeys.privateKey, b))).status).toBe(403);
  expect(events).not.toContain('disable'); expect(events.filter(e => e === 'readback')).toHaveLength(2);
});

it.each(['CLASS_STORE_FREEZING_PRODUCER_REGISTRATION', 'CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL', 'GOOGLE_REFRESH_TOKEN', 'CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY', 'CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY', 'CLASS_STORE_BRIDGE_MANIFEST_KEY_ID',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
  'LEGACY_REDIS_WRITER_CONTROL_URL', 'LEGACY_REDIS_WRITER_CONTROL_TOKEN'])('missing %s fails closed without public configuration details or side effects', async name => {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  vi.stubEnv(name, ''); const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  expect(response.status).toBe(403); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ outcome: 'REFUSED' }); expect(events).toEqual([]);
});

it.each(['sheet', 'scope', 'role', 'keys'])('rejects %s configuration mismatch before any connection or external call', async mismatch => {
  const r = registration();
  if (mismatch === 'sheet') vi.stubEnv('GOOGLE_SHEET_ID', 'other');
  if (mismatch === 'scope') Object.assign(r, { approvedScope: undefined });
  if (mismatch === 'role') vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_DATABASE_URL', 'postgresql://tenant_runtime:synthetic@127.0.0.1/isolated');
  if (mismatch === 'keys') Object.assign(r, { manifestPublicKey: r.requestPublicKey });
  vi.stubEnv('CLASS_STORE_FREEZING_PRODUCER_REGISTRATION', JSON.stringify(r));
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', body: '{}' }));
  expect(response.status).toBe(403); expect(events).toEqual([]);
});

it.each([undefined, '1'])('fixed route preserves bounded authenticated streaming with Content-Length %s', async length => {
  const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  let pulls = 0; let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(Buffer.alloc(4096, 32)); }, cancel() { cancelled = true; } });
  const headers = new Headers(signed.headers); if (length) headers.set('content-length', length);
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit));
  expect(response.status).toBe(403); expect(cancelled).toBe(true); expect(pulls).toBeLessThanOrEqual(4);
  expect(events).toEqual([]);
});

it.each(['body', 'cookie', 'authorization', 'referer', 'origin', 'query', 'purpose', 'path', 'audience', 'scope'])('fixed route refuses %s authentication confusion before SQL and side effects', async attack => {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  const headers = new Headers(signed.headers); let bytes = signed.body; let url = endpoint;
  if (attack === 'body') bytes += ' ';
  if (['authorization', 'referer', 'origin'].includes(attack)) headers.set(attack, 'https://browser.invalid');
  if (attack === 'cookie') headers.set('cookie', 'admin_session=synthetic');
  if (attack === 'query') url += '?source=other';
  if (attack === 'path') url += '/other';
  if (['purpose', 'audience', 'scope'].includes(attack)) {
    const auth = JSON.parse(Buffer.from(headers.get('x-class-store-freezing-reacquisition')!, 'base64url').toString());
    auth[attack] = 'CLASS_STORE_LEGACY_MANIFEST';
    headers.set('x-class-store-freezing-reacquisition', Buffer.from(JSON.stringify(auth)).toString('base64url'));
  }
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(url, { method: 'POST', headers, body: bytes }));
  expect(response.status).toBe(403); expect(events).toEqual([]);
});

it('bounds durable refresh-token JSON before allocation and never retries refresh or auto-enables after disable', async () => {
  const { Response: FetchResponse } = await import('node-fetch');
  let pulls = 0; let destroyed = false;
  const stream = new Readable({ read() { pulls++; this.push(Buffer.alloc(32_000, 32)); if (pulls === 64) this.push(null); }, destroy(error, done) { destroyed = true; done(error); } });
  io.google.mockImplementation(async () => { events.push('durable-token'); return new FetchResponse(stream, { status: 200 }); });
  const b = body(); const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  expect(response.status).toBe(503); expect(events).not.toContain('disable'); expect(events.filter(e => e === 'readback')).toHaveLength(1);
  expect(events.filter(e => e === 'durable-token')).toHaveLength(1);
  expect(destroyed).toBe(true); expect(pulls).toBeLessThan(10);
});

it.each([
  ['LEGACY_REDIS_WRITER_CONTROL_URL', 'http://evil.invalid/control'],
  ['LEGACY_REDIS_WRITER_CONTROL_URL', 'https://control.invalid/?'],
  ['LEGACY_REDIS_WRITER_CONTROL_URL', 'https://user:password@control.invalid/'],
  ['UPSTASH_REDIS_REST_URL', 'http://redis.invalid'],
  ['UPSTASH_REDIS_REST_URL', 'https://redis.invalid/#'],
  ['UPSTASH_REDIS_REST_TOKEN', 'bad token'],
  ['LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'bad token'],
  ['CLASS_STORE_BRIDGE_MANIFEST_KEY_ID', 'bad key'],
])('malformed server-owned %s fails before reservation or GET', async (name, value) => {
  vi.stubEnv(name, value);
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  expect(response.status).toBe(403); expect(events).toEqual([]);
});

it('absent read-scope registration cannot inherit the old disable registration', async () => {
  vi.stubEnv('CLASS_STORE_FREEZING_PRODUCER_REGISTRATION', '');
  vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION', JSON.stringify({ ...registration(), approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING' }));
  expect(() => getProductionFreezingReacquisitionProducer()).toThrow(); expect(events).toEqual([]);
});

async function sendNew(b = body()) {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  return POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
}
it('a new challenge captures an added row and new revision while preserving original signed fingerprints', async () => {
  const first = body(); const initial = await sendNew(first); expect(initial.status).toBe(200);
  const initialPayload = await openFreezingReacquisitionEnvelope(await initial.json(), { encryptionKey, signingPublicKey: manifestKeys.publicKey,
    expectedChallenge: first.challenge, nonceConsumer: { consumeOnce: async () => true } });
  extraRow = true; revision = '43';
  const next = body(); const response = await sendNew(next); expect(response.status).toBe(200);
  const wrapper = await response.json();
  const payload = await openFreezingReacquisitionEnvelope(wrapper, { encryptionKey, signingPublicKey: manifestKeys.publicKey,
    expectedChallenge: next.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload.sheetsSnapshot.sourceRevision).toBe('43'); expect(payload.sheetsSnapshot.tabs.Students.rows).toHaveLength(2);
  expect(payload.redisSnapshot.v1Tombstones).toHaveLength(1);
  expect(payload.sheetsSnapshot.digest).not.toBe(initialPayload.sheetsSnapshot.digest);
  expect(payload.sheetsSnapshot.digest).not.toBe(next.challenge.sourceAcquisitionDigest);
  expect(payload.challenge).toEqual(next.challenge); expect(wrapper.envelope.expiresAt).toBe(next.challenge.expiresAt);
  expect(payload.finalImportEligible).toBe(false); expect(events).not.toContain('disable');
});
it('lost durable COMMIT acknowledgement permanently suppresses same-challenge recovery and all GETs', async () => {
  const b = body(); fault = 'ack'; expect((await sendNew(b)).status).toBe(403);
  expect(events).toContain('discard'); fault = undefined;
  expect((await sendNew(b)).status).toBe(403);
  expect(events).not.toContain('readback'); expect(events).not.toContain('redis');
  expect((await db.query('SELECT challenge_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows).toHaveLength(1);
});
it.each(['timeout', 'overflow', 'drift'] as const)('control %s is terminal after reservation without retry, repair or enable', async fault => {
  const b = body(); controlFault = fault;
  const response = await sendNew(b); expect(response.status).toBe(503); expect(await response.json()).toEqual({ outcome: 'UNKNOWN' });
  const reads = events.filter(e => e === 'readback').length;
  expect(reads).toBe(fault === 'drift' ? 2 : 1);
  controlFault = undefined; expect((await sendNew(b)).status).toBe(403);
  expect(events.filter(e => e === 'readback')).toHaveLength(reads); expect(events).not.toContain('disable');
});
it.each(['ack', 'firstGET', 'capture', 'secondGET'] as const)('production checks the original sixty-second deadline at %s', async stage => {
  const b = body(); expiry = b.challenge.expiresAt; expireAt = stage;
  const response = await sendNew(b); expect(response.status).toBe(stage === 'ack' ? 403 : 503);
  expect(await response.json()).not.toHaveProperty('envelope');
  expect(events).toContain('commit'); expect(events).not.toContain('disable');
  if (stage === 'ack') expect(events).not.toContain('readback');
  if (stage === 'firstGET') expect(events).not.toContain('redis');
});
it.each(['INSERT', 'SELECT'] as const)('actual SQL %s ACL denial fails before GET', async privilege => {
  await db.exec(`REVOKE ${privilege} ON migration_bridge_producer_reservations FROM "legacy-1"`);
  try { expect((await sendNew()).status).toBe(403); expect(events).toContain('begin'); expect(events).not.toContain('readback'); }
  finally { await db.exec(`GRANT ${privilege} ON migration_bridge_producer_reservations TO "legacy-1"`); }
});
it('actual unsafe SQL role is refused before any INSERT or external read', async () => {
  await db.exec('ALTER ROLE "legacy-1" BYPASSRLS');
  try { expect((await sendNew()).status).toBe(403); expect(events).toContain('begin'); expect(events).not.toContain('commit'); expect(events).not.toContain('readback'); }
  finally { await db.exec('ALTER ROLE "legacy-1" NOBYPASSRLS'); }
});
it('actual SQL INSERT suppression rolls back instead of creating capture permission', async () => {
  await db.exec(`CREATE FUNCTION fixture_suppress_freezing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER fixture_suppress_freezing BEFORE INSERT ON migration_bridge_producer_reservations FOR EACH ROW EXECUTE FUNCTION fixture_suppress_freezing()`);
  const b = body();
  try {
    expect((await sendNew(b)).status).toBe(403); expect(events).toContain('begin'); expect(events).not.toContain('commit'); expect(events).not.toContain('readback');
    expect((await db.query('SELECT challenge_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows).toHaveLength(0);
  } finally { await db.exec('DROP TRIGGER fixture_suppress_freezing ON migration_bridge_producer_reservations; DROP FUNCTION fixture_suppress_freezing()'); }
});
it.each(['audience', 'path', 'scope', 'purpose', 'registrationDigest', 'registrationVersion', 'keyId', 'actorUserId',
  'actorSubject', 'sessionBinding', 'startCeremonyId', 'executionDigest', 'challengeId', 'bodyDigest'])('production refuses genuinely signed wrong %s binding before SQL', async field => {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  const auth = JSON.parse(Buffer.from(signed.headers['x-class-store-freezing-reacquisition'], 'base64url').toString());
  delete auth.signature; auth[field] = 'wrong';
  auth.signature = sign(null, Buffer.from('class-store:registered-freezing-reacquisition-request:v1\0' + canonicalJson(auth)), requestKeys.privateKey).toString('base64url');
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', body: signed.body, headers: {
    ...signed.headers, 'x-class-store-freezing-reacquisition': Buffer.from(canonicalJson(auth)).toString('base64url') } }));
  expect(response.status).toBe(403); expect(events).toEqual([]);
});
it('genuine old start request cannot run the new production phase or vice versa', async () => {
  const b = body(); const c = b.challenge;
  const oldRegistration = { ...registration(), endpoint: endpoint.replace('freezing-reacquisition', 'final-bridge'), approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING' as const };
  const old = signOldRequest(oldRegistration, requestKeys.privateKey, { ceremonyId: c.startCeremonyId, challenge: {
    purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE', bindingVersion: 2, expectedStatus: 'READY', challengeId: c.challengeId,
    tenantId: c.tenantId, migrationJobId: c.migrationJobId, expectedStateVersion: '1', sourceId: c.sourceId, spreadsheetIdDigest: c.spreadsheetIdDigest,
    jobSemanticFingerprint: c.jobSemanticFingerprint, sourceAcquisitionDigest: c.sourceAcquisitionDigest, deploymentId: c.deploymentId,
    actorUserId: c.actorUserId, actorSubject: c.actorSubject, issuedAt: c.issuedAt, expiresAt: c.expiresAt,
  } });
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  expect((await POST(new Request(endpoint, { method: 'POST', headers: old.headers, body: old.body }))).status).toBe(403);
  vi.stubEnv('CLASS_STORE_BRIDGE_PRODUCER_REGISTRATION', JSON.stringify(oldRegistration));
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const { POST: oldPOST } = await import('@/app/api/internal/migrations/final-bridge/route');
  expect((await oldPOST(new Request(oldRegistration.endpoint, { method: 'POST', headers: signed.headers, body: signed.body }))).status).toBe(403);
  expect(events).toEqual([]);
});

it.each(['private-mismatch', 'request-malformed', 'writer-shared', 'manifest-malformed', 'encryption-malformed', 'registration-extra', 'registration-empty', 'registration-malformed'] as const)(
  'production rejects %s keys or registration before SQL', async attack => {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  const r = registration();
  if (attack === 'private-mismatch') vi.stubEnv('CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY', pem(writerKeys.privateKey));
  if (attack === 'request-malformed') Object.assign(r, { requestPublicKey: 'not-a-key' });
  if (attack === 'writer-shared') Object.assign(r, { writerPublicKey: r.manifestPublicKey });
  if (attack === 'manifest-malformed') vi.stubEnv('CLASS_STORE_BRIDGE_MANIFEST_PRIVATE_KEY', 'malformed');
  if (attack === 'encryption-malformed') vi.stubEnv('CLASS_STORE_BRIDGE_MANIFEST_ENCRYPTION_KEY', randomBytes(31).toString('base64'));
  if (attack === 'registration-extra') Object.assign(r, { controlEndpoint: 'https://evil.invalid/control' });
  vi.stubEnv('CLASS_STORE_FREEZING_PRODUCER_REGISTRATION', attack === 'registration-empty' ? '{}' : attack === 'registration-malformed' ? '{' : JSON.stringify(r));
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  expect((await POST(new Request(endpoint, { method: 'POST', headers: signed.headers, body: signed.body }))).status).toBe(403);
  expect(events).toEqual([]);
});
function signedBytes(bytes: string, b: ReturnType<typeof body>) {
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, b);
  const auth = JSON.parse(Buffer.from(signed.headers['x-class-store-freezing-reacquisition'], 'base64url').toString());
  delete auth.signature; auth.bodyDigest = sha256(bytes);
  auth.signature = sign(null, Buffer.from('class-store:registered-freezing-reacquisition-request:v1\0' + canonicalJson(auth)), requestKeys.privateKey).toString('base64url');
  return { body: bytes, headers: { ...signed.headers, 'x-class-store-freezing-reacquisition': Buffer.from(canonicalJson(auth)).toString('base64url') } };
}
it.each([8192, 8193])('actual signed route enforces exact UTF-8 body bound %i without materializing upstream', async bytes => {
  const b = body(); const json = canonicalJson(b); const padded = json + ' '.repeat(bytes - Buffer.byteLength(json));
  expect(Buffer.byteLength(padded)).toBe(bytes);
  const signed = signedBytes(padded, b); const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  const response = await POST(new Request(endpoint, { method: 'POST', ...signed }));
  expect(response.status).toBe(bytes === 8192 ? 200 : 403);
  if (bytes === 8193) expect(events).toEqual([]);
});
it.each(['endpoint', 'encryptionKey', 'sheets', 'control', 'browserCredential', 'tenant', 'source', 'sheet', 'phase'] as const)(
  'genuinely signed body cannot inject %s authority through the production route', async attack => {
  const b = body(); const changed = JSON.parse(JSON.stringify(b));
  if (attack === 'tenant') changed.challenge.tenantId = randomUUID();
  else if (attack === 'source') changed.challenge.sourceId = 'other';
  else if (attack === 'sheet') changed.challenge.spreadsheetIdDigest = sha256('other');
  else if (attack === 'phase') changed.challenge.expectedStatus = 'READY';
  else changed[attack] = 'caller-value';
  const signed = signedBytes(canonicalJson(changed), b);
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  expect((await POST(new Request(endpoint, { method: 'POST', ...signed }))).status).toBe(403); expect(events).toEqual([]);
});
it('stalled ACK after actual SQL COMMIT times out, then late acknowledgement cannot recover capture', async () => {
  const originalConnect = io.connect.getMockImplementation()!;
  let acknowledge!: () => void; let committed!: () => void;
  const atCommit = new Promise<void>(resolve => { committed = resolve; });
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  io.connect.mockImplementation(async () => {
    const connection = await originalConnect();
    return { ...connection, query: async (text: string, values?: unknown[]) => {
      const result = await connection.query(text, values);
      if (text === 'COMMIT') { committed(); await ack; }
      return result;
    } };
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const b = body(); const pending = sendNew(b);
  try {
    await atCommit; await vi.advanceTimersByTimeAsync(5000);
    expect((await pending).status).toBe(403); expect(events).not.toContain('readback');
    acknowledge(); await vi.advanceTimersByTimeAsync(0); vi.useRealTimers();
    expect((await sendNew(b)).status).toBe(403); expect(events).not.toContain('readback');
    expect((await db.query('SELECT challenge_id FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows).toHaveLength(1);
  } finally { acknowledge(); vi.useRealTimers(); }
});
it('only the durable deployment refresh root is usable, never a browser, service-account or migration fallback', async () => {
  vi.stubEnv('GOOGLE_REFRESH_TOKEN', ''); vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'synthetic@example.invalid');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', 'synthetic-never-loaded');
  const signed = signBridgeRequest(registration(), requestKeys.privateKey, body());
  const { POST } = await import('@/app/api/internal/migrations/freezing-reacquisition/route');
  expect((await POST(new Request(endpoint, { method: 'POST', ...signed }))).status).toBe(403);
  expect(events).toEqual([]); expect(io.google).not.toHaveBeenCalled();
});
