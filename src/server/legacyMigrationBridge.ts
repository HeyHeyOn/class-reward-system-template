import { createHash, sign, verify, type KeyLike } from 'node:crypto';
import {
  canonicalJson, sealLegacyBridgeManifest, type LegacyBridgeEnvelope, type SealManifestOptions,
} from './migration/legacyBridgeManifest';
import { captureRedisClaimSnapshot, type LegacyRedisSnapshotReader, type RedisClaimSnapshot } from './migration/redisClaimSnapshot';
import { captureSheetsSnapshot, type SheetsSnapshot, type WorkbookSnapshotReader } from './migration/sheetsSnapshot';
import { deepFreeze } from './migration/sensitiveRedaction';

const V2_HASH_KEY = 'padlet:evidence-bindings:v2';
const V1_PREFIX = 'padlet:evidence-claim:v1:';
const REDIS_SOURCE = 'UPSTASH_REDIS_REST' as const;
const ATTESTATION_WINDOW_MS = 5 * 60_000;
const NEVER_CONFIGURED_PURPOSE = Buffer.from('class-store:redis-never-configured-proof:v1\0', 'utf8');
const WRITER_DISABLED_PURPOSE = Buffer.from('class-store:redis-writer-disabled-evidence:v1\0', 'utf8');
const PUBLIC_INPUT_KEYS = ['deploymentId', 'mode', 'capturedAt', 'sheets', 'redisNeverConfiguredProof', 'crypto', 'finalIntakeBinding'] as const;
const WRITER_CONTROL_RESPONSE_BYTES = 8_192;
const WRITER_CONTROL_TIMEOUT_MS = 5_000;
const UPSTASH_RESPONSE_BYTES = 1_048_576;
const UPSTASH_TIMEOUT_MS = 5_000;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RedisNeverConfiguredProof = Readonly<{
  version: 1;
  purpose: 'CLASS_STORE_REDIS_NEVER_CONFIGURED';
  deploymentId: string;
  source: typeof REDIS_SOURCE;
  status: 'NEVER_CONFIGURED';
  issuedAt: string;
  keyId: string;
  signature: string;
}>;

export type RedisWriterDisableEvidence = Readonly<{
  version: 1;
  purpose: 'CLASS_STORE_REDIS_WRITER_DISABLED';
  deploymentId: string;
  source: typeof REDIS_SOURCE;
  status: 'DISABLED';
  disabledAt: string;
  controlGeneration: number;
  controlEvidence: string;
  keyId: string;
  signature: string;
}>;

export type LegacyBridgeMode = 'preflight' | 'final-delta';
export type LegacyBridgeResult = Readonly<{
  mode: LegacyBridgeMode;
  manifest: LegacyBridgeEnvelope;
  redisAcquisition: 'CAPTURED' | 'PROVEN_NEVER_CONFIGURED';
  writerDisabled: boolean;
  writerDisableEvidence: RedisWriterDisableEvidence | null;
}>;

export type FinalBridgeChallenge = Readonly<{
  purpose: 'CLASS_STORE_FINAL_BRIDGE_INTAKE'; challengeId: string; tenantId: string; migrationJobId: string;
  expectedStatus: 'READY'; expectedStateVersion: string; sourceId: string; externalSourceId: string;
  sourceFingerprint: string; deploymentId: string; actorUserId: string; actorSubject: string;
  issuedAt: number; expiresAt: number;
}>;

