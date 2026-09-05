import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureRedisClaimSnapshot, type LegacyRedisSnapshotReader } from './redisClaimSnapshot';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const tupleDigest = (boardId: string, postId: string) => sha256(`${boardId}\0${postId}`);
const claimField = (boardId: string, postId: string) => `claim:${tupleDigest(boardId, postId)}`;
const operationField = (operationId: string) => `op:${sha256(operationId)}`;

const historicalBinding = {
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

function boundEntries(
  operationId = 'operation-1',
  binding: typeof historicalBinding = historicalBinding,
): Array<readonly [string, string]> {
  const field = claimField(binding.evidence.evidenceBoardId, binding.evidence.evidencePostId);
  return [
    [field, operationId],
    [operationField(operationId), JSON.stringify({ binding, claimField: field })],
  ];
}

function fakeRedis(overrides: Partial<LegacyRedisSnapshotReader> = {}): LegacyRedisSnapshotReader {
  const orphanField = claimField('BOARD000000000002', 'post-orphan');
  return {
    getRevision: async () => 'r1',
    hscan: async (_key, cursor) => cursor === '0'
      ? { cursor: '7', entries: boundEntries() }
      : { cursor: '0', entries: [[orphanField, 'operation-orphan']] },
    scan: async (cursor) => cursor === '0'
      ? { cursor: '4', keys: [`padlet:evidence-claim:v1:${'d'.repeat(64)}`] }
      : { cursor: '0', keys: [`padlet:evidence-claim:v1:${'e'.repeat(64)}`] },
    get: async (key) => key.endsWith('d'.repeat(64)) ? 'legacy-owner-one' : 'legacy-owner-two',
    ...overrides,
  };
}

const capture = (reader: LegacyRedisSnapshotReader) => captureRedisClaimSnapshot(reader, {
  capturedAt: '2026-09-05T00:00:00.000Z',
});

describe('complete legacy Redis claim snapshots', () => {
  it('parses the exact historical v2 fixed-hash fixture and correlates both fields', async () => {
    const snapshot = await capture(fakeRedis());

    expect(snapshot.v2Claims).toEqual([{
      tupleDigest: tupleDigest('BOARD000000000001', 'post-1'),
      boardId: 'BOARD000000000001',
      postId: 'post-1',
      ownerDigest: sha256('operation-1'),
      operationId: 'operation-1',
      sourceProvenance: 'upstash:padlet:evidence-bindings:v2',
    }]);
    expect(snapshot.operationBindings).toEqual([{
      operationId: 'operation-1',
      tupleDigest: tupleDigest('BOARD000000000001', 'post-1'),
      ownerDigest: sha256('operation-1'),
      payloadHash: 'sha256:c005007cfe89726a4421a364a802e0078eef7615cbfbe636ef99c73673e9c34f',
      claimField: claimField('BOARD000000000001', 'post-1'),
      binding: {
        taskId: 'TASK-1',
        studentId: 'STUDENT-1',
        cycleStartsAt: '2026-08-25T00:00:00.000Z',
        evidence: {
          evidenceProvider: 'PADLET',
          evidenceBoardId: 'BOARD000000000001',
          evidencePostId: 'post-1',
          evidenceCreatedAt: '2026-08-27T01:00:00.000Z',
          evidenceAuthorFullName: '김민준',
        },
      },
      sourceProvenance: 'upstash:padlet:evidence-bindings:v2',
    }]);
    expect(snapshot.orphanedClaimDigests).toEqual([
      tupleDigest('BOARD000000000002', 'post-orphan'),
    ]);
    expect(snapshot.v1Tombstones).toHaveLength(2);
    expect(snapshot.v1Tombstones[0]).toMatchObject({
      tupleDigest: 'd'.repeat(64),
      ownerDigest: sha256('legacy-owner-one'),
      sourceProvenance: 'upstash:padlet:evidence-claim:v1',
    });
    expect(JSON.stringify(snapshot)).not.toContain('legacy-owner-one');
  });

  it('deep-detaches and freezes preserved historical v2 binding records', async () => {
    const sourceBinding = {
      ...historicalBinding,
      evidence: { ...historicalBinding.evidence },
    };
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: boundEntries('operation-1', sourceBinding) }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });

    const snapshot = await capture(redis);
    const preserved = snapshot.operationBindings[0];
    expect(preserved.binding).not.toBe(sourceBinding);
    expect(preserved.binding.evidence).not.toBe(sourceBinding.evidence);
    expect(Object.isFrozen(preserved.binding)).toBe(true);
    expect(Object.isFrozen(preserved.binding.evidence)).toBe(true);

    sourceBinding.taskId = 'TASK-MUTATED';
    sourceBinding.evidence.evidenceAuthorFullName = '변조됨';
    expect(preserved.binding).toEqual(historicalBinding);
    expect(preserved.claimField).toBe(claimField('BOARD000000000001', 'post-1'));
  });

  it('rejects multiple tuple claims owned by the same operation', async () => {
    const secondBinding = {
      ...historicalBinding,
      evidence: { ...historicalBinding.evidence, evidencePostId: 'post-2' },
    };
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: [
        ...boundEntries(),
        [claimField('BOARD000000000001', 'post-2'), 'operation-1'],
        [operationField('operation-2'), JSON.stringify({
          binding: secondBinding,
          claimField: claimField('BOARD000000000001', 'post-2'),
        })],
      ] }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });

    await expect(capture(redis)).rejects.toThrow(/conflict/i);
  });

  it('rejects duplicate tuple digests with different owners', async () => {
    const field = claimField('BOARD000000000001', 'post-1');
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: [
        [field, 'operation-1'],
        [field, 'operation-2'],
        [operationField('operation-1'), JSON.stringify({ binding: historicalBinding, claimField: field })],
      ] }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });

    await expect(capture(redis)).rejects.toThrow(/conflict/i);
  });

  it('rejects a v1 digest-only tombstone colliding with a v2 tuple', async () => {
    const digest = tupleDigest('BOARD000000000001', 'post-1');
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: boundEntries() }),
      scan: async () => ({ cursor: '0', keys: [`padlet:evidence-claim:v1:${digest}`] }),
      get: async () => 'different-legacy-owner',
    });

    await expect(capture(redis)).rejects.toThrow(/conflict/i);
  });

  it.each([
    ['wrong operation field digest', [
      [`op:${'a'.repeat(64)}`, JSON.stringify({ binding: historicalBinding, claimField: claimField('BOARD000000000001', 'post-1') })],
      [claimField('BOARD000000000001', 'post-1'), 'operation-1'],
    ]],
    ['wrong record claimField', [
      [operationField('operation-1'), JSON.stringify({ binding: historicalBinding, claimField: claimField('BOARD000000000001', 'other-post') })],
      [claimField('BOARD000000000001', 'post-1'), 'operation-1'],
    ]],
    ['extra record value', [
      [operationField('operation-1'), JSON.stringify({ binding: historicalBinding, claimField: claimField('BOARD000000000001', 'post-1'), extra: true })],
      [claimField('BOARD000000000001', 'post-1'), 'operation-1'],
    ]],
    ['extra binding value', [
      [operationField('operation-1'), JSON.stringify({ binding: { ...historicalBinding, extra: true }, claimField: claimField('BOARD000000000001', 'post-1') })],
      [claimField('BOARD000000000001', 'post-1'), 'operation-1'],
    ]],
    ['unsupported evidence provider', [
      [operationField('operation-1'), JSON.stringify({ binding: {
        ...historicalBinding,
        evidence: { ...historicalBinding.evidence, evidenceProvider: 'OTHER' },
      }, claimField: claimField('BOARD000000000001', 'post-1') })],
      [claimField('BOARD000000000001', 'post-1'), 'operation-1'],
    ]],
  ] as const)('rejects malformed real v2 data: %s', async (_label, entries) => {
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });
    await expect(capture(redis)).rejects.toThrow(/unsupported|conflict/i);
  });

  it('uses locale-independent code-unit ordering and produces one digest for either scan order', async () => {
    const zBinding = {
      ...historicalBinding,
      taskId: 'TASK-Z',
      evidence: { ...historicalBinding.evidence, evidencePostId: 'post-z' },
    };
    const umlautBinding = {
      ...historicalBinding,
      taskId: 'TASK-UMLAUT',
      evidence: { ...historicalBinding.evidence, evidencePostId: 'post-umlaut' },
    };
    const entries = [...boundEntries('z-operation', zBinding), ...boundEntries('ä-operation', umlautBinding)];
    const make = (ordered: readonly (readonly [string, string])[]) => fakeRedis({
      hscan: async () => ({ cursor: '0', entries: ordered }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });

    const forward = await capture(make(entries));
    const reverse = await capture(make([...entries].reverse()));

    expect(forward.operationBindings.map(({ operationId }) => operationId)).toEqual(['z-operation', 'ä-operation']);
    expect(reverse.operationBindings.map(({ operationId }) => operationId)).toEqual(['z-operation', 'ä-operation']);
    expect(reverse.digest).toBe(forward.digest);
  });

  it('fails closed on pagination cursor cycles and source mutation', async () => {
    const cycling = fakeRedis({
      hscan: async () => ({ cursor: '1', entries: [] }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });
    await expect(captureRedisClaimSnapshot(cycling, {
      capturedAt: '2026-09-05T00:00:00.000Z', maxPages: 3,
    })).rejects.toThrow(/cursor|pagination/i);

    let revisionReads = 0;
    const mutating = fakeRedis({ getRevision: async () => (++revisionReads === 1 ? 'r1' : 'r2') });
    await expect(capture(mutating)).rejects.toThrow(/changed/i);
  });

  it('fails closed on missing pages and record limits without returning a truncated snapshot', async () => {
    const missing = fakeRedis({ hscan: async () => undefined as never });
    await expect(capture(missing)).rejects.toThrow(/missing|malformed/i);

    const bounded = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: boundEntries() }),
      scan: async () => ({ cursor: '0', keys: [] }),
    });
    await expect(captureRedisClaimSnapshot(bounded, {
      capturedAt: '2026-09-05T00:00:00.000Z', maxRecords: 1,
    })).rejects.toThrow(/record limit/i);
  });

  it('enforces one aggregate record limit across v2 hash fields and v1 keys', async () => {
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: boundEntries() }),
      scan: async () => ({ cursor: '0', keys: [`padlet:evidence-claim:v1:${'d'.repeat(64)}`] }),
    });

    await expect(captureRedisClaimSnapshot(redis, {
      capturedAt: '2026-09-05T00:00:00.000Z', maxRecords: 2,
    })).rejects.toThrow(/record limit/i);
  });

  it('allows the aggregate record count at the exact configured boundary', async () => {
    const redis = fakeRedis({
      hscan: async () => ({ cursor: '0', entries: boundEntries() }),
      scan: async () => ({ cursor: '0', keys: [`padlet:evidence-claim:v1:${'d'.repeat(64)}`] }),
    });

    const snapshot = await captureRedisClaimSnapshot(redis, {
      capturedAt: '2026-09-05T00:00:00.000Z', maxRecords: 3,
    });

    expect(snapshot.operationBindings).toHaveLength(1);
    expect(snapshot.v1Tombstones).toHaveLength(1);
  });

  it('deep-freezes the complete snapshot artifact', async () => {
    const snapshot = await capture(fakeRedis());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.v2Claims)).toBe(true);
    expect(Object.isFrozen(snapshot.v2Claims[0])).toBe(true);
    expect(Object.isFrozen(snapshot.operationBindings)).toBe(true);
    expect(Object.isFrozen(snapshot.v1Tombstones)).toBe(true);
    expect(Object.isFrozen(snapshot.orphanedClaimDigests)).toBe(true);
  });
});
