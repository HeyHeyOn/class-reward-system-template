import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  PADLET_BINDINGS_HASH_KEY,
  PadletEvidenceClaimStore,
  PadletEvidenceClaimStoreError,
} from './padletEvidenceClaimStore';

const env = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example',
  UPSTASH_REDIS_REST_TOKEN: 'redis-secret',
};

function redisResponse(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ result }), { status, headers: { 'content-type': 'application/json' } });
}

function digest(...parts: string[]): string {
  const hash = createHash('sha256');
  parts.forEach((part, index) => {
    if (index > 0) hash.update('\0');
    hash.update(part, 'utf8');
  });
  return hash.digest('hex');
}

const operationId = 'operation-1';
const operationField = `op:${digest(operationId)}`;
const claimField = `claim:${digest('BOARD000000000001', 'post-1')}`;
const binding = {
  taskId: 'TASK-1',
  studentId: 'STUDENT-1',
  cycleStartsAt: '2026-08-25T00:00:00.000Z',
  evidence: {
    evidenceProvider: 'PADLET' as const,
    evidenceBoardId: 'BOARD000000000001',
    evidencePostId: 'post-1',
    evidenceCreatedAt: '2026-08-27T01:00:00.000Z',
    evidenceAuthorFullName: '김민준',
  },
};
const record = { binding, claimField };
const serializedRecord = JSON.stringify(record);

function requestCommand(fetchImpl: ReturnType<typeof vi.fn>, call = 0): string[] {
  return JSON.parse(String(fetchImpl.mock.calls[call][1].body)) as string[];
}

describe('PadletEvidenceClaimStore v2 bound evidence', () => {
  it('uses one fixed-key EVAL and one HSET command for an immutable bidirectional binding', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redisResponse(['CLAIMED']));
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });

    await expect(store.claimBoundEvidence({ operationId, ...binding }))
      .resolves.toEqual({ status: 'CLAIMED', binding });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const command = requestCommand(fetchImpl);
    expect(command.slice(0, 4)).toEqual(['EVAL', expect.any(String), '1', PADLET_BINDINGS_HASH_KEY]);
    expect(command.slice(4)).toEqual([operationField, claimField, operationId, serializedRecord]);
    expect(JSON.stringify(command.slice(3, 6))).not.toContain('BOARD000000000001');
    expect(JSON.stringify(command.slice(3, 6))).not.toContain('post-1');
    const script = command[1];
    expect(script.match(/redis\.call\('HSET'/g)).toHaveLength(1);
    expect(script).toContain("redis.call('HSET', KEYS[1], ARGV[1], ARGV[4], ARGV[2], ARGV[3])");
    expect(script).not.toMatch(/redis\.call\('(SET|DEL|EXPIRE|PEXPIRE)'/i);
  });

  it('safely decodes an existing record and checks its stored claim owner before comparing records', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redisResponse(['IDEMPOTENT', serializedRecord]));
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });
    await store.claimBoundEvidence({ operationId, ...binding });

    const script = requestCommand(fetchImpl)[1];
    expect(script).toMatch(/pcall\(cjson\.decode,\s*storedRecord\)/);
    expect(script).toContain("local storedOwner = redis.call('HGET', KEYS[1], decoded.claimField)");
    const ownerCheck = script.indexOf('storedOwner ~= ARGV[3]');
    const exactCheck = script.indexOf('storedRecord == ARGV[4]');
    expect(ownerCheck).toBeGreaterThan(-1);
    expect(exactCheck).toBeGreaterThan(ownerCheck);
  });

  it.each([
    [['CLAIMED'], { status: 'CLAIMED', binding }],
    [['IDEMPOTENT', serializedRecord], { status: 'IDEMPOTENT', binding }],
    [['OPERATION_CONFLICT', serializedRecord], { status: 'OPERATION_CONFLICT', binding }],
    [['CONFLICT'], { status: 'CONFLICT' }],
  ])('maps valid atomic result %j', async (redisResult, expected) => {
    const store = new PadletEvidenceClaimStore({ env, fetchImpl: vi.fn().mockResolvedValue(redisResponse(redisResult)) });
    await expect(store.claimBoundEvidence({ operationId, ...binding })).resolves.toEqual(expected);
  });

  it.each([
    ['PARTIAL'], ['BROKEN'], ['CLAIMED', serializedRecord], ['IDEMPOTENT'],
    ['IDEMPOTENT', '{bad'], ['OPERATION_CONFLICT', JSON.stringify(binding)],
  ])('fails closed for malformed atomic result %j', async (...redisResult) => {
    const store = new PadletEvidenceClaimStore({ env, fetchImpl: vi.fn().mockResolvedValue(redisResponse(redisResult)) });
    await expect(store.claimBoundEvidence({ operationId, ...binding })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('atomically reads and owner-checks an operation binding with one fixed-key EVAL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redisResponse(['FOUND', serializedRecord]));
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });

    await expect(store.getOperationBinding(operationId)).resolves.toEqual(binding);
    const command = requestCommand(fetchImpl);
    expect(command.slice(0, 4)).toEqual(['EVAL', expect.any(String), '1', PADLET_BINDINGS_HASH_KEY]);
    expect(command.slice(4)).toEqual([operationField, operationId]);
    expect(command[1]).toMatch(/pcall\(cjson\.decode,\s*storedRecord\)/);
    expect(command[1]).toContain("redis.call('HGET', KEYS[1], decoded.claimField)");
    expect(command[1]).toContain('owner ~= ARGV[2]');
  });

  it.each([
    [['ABSENT'], null],
    [['PARTIAL'], 'reject'],
    [['FOUND', JSON.stringify(record)], binding],
    [['FOUND', JSON.stringify({ binding, claimField: `claim:${'a'.repeat(64)}` })], 'reject'],
    [['FOUND', '{bad'], 'reject'],
    [serializedRecord, 'reject'],
  ])('fails closed for binding-only, foreign-owner, or malformed lookup result %j', async (redisResult, expected) => {
    const store = new PadletEvidenceClaimStore({ env, fetchImpl: vi.fn().mockResolvedValue(redisResponse(redisResult)) });
    const pending = store.getOperationBinding(operationId);
    if (expected === 'reject') await expect(pending).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    else await expect(pending).resolves.toEqual(expected);
  });

  it.each([
    { ...binding, taskId: ' TASK-1' },
    { ...binding, studentId: '' },
    { ...binding, cycleStartsAt: '2026-08-25T09:00:00+09:00' },
    { ...binding, cycleStartsAt: '2026-08-25T00:00:00Z' },
    { ...binding, evidence: { ...binding.evidence, evidenceCreatedAt: '2026-08-27T10:00:00+09:00' } },
    { ...binding, evidence: { ...binding.evidence, evidenceCreatedAt: '2026-08-27T01:00:00.00Z' } },
    { ...binding, evidence: { ...binding.evidence, evidencePostId: 'bad/id' } },
    { ...binding, extra: true },
  ])('rejects malformed stored binding %#', async (badBinding) => {
    const badRecord = JSON.stringify({ binding: badBinding, claimField });
    const store = new PadletEvidenceClaimStore({ env, fetchImpl: vi.fn().mockResolvedValue(redisResponse(['FOUND', badRecord])) });
    await expect(store.getOperationBinding(operationId)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it('uses HMGET on tuple-hashed fields in the fixed hash and keeps equal posts on different boards distinct', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(redisResponse([null, 'op-2']))
      .mockResolvedValueOnce(redisResponse(['op-A']))
      .mockResolvedValueOnce(redisResponse(['op-B']));
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });

    await expect(store.getClaimOwners('board-A', ['post-1', 'post-2']))
      .resolves.toEqual(new Map([['post-1', null], ['post-2', 'op-2']]));
    await store.getClaimOwners('board-A', ['same-post']);
    await store.getClaimOwners('board-B', ['same-post']);

    const first = requestCommand(fetchImpl, 0);
    expect(first[0]).toBe('HMGET');
    expect(first[1]).toBe(PADLET_BINDINGS_HASH_KEY);
    expect(first.slice(2)).toEqual([
      `claim:${digest('board-A', 'post-1')}`,
      `claim:${digest('board-A', 'post-2')}`,
    ]);
    expect(requestCommand(fetchImpl, 1)[2]).not.toBe(requestCommand(fetchImpl, 2)[2]);
  });
});

