import { generateKeyPairSync, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REQUIRED_SHEETS } from '@/generator/config/schema';
import { FREEZING_REACQUISITION_PURPOSE as PHASE, parseFreezingReacquisitionChallenge } from './freezingReacquisitionContract';
import { openLegacyBridgeManifest, sealLegacyBridgeManifest } from './legacyBridgeManifest';
import {
  createRegisteredFreezingReacquisition, openFreezingReacquisitionEnvelope, signFreezingReacquisitionRequest,
  type FreezingReacquisitionPayload, type FreezingReacquisitionRegistration, type FreezingReacquisitionReservation,
} from './registeredFreezingReacquisition';
import { type WorkbookSnapshotReader } from './sheetsSnapshot';
import { sha256 } from './validators';

vi.mock('server-only', () => ({}));

// NONAUTHORITY characterization only. Real signing, acquisition, normalization,
// sealing and public opening remain intact. All I/O/reservation seams below are
// memory-only. No listener, real fetch fallback, database or durable lease exists.
// The deliberately out-of-control fixture writer models an unknown external actor;
// acceptance of its historical snapshot is NOT an observed production bypass or
// proof of continuous exclusion, authenticated central FREEZING or FINAL_IMPORT.
const CAPTURED_AT = '2026-09-26T00:00:00.000Z';
const DISABLED_AT = '2026-09-24T00:00:00.000Z';
const CONTROL_URL = 'https://control.example/exclusion-boundary';
const REDIS_URL = 'https://redis.example';
const CLAIM_A = 'd'.repeat(64);
const CLAIM_B = 'e'.repeat(64);
const CLAIM_PREFIX = 'padlet:evidence-claim:v1:';
type ControlObservation = Omit<FreezingReacquisitionPayload['localWriterObservation'], 'observedAt'>;
type LiveSource = { tabs: Record<string, string[][]>; revision: string; claims: Map<string, string> };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(CAPTURED_AT));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function fixture(options: {
  controlPatch?: (observation: number) => Record<string, unknown>;
  beforeFinalControl?: (source: LiveSource) => void;
} = {}) {
  const requestKeys = generateKeyPairSync('ed25519');
  const manifestKeys = generateKeyPairSync('ed25519');
  const writerKeys = generateKeyPairSync('ed25519');
  const encryptionKey = randomBytes(32);
  const registration: FreezingReacquisitionRegistration = {
    endpoint: 'https://legacy.example/api/internal/migrations/freezing-reacquisition',
    deploymentId: 'legacy-exclusion-boundary', registrationDigest: 'c'.repeat(64), registrationVersion: '1',
    approvedScope: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE',
    tenantId: '20000000-0000-4000-8000-000000000001', sourceId: 'sheet', spreadsheetId: 'sheet-exclusion-boundary',
    requestKeyId: 'request-exclusion-boundary', requestPublicKey: requestKeys.publicKey,
    manifestPublicKey: manifestKeys.publicKey, writerPublicKey: writerKeys.publicKey,
  };
  const control: ControlObservation = Object.freeze({
    version: 1, deploymentId: registration.deploymentId, source: 'UPSTASH_REDIS_REST',
    status: 'DISABLED', disabled: true, generation: 1, evidence: `sha256:${'a'.repeat(64)}`, disabledAt: DISABLED_AT,
  });
  const live: LiveSource = {
    revision: 'revision-A', claims: new Map([[`${CLAIM_PREFIX}${CLAIM_A}`, 'synthetic-owner-A']]),
    tabs: {
      Students: [[...REQUIRED_SHEETS.Students], ['S1', 'Alice', '100', 'ACTIVE']],
      Products: [[...REQUIRED_SHEETS.Products]],
      Transactions: [[...REQUIRED_SHEETS.Transactions]],
      Adjustments: [[...REQUIRED_SHEETS.Adjustments]],
      Settings: [['key', 'value'], ['schemaVersion', '1'], ['classTimeZone', 'Asia/Seoul']],
      Tasks: [[...REQUIRED_SHEETS.Tasks]],
    },
  };
  const events: string[] = [];
  const unexpected: string[] = [];
  const observations: Record<string, unknown>[] = [];
  const reservations: FreezingReacquisitionReservation[] = [];
  const refuseUnexpected = (message: string): never => {
    unexpected.push(message);
    throw new Error(`Nonfixture I/O forbidden: ${message}`);
  };
  let observation = 0;
  vi.stubEnv('UPSTASH_REDIS_REST_URL', REDIS_URL);
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic-redis-token');
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL', CONTROL_URL);
  vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN', 'synthetic-control-token');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url === CONTROL_URL) {
      if (init.method !== 'GET') return refuseUnexpected('control mutation');
      observation++;
      if (observation > 2) return refuseUnexpected('extra control observation');
      if (observation === 2 && options.beforeFinalControl) {
        options.beforeFinalControl(live);
        events.push('outside-writer:edit');
      }
      const value = { ...control, ...options.controlPatch?.(observation) };
      observations.push(value);
      events.push(`control:${observation}`);
      return Response.json(value);
    }
    if (url !== REDIS_URL || init.method !== 'POST') return refuseUnexpected('unknown endpoint/method');
    const command: unknown = JSON.parse(String(init.body));
    if (!Array.isArray(command)) return refuseUnexpected('invalid Redis command');
    // Strict read-only command allowlist; no generic success or network fallback.
    if (JSON.stringify(command) === JSON.stringify(['HSCAN', 'padlet:evidence-bindings:v2', '0', 'COUNT', 500])) {
      events.push('redis:HSCAN');
      return Response.json({ result: ['0', []] });
    }
    if (JSON.stringify(command) === JSON.stringify(['SCAN', '0', 'MATCH', `${CLAIM_PREFIX}*`, 'COUNT', 500])) {
      events.push('redis:SCAN');
      return Response.json({ result: ['0', [...live.claims.keys()]] });
    }
    if (command.length === 2 && command[0] === 'GET' && typeof command[1] === 'string' && live.claims.has(command[1])) {
      events.push('redis:GET');
      return Response.json({ result: live.claims.get(command[1]) });
    }
    return refuseUnexpected('unlisted Redis command');
  });
  const sheets: WorkbookSnapshotReader = {
    listSheetNames: async () => { events.push('sheet:names'); return Object.keys(live.tabs); },
    getRevision: async () => { events.push('sheet:revision'); return live.revision; },
    getRows: async (name) => {
      if (!Object.hasOwn(live.tabs, name)) return refuseUnexpected('unlisted Sheet');
      events.push(`sheet:rows:${name}`);
      return live.tabs[name].map(row => [...row]);
    },
  };
  const reserveAndCommit = async (row: FreezingReacquisitionReservation) => {
    if (reservations.some(prior => prior.nonceDigest === row.nonceDigest || prior.challengeId === row.challengeId)) {
      throw new Error('Duplicate in-memory reservation');
    }
    reservations.push(row);
    events.push('reserve');
    return row;
  };
  const manifest = { keyId: 'manifest-exclusion-boundary', signingPrivateKey: manifestKeys.privateKey, encryptionKey };
  const produce = createRegisteredFreezingReacquisition({ registration, reservations: { reserveAndCommit }, sheets, manifest });
  return { registration, requestKeys, manifestKeys, manifest, encryptionKey, control, live, events,
    unexpected, observations, reservations, produce };
}
type Fixture = ReturnType<typeof fixture>;