/** Binding data, not permission or proof that any writer is excluded. */
export function parseFinalBridgeChallenge(value: unknown): FinalBridgeChallenge {
  const keys = ['purpose', 'challengeId', 'tenantId', 'migrationJobId', 'expectedStatus', 'expectedStateVersion',
    'sourceId', 'externalSourceId', 'sourceFingerprint', 'deploymentId', 'actorUserId', 'actorSubject', 'issuedAt', 'expiresAt'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      return !d?.enumerable || !('value' in d);
    })) throw new Error('Final bridge binding invalid.');
  for (const key of ['challengeId', 'tenantId', 'migrationJobId', 'actorUserId']) {
    if (typeof value[key] !== 'string' || !uuid.test(value[key])) throw new Error('Final bridge binding invalid.');
  }
  for (const key of ['sourceId', 'externalSourceId', 'deploymentId', 'actorSubject']) validateIdentity(value[key], 'binding', key === 'actorSubject' ? 255 : 512);
  if (value.purpose !== 'CLASS_STORE_FINAL_BRIDGE_INTAKE' || value.expectedStatus !== 'READY'
    || typeof value.expectedStateVersion !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value.expectedStateVersion)
    || BigInt(value.expectedStateVersion) > BigInt(Number.MAX_SAFE_INTEGER)
    || typeof value.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.sourceFingerprint)
    || !Number.isSafeInteger(value.issuedAt) || Number(value.issuedAt) < 0
    || !Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= Number(value.issuedAt)
    || Number(value.expiresAt) - Number(value.issuedAt) > 300_000) throw new Error('Final bridge binding invalid.');
  return deepFreeze({ ...value } as FinalBridgeChallenge);
}

export type LegacyMigrationBridgeInput = Readonly<{
  deploymentId: string;
  mode: LegacyBridgeMode;
  capturedAt: string;
  sheets: Readonly<{ spreadsheetId: string; reader: WorkbookSnapshotReader }>;
  /** A deployment-bound artifact only; its trust anchor is never accepted from the caller. */
  redisNeverConfiguredProof?: RedisNeverConfiguredProof;
  crypto: Omit<SealManifestOptions, 'now'>;
  finalIntakeBinding?: FinalBridgeChallenge;
}>;

export function createRedisNeverConfiguredProof(options: Readonly<{
  deploymentId: string;
  issuedAt: string;
  keyId: string;
  signingPrivateKey: KeyLike;
}>): RedisNeverConfiguredProof {
  validateIdentity(options.deploymentId, 'deployment identity');
  assertCanonicalInstant(options.issuedAt, 'proof time');
  validateIdentity(options.keyId, 'attestation key identity', 128);
  const unsigned = {
    version: 1 as const,
    purpose: 'CLASS_STORE_REDIS_NEVER_CONFIGURED' as const,
    deploymentId: options.deploymentId,
    source: REDIS_SOURCE,
    status: 'NEVER_CONFIGURED' as const,
    issuedAt: options.issuedAt,
    keyId: options.keyId,
  };
  return deepFreeze({
    ...unsigned,
    signature: sign(null, attestationBytes(NEVER_CONFIGURED_PURPOSE, unsigned), options.signingPrivateKey).toString('base64url'),
  });
}

export function createRedisWriterDisableEvidence(options: Readonly<{
  deploymentId: string;
  disabledAt: string;
  controlGeneration: number;
  controlEvidence: string;
  keyId: string;
  signingPrivateKey: KeyLike;
}>): RedisWriterDisableEvidence {
  validateIdentity(options.deploymentId, 'deployment identity');
  assertCanonicalInstant(options.disabledAt, 'disable time');
  validateControlGeneration(options.controlGeneration);
  validateControlEvidence(options.controlEvidence);
  validateIdentity(options.keyId, 'attestation key identity', 128);
  const unsigned = {
    version: 1 as const,
    purpose: 'CLASS_STORE_REDIS_WRITER_DISABLED' as const,
    deploymentId: options.deploymentId,
    source: REDIS_SOURCE,
    status: 'DISABLED' as const,
    disabledAt: options.disabledAt,
    controlGeneration: options.controlGeneration,
    controlEvidence: options.controlEvidence,
    keyId: options.keyId,
  };
  return deepFreeze({
    ...unsigned,
    signature: sign(null, attestationBytes(WRITER_DISABLED_PURPOSE, unsigned), options.signingPrivateKey).toString('base64url'),
  });
}

