import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegisteredBridgeProducer, signBridgeRequest, type BridgeReservation, type BridgeRegistration } from './registeredBridgeProducer';
import { sha256 } from './validators';
import { canonicalJson, openLegacyBridgeManifest } from './legacyBridgeManifest';

vi.mock('server-only', () => ({}));
export const requestKeys = generateKeyPairSync('ed25519');
const manifestKeys = generateKeyPairSync('ed25519');
const writerKeys = generateKeyPairSync('ed25519');
export const registration: BridgeRegistration = {
  endpoint: 'https://legacy.example/api/internal/migrations/final-bridge', deploymentId: 'legacy-1',
  registrationDigest: 'c'.repeat(64), registrationVersion: '1', approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING',
  tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-1',
  requestKeyId: 'request-1', requestPublicKey: requestKeys.publicKey,
  manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writerKeys.publicKey,
};
export function body(now = Date.now()) {
  return { ceremonyId: randomUUID(), challenge: {
    purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE' as const, bindingVersion: 2 as const, challengeId: randomUUID(),
    tenantId: registration.tenantId, migrationJobId: randomUUID(), expectedStatus: 'READY' as const,
    expectedStateVersion: '1', sourceId: 'sheet', spreadsheetIdDigest: sha256('sheet-1'),
    jobSemanticFingerprint: 'a'.repeat(64), sourceAcquisitionDigest: 'b'.repeat(64), deploymentId: 'legacy-1',
    actorUserId: randomUUID(), actorSubject: 'owner', issuedAt: now, expiresAt: now + 60_000,
  } };
}
function fixture(options: { ack?: 'lost' | 'wrong' | 'stall'; advance?: () => void } = {}) {
  const events: string[] = []; const rows: BridgeReservation[] = [];
  const reserve = async (row: BridgeReservation) => {
    if (rows.some(r => r.nonceDigest === row.nonceDigest || r.challengeId === row.challengeId)) throw Error('duplicate');
    rows.push(row); events.push('reserve'); options.advance?.();
    if (options.ack === 'lost') throw Error('lost');
    if (options.ack === 'stall') return new Promise<BridgeReservation>(() => {});
    return options.ack === 'wrong' ? { ...row, requestDigest: '0'.repeat(64) } : row;
  };
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example'); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/control');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic-control');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID', 'writer-1');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', String(writerKeys.publicKey.export({ type: 'spki', format: 'pem' })));
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY', String(writerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.includes('/control')) {
      events.push(init.method === 'POST' ? 'disable' : 'readback');
      if (init.method === 'POST') start = Date.now();
      return Response.json({ version: 1, deploymentId: 'legacy-1', source: 'UPSTASH_REDIS_REST', status: 'DISABLED',
        disabled: true, generation: 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt: new Date(start).toISOString() });
    }
    events.push('redis'); return Response.json({ result: ['0', []] });
  });
  let start = Date.now(); const encryptionKey = randomBytes(32);
  const create = () => createRegisteredBridgeProducer({ registration, reservations: { reserveAndCommit: reserve },
    sheets: { listSheetNames: async () => { events.push('sheets'); return ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks']; },
      getRows: async (name: string) => name === 'Settings' ? [['key', 'value'], ['schemaVersion', '1']] : [['id']], getRevision: async () => 'revision' },
    manifest: { keyId: 'manifest-1', signingPrivateKey: manifestKeys.privateKey, encryptionKey },
  });
  return { events, rows, create, encryptionKey };
}
function request(b = body(), r = registration) {
  const signed = signBridgeRequest(r, requestKeys.privateKey, b);
  return new Request(r.endpoint, { method: 'POST', headers: signed.headers, body: signed.body });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
it('authenticates then acknowledges replay reservation before actual disable/readback/capture/seal', async () => {
  const f = fixture(); const b = body(); const response = await f.create()(request(b));
  expect(response.status).toBe(200);
  const payload = await openLegacyBridgeManifest(await response.json(), { encryptionKey: f.encryptionKey,
    signingPublicKey: manifestKeys.publicKey, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload).toMatchObject({ finalIntakeBinding: b.challenge, writerDisableRequired: true });
  expect(f.events.slice(0, 3)).toEqual(['reserve', 'disable', 'readback']);
  expect(f.events.at(-1)).toBe('readback'); expect(f.events.indexOf('sheets')).toBeGreaterThan(f.events.indexOf('redis'));
});
it.each(['lost', 'wrong'] as const)('never disables when reservation ACK is %s', async ack => {
  const f = fixture({ ack }); expect((await f.create()(request())).status).toBe(403); expect(f.events).toEqual(['reserve']);
});
it('two instances reject both nonce replay and fresh-nonce challenge replay', async () => {
  const f = fixture(); const b = body(); const req = request(b);
  const responses = await Promise.all([f.create()(req.clone()), f.create()(req.clone())]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 403]);
  expect((await f.create()(request(b))).status).toBe(403); expect(f.events.filter(e => e === 'disable')).toHaveLength(1);
});
it.each(['body', 'path', 'audience', 'registration', 'purpose', 'key', 'query', 'injection'])('refuses %s tampering before reservation', async attack => {
  const f = fixture(); const b = body(); const signed = signBridgeRequest(registration, requestKeys.privateKey, b);
  const headers = new Headers(signed.headers); let bytes = signed.body; let url = registration.endpoint;
  if (attack === 'body') bytes += ' ';
  if (attack === 'path') url += '/other';
  if (attack === 'query') url += '?';
  if (attack === 'injection') bytes = JSON.stringify({ ...b, reader: 'evil' });
  if (['audience', 'registration', 'purpose', 'key'].includes(attack)) {
    const auth = JSON.parse(Buffer.from(headers.get('x-class-store-bridge')!, 'base64url').toString());
    auth[{ audience: 'audience', registration: 'registrationDigest', purpose: 'purpose', key: 'keyId' }[attack]!] = 'wrong';
    headers.set('x-class-store-bridge', Buffer.from(JSON.stringify(auth)).toString('base64url'));
  }
  expect((await f.create()(new Request(url, { method: 'POST', headers, body: bytes }))).status).toBe(403);
  expect(f.events).toEqual([]);
});
it('rejects shared cryptographic key purposes and absent approval', () => {
  const f = fixture(); expect(f.create).not.toThrow();
  for (const r of [{ ...registration, manifestPublicKey: requestKeys.publicKey }, { ...registration, approvedScope: undefined }]) {
    expect(() => signBridgeRequest(r as BridgeRegistration, requestKeys.privateKey, body())).toThrow();
  }
});
it('checks unchanged TTL after reservation ACK and cancellation before disable', async () => {
  vi.useFakeTimers(); const now = Date.now();
  const f = fixture({ advance: () => vi.setSystemTime(now + 60_000) });
  expect((await f.create()(request(body(now)))).status).toBe(403); expect(f.events).toEqual(['reserve']);
});
it('refuses pre-aborted request without reservation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  expect((await f.create()(new Request(request(), { signal: controller.signal }))).status).toBe(403); expect(f.events).toEqual([]);
});