async function produce(f: Fixture) {
  const now = Date.now();
  const r = f.registration;
  const challenge = parseFreezingReacquisitionChallenge({
    purpose: 'CLASS_STORE_FREEZING_REACQUISITION', bindingVersion: 1, expectedStatus: 'FREEZING',
    challengeId: randomUUID(), tenantId: r.tenantId, migrationJobId: randomUUID(), expectedStateVersion: '2',
    sourceId: r.sourceId, spreadsheetIdDigest: sha256(r.spreadsheetId), jobSemanticFingerprint: 'a'.repeat(64),
    sourceAcquisitionDigest: 'b'.repeat(64), deploymentId: r.deploymentId, actorUserId: randomUUID(),
    actorSubject: 'synthetic-owner', sessionBinding: 'd'.repeat(64), startCeremonyId: randomUUID(),
    executionDigest: 'e'.repeat(64), preflightSnapshotId: 'import:' + 'f'.repeat(64),
    preflightSnapshotDigest: 'f'.repeat(64), registrationDigest: r.registrationDigest,
    registrationVersion: r.registrationVersion, issuedAt: now, expiresAt: now + 60_000,
  });
  const signed = signFreezingReacquisitionRequest(r, f.requestKeys.privateKey, { challenge });
  const response = await f.produce(new Request(r.endpoint, { method: 'POST', headers: signed.headers, body: signed.body }));
  f.events.push('producer:return');
  expect(f.unexpected).toEqual([]);
  return { response, challenge };
}