/**
 * Reads credentials only from this deployment's environment, eagerly acquires the
 * complete bounded Redis data set, and returns a credential-free snapshot reader.
 */
export async function acquireDeploymentLocalRedisReader(options: Readonly<{
  fetch?: FetchLike;
  maxPages?: number;
  maxRecords?: number;
  pageSize?: number;
}> = {}): Promise<LegacyRedisSnapshotReader | null> {
  const command = deploymentLocalRedisCommand(options.fetch);
  if (!command) return null;
  const maxPages = boundedPositive(options.maxPages ?? 10_000, 10_000, 'page limit');
  const maxRecords = boundedPositive(options.maxRecords ?? 100_000, 100_000, 'record limit');
  const pageSize = boundedPositive(options.pageSize ?? 500, 1_000, 'page size');

  const first = await acquireCanonicalRedisContents(command, maxPages, maxRecords, pageSize);
  const second = await acquireCanonicalRedisContents(command, maxPages, maxRecords, pageSize);
  const firstCanonical = canonicalJson(first);
  if (firstCanonical !== canonicalJson(second)) {
    throw new Error('Redis source changed during deployment-local acquisition.');
  }
  const revision = createHash('sha256').update(firstCanonical, 'utf8').digest('hex');
  const hashEntries = first.v2HashEntries;
  const v1Keys = first.v1Entries.map(([key]) => key);
  const values = new Map(first.v1Entries);
  const reader: LegacyRedisSnapshotReader = {
    getRevision: async () => revision,
    hscan: async (key, cursor) => {
      if (key !== V2_HASH_KEY || cursor !== '0') throw new Error('Unsupported in-memory Redis snapshot request.');
      return { cursor: '0', entries: hashEntries };
    },
    scan: async (cursor, match) => {
      if (cursor !== '0' || match !== `${V1_PREFIX}*`) throw new Error('Unsupported in-memory Redis snapshot request.');
      return { cursor: '0', keys: v1Keys };
    },
    get: async (key) => values.has(key) ? values.get(key)! : null,
  };
  return deepFreeze(reader);
}

