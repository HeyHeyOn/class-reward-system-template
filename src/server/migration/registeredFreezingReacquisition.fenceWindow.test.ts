import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { REQUIRED_SHEETS } from '@/generator/config/schema';
import { acquireDeploymentLocalRedisReader, readDeploymentLocalWriterStatus } from '../legacyMigrationBridge';
import { parseFreezingReacquisitionChallenge } from './freezingReacquisitionContract';
import { canonicalJson } from './legacyBridgeManifest';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import {
  createRegisteredFreezingReacquisition, openFreezingReacquisitionEnvelope, signFreezingReacquisitionRequest,
  type FreezingReacquisitionEnvelope, type FreezingReacquisitionRegistration,
  type FreezingReacquisitionReservation,
} from './registeredFreezingReacquisition';
import { captureSheetsSnapshot, type WorkbookSnapshotReader } from './sheetsSnapshot';
import { sha256 } from './validators';

vi.mock('server-only', () => ({}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

// Synthetic characterization only: the fake external actor is deliberately outside
// the fake control contract. This does NOT demonstrate a production writer bypass,
// a drained queue, real Google/Redis access, durable replay storage or activation.
// Time and mutation order are fixed; ephemeral crypto keys/IVs remain genuinely random.
it('authenticates historical FREEZING envelope A while post-return fake Sheet/Redis B diverges under unchanged DISABLED control, without proving exclusion', async () => {
  vi.useFakeTimers();
  const capturedAt = '2026-01-15T00:00:00.000Z';
  const now = Date.parse(capturedAt);
  vi.setSystemTime(now);
  const requestKeys = generateKeyPairSync('ed25519');
  const manifestKeys = generateKeyPairSync('ed25519');
  const writerKeys = generateKeyPairSync('ed25519');
  const encryptionKey = randomBytes(32);
  const registration: FreezingReacquisitionRegistration = {
    endpoint: 'https://legacy.example/api/internal/migrations/freezing-reacquisition',
    deploymentId: 'legacy-fence-window', registrationDigest: 'c'.repeat(64), registrationVersion: '1',
    approvedScope: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE',
    tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-fence-window',
    requestKeyId: 'request-fence-window', requestPublicKey: requestKeys.publicKey,
    manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writerKeys.publicKey,
  };
  const challenge = parseFreezingReacquisitionChallenge({
    purpose: 'CLASS_STORE_FREEZING_REACQUISITION', bindingVersion: 1, expectedStatus: 'FREEZING',
    challengeId: '20000000-0000-4000-8000-000000000002', tenantId: registration.tenantId,
    migrationJobId: '20000000-0000-4000-8000-000000000003', expectedStateVersion: '2',
    sourceId: registration.sourceId, spreadsheetIdDigest: sha256(registration.spreadsheetId),
    jobSemanticFingerprint: 'a'.repeat(64), sourceAcquisitionDigest: 'b'.repeat(64),
    deploymentId: registration.deploymentId, actorUserId: '20000000-0000-4000-8000-000000000004',
    actorSubject: 'synthetic-owner', sessionBinding: 'd'.repeat(64),
    startCeremonyId: '20000000-0000-4000-8000-000000000005', executionDigest: 'e'.repeat(64),
    preflightSnapshotId: '20000000-0000-4000-8000-000000000006', preflightSnapshotDigest: 'f'.repeat(64),
    registrationDigest: registration.registrationDigest, registrationVersion: registration.registrationVersion,
    issuedAt: now, expiresAt: now + 60_000,
  });

  const events: string[] = [];
  const unexpectedFetches: string[] = [];
  const controlState = Object.freeze({
    version: 1, deploymentId: registration.deploymentId, source: 'UPSTASH_REDIS_REST',
    status: 'DISABLED', disabled: true, generation: 7, evidence: `sha256:${'a'.repeat(64)}`,
    disabledAt: '2026-01-14T00:00:00.000Z',
  });
  const controlAtStart = canonicalJson(controlState);
  const controlResponses: string[] = [];
  const controlUrl = 'http://127.0.0.1:8787/control';
  const redisUrl = 'https://redis.example';
  const claimA = 'd'.repeat(64);
  const claimB = 'e'.repeat(64);
  const claimKey = (digest: string) => `padlet:evidence-claim:v1:${digest}`;
  const redisClaims = new Map([[claimKey(claimA), 'synthetic-owner-A']]);
  let sheetRevision = 'revision-A';
  const liveTabs: Record<string, string[][]> = {
    Students: [[...REQUIRED_SHEETS.Students], ['S1', 'Alice', '100', 'ACTIVE']],
    Products: [[...REQUIRED_SHEETS.Products]],
    Transactions: [[...REQUIRED_SHEETS.Transactions]],
    Adjustments: [[...REQUIRED_SHEETS.Adjustments]],
    Settings: [['key', 'value'], ['schemaVersion', '1'], ['classTimeZone', 'Asia/Seoul']],
    Tasks: [[...REQUIRED_SHEETS.Tasks]],
  };
  const originalStudent = [...liveTabs.Students[1]];
  const sheets: WorkbookSnapshotReader = {
    getRevision: async () => { events.push('sheet:revision'); return sheetRevision; },
    listSheetNames: async () => { events.push('sheet:names'); return Object.keys(liveTabs); },
    getRows: async name => {
      events.push(`sheet:rows:${name}`);
      if (!Object.hasOwn(liveTabs, name)) throw new Error('Unrecognized fake Sheet tab.');
      return liveTabs[name].map(row => [...row]);
    },
  };

  // No passthrough fetch: even a known URL must match the exact read-only request.
  // POST is allowed only for the Redis read-command transport, never writer control.
  const fixtureFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    events.push(`fetch:${init?.method ?? 'GET'}:${url}`);
    if (input === controlUrl && init?.method === 'GET' && init.body === undefined) {
      controlResponses.push(canonicalJson(controlState));
      return Response.json(controlState);
    }
    if (input === redisUrl && init?.method === 'POST' && typeof init.body === 'string') {
      const command: unknown = JSON.parse(init.body);
      if (canonicalJson(command) === canonicalJson(['HSCAN', 'padlet:evidence-bindings:v2', '0', 'COUNT', 500])) {
        return Response.json({ result: ['0', []] });
      }
      if (canonicalJson(command) === canonicalJson(['SCAN', '0', 'MATCH', 'padlet:evidence-claim:v1:*', 'COUNT', 500])) {
        return Response.json({ result: ['0', [...redisClaims.keys()].sort()] });
      }
      if (Array.isArray(command) && command.length === 2 && command[0] === 'GET'
        && typeof command[1] === 'string' && redisClaims.has(command[1])) {
        return Response.json({ result: redisClaims.get(command[1]) });
      }
    }
    unexpectedFetches.push(`${init?.method ?? 'GET'}:${url}`);
    throw new Error('Unrecognized external fetch forbidden in fence-window fixture.');
  });
  vi.stubGlobal('fetch', fixtureFetch);
  vi.stubEnv('UPSTASH_REDIS_REST_URL', redisUrl);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic-redis-token');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', controlUrl);
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic-control-token');

  // Deliberately in-memory seams, not production persistence/registration evidence.
  const reserved: FreezingReacquisitionReservation[] = [];
  const producer = createRegisteredFreezingReacquisition({
    registration, sheets,
    reservations: { reserveAndCommit: async row => {
      if (reserved.some(prior => prior.nonceDigest === row.nonceDigest || prior.challengeId === row.challengeId)) {
        throw new Error('Duplicate fake reservation.');
      }
      reserved.push({ ...row });
      events.push('reserve');
      return { ...row };
    } },
    manifest: { keyId: 'manifest-fence-window', signingPrivateKey: manifestKeys.privateKey, encryptionKey },
  });
  const signed = signFreezingReacquisitionRequest(registration, requestKeys.privateKey, { challenge });
  const response = await producer(new Request(registration.endpoint, {
    method: 'POST', headers: signed.headers, body: signed.body,
  }));
  expect(response.status).toBe(200);
  events.push('producer:returned');
  const envelopeA = await response.json() as FreezingReacquisitionEnvelope;
  const sealedA = canonicalJson(envelopeA);
  expect(reserved).toHaveLength(1);
  expect(reserved[0]).toMatchObject({ challengeId: challenge.challengeId, requestDigest: signed.requestDigest });
  expect(events[0]).toBe('reserve');
  expect(controlResponses).toEqual([controlAtStart, controlAtStart]);
  expect(envelopeA.envelope.issuedAt).toBe(now);
  expect(envelopeA.envelope.expiresAt).toBe(challenge.expiresAt);

  // Only AFTER the real producer returned: model an ungoverned human edit and a
  // delayed writer outside the fake control contract. No real actor or queue runs.
  vi.setSystemTime(now + 1_000);
  liveTabs.Students[1][1] = 'Alice edited after seal';
  liveTabs.Students.push(['S2', 'Bob', '0', 'ACTIVE']);
  sheetRevision = 'revision-B';
  redisClaims.set(claimKey(claimB), 'synthetic-delayed-owner-B');
  events.push('fixture:external-mutation');
  expect(events.indexOf('fixture:external-mutation')).toBeGreaterThan(events.indexOf('producer:returned'));
  expect(await readDeploymentLocalWriterStatus(registration.deploymentId)).toEqual(controlState);
  expect(controlResponses).toEqual([controlAtStart, controlAtStart, controlAtStart]);
  expect(canonicalJson(controlState)).toBe(controlAtStart);
  expect(Date.now()).toBeGreaterThan(envelopeA.envelope.issuedAt);
  expect(Date.now()).toBeLessThan(envelopeA.envelope.expiresAt);

  const consumed = new Set<string>();
  const consumeOnce = vi.fn(async (nonce: string, expiresAt: number) => {
    expect(expiresAt).toBe(challenge.expiresAt);
    if (consumed.has(nonce)) return false;
    consumed.add(nonce);
    return true;
  });
  const openOptions = { encryptionKey, signingPublicKey: manifestKeys.publicKey,
    expectedChallenge: challenge, nonceConsumer: { consumeOnce } };
  const ioBeforeOpen = [...events];
  const fetchesBeforeOpen = fixtureFetch.mock.calls.length;
  // Negative crypto control: an authentic request key is NOT the manifest key.
  await expect(openFreezingReacquisitionEnvelope(envelopeA, {
    ...openOptions, signingPublicKey: requestKeys.publicKey,
  })).rejects.toThrow('Legacy bridge manifest is invalid.');
  expect(consumeOnce).not.toHaveBeenCalled();
  const historicalA = await openFreezingReacquisitionEnvelope(envelopeA, openOptions);
  expect(consumeOnce).toHaveBeenCalledTimes(1);
  expect(consumed.size).toBe(1);
  expect(events).toEqual(ioBeforeOpen);
  expect(fixtureFetch).toHaveBeenCalledTimes(fetchesBeforeOpen);
  expect(canonicalJson(envelopeA)).toBe(sealedA);
  expect(historicalA).toMatchObject({
    purpose: 'CLASS_STORE_FREEZING_REACQUISITION', bindingVersion: 1,
    authority: 'NONAUTHORITY', outcome: 'AUTHENTIC_FREEZING_ACQUISITION',
    exclusion: 'NOT_PROVEN', finalImportEligible: false, challenge, capturedAt,
    localWriterObservation: { ...controlState, observedAt: capturedAt },
  });
  expect(historicalA.sheetsSnapshot.sourceRevision).toBe('revision-A');
  expect(historicalA.sheetsSnapshot.tabs.Students.rows.map(row => row.cells)).toEqual([originalStudent]);
  expect(historicalA.redisSnapshot.v1Tombstones).toEqual([{
    tupleDigest: claimA, ownerDigest: sha256('synthetic-owner-A'), sourceProvenance: 'upstash:padlet:evidence-claim:v1',
  }]);
  expect(historicalA.normalization.sourceArtifacts.sheets.digest).toBe(historicalA.sheetsSnapshot.digest);
  expect(historicalA.normalization.sourceArtifacts.redis?.digest).toBe(historicalA.redisSnapshot.digest);
  expect(historicalA).not.toHaveProperty('lease');
  expect(historicalA).not.toHaveProperty('leaseExpiresAt');
  expect(historicalA).not.toHaveProperty('activationAllowed');
  expect(JSON.stringify(historicalA)).not.toContain('FINAL_FROZEN');

  // Independently read B through the same real low-level capture code. This is
  // fresh diagnostic fixture data, not a second authority envelope or a cutover.
  const historicalBytes = canonicalJson(historicalA);
  const capturedAtB = new Date().toISOString();
  const sheetsB = await captureSheetsSnapshot({ spreadsheetId: registration.spreadsheetId, capturedAt: capturedAtB, reader: sheets });
  const readerB = await acquireDeploymentLocalRedisReader();
  if (!readerB) throw new Error('Configured fake Redis reader unexpectedly absent.');
  const redisB = await captureRedisClaimSnapshot(readerB, { capturedAt: capturedAtB });
  expect(sheetsB.sourceRevision).toBe('revision-B');
  expect(sheetsB.tabs.Students.rows.map(row => row.cells)).toEqual([
    ['S1', 'Alice edited after seal', '100', 'ACTIVE'], ['S2', 'Bob', '0', 'ACTIVE'],
  ]);
  expect(redisB.v1Tombstones).toEqual([
    { tupleDigest: claimA, ownerDigest: sha256('synthetic-owner-A'), sourceProvenance: 'upstash:padlet:evidence-claim:v1' },
    { tupleDigest: claimB, ownerDigest: sha256('synthetic-delayed-owner-B'), sourceProvenance: 'upstash:padlet:evidence-claim:v1' },
  ]);
  // Content and source revisions differ, not merely timestamp-dependent digests.
  expect(sheetsB.tabs.Students).not.toEqual(historicalA.sheetsSnapshot.tabs.Students);
  expect(sheetsB.sourceRevision).not.toBe(historicalA.sheetsSnapshot.sourceRevision);
  expect(redisB.v1Tombstones).not.toEqual(historicalA.redisSnapshot.v1Tombstones);
  expect(redisB.sourceRevision).not.toBe(historicalA.redisSnapshot.sourceRevision);
  expect(sheetsB.digest).not.toBe(historicalA.sheetsSnapshot.digest);
  expect(redisB.digest).not.toBe(historicalA.redisSnapshot.digest);
  expect(await readDeploymentLocalWriterStatus(registration.deploymentId)).toEqual(controlState);
  expect(controlResponses).toEqual([controlAtStart, controlAtStart, controlAtStart, controlAtStart]);
  expect(canonicalJson(historicalA)).toBe(historicalBytes);
  expect(canonicalJson(envelopeA)).toBe(sealedA);
  expect(Object.isFrozen(historicalA.sheetsSnapshot.tabs.Students.rows)).toBe(true);
  expect(Object.isFrozen(historicalA.redisSnapshot.v1Tombstones)).toBe(true);

  // Preserve replay refusal; successful historical validation is not a replay bypass.
  const ioBeforeReplay = [...events];
  await expect(openFreezingReacquisitionEnvelope(envelopeA, openOptions)).rejects.toThrow('Freezing reacquisition refused.');
  expect(consumeOnce).toHaveBeenCalledTimes(2);
  expect(consumed.size).toBe(1);
  expect(events).toEqual(ioBeforeReplay);
  expect(unexpectedFetches).toEqual([]);
  expect(fixtureFetch.mock.calls.filter(([url]) => url === controlUrl).map(([, init]) => init?.method))
    .toEqual(['GET', 'GET', 'GET', 'GET']);
});