async function accepted(f: Fixture) {
  const { response, challenge } = await produce(f);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const wrapper: unknown = await response.json();
  const seen = new Set<string>();
  const consumeOnce = vi.fn(async (nonce: string) => {
    if (seen.has(nonce)) return false;
    seen.add(nonce);
    return true;
  });
  const payload = await openFreezingReacquisitionEnvelope(wrapper, {
    encryptionKey: f.encryptionKey, signingPublicKey: f.manifestKeys.publicKey, expectedChallenge: challenge,
    nonceConsumer: { consumeOnce },
  });
  expect(consumeOnce).toHaveBeenCalledTimes(1);
  expect(f.reservations).toHaveLength(1);
  expect(f.observations).toHaveLength(2);
  expect(payload).toMatchObject({ authority: 'NONAUTHORITY', outcome: 'AUTHENTIC_FREEZING_ACQUISITION',
    exclusion: 'NOT_PROVEN', finalImportEligible: false, challenge });
  return { payload, challenge };
}

function expectCaptured(f: Fixture) {
  expect(f.events.filter(event => event.startsWith('redis:'))).toEqual([
    'redis:HSCAN', 'redis:SCAN', 'redis:GET', 'redis:HSCAN', 'redis:SCAN', 'redis:GET',
  ]);
  expect(f.events.filter(event => event.startsWith('sheet:rows:'))).toEqual(
    Object.keys(f.live.tabs).map(name => `sheet:rows:${name}`),
  );
  expect(f.events.filter(event => event === 'sheet:revision')).toHaveLength(2);
}

it('returns only a NONAUTHORITY candidate and preserves historical disable time, not a renewed exclusion lease', async () => {
  const f = fixture();
  const { payload } = await accepted(f);
  expectCaptured(f);
  expect(f.observations).toEqual([f.control, f.control]);
  expect(payload.localWriterObservation).toEqual({ ...f.control, observedAt: CAPTURED_AT });
  expect(payload.localWriterObservation.disabledAt).not.toBe(payload.capturedAt);
  expect(payload.capturedAt).toBe(CAPTURED_AT);
  expect(payload.sheetsSnapshot.capturedAt).toBe(CAPTURED_AT);
  expect(payload.redisSnapshot.capturedAt).toBe(CAPTURED_AT);
  expect(payload.normalization.sourceArtifacts.redis?.digest).toBe(payload.redisSnapshot.digest);
});

it('cannot infer continuous external exclusion from equal DISABLED observations around an in-memory outside-writer edit', async () => {
  // This controlled edit occurs AFTER the final source read but BEFORE the
  // producer's second control observation/return, unlike a post-return edit.
  // The mock controller does not own this actor. No actual writer is manipulated.
  const f = fixture({ beforeFinalControl: source => {
    source.tabs.Students[1][1] = 'Bob';
    source.revision = 'revision-B';
    source.claims.set(`${CLAIM_PREFIX}${CLAIM_B}`, 'synthetic-owner-B');
  } });
  const { payload } = await accepted(f);
  expectCaptured(f);
  expect(f.observations).toEqual([f.control, f.control]);
  const edit = f.events.indexOf('outside-writer:edit');
  expect(f.events.indexOf('control:1')).toBeGreaterThan(-1);
  expect(f.events.lastIndexOf('sheet:revision')).toBeGreaterThan(f.events.indexOf('control:1'));
  expect(edit).toBeGreaterThan(f.events.lastIndexOf('sheet:revision'));
  expect(f.events.indexOf('control:2')).toBeGreaterThan(edit);
  expect(f.events.indexOf('producer:return')).toBeGreaterThan(f.events.indexOf('control:2'));
  expect(payload.sheetsSnapshot.sourceRevision).toBe('revision-A');
  expect(payload.sheetsSnapshot.tabs.Students.rows[0].cells).toEqual(['S1', 'Alice', '100', 'ACTIVE']);
  expect(f.live.tabs.Students[1]).toEqual(['S1', 'Bob', '100', 'ACTIVE']);
  expect(f.live.revision).toBe('revision-B');
  expect(payload.redisSnapshot.v1Tombstones.map(row => row.tupleDigest)).toEqual([CLAIM_A]);
  expect([...f.live.claims.keys()]).toEqual([`${CLAIM_PREFIX}${CLAIM_A}`, `${CLAIM_PREFIX}${CLAIM_B}`]);
  // Authenticity of A is compatible with this fake live state B; neither is an authority token.
  expect(payload.exclusion).toBe('NOT_PROVEN');
  expect(payload.finalImportEligible).toBe(false);
});