export async function runLegacyMigrationBridge(input: LegacyMigrationBridgeInput): Promise<LegacyBridgeResult> {
  assertPublicBridgeInput(input);
  validateIdentity(input.deploymentId, 'deployment identity');
  const capturedAtMs = assertCanonicalInstant(input.capturedAt, 'capture time');
  const finalIntakeBinding = input.finalIntakeBinding === undefined ? undefined : parseFinalBridgeChallenge(input.finalIntakeBinding);
  if (finalIntakeBinding && (input.mode !== 'final-delta' || finalIntakeBinding.deploymentId !== input.deploymentId
    || finalIntakeBinding.externalSourceId !== input.sheets.spreadsheetId || finalIntakeBinding.issuedAt > capturedAtMs
    || capturedAtMs >= finalIntakeBinding.expiresAt)) throw new Error('Final bridge binding mismatch.');

  // Redis credentials, writer control, and readers are resolved only inside this trust boundary.
  const redisConfigured = deploymentLocalRedisIsConfigured();
  let writerControl: DeploymentLocalWriterControl | null = null;
  let writerControlState: WriterControlState | null = null;
  let writerDisableTrust: DeploymentTrustAnchor | null = null;
  if (input.mode === 'final-delta' && redisConfigured) {
    writerControl = deploymentLocalWriterControl();
    writerDisableTrust = deploymentTrustAnchor(
      'CLASS_STORE_REDIS_WRITER_DISABLE', 'Redis writer disable evidence', true,
    );
    writerControlState = await writerControl.disableAndReadBack(input.deploymentId);
  }

  const redisReader = redisConfigured ? await acquireDeploymentLocalRedisReader() : null;
  if (redisConfigured && !redisReader) {
    throw new Error('Cutover blocked: deployment-local Redis acquisition failed.');
  }
  if (redisReader && input.redisNeverConfiguredProof) {
    throw new Error('Cutover blocked: a never-configured proof conflicts with deployment-local Redis configuration.');
  }
  if (!redisReader) {
    if (!input.redisNeverConfiguredProof) {
      throw new Error('Cutover blocked: missing Redis configuration requires a deployment-rooted never-configured proof.');
    }
    const trust = deploymentTrustAnchor(
      'CLASS_STORE_REDIS_NEVER_CONFIGURED', 'Redis never-configured proof', false,
    );
    verifyNeverConfiguredProof(
      input.redisNeverConfiguredProof, trust.publicKey, trust.keyId, input.deploymentId, capturedAtMs,
    );
  }

  const redisSnapshot: RedisClaimSnapshot | null = redisReader
    ? await captureRedisClaimSnapshot(redisReader, { capturedAt: input.capturedAt })
    : null;
  const redisAcquisition = redisSnapshot ? 'CAPTURED' as const : 'PROVEN_NEVER_CONFIGURED' as const;

  const sheetsSnapshot = await captureSheetsSnapshot({
    spreadsheetId: input.sheets.spreadsheetId,
    capturedAt: input.capturedAt,
    reader: input.sheets.reader,
  });

  // The final status request below is the last awaited source operation before sealing.
  let writerDisableEvidence: RedisWriterDisableEvidence | null = null;
  if (writerControl && writerControlState && writerDisableTrust) {
    const finalWriterState = await writerControl.readStatus(input.deploymentId);
    if (!sameWriterControlState(writerControlState, finalWriterState)) {
      throw new Error('Cutover blocked: deployment-local writer control generation changed during capture.');
    }
    writerDisableEvidence = createRedisWriterDisableEvidence({
      deploymentId: input.deploymentId,
      disabledAt: finalWriterState.disabledAt,
      controlGeneration: finalWriterState.generation,
      controlEvidence: finalWriterState.evidence,
      keyId: writerDisableTrust.keyId,
      signingPrivateKey: writerDisableTrust.privateKey!,
    });
    writerDisableEvidence = verifyWriterDisableEvidence(
      writerDisableEvidence, writerDisableTrust.publicKey, writerDisableTrust.keyId, input.deploymentId, capturedAtMs,
    );
  }

  const payload: Readonly<{
    manifestType: 'CLASS_STORE_LEGACY_ACQUISITION';
    finalIntakeBinding?: FinalBridgeChallenge;
    deploymentId: string;
    mode: LegacyBridgeMode;
    capturedAt: string;
    sheetsSnapshot: SheetsSnapshot;
    redisAcquisition: typeof redisAcquisition;
    redisSnapshot: RedisClaimSnapshot | null;
    redisNeverConfiguredProof: RedisNeverConfiguredProof | null;
    writerDisableRequired: boolean;
    writerDisableEvidence: RedisWriterDisableEvidence | null;
  }> = {
    manifestType: 'CLASS_STORE_LEGACY_ACQUISITION',
    ...(finalIntakeBinding ? { finalIntakeBinding } : {}),
    deploymentId: input.deploymentId,
    mode: input.mode,
    capturedAt: input.capturedAt,
    sheetsSnapshot,
    redisAcquisition,
    redisSnapshot,
    redisNeverConfiguredProof: input.redisNeverConfiguredProof ?? null,
    writerDisableRequired: input.mode === 'final-delta' && Boolean(redisReader),
    writerDisableEvidence,
  };
  // A final manifest cannot exist until both authoritative disabled-state reads have succeeded above.
  const manifest = sealLegacyBridgeManifest(payload, { ...input.crypto, now: () => capturedAtMs });
  return deepFreeze({
    mode: input.mode,
    manifest,
    redisAcquisition,
    writerDisabled: writerDisableEvidence !== null,
    writerDisableEvidence,
  });
}

type RedisCommand = (parts: readonly (string | number)[]) => Promise<unknown>;

