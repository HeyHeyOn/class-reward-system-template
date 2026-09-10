import { generateKeyPairSync, hkdfSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { REQUIRED_SHEETS } from '@/generator/config/schema';
import { sha256 } from './validators';
import * as Producer from './registeredFreezingReacquisition';
import { canonicalJson, openLegacyBridgeManifest, sealLegacyBridgeManifest } from './legacyBridgeManifest';
import { parseFreezingReacquisitionChallenge } from './freezingReacquisitionContract';
import { parseFinalBridgeChallenge } from '../legacyMigrationBridge';
import { createRegisteredBridgeProducer, signBridgeRequest, type BridgeRegistration } from './registeredBridgeProducer';
import { createFinalBridgeIntake } from './finalBridgeIntake';

vi.mock('server-only', () => ({}));
async function production(): Promise<typeof Producer> { return Producer; }
const requestKeys = generateKeyPairSync('ed25519');
const manifestKeys = generateKeyPairSync('ed25519');
const writerKeys = generateKeyPairSync('ed25519');
const registration = {
  endpoint: 'https://legacy.example/api/internal/migrations/freezing-reacquisition', deploymentId: 'legacy-1',
  registrationDigest: 'c'.repeat(64), registrationVersion: '1', approvedScope: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE' as const,
  tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-1',
  requestKeyId: 'request-1', requestPublicKey: requestKeys.publicKey,
  manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writerKeys.publicKey,
};
function body(now = Date.now()) {
  return { challenge: {
    purpose: 'CLASS_STORE_FREEZING_REACQUISITION' as const, bindingVersion: 1 as const, challengeId: randomUUID(),
    tenantId: registration.tenantId, migrationJobId: randomUUID(), expectedStatus: 'FREEZING' as const,
    expectedStateVersion: '2', sourceId: 'sheet', spreadsheetIdDigest: sha256('sheet-1'),
    jobSemanticFingerprint: 'a'.repeat(64), sourceAcquisitionDigest: 'b'.repeat(64), deploymentId: 'legacy-1',
    actorUserId: randomUUID(), actorSubject: 'owner', sessionBinding: 'd'.repeat(64),
    startCeremonyId: randomUUID(), executionDigest: 'e'.repeat(64), preflightSnapshotId: randomUUID(),
    preflightSnapshotDigest: 'f'.repeat(64), registrationDigest: registration.registrationDigest,
    registrationVersion: registration.registrationVersion, issuedAt: now, expiresAt: now + 60_000,
  } };
}
function fixture(options: { ack?: 'lost' | 'wrong'; advance?: () => void; control?: (count: number) => Record<string, unknown>; revision?: string; extra?: boolean; malformed?: boolean } = {}) {
  const events: string[] = []; const rows: Producer.FreezingReacquisitionReservation[] = [];
  const reserve = async (row: Producer.FreezingReacquisitionReservation) => {
    if (rows.some(r => r.nonceDigest === row.nonceDigest || r.challengeId === row.challengeId)) throw Error('duplicate');
    rows.push(row); events.push('reserve'); options.advance?.();
    if (options.ack === 'lost') throw Error('lost');
    return options.ack === 'wrong' ? { ...row, requestDigest: '0'.repeat(64) } : row;
  };
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example'); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', 'http://127.0.0.1:8787/control');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic-control');
  let count = 0;
  const disabledAt = new Date(Date.now() - 86_400_000).toISOString();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === 'http://127.0.0.1:8787/control') {
      events.push(`control:${init.method}`);
      return Response.json({ version: 1, deploymentId: 'legacy-1', source: 'UPSTASH_REDIS_REST', status: 'DISABLED',
        disabled: true, generation: 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt, ...options.control?.(++count) });
    }
    if (url !== 'https://redis.example') throw Error('Nonfixture network forbidden');
    const command = JSON.parse(String(init.body)); events.push(`redis:${command[0]}`);
    return Response.json({ result: options.malformed ? ['0', ['odd']] : command[0] === 'SCAN'
      ? ['0', [`padlet:evidence-claim:v1:${'d'.repeat(64)}`]] : command[0] === 'GET' ? 'legacy-owner' : ['0', []] });
  });
  const encryptionKey = randomBytes(32);
  const dependencies = { registration, reservations: { reserveAndCommit: reserve },
    sheets: { listSheetNames: async () => { events.push('sheets'); return ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks']; },
      getRows: async (name: string) => name === 'Settings' ? [['key', 'value'], ['schemaVersion', '1'], ['classTimeZone', 'Asia/Seoul']]
        : name === 'Students' ? [[...REQUIRED_SHEETS.Students], ['S1', 'Alice', '100', 'ACTIVE'], ...(options.extra ? [['S2', 'Bob', '0', 'ACTIVE']] : [])]
          : [[...REQUIRED_SHEETS[name as keyof typeof REQUIRED_SHEETS]]], getRevision: async () => options.revision ?? 'revision-2' },
    manifest: { keyId: 'manifest-1', signingPrivateKey: manifestKeys.privateKey, encryptionKey },
  };
  return { events, rows, dependencies, encryptionKey, disabledAt };
}
async function request(p: typeof Producer, b = body()) {
  const signed = p.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, b);
  return new Request(registration.endpoint, { method: 'POST', headers: signed.headers, body: signed.body });
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
it('executes the new registered read-only capture and seals the real complete pair without renewing old disable evidence', async () => {
  const p = await production(); const f = fixture(); const b = body();
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b));
  expect(response.status).toBe(200);
  const payload = await p.openFreezingReacquisitionEnvelope(await response.json(), { encryptionKey: f.encryptionKey,
    signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload).toMatchObject({ challenge: b.challenge, authority: 'NONAUTHORITY', outcome: 'AUTHENTIC_FREEZING_ACQUISITION',
    exclusion: 'NOT_PROVEN', finalImportEligible: false, localWriterObservation: { disabledAt: f.disabledAt },
    sheetsSnapshot: { sourceRevision: 'revision-2' } });
  expect(payload.redisSnapshot.v1Tombstones).toHaveLength(1);
  expect(payload.sheetsSnapshot.tabs.Students.rows).toHaveLength(1);
  expect(payload.normalization.sourceArtifacts.redis?.digest).toBe(payload.redisSnapshot.digest);
  expect(f.events).toEqual(['reserve', 'control:GET', 'redis:HSCAN', 'redis:SCAN', 'redis:GET', 'redis:HSCAN', 'redis:SCAN', 'redis:GET', 'sheets', 'control:GET']);
  expect(JSON.stringify(payload)).not.toContain('FINAL_FROZEN');
});

