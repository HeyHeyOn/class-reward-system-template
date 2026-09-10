// @vitest-environment node
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { TransactionPool, TransactionConnection } from '@/server/db/transaction';
import { REQUIRED_SHEETS } from '@/generator/config/schema';
import { canonicalJson } from './legacyBridgeManifest';
import { sha256 } from './validators';
import * as Producer from './registeredFreezingReacquisition';
import { createFreezingProducerReservations } from './freezingProducerReservations';
import { createBridgeProducerReservations } from './bridgeProducerReservations';
vi.mock('server-only', () => ({}));
let db: PGlite;
let historic: unknown[];
// PGlite has one physical connection. Model a size-one SQL pool, not independent
// PostgreSQL connections; separate-connection lock races remain a release gate.
let connectionTail = Promise.resolve();
const oldRow = () => ({ deploymentId: 'legacy-1', registrationDigest: 'c'.repeat(64), ceremonyId: randomUUID(),
  challengeId: randomUUID(), nonceDigest: randomBytes(32).toString('hex'), requestDigest: 'd'.repeat(64),
  issuedAt: Date.now(), expiresAt: Date.now() + 59_000 });
const newRow = (): Producer.FreezingReacquisitionReservation => {
  const { ceremonyId, ...row } = oldRow();
  return { ...row, purpose: 'CLASS_STORE_REGISTERED_FREEZING_REACQUISITION_REQUEST', startCeremonyId: ceremonyId, executionDigest: 'e'.repeat(64) };
};
beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const files = (await readdir('src/server/db/migrations')).filter(f => f.endsWith('.sql')).sort();
  for (const file of files.filter(f => f < '0022')) await db.exec(await readFile(`src/server/db/migrations/${file}`, 'utf8'));
  await db.exec(`CREATE ROLE "legacy-1" NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE "legacy-2" NOSUPERUSER NOBYPASSRLS;
    GRANT SELECT, INSERT ON migration_bridge_producer_reservations TO "legacy-1", "legacy-2"`);
  await createBridgeProducerReservations(localPool([]), 'legacy-1').reserveAndCommit(oldRow());
  historic = (await db.query('SELECT * FROM migration_bridge_producer_reservations')).rows;
  // Test-only SQL nonce sink for crypto-open; not a mocked acceptance and not
  // the deferred central candidate-intake transaction/authority.
  await db.exec('CREATE TABLE freezing_envelope_test_nonces (nonce_digest text PRIMARY KEY)');
  for (const file of files.filter(f => f >= '0022')) await db.exec(await readFile(`src/server/db/migrations/${file}`, 'utf8'));
}, 60_000);
afterAll(async () => { await db?.close(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
type Fault = 'ack' | 'readback' | 'mismatch' | 'isolation' | 'clock' | 'expiry';
function localPool(events: string[], fault?: Fault, role = 'legacy-1'): TransactionPool {
  return { async connect() {
    const prior = connectionTail; let unlock!: () => void;
    connectionTail = new Promise<void>(resolve => { unlock = resolve; });
    await prior;
    events.push('connect');
    return { async query(text: string, values?: unknown[]) {
      if (text.startsWith('BEGIN')) {
        await db.exec(text); await db.exec(`SET LOCAL ROLE "${role}"`);
        events.push(text); return { rows: [], rowCount: null };
      }
      const result = await db.query(text, values);
      if (text === 'COMMIT') {
        events.push('COMMIT');
        if (fault === 'ack') throw Error('ACK lost after actual commit');
        if (fault === 'expiry') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 60_000); }
      }
      if (text.startsWith('SELECT nonce_digest')) {
        if (fault === 'readback') return { rows: [] };
        if (fault === 'mismatch') return { rows: result.rows.map(r => ({ ...(r as Record<string, unknown>), execution_digest: 'f'.repeat(64) })) };
      }
      if (fault === 'isolation' && text.startsWith('SHOW')) return { rows: [{ transaction_isolation: 'repeatable read' }] };
      if (fault === 'clock' && text.includes('clock_timestamp')) return { rows: [{ now_ms: '9007199254740991' }] };
      return result;
    }, release(discard) { events.push(discard ? 'discard' : 'release'); unlock(); } } as TransactionConnection;
  } };
}
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
  const events: string[] = [];
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
  const dependencies = { registration, reservations: createFreezingProducerReservations(localPool(events), registration.deploymentId),
    sheets: { listSheetNames: async () => { events.push('sheets'); return ['Students', 'Products', 'Transactions', 'Adjustments', 'Settings', 'Tasks']; },
      getRows: async (name: string) => name === 'Settings' ? [['key', 'value'], ['schemaVersion', '1'], ['classTimeZone', 'Asia/Seoul']]
        : name === 'Students' ? [[...REQUIRED_SHEETS.Students], ['S1', 'Alice', '100', 'ACTIVE'], ...(options.extra ? [['S2', 'Bob', '0', 'ACTIVE']] : [])]
          : [[...REQUIRED_SHEETS[name as keyof typeof REQUIRED_SHEETS]]], getRevision: async () => options.revision ?? 'revision-2' },
    manifest: { keyId: 'manifest-1', signingPrivateKey: manifestKeys.privateKey, encryptionKey },
  };
  return { events, dependencies, encryptionKey, disabledAt };
}
async function request(p: typeof Producer, b = body()) {
  const signed = p.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, b);
  return new Request(registration.endpoint, { method: 'POST', headers: signed.headers, body: signed.body });
}