type DeploymentTrustAnchor = Readonly<{
  keyId: string;
  publicKey: KeyLike;
  privateKey?: KeyLike;
}>;

type WriterControlState = Readonly<{
  version: 1;
  deploymentId: string;
  source: typeof REDIS_SOURCE;
  status: 'DISABLED';
  disabled: true;
  generation: number;
  evidence: string;
  disabledAt: string;
}>;

type DeploymentLocalWriterControl = Readonly<{
  disableAndReadBack: (deploymentId: string) => Promise<WriterControlState>;
  readStatus: (deploymentId: string) => Promise<WriterControlState>;
}>;

function assertPublicBridgeInput(value: unknown): asserts value is LegacyMigrationBridgeInput {
  if (!isRecord(value)) throw new Error('Cutover blocked: legacy bridge input is invalid.');
  const allowed = new Set<string>(PUBLIC_INPUT_KEYS);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const required = ['deploymentId', 'mode', 'capturedAt', 'sheets', 'crypto'];
  if (unexpected.length > 0 || required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('Cutover blocked: unexpected caller-controlled legacy bridge option.');
  }
  if (value.mode !== 'preflight' && value.mode !== 'final-delta') {
    throw new Error('Cutover blocked: legacy bridge mode is invalid.');
  }
}

function deploymentLocalRedisCommand(fetchOverride?: FetchLike): RedisCommand | null {
  const urlValue = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!urlValue && !token) return null;
  if (!urlValue || !token) throw new Error('Cutover blocked: incomplete deployment-local Upstash configuration.');

  const endpoint = validateUpstashEndpoint(urlValue);
  const fetchImpl = fetchOverride ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Cutover blocked: deployment-local fetch is unavailable.');
  return async (parts: readonly (string | number)[]): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(parts),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timeout);
      controller.abort();
      throw new Error('Deployment-local Upstash request failed.');
    }
    try {
      if (!response.ok || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
        || response.headers.get('content-type') !== 'application/json') {
        throw new Error('invalid response');
      }
      const text = await readBoundedUtf8Response(response, UPSTASH_RESPONSE_BYTES, controller);
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error('invalid JSON'); }
      if (!isRecord(body) || Object.keys(body).some((key) => key !== 'result') || !Object.hasOwn(body, 'result')) {
        throw new Error('invalid response');
      }
      return body.result;
    } catch {
      controller.abort();
      throw new Error('Deployment-local Upstash response is malformed.');
    } finally {
      clearTimeout(timeout);
    }
  };
}

function deploymentLocalRedisIsConfigured(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url && !token) return false;
  if (!url || !token) throw new Error('Cutover blocked: incomplete deployment-local Upstash configuration.');
  return true;
}

function deploymentTrustAnchor(
  prefix: 'CLASS_STORE_REDIS_NEVER_CONFIGURED' | 'CLASS_STORE_REDIS_WRITER_DISABLE',
  label: string,
  privateKeyRequired: boolean,
): DeploymentTrustAnchor {
  const keyId = process.env[`${prefix}_KEY_ID`];
  const publicKey = process.env[`${prefix}_PUBLIC_KEY`];
  const privateKey = process.env[`${prefix}_PRIVATE_KEY`];
  if (!keyId || !publicKey || (privateKeyRequired && !privateKey)) {
    throw new Error(`Cutover blocked: deployment trust anchor for ${label} is unavailable.`);
  }
  validateIdentity(keyId, 'attestation key identity', 128);
  return { keyId, publicKey, ...(privateKeyRequired ? { privateKey: privateKey! } : {}) };
}