it('accepts a separately captured later revision and extra source row without replacing original bindings', async () => {
  const p = await production(); const b = body(); const f = fixture({ revision: 'revision-3', extra: true });
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b));
  expect(response.status).toBe(200);
  const wrapped = await response.json();
  const payload = await p.openFreezingReacquisitionEnvelope(wrapped, { encryptionKey: f.encryptionKey,
    signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(payload.sheetsSnapshot.tabs.Students.rows).toHaveLength(2);
  expect(payload.sheetsSnapshot.sourceRevision).toBe('revision-3');
  expect(payload.sheetsSnapshot.digest).not.toBe(b.challenge.sourceAcquisitionDigest);
  expect(payload.challenge).toEqual(b.challenge);
  expect(wrapped.envelope.expiresAt).toBe(b.challenge.expiresAt);
});
it.each(['lost', 'wrong'] as const)('reservation %s ACK is terminal with zero control/source reads', async ack => {
  const p = await production(); const f = fixture({ ack }); const b = body();
  expect((await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b))).status).toBe(403);
  expect(f.events).toEqual(['reserve']); expect(f.rows).toHaveLength(1);
});
it('competing instances and fresh nonce duplicate challenges cannot capture twice', async () => {
  const p = await production(); const f = fixture(); const b = body(); const req = await request(p, b);
  const statuses = await Promise.all([p.createRegisteredFreezingReacquisition(f.dependencies)(req.clone()), p.createRegisteredFreezingReacquisition(f.dependencies)(req.clone())]);
  expect(statuses.map(r => r.status).sort()).toEqual([200, 403]);
  expect((await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b))).status).toBe(403);
  expect(f.rows).toHaveLength(1); expect(f.events.filter(e => e === 'sheets')).toHaveLength(1);
});
function resign(p: typeof Producer, change: Record<string, unknown>, b = body(), alterBody?: (b: ReturnType<typeof body>) => unknown) {
  const signed = p.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, b);
  const auth = JSON.parse(Buffer.from(signed.headers['x-class-store-freezing-reacquisition'], 'base64url').toString());
  delete auth.signature; Object.assign(auth, change);
  const bytes = alterBody ? canonicalJson(alterBody(b)) : signed.body;
  if (alterBody) auth.bodyDigest = sha256(bytes);
  auth.signature = sign(null, Buffer.from('class-store:registered-freezing-reacquisition-request:v1\0' + canonicalJson(auth)), requestKeys.privateKey).toString('base64url');
  return new Request(registration.endpoint, { method: 'POST', body: bytes, headers: {
    'content-type': 'application/json', 'x-class-store-freezing-reacquisition': Buffer.from(canonicalJson(auth)).toString('base64url') } });
}
it.each(['audience', 'path', 'scope', 'purpose', 'registrationDigest', 'registrationVersion', 'keyId', 'actorUserId',
  'actorSubject', 'sessionBinding', 'startCeremonyId', 'executionDigest', 'challengeId', 'bodyDigest'])('rejects correctly signed altered %s before reservation', async key => {
  const p = await production(); const f = fixture();
  expect((await p.createRegisteredFreezingReacquisition(f.dependencies)(resign(p, { [key]: 'wrong' }))).status).toBe(403);
  expect(f.events).toEqual([]);
});
it('rejects a reused nonce across distinct challenges', async () => {
  const p = await production(); const f = fixture(); const run = p.createRegisteredFreezingReacquisition(f.dependencies);
  expect((await run(resign(p, { nonce: 'A'.repeat(32) }))).status).toBe(200);
  expect((await run(resign(p, { nonce: 'A'.repeat(32) }))).status).toBe(403);
  expect(f.rows).toHaveLength(1);
});
it.each(['enabled', 'drift', 'disabledAt', 'malformed', 'missingRedis'] as const)('refuses %s without disable/enable or seal', async mode => {
  const p = await production(); const f = fixture({ malformed: mode === 'malformed', control: count =>
    mode === 'enabled' ? { disabled: false, status: 'ENABLED' } : count === 2 && mode === 'drift' ? { generation: 2 }
      : count === 2 && mode === 'disabledAt' ? { disabledAt: new Date().toISOString() } : {} });
  if (mode === 'missingRedis') { vi.stubEnv('UPSTASH_REDIS_REST_URL', ''); vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', ''); }
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p));
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ outcome: 'UNKNOWN' });
  expect(f.events).not.toContain('control:POST');
  if (mode === 'enabled') expect(f.events).toEqual(['reserve', 'control:GET']);
});
it.each(['entry', 'reservation', 'beforeCapture', 'beforeSeal'] as const)('checks original lifetime at %s', async stage => {
  vi.useFakeTimers(); const now = Date.now(); const b = body(now); const p = await production();
  const f = fixture({ advance: stage === 'reservation' ? () => vi.setSystemTime(now + 60_000) : undefined,
    control: count => { if ((stage === 'beforeCapture' && count === 1) || (stage === 'beforeSeal' && count === 2)) vi.setSystemTime(now + 60_000); return {}; } });
  const req = await request(p, b); if (stage === 'entry') vi.setSystemTime(now + 60_000);
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(req);
  expect(response.status).toBe(stage === 'entry' || stage === 'reservation' ? 403 : 503);
  expect(await response.json()).not.toHaveProperty('envelope');
  if (stage !== 'beforeSeal') expect(f.events).not.toContain('sheets');
});
it('rejects request expiry extension and future issuance before reservation', async () => {
  const p = await production(); const f = fixture(); const b = body();
  for (const changes of [{ expiresAt: b.challenge.expiresAt + 1 }, { issuedAt: b.challenge.issuedAt + 120_000 }]) {
    expect((await p.createRegisteredFreezingReacquisition(f.dependencies)(resign(p, changes, b))).status).toBe(403);
  }
  expect(f.events).toEqual([]);
});
it('refuses old/new registrations and shared key purposes', async () => {
  const p = await production(); const f = fixture();
  for (const r of [{ ...registration, approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING' },
    { ...registration, endpoint: 'https://legacy.example/api/internal/migrations/final-bridge' },
    { ...registration, manifestPublicKey: requestKeys.publicKey }, { ...registration, writerPublicKey: requestKeys.publicKey }]) {
    expect(() => p.createRegisteredFreezingReacquisition({ ...f.dependencies, registration: r as Producer.FreezingReacquisitionRegistration })).toThrow();
  }
});
function oldBody(b = body()) {
  const { sessionBinding: _session, startCeremonyId, executionDigest: _execution, preflightSnapshotId: _preflight,
    preflightSnapshotDigest: _digest, registrationDigest: _registration, registrationVersion: _version, ...base } = b.challenge;
  void [_session, _execution, _preflight, _digest, _registration, _version];
  return { ceremonyId: startCeremonyId, challenge: { ...base, purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE' as const,
    bindingVersion: 2 as const, expectedStatus: 'READY' as const } };
}
it('genuine READY v2 and FREEZING v1 parsers, signed producers and old intake reject cross-phase objects', async () => {
  const p = await production(); const f = fixture(); const b = body(); const old = oldBody(b);
  expect(parseFinalBridgeChallenge(old.challenge)).toEqual(old.challenge);
  expect(parseFreezingReacquisitionChallenge(b.challenge)).toEqual(b.challenge);
  expect(() => parseFinalBridgeChallenge(b.challenge)).toThrow();
  expect(() => parseFreezingReacquisitionChallenge(old.challenge)).toThrow();
  const oldRegistration: BridgeRegistration = { ...registration, endpoint: 'https://legacy.example/api/internal/migrations/final-bridge', approvedScope: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING' };
  const oldSigned = signBridgeRequest(oldRegistration, requestKeys.privateKey, old);
  expect((await p.createRegisteredFreezingReacquisition(f.dependencies)(new Request(registration.endpoint, { method: 'POST', headers: oldSigned.headers, body: oldSigned.body }))).status).toBe(403);
  const oldRun = createRegisteredBridgeProducer({ ...f.dependencies, registration: oldRegistration,
    reservations: { reserveAndCommit: async () => { throw Error('old reservation must not run'); } } });
  const newRequest = await request(p, b);
  expect((await oldRun(new Request(oldRegistration.endpoint, { method: 'POST', headers: newRequest.headers, body: await newRequest.text() }))).status).toBe(403);
  expect(f.events).toEqual([]);
  const result = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b));
  expect(result.status).toBe(200); const envelope = await result.json();
  const tx = vi.fn(async () => { throw Error('old SQL must not run'); });
  const intake = createFinalBridgeIntake({ tenantId: registration.tenantId, getAuthenticatedSubject: async () => 'owner', registeredDeployments: [], runTransaction: tx });
  await expect(intake.accept({ challengeId: b.challenge.challengeId, manifest: envelope })).rejects.toThrow();
  expect(tx).not.toHaveBeenCalled();
  await expect(openLegacyBridgeManifest(envelope, { encryptionKey: f.encryptionKey, signingPublicKey: manifestKeys.publicKey,
    nonceConsumer: { consumeOnce: async () => true } })).rejects.toThrow();
  const legacyEnvelope = sealLegacyBridgeManifest({ manifestType: 'CLASS_STORE_LEGACY_ACQUISITION', finalIntakeBinding: old.challenge },
    { ...f.dependencies.manifest });
  await expect(p.openFreezingReacquisitionEnvelope(legacyEnvelope, { encryptionKey: f.encryptionKey, signingPublicKey: manifestKeys.publicKey,
    expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } })).rejects.toThrow();
});
it.each(['ttl', 'unknown', 'uuid', 'session', 'version'] as const)('strict phase contract rejects %s', mode => {
  const c = body().challenge;
  const changed = mode === 'ttl' ? { ...c, expiresAt: c.expiresAt + 1 } : mode === 'unknown' ? { ...c, lease: true }
    : mode === 'uuid' ? { ...c, challengeId: 'not-random-id' } : mode === 'session' ? { ...c, sessionBinding: '' }
      : { ...c, expectedStateVersion: '9007199254740992' };
  expect(() => parseFreezingReacquisitionChallenge(changed)).toThrow();
});
it.each(['extra', 'observation', 'captureTime', 'source', 'challenge', 'normalization', 'nullRedis', 'promoted'] as const)('refuses signed malformed %s before consuming nonce', async attack => {
  const p = await production(); const f = fixture(); const b = body();
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b));
  expect(response.status).toBe(200);
  const valid = await p.openFreezingReacquisitionEnvelope(await response.json(), { encryptionKey: f.encryptionKey, signingPublicKey: manifestKeys.publicKey,
    expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } });
  const payload = JSON.parse(JSON.stringify(valid));
  if (attack === 'extra') payload.leaseExpiresAt = b.challenge.expiresAt;
  if (attack === 'observation') payload.localWriterObservation.status = 'ENABLED';
  if (attack === 'captureTime') payload.capturedAt = '2020-01-01T00:00:00.000Z';
  if (attack === 'source') payload.challenge.spreadsheetIdDigest = '0'.repeat(64);
  if (attack === 'challenge') payload.challenge.executionDigest = '0'.repeat(64);
  if (attack === 'normalization') payload.normalization.sourceFingerprint = '0'.repeat(64);
  if (attack === 'nullRedis') payload.redisSnapshot = null;
  if (attack === 'promoted') payload.finalImportEligible = true;
  const sealAt = Date.now();
  const encrypted = sealLegacyBridgeManifest(payload, { ...f.dependencies.manifest, now: () => sealAt,
    encryptionKey: Buffer.from(hkdfSync('sha256', f.encryptionKey, 'CLASS_STORE_FREEZING_REACQUISITION', 'encrypted-candidate:v1', 32)),
    ttlMs: b.challenge.expiresAt - sealAt });
  const consumeOnce = vi.fn(async () => true);
  await expect(p.openFreezingReacquisitionEnvelope({ purpose: 'CLASS_STORE_FREEZING_REACQUISITION', bindingVersion: 1, envelope: encrypted }, {
    encryptionKey: f.encryptionKey, signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge, nonceConsumer: { consumeOnce } })).rejects.toThrow();
  expect(consumeOnce).not.toHaveBeenCalled();
});
it('refuses unsupported Settings alias retention before sealing, even when the normalizer only quarantines it', async () => {
  const p = await production(); const f = fixture(); const names = f.dependencies.sheets.listSheetNames;
  const rows = f.dependencies.sheets.getRows;
  f.dependencies.sheets.listSheetNames = async () => [...await names(), ' settings '];
  f.dependencies.sheets.getRows = async name => name === ' settings ' ? [['key', 'value'], ['themeColor', 'blue']] : rows(name);
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p));
  expect(response.status).toBe(503);
  expect(f.events).toContain('sheets');
});
it('redacts raw deployment credential cells and unsupported hashes with the actual capture', async () => {
  const p = await production(); const f = fixture(); const rows = f.dependencies.sheets.getRows;
  f.dependencies.sheets.getRows = async name => name === 'Settings'
    ? [...await rows(name), ['adminPassword', 'synthetic-password']] : rows(name);
  const b = body(); const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b));
  expect(response.status).toBe(200);
  const payload = await p.openFreezingReacquisitionEnvelope(await response.json(), { encryptionKey: f.encryptionKey,
    signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(JSON.stringify(payload)).not.toContain('synthetic-password');
  expect(JSON.stringify(payload)).not.toContain('legacy-owner');
  f.dependencies.sheets.getRows = async name => name === 'Settings'
    ? [...await rows(name), ['adminPasswordHash', 'not-a-hash']] : rows(name);
  const second = body();
  const redacted = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, second));
  expect(redacted.status).toBe(200);
  const secondPayload = await p.openFreezingReacquisitionEnvelope(await redacted.json(), { encryptionKey: f.encryptionKey,
    signingPublicKey: manifestKeys.publicKey, expectedChallenge: second.challenge, nonceConsumer: { consumeOnce: async () => true } });
  expect(JSON.stringify(secondPayload)).not.toContain('not-a-hash');
  expect(secondPayload.sheetsSnapshot.credentialHashes).not.toHaveProperty('adminPasswordHash');
});
it('lost/stalled reservation ACK times out without any read or automatic retry', async () => {
  vi.useFakeTimers(); const p = await production(); const f = fixture(); let reserved = 0;
  const run = p.createRegisteredFreezingReacquisition({ ...f.dependencies, reservations: { reserveAndCommit: async () => {
    reserved++; return new Promise<Producer.FreezingReacquisitionReservation>(() => {});
  } } });
  const pending = run(await request(p)); await vi.advanceTimersByTimeAsync(5000);
  expect((await pending).status).toBe(403); expect(reserved).toBe(1); expect(f.events).toEqual([]);
});
it('rejects oversized and cancelled authenticated request streams before reservation', async () => {
  const p = await production(); const f = fixture(); const req = await request(p); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.alloc(8193, 32)); }, cancel() { cancelled = true; } });
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(new Request(req.url,
    { method: 'POST', headers: req.headers, body: stream, duplex: 'half' } as RequestInit));
  expect(response.status).toBe(403); expect(cancelled).toBe(true); expect(f.events).toEqual([]);
});
it('envelope nonce ACK loss or expiry after its wait never returns a candidate or retries', async () => {
  vi.useFakeTimers(); const p = await production(); const f = fixture(); const b = body();
  const response = await p.createRegisteredFreezingReacquisition(f.dependencies)(await request(p, b)); expect(response.status).toBe(200);
  const envelope = await response.json(); const consumeOnce = vi.fn(async () => { vi.setSystemTime(b.challenge.expiresAt); return true; });
  await expect(p.openFreezingReacquisitionEnvelope(envelope, { encryptionKey: f.encryptionKey, signingPublicKey: manifestKeys.publicKey,
    expectedChallenge: b.challenge, nonceConsumer: { consumeOnce } })).rejects.toThrow();
  expect(consumeOnce).toHaveBeenCalledTimes(1);
});