function resigned(change: Record<string, unknown>, bytes?: string) {
  const signed = signBridgeRequest(registration, requestKeys.privateKey, body());
  const auth = JSON.parse(Buffer.from(signed.headers['x-class-store-bridge'], 'base64url').toString());
  delete auth.signature; Object.assign(auth, change);
  if (bytes !== undefined) auth.bodyDigest = sha256(bytes);
  auth.signature = sign(null, Buffer.from('class-store:registered-final-bridge-request:v1\0' + canonicalJson(auth)), requestKeys.privateKey).toString('base64url');
  return new Request(registration.endpoint, { method: 'POST', body: bytes ?? signed.body,
    headers: { 'content-type': 'application/json', 'x-class-store-bridge': Buffer.from(canonicalJson(auth)).toString('base64url') } });
}
it.each([
  { audience: 'other' }, { path: '/other' }, { purpose: 'CLASS_STORE_LEGACY_MANIFEST' },
  { registrationDigest: 'd'.repeat(64) }, { registrationVersion: '2' }, { ceremonyId: randomUUID() },
  { bridgeChallengeId: randomUUID() }, { issuedAt: Date.now() + 120_000 }, { expiresAt: Date.now() - 1 },
])('rejects valid request-key signature with incorrect binding %j', async change => {
  const f = fixture(); expect((await f.create()(resigned(change))).status).toBe(403); expect(f.events).toEqual([]);
});
it('globally rejects one request nonce used across different challenges and instances', async () => {
  const f = fixture(); const nonce = 'A'.repeat(32);
  const responses = await Promise.all([f.create()(resigned({ nonce })), f.create()(resigned({ nonce }))]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 403]);
  expect(f.rows).toHaveLength(1); expect(f.events.filter(e => e === 'disable')).toHaveLength(1);
});
it('cancels oversized authenticated request stream before reservation', async () => {
  const f = fixture(); const bytes = ' '.repeat(8193); let cancelled = false;
  const req = resigned({}, bytes);
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from(bytes)); }, cancel() { cancelled = true; } });
  const streamed = new Request(req.url, { method: 'POST', headers: req.headers, body: stream, duplex: 'half' } as RequestInit);
  expect((await f.create()(streamed)).status).toBe(403); expect(cancelled).toBe(true); expect(f.events).toEqual([]);
});
it('cancels a stalled authenticated request body at its deadline', async () => {
  vi.useFakeTimers(); const f = fixture(); let cancelled = false; const req = request();
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = f.create()(new Request(req.url, { method: 'POST', headers: req.headers, body: stream, duplex: 'half' } as RequestInit));
  await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).status).toBe(403); expect(cancelled).toBe(true); expect(f.events).toEqual([]);
});
it('rejects a deployment-local writer key that differs from registration before disable', async () => {
  const f = fixture(); vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', String(requestKeys.publicKey.export({ type: 'spki', format: 'pem' })));
  expect((await f.create()(request())).status).toBe(403); expect(f.events).toEqual([]);
});
it('times out an unacknowledged reservation without ever entering producer', async () => {
  vi.useFakeTimers(); const f = fixture({ ack: 'stall' }); let response: Response | undefined;
  void f.create()(request()).then(r => { response = r; });
  await vi.advanceTimersByTimeAsync(5000);
  expect(response?.status).toBe(403); expect(f.events).toEqual(['reserve']);
});
it('ACK reservation cancellation prevents disable and keeps the tombstone', async () => {
  const controller = new AbortController(); const f = fixture({ advance: () => controller.abort() });
  expect((await f.create()(new Request(request(), { signal: controller.signal }))).status).toBe(403);
  expect(f.events).toEqual(['reserve']); expect(f.rows).toHaveLength(1);
});