function deploymentLocalWriterControl(): DeploymentLocalWriterControl {
  const urlValue = process.env.LEGACY_REDIS_WRITER_CONTROL_URL;
  const token = process.env.LEGACY_REDIS_WRITER_CONTROL_TOKEN;
  if (!urlValue || !token) {
    throw new Error('Cutover blocked: deployment-local writer control configuration is unavailable.');
  }
  const endpoint = validateWriterControlEndpoint(urlValue);
  validateWriterControlToken(token);
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Cutover blocked: deployment-local writer control is unavailable.');
  }

  const request = async (method: 'POST' | 'GET', deploymentId: string): Promise<WriterControlState> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WRITER_CONTROL_TIMEOUT_MS);
    try {
      const response = await globalThis.fetch(endpoint, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? {
          body: JSON.stringify({ action: 'disable', deploymentId, source: REDIS_SOURCE }),
        } : {}),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300
        || response.headers.get('content-type') !== 'application/json') {
        throw new Error('invalid response');
      }
      const text = await readBoundedUtf8Response(response, WRITER_CONTROL_RESPONSE_BYTES, controller);
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new Error('invalid JSON'); }
      return parseWriterControlState(body, deploymentId, token);
    } catch {
      controller.abort();
      throw new Error('Cutover blocked: deployment-local writer control request failed.');
    } finally {
      clearTimeout(timeout);
    }
  };

  return {
    disableAndReadBack: async (deploymentId) => {
      const postState = await request('POST', deploymentId);
      const authoritativeState = await request('GET', deploymentId);
      if (!sameWriterControlState(postState, authoritativeState)) {
        throw new Error('Cutover blocked: deployment-local writer control read-back failed.');
      }
      return authoritativeState;
    },
    readStatus: (deploymentId) => request('GET', deploymentId),
  };
}

type CanonicalRedisContents = Readonly<{
  v2HashEntries: readonly (readonly [string, string])[];
  v1Entries: readonly (readonly [string, string | null])[];
}>;

async function acquireCanonicalRedisContents(
  command: RedisCommand, maxPages: number, maxRecords: number, pageSize: number,
): Promise<CanonicalRedisContents> {
  const hashEntries: Array<readonly [string, string]> = [];
  await collectPages('hash', async (cursor) => {
    const result = await command(['HSCAN', V2_HASH_KEY, cursor, 'COUNT', pageSize]);
    if (!Array.isArray(result) || result.length !== 2 || !isCursor(result[0]) || !Array.isArray(result[1])
      || result[1].length % 2 !== 0 || result[1].some((value) => !isBoundedRedisString(value))) {
      throw new Error('Deployment-local Upstash HSCAN response is malformed.');
    }
    const flat = result[1] as string[];
    const entries: Array<readonly [string, string]> = [];
    for (let index = 0; index < flat.length; index += 2) entries.push([flat[index]!, flat[index + 1]!]);
    hashEntries.push(...entries);
    return { cursor: result[0], records: entries.length };
  }, maxPages, maxRecords);

  const v1Keys: string[] = [];
  await collectPages('key', async (cursor) => {
    const result = await command(['SCAN', cursor, 'MATCH', `${V1_PREFIX}*`, 'COUNT', pageSize]);
    if (!Array.isArray(result) || result.length !== 2 || !isCursor(result[0]) || !Array.isArray(result[1])
      || result[1].some((value) => !isBoundedRedisString(value))) {
      throw new Error('Deployment-local Upstash SCAN response is malformed.');
    }
    const keys = result[1] as string[];
    v1Keys.push(...keys);
    return { cursor: result[0], records: keys.length };
  }, maxPages, maxRecords - hashEntries.length);

  const v1Entries: Array<readonly [string, string | null]> = [];
  for (const key of v1Keys.sort(compareCodeUnits)) {
    const value = await command(['GET', key]);
    if (value !== null && !isBoundedRedisString(value, 32_768)) {
      throw new Error('Deployment-local Upstash GET response is malformed.');
    }
    v1Entries.push([key, value as string | null]);
  }
  hashEntries.sort(compareRedisEntries);
  v1Entries.sort(compareRedisEntries);
  return { v2HashEntries: hashEntries, v1Entries };
}