describe('PadletEvidenceClaimStore compatibility and transport', () => {
  it('keeps legacy claim on its v1 standalone key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(redisResponse('OK'));
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });
    await expect(store.claim({ boardId: 'board-A', postId: 'post/unsafe?', operationId: 'op-1' }))
      .resolves.toEqual({ status: 'CLAIMED' });
    expect(requestCommand(fetchImpl)).toEqual([
      'SET', expect.stringMatching(/^padlet:evidence-claim:v1:[a-f0-9]{64}$/), 'op-1', 'NX',
    ]);
  });

  it('fails closed without configuration and does not leak causes', async () => {
    const fetchImpl = vi.fn();
    const store = new PadletEvidenceClaimStore({ env: {}, fetchImpl });
    const error = await store.getOperationBinding(operationId).catch((caught) => caught);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(PadletEvidenceClaimStoreError);
    expect(error).toMatchObject({ code: 'UNAVAILABLE' });
    expect(error.cause).toBeUndefined();
  });

  it.each([
    ['network failure', () => Promise.reject(new Error('redis-secret network detail'))],
    ['HTTP failure', () => Promise.resolve(new Response('redis-secret body', { status: 503 }))],
    ['invalid body', () => Promise.resolve(new Response('{broken', { status: 200 }))],
  ])('fails closed on %s without leaking credentials', async (_case, response) => {
    const store = new PadletEvidenceClaimStore({ env, fetchImpl: vi.fn(response) });
    const error = await store.getOperationBinding(operationId).catch((caught) => caught);
    expect(error).toBeInstanceOf(PadletEvidenceClaimStoreError);
    expect(String(error)).not.toContain('redis-secret');
    expect(error.cause).toBeUndefined();
  });

  it('bounds direct operation-binding lookup to five seconds without leaking the abort cause', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('redis-secret', 'AbortError')));
    }));
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });
    const pending = store.getOperationBinding(operationId).catch((caught) => caught);

    await vi.advanceTimersByTimeAsync(5_000);
    const error = await pending;
    expect(error).toMatchObject({ code: 'UNAVAILABLE' });
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain('redis-secret');
    expect(requestCommand(fetchImpl)[0]).toBe('EVAL');
    vi.useRealTimers();
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal ?? null;
      return Promise.resolve({
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new DOMException('redis-secret', 'AbortError')));
        }),
      } as Response);
    });
    const store = new PadletEvidenceClaimStore({ env, fetchImpl });
    const pending = store.getOperationBinding(operationId).catch((caught) => caught);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((requestSignal as AbortSignal | null)?.aborted).toBe(true);
    await expect(pending).resolves.toMatchObject({ code: 'UNAVAILABLE' });
    vi.useRealTimers();
  });
});