it('executes genuinely signed producer through durable restricted SQL ACK before GET/capture and crypto-open', async () => {
  const f = fixture(); const b = body();
  const signed = Producer.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, b);
  const req = new Request(registration.endpoint, { method: 'POST', headers: signed.headers, body: signed.body });
  const response = await Producer.createRegisteredFreezingReacquisition(f.dependencies)(req.clone());
  expect(response.status).toBe(200);
  const payload = await Producer.openFreezingReacquisitionEnvelope(await response.json(), {
    encryptionKey: f.encryptionKey, signingPublicKey: manifestKeys.publicKey, expectedChallenge: b.challenge,
    nonceConsumer: { consumeOnce: async nonce => {
      const inserted = await db.query('INSERT INTO freezing_envelope_test_nonces VALUES ($1) ON CONFLICT DO NOTHING RETURNING nonce_digest', [nonce]);
      return inserted.rows.length === 1;
    } } });
  expect(payload).toMatchObject({ authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', finalImportEligible: false,
    challenge: b.challenge, localWriterObservation: { disabledAt: f.disabledAt } });
  expect(payload.redisSnapshot.v1Tombstones).toHaveLength(1);
  expect(payload.sheetsSnapshot.tabs.Students.rows).toHaveLength(1);
  expect(JSON.stringify(payload)).not.toContain('FINAL_FROZEN');
  expect(f.events).toEqual(['connect', 'BEGIN ISOLATION LEVEL READ COMMITTED', 'COMMIT', 'release',
    'control:GET', 'redis:HSCAN', 'redis:SCAN', 'redis:GET', 'redis:HSCAN', 'redis:SCAN', 'redis:GET', 'sheets', 'control:GET']);
  const auth = JSON.parse(Buffer.from(signed.headers['x-class-store-freezing-reacquisition'], 'base64url').toString());
  const rows = (await db.query('SELECT * FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ purpose: auth.purpose, ceremony_id: null, start_ceremony_id: b.challenge.startCeremonyId,
    execution_digest: b.challenge.executionDigest, registration_digest: registration.registrationDigest,
    request_digest: signed.requestDigest, nonce_digest: sha256(JSON.stringify([auth.purpose, auth.nonce])) });
  const other = Producer.createRegisteredFreezingReacquisition({ ...f.dependencies,
    reservations: createFreezingProducerReservations(localPool(f.events), 'legacy-1') });
  expect((await other(req.clone())).status).toBe(403);
  expect((await other(await request(Producer, b))).status).toBe(403);
  expect(f.events.filter(e => e === 'sheets')).toHaveLength(1);
});
it('labels preserved old rows with their actual signed request purpose, not an invented alias', async () => {
  const row = historic[0] as {nonce_digest:string};
  expect((await db.query('SELECT purpose FROM migration_bridge_producer_reservations WHERE nonce_digest=$1', [row.nonce_digest])).rows)
    .toEqual([{ purpose: 'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST' }]);
});
it('accepts exact phase-correct durable rows', async () => {
  const row = newRow();
  expect(await createFreezingProducerReservations(localPool([]), 'legacy-1').reserveAndCommit(row)).toEqual(row);
});
it('preserves every historical value and keeps old producer executable after upgrade', async () => {
  const columns = Object.keys(historic[0] as object).join(',');
  const current = (await db.query(`SELECT ${columns} FROM migration_bridge_producer_reservations WHERE nonce_digest=$1`, [(historic[0] as {nonce_digest:string}).nonce_digest])).rows;
  expect(current).toEqual(historic);
  const row = oldRow();
  expect(await createBridgeProducerReservations(localPool([]), 'legacy-1').reserveAndCommit(row)).toEqual(row);
});
it.each(['old-first', 'new-first'] as const)('enforces shared cross-phase challenge and nonce uniqueness: %s', async order => {
  const old = oldRow(); const fresh = newRow();
  const a = createBridgeProducerReservations(localPool([]), 'legacy-1');
  const b = createFreezingProducerReservations(localPool([]), 'legacy-1');
  if (order === 'old-first') {
    await a.reserveAndCommit(old);
    await expect(b.reserveAndCommit({ ...fresh, challengeId: old.challengeId })).rejects.toThrow();
    await expect(b.reserveAndCommit({ ...fresh, nonceDigest: old.nonceDigest })).rejects.toThrow();
  } else {
    await b.reserveAndCommit(fresh);
    await expect(a.reserveAndCommit({ ...old, challengeId: fresh.challengeId })).rejects.toThrow();
    await expect(a.reserveAndCommit({ ...old, nonceDigest: fresh.nonceDigest })).rejects.toThrow();
  }
});
it.each(['ack', 'readback', 'mismatch', 'isolation', 'clock', 'expiry'] as const)('producer refuses %s with no GET and no retry', async fault => {
  const f = fixture(); const b = body();
  const dependencies = { ...f.dependencies, reservations: createFreezingProducerReservations(localPool(f.events, fault), 'legacy-1') };
  expect((await Producer.createRegisteredFreezingReacquisition(dependencies)(await request(Producer, b))).status).toBe(403);
  expect(f.events.filter(e => e === 'connect')).toHaveLength(1);
  expect(f.events.some(e => e.startsWith('control:') || e.startsWith('redis:') || e === 'sheets')).toBe(false);
  expect(f.events.filter(e => e === 'COMMIT')).toHaveLength(fault === 'ack' || fault === 'expiry' ? 1 : 0);
  expect(f.events.includes('discard')).toBe(fault === 'ack');
  expect((await db.query('SELECT * FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows)
    .toHaveLength(fault === 'ack' || fault === 'expiry' ? 1 : 0);
});
it('rejects suppressed SQL insertion by exact readback before commit', async () => {
  await db.exec(`CREATE FUNCTION suppress_freezing_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER suppress_freezing_test BEFORE INSERT ON migration_bridge_producer_reservations FOR EACH ROW EXECUTE FUNCTION suppress_freezing_test()`);
  try {
    const events: string[] = [];
    await expect(createFreezingProducerReservations(localPool(events), 'legacy-1').reserveAndCommit(newRow())).rejects.toThrow();
    expect(events).not.toContain('COMMIT');
  } finally { await db.exec('DROP TRIGGER suppress_freezing_test ON migration_bridge_producer_reservations; DROP FUNCTION suppress_freezing_test()'); }
});
it('runtime cannot mutate, delete, truncate or read another deployment tombstone', async () => {
  const row = newRow(); await createFreezingProducerReservations(localPool([]), 'legacy-1').reserveAndCommit(row);
  for (const role of ['legacy-1', 'legacy-2']) {
    await db.exec(`SET ROLE "${role}"`);
    try {
      for (const sql of ['UPDATE migration_bridge_producer_reservations SET request_digest=request_digest',
        'DELETE FROM migration_bridge_producer_reservations', 'TRUNCATE migration_bridge_producer_reservations']) await expect(db.exec(sql)).rejects.toThrow();
      if (role === 'legacy-2') expect((await db.query('SELECT * FROM migration_bridge_producer_reservations')).rows).toEqual([]);
    } finally { await db.exec('RESET ROLE'); }
  }
  for (const sql of ['UPDATE migration_bridge_producer_reservations SET request_digest=request_digest',
    'DELETE FROM migration_bridge_producer_reservations', 'TRUNCATE migration_bridge_producer_reservations']) await expect(db.exec(sql)).rejects.toThrow();
});
it('same-purpose signed body tampering fails before SQL connection', async () => {
  const f = fixture(); const b = body();
  const signed = Producer.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, b);
  b.challenge.executionDigest = 'f'.repeat(64);
  const response = await Producer.createRegisteredFreezingReacquisition(f.dependencies)(new Request(registration.endpoint,
    { method: 'POST', headers: signed.headers, body: JSON.stringify(b) }));
  expect(response.status).toBe(403); expect(f.events).toEqual([]);
});

it('concurrent producer instances sharing one actual SQL connection capture only once', async () => {
  const f = fixture(); const b = body(); const req = await request(Producer, b);
  const other = { ...f.dependencies, reservations: createFreezingProducerReservations(localPool(f.events), 'legacy-1') };
  const responses = await Promise.all([
    Producer.createRegisteredFreezingReacquisition(f.dependencies)(req.clone()),
    Producer.createRegisteredFreezingReacquisition(other)(req.clone()),
  ]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 403]);
  expect(f.events.filter(e => e === 'sheets')).toHaveLength(1);
  expect((await db.query('SELECT * FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows).toHaveLength(1);
});
it('real signed same-purpose nonce reuse on a fresh challenge cannot capture again', async () => {
  const f = fixture(); const run = Producer.createRegisteredFreezingReacquisition(f.dependencies);
  const a = body(); const b = body();
  const first = Producer.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, a);
  const next = Producer.signFreezingReacquisitionRequest(registration, requestKeys.privateKey, b);
  const auth = JSON.parse(Buffer.from(next.headers['x-class-store-freezing-reacquisition'], 'base64url').toString());
  const firstAuth = JSON.parse(Buffer.from(first.headers['x-class-store-freezing-reacquisition'], 'base64url').toString());
  delete auth.signature; auth.nonce = firstAuth.nonce;
  auth.signature = sign(null, Buffer.from('class-store:registered-freezing-reacquisition-request:v1\0' + canonicalJson(auth)), requestKeys.privateKey).toString('base64url');
  const second = new Request(registration.endpoint, { method: 'POST', body: next.body, headers: { ...next.headers,
    'x-class-store-freezing-reacquisition': Buffer.from(canonicalJson(auth)).toString('base64url') } });
  expect((await run(new Request(registration.endpoint, { method: 'POST', headers: first.headers, body: first.body }))).status).toBe(200);
  expect((await run(second)).status).toBe(403);
  expect(f.events.filter(e => e === 'sheets')).toHaveLength(1);
  expect((await db.query('SELECT * FROM migration_bridge_producer_reservations WHERE challenge_id=$1', [b.challenge.challengeId])).rows).toHaveLength(0);
});
it.each([
  { purpose: null }, { purpose: 'OTHER' }, { purpose: 'CLASS_STORE_REGISTERED_FINAL_BRIDGE_REQUEST' },
  { startCeremonyId: null }, { executionDigest: null }, { executionDigest: 'bad' },
  { ceremonyId: '10000000-0000-4000-8000-000000000001' },
  { issuedAt: -1 }, { expiresAt: 9007199254740992 }, { registrationDigest: 'bad' },
] as const)('SQL refuses malformed phase/start/lifetime binding %j without durable row', async change => {
  const row = { ...newRow(), ceremonyId: null, ...change };
  await expect(db.query(`INSERT INTO migration_bridge_producer_reservations
    (nonce_digest, challenge_id, purpose, start_ceremony_id, execution_digest, ceremony_id,
    deployment_id, registration_digest, request_digest, issued_at_ms, expires_at_ms)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [row.nonceDigest, row.challengeId, row.purpose,
    row.startCeremonyId, row.executionDigest, row.ceremonyId, row.deploymentId, row.registrationDigest,
    row.requestDigest, row.issuedAt, row.expiresAt])).rejects.toThrow();
  expect((await db.query('SELECT * FROM migration_bridge_producer_reservations WHERE nonce_digest=$1', [row.nonceDigest])).rows).toHaveLength(0);
});
it('old adapter never acknowledges a new-purpose cast or a hybrid ceremony shape', async () => {
  const row = newRow();
  const old = createBridgeProducerReservations(localPool([]), 'legacy-1');
  await expect(old.reserveAndCommit(row as unknown as ReturnType<typeof oldRow>)).rejects.toThrow();
  await expect(old.reserveAndCommit({ ...row, ceremonyId: row.startCeremonyId } as unknown as ReturnType<typeof oldRow>)).rejects.toThrow();
  expect((await db.query('SELECT * FROM migration_bridge_producer_reservations WHERE nonce_digest=$1', [row.nonceDigest])).rows).toHaveLength(0);
});
it('SQL and adapter refuse cross-deployment new inserts and owner role authority', async () => {
  const row = newRow();
  const wrong = createFreezingProducerReservations(localPool([], undefined, 'legacy-2'), 'legacy-2');
  await expect(wrong.reserveAndCommit(row)).rejects.toThrow();
  await db.exec('SET ROLE "legacy-2"');
  try {
    await expect(db.query(`INSERT INTO migration_bridge_producer_reservations
      (nonce_digest, challenge_id, purpose, start_ceremony_id, execution_digest, deployment_id,
       registration_digest, request_digest, issued_at_ms, expires_at_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [row.nonceDigest, row.challengeId, row.purpose,
        row.startCeremonyId, row.executionDigest, row.deploymentId, row.registrationDigest, row.requestDigest, row.issuedAt, row.expiresAt])).rejects.toThrow();
  } finally { await db.exec('RESET ROLE'); }
  const owner = (await db.query<{name:string}>('SELECT current_user::text AS name')).rows[0].name;
  await expect(createFreezingProducerReservations(localPool([], undefined, owner), owner).reserveAndCommit({ ...row, deploymentId: owner })).rejects.toThrow();
});
