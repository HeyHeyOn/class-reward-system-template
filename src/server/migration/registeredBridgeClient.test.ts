// @vitest-environment node
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createRegisteredBridgeClient } from './registeredBridgeClient';
import { createRegisteredBridgeProducer, type BridgeRegistration, type BridgeReservation } from './registeredBridgeProducer';
import { openLegacyBridgeManifest } from './legacyBridgeManifest';
import { sha256 } from './validators';
vi.mock('server-only', () => ({}));
const nativeFetch = globalThis.fetch;
const requestKeys = generateKeyPairSync('ed25519'); const manifestKeys = generateKeyPairSync('ed25519');
const writerKeys = generateKeyPairSync('ed25519'); const encryptionKey = randomBytes(32);
const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }))); });
async function server(handler: (r: Request) => Promise<Response>) {
  const s = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const response = await handler(new Request(`http://127.0.0.1:${(s.address() as { port: number }).port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, body: Buffer.concat(chunks),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) { for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk); }
    res.end();
  }); servers.push(s); await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}/api/internal/migrations/final-bridge`;
}
function registration(endpoint: string): BridgeRegistration { return {
  endpoint, deploymentId: 'local-legacy', tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-1',
  registrationVersion: '1', registrationDigest: 'c'.repeat(64), approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING',
  requestKeyId: 'request-1', requestPublicKey: requestKeys.publicKey, manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writerKeys.publicKey,
}; }
function body() { const now = Date.now(); return { ceremonyId: randomUUID(), challenge: {
  purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE' as const, bindingVersion: 2 as const, challengeId: randomUUID(),
  tenantId: '20000000-0000-4000-8000-000000000001', migrationJobId: randomUUID(), expectedStatus: 'READY' as const,
  expectedStateVersion: '1', sourceId: 'sheet', spreadsheetIdDigest: sha256('sheet-1'), jobSemanticFingerprint: 'a'.repeat(64),
  sourceAcquisitionDigest: 'b'.repeat(64), deploymentId: 'local-legacy', actorUserId: randomUUID(), actorSubject: 'owner', issuedAt: now, expiresAt: now + 60_000,
} }; }
function client(r: BridgeRegistration, timeoutMs = 1000) { return createRegisteredBridgeClient({ registration: r, requestPrivateKey: requestKeys.privateKey, timeoutMs }); }
it.each(['success', 'timeout'])('real signed localhost HTTP invokes actual producer exactly once: %s', async mode => {
  let handler: (r: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
  let completed: Response | undefined;
  let finish: () => void = () => {};
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const endpoint = await server(async req => { const response = await handler(req); completed = response.clone(); finish(); return response; });
  const r = registration(endpoint); const events: string[] = []; const rows: BridgeReservation[] = [];
  let disabledAt = ''; vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example'); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/control'); vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID', 'writer-1');
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY', String(writerKeys.publicKey.export({ type: 'spki', format: 'pem' })));
  vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY', String(writerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' })));
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === endpoint) return nativeFetch(url, init);
    if (url.includes('/control')) {
      events.push(init.method === 'POST' ? 'disable' : 'readback'); if (init.method === 'POST') disabledAt = new Date().toISOString();
      return Response.json({ version: 1, deploymentId: 'local-legacy', source: 'UPSTASH_REDIS_REST', status: 'DISABLED', disabled: true,
        generation: 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt });
    }
    expect(url).toBe('https://redis.example'); events.push('redis'); return Response.json({ result: ['0', []] });
  });
  handler = createRegisteredBridgeProducer({ registration: r, reservations: { reserveAndCommit: async row => { rows.push(row); events.push('ACK'); return row; } },
    manifest: { keyId: 'manifest-1', signingPrivateKey: manifestKeys.privateKey, encryptionKey }, sheets: {
      listSheetNames: async () => { events.push('sheets'); if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 120));
        return ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks']; },
      getRows: async name => name === 'Settings' ? [['key', 'value'], ['schemaVersion', '1']] : [['id']], getRevision: async () => 'r1',
    } });
  const b = body(); const attempt = client(r, mode === 'timeout' ? 60 : 1000).prepare(b); const result = await attempt.send();
  expect(result.outcome).toBe(mode === 'timeout' ? 'UNKNOWN' : 'RECEIVED');
  await finished;
  const envelope = result.outcome === 'RECEIVED' ? result.manifest : await completed!.json();
  const payload = await openLegacyBridgeManifest(envelope, { encryptionKey, signingPublicKey: manifestKeys.publicKey, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload).toMatchObject({ finalIntakeBinding: b.challenge, writerDisableRequired: true, redisAcquisition: 'CAPTURED' });
  expect(rows[0].requestDigest).toBe(attempt.requestDigest); expect(events.slice(0, 3)).toEqual(['ACK', 'disable', 'readback']); expect(events.at(-1)).toBe('readback');
  expect(await attempt.send()).toEqual({ outcome: 'NOT_SENT' }); expect(events.filter(e => e === 'disable')).toHaveLength(1);
});
it.each(['redirect', 'large', 'timeout', 'error'])('bounded real HTTP %s is UNKNOWN without retry or leaked body', async mode => {
  let calls = 0; let followed = 0;
  const target = await server(async () => { followed++; return Response.json({ secret: 'do-not-copy' }); });
  const endpoint = await server(async () => { calls++;
    if (mode === 'redirect') return new Response(null, { status: 307, headers: { location: target } });
    if (mode === 'large') return new Response('x'.repeat(1_500_001), { headers: { 'content-type': 'application/json' } });
    if (mode === 'timeout') await new Promise(resolve => setTimeout(resolve, 80));
    return new Response('credential-do-not-copy', { status: 503 });
  });
  const result = await client(registration(endpoint), mode === 'timeout' ? 20 : 1000).prepare(body()).send();
  expect(result).toEqual({ outcome: 'UNKNOWN' }); expect(calls).toBe(1); expect(followed).toBe(0);
});
it('rejects caller endpoint/key/reader injection before network and HTTPS exceptions outside tests', () => {
  const r = registration('https://legacy.example/api/internal/migrations/final-bridge');
  expect(() => client(r).prepare({ ...body(), endpoint: 'https://evil.example' } as ReturnType<typeof body>)).toThrow();
  vi.stubEnv('NODE_ENV', 'production'); expect(() => client(registration('http://127.0.0.1:8787/api/internal/migrations/final-bridge'))).toThrow();
  for (const endpoint of [r.endpoint + '?', r.endpoint + '#', r.endpoint + '/other', 'https://user:password@legacy.example/api/internal/migrations/final-bridge']) {
    expect(() => client({ ...r, endpoint })).toThrow();
  }
});
it('pre-cancelled and expired prepared attempts never send', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const c = client(registration('https://legacy.example/api/internal/migrations/final-bridge'));
  const controller = new AbortController(); controller.abort(); expect(await c.prepare(body()).send(controller.signal)).toEqual({ outcome: 'NOT_SENT' });
  const attempt = c.prepare(body()); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
  try { expect(await attempt.send()).toEqual({ outcome: 'NOT_SENT' }); } finally { vi.restoreAllMocks(); }
  expect(fetch).not.toHaveBeenCalled();
});