it.each([
  { field: 'generation', value: 2 },
  { field: 'evidence', value: `sha256:${'b'.repeat(64)}` },
  { field: 'disabledAt', value: '2026-09-25T00:00:00.000Z' },
] as const)('rejects a changed $field between individually admissible DISABLED observations', async ({ field, value }) => {
  const patch = { [field]: value };
  // Prove the changed value itself can be admitted when both observations agree.
  // This avoids counting malformed evidence, future dates or a broken baseline as mismatch coverage.
  const stable = fixture({ controlPatch: () => patch });
  const { payload } = await accepted(stable);
  expect(payload.localWriterObservation[field]).toBe(value);
  const f = fixture({ controlPatch: count => count === 2 ? patch : {} });
  const { response } = await produce(f);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ outcome: 'UNKNOWN' });
  expect(f.reservations).toHaveLength(1);
  expectCaptured(f);
  expect(f.observations).toEqual([f.control, { ...f.control, ...patch }]);
});

it.each([1, 2] as const)('rejects an ENABLED/non-disabled observation at boundary %s without returning a candidate', async boundary => {
  await accepted(fixture());
  const f = fixture({ controlPatch: count => count === boundary ? { status: 'ENABLED', disabled: false } : {} });
  const { response } = await produce(f);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ outcome: 'UNKNOWN' });
  expect(f.reservations).toHaveLength(1);
  expect(f.observations).toHaveLength(boundary);
  expect(f.observations[boundary - 1]).toEqual({ ...f.control, status: 'ENABLED', disabled: false });
  if (boundary === 1) expect(f.events).toEqual(['reserve', 'control:1', 'producer:return']);
  else expectCaptured(f);
});

it('rejects a future disabledAt before source acquisition rather than treating DISABLED as a sufficient guarantee', async () => {
  await accepted(fixture());
  const f = fixture({ controlPatch: () => ({ disabledAt: '2026-09-27T00:00:00.000Z' }) });
  const { response } = await produce(f);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ outcome: 'UNKNOWN' });
  expect(f.events).toEqual(['reserve', 'control:1', 'producer:return']);
  expect(f.reservations).toHaveLength(1);
  expect(f.observations).toEqual([{ ...f.control, disabledAt: '2026-09-27T00:00:00.000Z' }]);
});

it.each([
  { field: 'authority', value: 'AUTHORITY' },
  { field: 'exclusion', value: 'PROVEN' },
  { field: 'finalImportEligible', value: true },
] as const)('rejects a correctly sealed promotion of $field before consuming the public opening nonce', async ({ field, value }) => {
  const f = fixture();
  const { payload, challenge } = await accepted(f);
  const promoted = { ...payload, [field]: value };
  // Use the actual phase-separated codec domain, not corrupt crypto/expiry as a refusal shortcut.
  const encryptionKey = Buffer.from(hkdfSync('sha256', f.encryptionKey, PHASE, 'encrypted-candidate:v1', 32));
  const sealAt = Date.now();
  const sealOptions = {
    ...f.manifest, encryptionKey, now: () => sealAt, ttlMs: challenge.expiresAt - sealAt,
  };
  const baselineNonce = vi.fn(async () => true);
  const baseline = sealLegacyBridgeManifest(payload, sealOptions);
  expect(await openFreezingReacquisitionEnvelope({ purpose: PHASE, bindingVersion: 1, envelope: baseline }, {
    encryptionKey: f.encryptionKey, signingPublicKey: f.manifestKeys.publicKey, expectedChallenge: challenge,
    nonceConsumer: { consumeOnce: baselineNonce },
  })).toEqual(payload);
  expect(baselineNonce).toHaveBeenCalledTimes(1);
  const envelope = sealLegacyBridgeManifest(promoted, sealOptions);
  const decoded = await openLegacyBridgeManifest<Record<string, unknown>>(envelope, {
    encryptionKey, signingPublicKey: f.manifestKeys.publicKey, nonceConsumer: { consumeOnce: async () => true },
  });
  expect(decoded[field]).toBe(value);
  const consumeOnce = vi.fn(async () => true);
  await expect(openFreezingReacquisitionEnvelope({ purpose: PHASE, bindingVersion: 1, envelope }, {
    encryptionKey: f.encryptionKey, signingPublicKey: f.manifestKeys.publicKey, expectedChallenge: challenge,
    nonceConsumer: { consumeOnce },
  })).rejects.toThrow('Freezing reacquisition refused.');
  expect(consumeOnce).not.toHaveBeenCalled();
});