async function readBoundedUtf8Response(response: Response, maxBytes: number, controller: AbortController): Promise<string> {
  const contentLength = response.headers.get('content-length');
  let declaredBytes: number | null = null;
  if (contentLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(contentLength)) throw new Error('invalid response');
    declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxBytes) throw new Error('invalid response');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('invalid response');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        controller.abort();
        throw new Error('invalid response');
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if (declaredBytes !== null && bytes !== declaredBytes) throw new Error('invalid response');
    return text;
  } catch (error) {
    try { await reader.cancel(); } catch { /* fail closed below */ }
    controller.abort();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function collectPages(
  label: string,
  readPage: (cursor: string) => Promise<Readonly<{ cursor: string; records: number }>>,
  maxPages: number,
  maxRecords: number,
): Promise<void> {
  if (maxRecords < 0) throw new Error('Deployment-local Redis snapshot exceeds record limit.');
  let cursor = '0';
  let records = 0;
  const seen = new Set<string>(['0']);
  for (let page = 0; page < maxPages; page += 1) {
    const result = await readPage(cursor);
    records += result.records;
    if (records > maxRecords) throw new Error('Deployment-local Redis snapshot exceeds record limit.');
    if (result.cursor === '0') return;
    if (seen.has(result.cursor)) throw new Error(`Deployment-local Redis ${label} pagination cursor cycle detected.`);
    seen.add(result.cursor);
    cursor = result.cursor;
  }
  throw new Error(`Deployment-local Redis ${label} pagination did not complete within the page limit.`);
}

function verifyNeverConfiguredProof(
  value: unknown, publicKey: KeyLike, expectedKeyId: string, deploymentId: string, capturedAtMs: number,
): asserts value is RedisNeverConfiguredProof {
  if (!isRecord(value) || !hasExactKeys(value,
    ['version', 'purpose', 'deploymentId', 'source', 'status', 'issuedAt', 'keyId', 'signature'])
    || value.version !== 1 || value.purpose !== 'CLASS_STORE_REDIS_NEVER_CONFIGURED'
    || value.deploymentId !== deploymentId || value.source !== REDIS_SOURCE || value.status !== 'NEVER_CONFIGURED'
    || value.keyId !== expectedKeyId) {
    throw new Error('Cutover blocked: Redis never-configured proof is invalid.');
  }
  const issuedAtMs = assertCanonicalInstant(value.issuedAt, 'proof time');
  if (issuedAtMs > capturedAtMs || capturedAtMs - issuedAtMs > ATTESTATION_WINDOW_MS) {
    throw new Error('Cutover blocked: Redis never-configured proof is stale or future-dated.');
  }
  verifyAttestation(value, NEVER_CONFIGURED_PURPOSE, publicKey, 'Redis never-configured proof');
}

export function verifyWriterDisableEvidence(
  value: unknown, publicKey: KeyLike, expectedKeyId: string, deploymentId: string, capturedAtMs: number,
): RedisWriterDisableEvidence {
  if (!isRecord(value) || !hasExactKeys(value,
    ['version', 'purpose', 'deploymentId', 'source', 'status', 'disabledAt', 'controlGeneration', 'controlEvidence', 'keyId', 'signature'])
    || value.version !== 1 || value.purpose !== 'CLASS_STORE_REDIS_WRITER_DISABLED'
    || value.deploymentId !== deploymentId || value.source !== REDIS_SOURCE || value.status !== 'DISABLED'
    || value.keyId !== expectedKeyId) {
    throw new Error('Cutover blocked: Redis writer disable evidence is invalid.');
  }
  const disabledAtMs = assertCanonicalInstant(value.disabledAt, 'disable time');
  validateControlGeneration(value.controlGeneration);
  validateControlEvidence(value.controlEvidence);
  if (disabledAtMs < capturedAtMs || disabledAtMs - capturedAtMs > ATTESTATION_WINDOW_MS) {
    throw new Error('Cutover blocked: Redis writer disable evidence time is invalid.');
  }
  verifyAttestation(value, WRITER_DISABLED_PURPOSE, publicKey, 'Redis writer disable evidence');
  return deepFreeze(value as RedisWriterDisableEvidence);
}

function verifyAttestation(value: Record<string, unknown>, purpose: Buffer, publicKey: KeyLike, label: string): void {
  if (typeof value.keyId !== 'string' || !value.keyId || value.keyId.length > 128
    || typeof value.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature)) {
    throw new Error(`Cutover blocked: ${label} is invalid.`);
  }
  const { signature, ...unsigned } = value;
  let valid = false;
  try {
    valid = verify(null, attestationBytes(purpose, unsigned), publicKey, Buffer.from(signature, 'base64url'));
  } catch { /* fail closed below */ }
  if (!valid) throw new Error(`Cutover blocked: ${label} is invalid.`);
}

