import { createHash } from 'node:crypto';
import type { TaskCompletionEvidence } from '@/domain/types';
import { isCanonicalPadletPostId } from './padletClient';

export type PadletEvidenceClaimResult =
  | { status: 'CLAIMED' }
  | { status: 'IDEMPOTENT' }
  | { status: 'CONFLICT' };

export type PadletOperationBinding = Readonly<{
  taskId: string;
  studentId: string;
  cycleStartsAt: string;
  evidence: Readonly<TaskCompletionEvidence>;
}>;

export type PadletBoundEvidenceClaimResult =
  | { status: 'CLAIMED' | 'IDEMPOTENT'; binding: PadletOperationBinding }
  | { status: 'OPERATION_CONFLICT'; binding: PadletOperationBinding }
  | { status: 'CONFLICT' };

export class PadletEvidenceClaimStoreError extends Error {
  readonly code = 'UNAVAILABLE' as const;

  constructor() {
    super('Evidence claims are unavailable.');
    this.name = 'PadletEvidenceClaimStoreError';
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RedisEnvironment = {
  [key: string]: string | undefined;
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
};
type RedisResult = string | null | Array<string | null>;
type SerializedBindingRecord = Readonly<{
  binding: PadletOperationBinding;
  claimField: string;
}>;

export const PADLET_BINDINGS_HASH_KEY = 'padlet:evidence-bindings:v2';

const CLAIM_BOUND_SCRIPT = `
local storedRecord = redis.call('HGET', KEYS[1], ARGV[1])
if storedRecord then
  local decodeOk, decoded = pcall(cjson.decode, storedRecord)
  if not decodeOk or type(decoded) ~= 'table' or type(decoded.claimField) ~= 'string' then
    return {'PARTIAL'}
  end
  local storedOwner = redis.call('HGET', KEYS[1], decoded.claimField)
  if not storedOwner or storedOwner ~= ARGV[3] then return {'PARTIAL'} end
  if storedRecord == ARGV[4] then return {'IDEMPOTENT', storedRecord} end
  return {'OPERATION_CONFLICT', storedRecord}
end
local candidateOwner = redis.call('HGET', KEYS[1], ARGV[2])
if candidateOwner then
  if candidateOwner == ARGV[3] then return {'PARTIAL'} end
  return {'CONFLICT'}
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4], ARGV[2], ARGV[3])
return {'CLAIMED'}
`.trim();

const GET_OPERATION_BINDING_SCRIPT = `
local storedRecord = redis.call('HGET', KEYS[1], ARGV[1])
if not storedRecord then return {'ABSENT'} end
local decodeOk, decoded = pcall(cjson.decode, storedRecord)
if not decodeOk or type(decoded) ~= 'table' or type(decoded.claimField) ~= 'string' then
  return {'PARTIAL'}
end
local owner = redis.call('HGET', KEYS[1], decoded.claimField)
if not owner or owner ~= ARGV[2] then return {'PARTIAL'} end
return {'FOUND', storedRecord}
`.trim();

export class PadletEvidenceClaimStore {
  private readonly env: RedisEnvironment;
  private readonly fetchImpl: FetchLike;

  constructor({ env = process.env, fetchImpl = fetch }: { env?: RedisEnvironment; fetchImpl?: FetchLike } = {}) {
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  async claim({ boardId, postId, operationId }: {
    boardId: string;
    postId: string;
    operationId: string;
  }): Promise<PadletEvidenceClaimResult> {
    if (!boardId || !postId || !operationId) throw new PadletEvidenceClaimStoreError();

    const key = evidenceClaimKey(boardId, postId);
    const setResult = await this.command(['SET', key, operationId, 'NX']);
    if (setResult === 'OK') return { status: 'CLAIMED' };
    if (setResult !== null) throw new PadletEvidenceClaimStoreError();

    const owner = await this.command(['GET', key]);
    if (owner === operationId) return { status: 'IDEMPOTENT' };
    if (typeof owner === 'string') return { status: 'CONFLICT' };
    throw new PadletEvidenceClaimStoreError();
  }

  async getOperationBinding(operationId: string): Promise<PadletOperationBinding | null> {
    if (!isCanonicalInternalId(operationId)) throw new PadletEvidenceClaimStoreError();
    const result = await this.command([
      'EVAL', GET_OPERATION_BINDING_SCRIPT, '1', PADLET_BINDINGS_HASH_KEY,
      operationBindingField(operationId), operationId,
    ]);
    if (!Array.isArray(result) || typeof result[0] !== 'string') throw new PadletEvidenceClaimStoreError();
    if (result[0] === 'ABSENT' && result.length === 1) return null;
    if (result[0] === 'FOUND' && result.length === 2 && typeof result[1] === 'string') {
      return parseBindingRecord(result[1]).binding;
    }
    throw new PadletEvidenceClaimStoreError();
  }

  async claimBoundEvidence({ operationId, taskId, studentId, cycleStartsAt, evidence }: {
    operationId: string;
    taskId: string;
    studentId: string;
    cycleStartsAt: string;
    evidence: TaskCompletionEvidence;
  }): Promise<PadletBoundEvidenceClaimResult> {
    if (!isCanonicalInternalId(operationId)) throw new PadletEvidenceClaimStoreError();
    const binding = validateOperationBinding({ taskId, studentId, cycleStartsAt, evidence });
    const claimField = evidenceClaimField(binding.evidence.evidenceBoardId, binding.evidence.evidencePostId);
    const serializedRecord = JSON.stringify({ binding, claimField });
    const result = await this.command([
      'EVAL', CLAIM_BOUND_SCRIPT, '1', PADLET_BINDINGS_HASH_KEY,
      operationBindingField(operationId), claimField, operationId, serializedRecord,
    ]);

    if (!Array.isArray(result) || typeof result[0] !== 'string') throw new PadletEvidenceClaimStoreError();
    if (result[0] === 'CLAIMED' && result.length === 1) return { status: 'CLAIMED', binding };
    if (result[0] === 'CONFLICT' && result.length === 1) return { status: 'CONFLICT' };
    if ((result[0] === 'IDEMPOTENT' || result[0] === 'OPERATION_CONFLICT')
      && result.length === 2 && typeof result[1] === 'string') {
      return { status: result[0], binding: parseBindingRecord(result[1]).binding };
    }
    throw new PadletEvidenceClaimStoreError();
  }

  async getClaimOwners(boardId: string, postIds: readonly string[]): Promise<Map<string, string | null>> {
    if (!boardId || postIds.some((postId) => !postId)) throw new PadletEvidenceClaimStoreError();
    if (postIds.length === 0) return new Map();
    const result = await this.command([
      'HMGET', PADLET_BINDINGS_HASH_KEY,
      ...postIds.map((postId) => evidenceClaimField(boardId, postId)),
    ]);
    if (!Array.isArray(result) || result.length !== postIds.length
      || result.some((owner) => owner !== null && typeof owner !== 'string')) {
      throw new PadletEvidenceClaimStoreError();
    }
    return new Map(postIds.map((postId, index) => [postId, result[index]]));
  }

  private async command(command: readonly string[]): Promise<RedisResult> {
    const url = this.env.UPSTASH_REDIS_REST_URL?.trim();
    const token = this.env.UPSTASH_REDIS_REST_TOKEN?.trim();
    if (!url || !token) throw new PadletEvidenceClaimStoreError();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url.replace(/\/+$/, ''), {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(command),
          signal: controller.signal,
        });
      } catch {
        throw new PadletEvidenceClaimStoreError();
      }
      if (!response.ok) throw new PadletEvidenceClaimStoreError();

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new PadletEvidenceClaimStoreError();
      }
      if (!isRecord(payload) || !Object.hasOwn(payload, 'result')) throw new PadletEvidenceClaimStoreError();
      if (payload.result !== null && typeof payload.result !== 'string' && !Array.isArray(payload.result)) {
        throw new PadletEvidenceClaimStoreError();
      }
      return payload.result as RedisResult;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function evidenceClaimKey(boardId: string, postId: string): string {
  return `padlet:evidence-claim:v1:${tupleDigest(boardId, postId)}`;
}

export function operationBindingKey(operationId: string): string {
  return `padlet:operation-binding:v1:${digest(operationId)}`;
}

function operationBindingField(operationId: string): string {
  return `op:${digest(operationId)}`;
}

function evidenceClaimField(boardId: string, postId: string): string {
  return `claim:${tupleDigest(boardId, postId)}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tupleDigest(first: string, second: string): string {
  return createHash('sha256').update(first, 'utf8').update('\0').update(second, 'utf8').digest('hex');
}

function parseBindingRecord(serialized: string): SerializedBindingRecord {
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isRecord(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'binding') || typeof value.claimField !== 'string') {
      throw new PadletEvidenceClaimStoreError();
    }
    const binding = validateOperationBinding(value.binding);
    const expectedClaimField = evidenceClaimField(
      binding.evidence.evidenceBoardId,
      binding.evidence.evidencePostId,
    );
    if (value.claimField !== expectedClaimField) throw new PadletEvidenceClaimStoreError();
    return { binding, claimField: value.claimField };
  } catch {
    throw new PadletEvidenceClaimStoreError();
  }
}

function validateOperationBinding(value: unknown): PadletOperationBinding {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || !isCanonicalInternalId(value.taskId) || !isCanonicalInternalId(value.studentId)
    || !isCanonicalUtcMillisecondIso(value.cycleStartsAt) || !isRecord(value.evidence)) {
    throw new PadletEvidenceClaimStoreError();
  }
  const evidence = value.evidence;
  if (Object.keys(evidence).length !== 5
    || evidence.evidenceProvider !== 'PADLET'
    || typeof evidence.evidenceBoardId !== 'string' || !/^[A-Za-z0-9]{16,22}$/.test(evidence.evidenceBoardId)
    || typeof evidence.evidencePostId !== 'string' || !isCanonicalPadletPostId(evidence.evidencePostId)
    || !isCanonicalUtcMillisecondIso(evidence.evidenceCreatedAt)
    || typeof evidence.evidenceAuthorFullName !== 'string'
    || evidence.evidenceAuthorFullName !== evidence.evidenceAuthorFullName.trim()
    || evidence.evidenceAuthorFullName.length < 1 || evidence.evidenceAuthorFullName.length > 200) {
    throw new PadletEvidenceClaimStoreError();
  }
  return {
    taskId: value.taskId,
    studentId: value.studentId,
    cycleStartsAt: value.cycleStartsAt,
    evidence: {
      evidenceProvider: 'PADLET',
      evidenceBoardId: evidence.evidenceBoardId,
      evidencePostId: evidence.evidencePostId,
      evidenceCreatedAt: evidence.evidenceCreatedAt,
      evidenceAuthorFullName: evidence.evidenceAuthorFullName,
    },
  };
}

function isCanonicalUtcMillisecondIso(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isCanonicalInternalId(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