function attestationBytes(purpose: Buffer, value: unknown): Buffer {
  return Buffer.concat([purpose, Buffer.from(canonicalJson(value), 'utf8')]);
}
function validateUpstashEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Cutover blocked: deployment-local Upstash URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Cutover blocked: deployment-local Upstash URL is invalid.');
  }
  return url.href.replace(/\/$/, '');
}
function validateWriterControlEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 2_048) {
    throw new Error('Cutover blocked: deployment-local writer control URL is invalid.');
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Cutover blocked: deployment-local writer control URL is invalid.'); }
  const testLocalHttp = process.env.NODE_ENV === 'test' && url.protocol === 'http:'
    && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  if ((url.protocol !== 'https:' && !testLocalHttp) || url.username || url.password || url.search || url.hash) {
    throw new Error('Cutover blocked: deployment-local writer control URL is invalid.');
  }
  return url.href.replace(/\/$/, '');
}
function validateWriterControlToken(value: string): void {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 4_096
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error('Cutover blocked: deployment-local writer control token is invalid.');
  }
}
function parseWriterControlState(value: unknown, deploymentId: string, controlToken: string): WriterControlState {
  if (!isRecord(value) || !hasExactKeys(value,
    ['version', 'deploymentId', 'source', 'status', 'disabled', 'generation', 'evidence', 'disabledAt'])
    || value.version !== 1 || value.deploymentId !== deploymentId || value.source !== REDIS_SOURCE
    || value.status !== 'DISABLED' || value.disabled !== true) {
    throw new Error('Deployment-local writer control status is malformed.');
  }
  validateControlGeneration(value.generation);
  validateControlEvidence(value.evidence, controlToken);
  assertCanonicalInstant(value.disabledAt, 'writer control disable time');
  return deepFreeze(value as WriterControlState);
}
function sameWriterControlState(left: WriterControlState, right: WriterControlState): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function validateControlGeneration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error('Deployment-local writer control generation is invalid.');
  }
}
function validateControlEvidence(value: unknown, forbiddenSecret?: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)
    || (forbiddenSecret !== undefined && (value === forbiddenSecret || value.includes(forbiddenSecret)))) {
    throw new Error('Deployment-local writer control evidence is invalid.');
  }
}
function boundedPositive(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid deployment-local Redis ${label}.`);
  return value;
}
function compareCodeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareRedisEntries(
  left: readonly [string, string | null], right: readonly [string, string | null],
): number {
  return compareCodeUnits(left[0], right[0]) || compareCodeUnits(left[1] ?? '', right[1] ?? '');
}
function isCursor(value: unknown): value is string { return typeof value === 'string' && /^\d{1,32}$/.test(value); }
function isBoundedRedisString(value: unknown, max = 32_768): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= max;
}
function assertCanonicalInstant(value: unknown, label: string): number {
  if (typeof value !== 'string') throw new Error(`Legacy bridge ${label} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || new Date(parsed).toISOString() !== value) {
    throw new Error(`Legacy bridge ${label} is invalid.`);
  }
  return parsed;
}
function validateIdentity(value: unknown, label: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > max) {
    throw new Error(`Legacy bridge ${label} is invalid.`);
  }
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
