import { describe, expect, it, vi } from 'vitest';
import type { TaskCycleProjectionDto } from '@/server/repositories/sheets/taskHistoryQueries';
import type { PadletPost } from './padletClient';
import {
  allocatePadletTaskEligibility,
  claimPadletEvidenceForTask,
  MAX_CLAIM_ATTEMPTS,
  MAX_CONCURRENT_PADLET_BOARDS,
  MAX_PADLET_POSTS,
  MAX_PADLET_TASKS_PER_BOARD,
  PadletTaskVerificationError,
} from './padletTaskVerification';

function task(overrides: Partial<TaskCycleProjectionDto>): TaskCycleProjectionDto {
  return {
    taskId: 'T1', taskInstanceId: 'I1', title: '과제', description: '', reward: 1,
    isActive: true, sortOrder: 1, allowedStudentIds: ['S1'], padletBoardId: 'BOARD000000000001',
    currentCycle: {
      cycleId: 'C1', startsAt: '2026-08-27T00:00:00.000Z',
      students: [{ studentId: 'S1', assigned: true, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' }],
    },
    ...overrides,
  } as TaskCycleProjectionDto;
}

const posts = [
  { id: 'POST2', approved: true, createdAt: '2026-08-27T02:00:00.000Z', author: { fullName: ' 김민준 ' } },
  { id: 'POST1', approved: true, createdAt: '2026-08-27T01:00:00.000Z', author: { fullName: '김민준' } },
];

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    fetchBoardPosts: vi.fn().mockResolvedValue(posts),
    claimStore: { getClaimOwners: vi.fn().mockResolvedValue(new Map(posts.map(({ id }) => [id, null]))) },
    ...overrides,
  };
}

describe('allocatePadletTaskEligibility', () => {
  it('allocates oldest approved matching posts once by sort order then task id', async () => {
    const tasks = [
      task({ taskId: 'CHILD', sortOrder: 1 }),
      task({ taskId: 'ROOT', sortOrder: 0 }),
      task({ taskId: 'THIRD', sortOrder: 2 }),
    ];
    const deps = dependencies();

    const result = await allocatePadletTaskEligibility(tasks, 'S1', ' 김민준 ', deps);

    expect(result).toEqual(new Map([
      ['ROOT', { status: 'READY', message: 'Padlet 게시물이 확인되어 완료할 수 있습니다.' }],
      ['CHILD', { status: 'READY', message: 'Padlet 게시물이 확인되어 완료할 수 있습니다.' }],
      ['THIRD', { status: 'SUBMISSION_REQUIRED', message: '승인된 Padlet 게시물을 작성한 뒤 다시 확인해 주세요.' }],
    ]));
    expect(deps.fetchBoardPosts).toHaveBeenCalledOnce();
    expect(deps.claimStore.getClaimOwners).toHaveBeenCalledWith('BOARD000000000001', ['POST1', 'POST2']);
  });

  it('requires exact case-sensitive trimmed author matches, approval, and each task cycle start', async () => {
    const mixedPosts = [
      { id: 'wrong-case', approved: true, createdAt: '2026-08-28T02:00:00.000Z', author: { fullName: 'kim' } },
      { id: 'pending', approved: false, createdAt: '2026-08-28T02:00:00.000Z', author: { fullName: '김민준' } },
      { id: 'old', approved: true, createdAt: '2026-08-27T23:59:59.999Z', author: { fullName: '김민준' } },
    ];
    const deps = dependencies({
      fetchBoardPosts: vi.fn().mockResolvedValue(mixedPosts),
      claimStore: { getClaimOwners: vi.fn().mockResolvedValue(new Map(mixedPosts.map(({ id }) => [id, null]))) },
    });

    const result = await allocatePadletTaskEligibility([
      task({ currentCycle: { ...task({}).currentCycle, startsAt: '2026-08-28T00:00:00.000Z' } }),
    ], 'S1', '김민준', deps);

    expect(result.get('T1')?.status).toBe('SUBMISSION_REQUIRED');
  });

  it('excludes consumed claims and does not evaluate completed or non-Padlet tasks', async () => {
    const deps = dependencies({
      claimStore: { getClaimOwners: vi.fn().mockResolvedValue(new Map([['POST1', 'op-old'], ['POST2', 'op-old']])) },
    });
    const completed = task({ taskId: 'DONE', currentCycle: {
      ...task({}).currentCycle,
      students: [{ studentId: 'S1', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' }],
    } });
    const plain = task({ taskId: 'PLAIN', padletBoardId: undefined });

    const result = await allocatePadletTaskEligibility([task({}), completed, plain], 'S1', '김민준', deps);

    expect(result).toEqual(new Map([['T1', {
      status: 'SUBMISSION_REQUIRED', message: '승인된 Padlet 게시물을 작성한 뒤 다시 확인해 주세요.',
    }]]));
  });

  it('excludes inactive, unavailable, unassigned, and prerequisite-blocked siblings from listing allocation', async () => {
    const deps = dependencies({
      fetchBoardPosts: vi.fn().mockResolvedValue([posts[0]]),
      claimStore: { getClaimOwners: vi.fn().mockResolvedValue(new Map([[posts[0].id, null]])) },
    });
    const unassignedCycle = {
      ...task({}).currentCycle,
      students: [{ studentId: 'S1', assigned: false, completed: false, assignmentOrigin: 'DEFAULT' as const, completionOrigin: 'DEFAULT' as const }],
    };
    const tasks = [
      task({ taskId: 'INACTIVE', sortOrder: 0, isActive: false }),
      task({ taskId: 'UNAVAILABLE', sortOrder: 1, availableFrom: '2026-08-29T00:00:00.000Z' }),
      task({ taskId: 'UNASSIGNED', sortOrder: 2, currentCycle: unassignedCycle }),
      task({ taskId: 'ROOT', padletBoardId: undefined }),
      task({ taskId: 'BLOCKED', sortOrder: 3, prerequisiteTaskId: 'ROOT' }),
      task({ taskId: 'TARGET', sortOrder: 4 }),
    ];

    const result = await allocatePadletTaskEligibility(
      tasks, 'S1', '김민준', deps, '2026-08-28T00:00:00.000Z',
    );

    expect(result).toEqual(new Map([['TARGET', {
      status: 'READY', message: 'Padlet 게시물이 확인되어 완료할 수 있습니다.',
    }]]));
  });

  it.each(['Padlet', 'Redis'])('fails closed for %s while leaving unrelated tasks untouched', async (failure) => {
    const deps = dependencies(failure === 'Padlet'
      ? { fetchBoardPosts: vi.fn().mockRejectedValue(new Error('provider secret')) }
      : { claimStore: { getClaimOwners: vi.fn().mockRejectedValue(new Error('redis secret')) } });

    const result = await allocatePadletTaskEligibility([
      task({ taskId: 'PADLET' }), task({ taskId: 'PLAIN', padletBoardId: undefined }),
    ], 'S1', '김민준', deps);

    expect(result).toEqual(new Map([['PADLET', {
      status: 'CHECK_UNAVAILABLE', message: 'Padlet 게시물 확인이 일시적으로 불가능합니다. 잠시 후 다시 시도해 주세요.',
    }]]));
  });

  it('fails the linked board closed for duplicate task ids without external calls', async () => {
    const deps = dependencies();
    const result = await allocatePadletTaskEligibility([task({}), task({ sortOrder: 2 })], 'S1', '김민준', deps);
    expect(result.get('T1')?.status).toBe('CHECK_UNAVAILABLE');
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
  });

  it.each([
    [{ fetchedPosts: [{ ...posts[0] }, { ...posts[0] }] }],
    [{ fetchedPosts: [{ ...posts[0], id: 'bad/id' }] }],
    [{ fetchedPosts: [{ ...posts[0], id: 'x'.repeat(129) }] }],
    [{ fetchedPosts: [{ ...posts[0], createdAt: '2026-08-27' }] }],
    [{ fetchedPosts: [{ ...posts[0], createdAt: '2026-02-31T00:00:00Z' }] }],
    [{ fetchedPosts: [{ ...posts[0], createdAt: '2026-08-27T01:00:00' }] }],
  ])('fails listing closed for an invalid fetched collection %#', async ({ fetchedPosts }) => {
    const deps = dependencies({ fetchBoardPosts: vi.fn().mockResolvedValue(fetchedPosts) });
    const result = await allocatePadletTaskEligibility([task({})], 'S1', '김민준', deps);
    expect(result.get('T1')?.status).toBe('CHECK_UNAVAILABLE');
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
  });

  it('fails listing closed at task and post bounds and for an invalid sibling cycle', async () => {
    const tooManyTasks = Array.from({ length: MAX_PADLET_TASKS_PER_BOARD + 1 }, (_, index) => task({ taskId: `T${index}` }));
    const taskDeps = dependencies();
    const taskResult = await allocatePadletTaskEligibility(tooManyTasks, 'S1', '김민준', taskDeps);
    expect(new Set([...taskResult.values()].map(({ status }) => status))).toEqual(new Set(['CHECK_UNAVAILABLE']));
    expect(taskDeps.fetchBoardPosts).not.toHaveBeenCalled();

    const postDeps = dependencies({ fetchBoardPosts: vi.fn().mockResolvedValue(Array.from(
      { length: MAX_PADLET_POSTS + 1 }, (_, index) => ({ ...posts[0], id: `POST_${index}` }),
    )) });
    expect((await allocatePadletTaskEligibility([task({})], 'S1', '김민준', postDeps)).get('T1')?.status)
      .toBe('CHECK_UNAVAILABLE');
    expect(postDeps.claimStore.getClaimOwners).not.toHaveBeenCalled();

    const siblingDeps = dependencies();
    const siblingResult = await allocatePadletTaskEligibility([
      task({ taskId: 'GOOD' }),
      task({ taskId: 'BAD', currentCycle: { ...task({}).currentCycle, startsAt: 'invalid' } }),
    ], 'S1', '김민준', siblingDeps);
    expect([...siblingResult.values()].every(({ status }) => status === 'CHECK_UNAVAILABLE')).toBe(true);
    expect(siblingDeps.fetchBoardPosts).not.toHaveBeenCalled();
  });

  it('rejects more than the global task bound even when every task uses a different board', async () => {
    const tasks = Array.from({ length: MAX_PADLET_TASKS_PER_BOARD + 1 }, (_, index) => task({
      taskId: `T${index}`,
      padletBoardId: `BOARD${String(index).padStart(11, '0')}`,
    }));
    const deps = dependencies();

    const result = await allocatePadletTaskEligibility(tasks, 'S1', '김민준', deps);

    expect(result.size).toBe(tasks.length);
    expect([...result.values()].every(({ status }) => status === 'CHECK_UNAVAILABLE')).toBe(true);
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
  });

  it('limits listing provider fan-out across distinct boards', async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fetchBoardPosts = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.push(() => { active -= 1; resolve(); }));
      return posts;
    });
    const tasks = Array.from({ length: MAX_CONCURRENT_PADLET_BOARDS + 1 }, (_, index) => task({
      taskId: `T${index}`,
      padletBoardId: `BOARD${String(index).padStart(11, '0')}`,
    }));
    const deps = dependencies({ fetchBoardPosts });

    const pending = allocatePadletTaskEligibility(tasks, 'S1', '김민준', deps);
    await vi.waitFor(() => expect(fetchBoardPosts).toHaveBeenCalledTimes(MAX_CONCURRENT_PADLET_BOARDS));
    expect(maximumActive).toBe(MAX_CONCURRENT_PADLET_BOARDS);
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(fetchBoardPosts).toHaveBeenCalledTimes(tasks.length));
    releases.splice(0).forEach((release) => release());
    await pending;
    expect(maximumActive).toBe(MAX_CONCURRENT_PADLET_BOARDS);
  });
});

describe('claimPadletEvidenceForTask', () => {
  function claimDependencies({
    fetchedPosts = posts,
    owners = new Map(fetchedPosts.map(({ id }) => [id, null])),
    claimStatuses = ['CLAIMED' as const],
    operationBinding = null,
  }: {
    fetchedPosts?: PadletPost[];
    owners?: Map<string, string | null>;
    claimStatuses?: Array<'CLAIMED' | 'IDEMPOTENT' | 'CONFLICT'>;
    operationBinding?: {
      taskId: string;
      studentId: string;
      cycleStartsAt: string;
      evidence: { evidenceProvider: 'PADLET'; evidenceBoardId: string; evidencePostId: string;
        evidenceCreatedAt: string; evidenceAuthorFullName: string };
    } | null;
  } = {}) {
    const getOperationBinding = vi.fn().mockResolvedValue(operationBinding);
    const claimBoundEvidence = vi.fn().mockImplementation(async (call) => {
      const status = claimStatuses.shift() ?? 'CLAIMED';
      return status === 'CONFLICT' ? { status } : {
        status, binding: {
          taskId: call.taskId,
          studentId: call.studentId,
          cycleStartsAt: call.cycleStartsAt,
          evidence: call.evidence,
        },
      };
    });
    return {
      fetchBoardPosts: vi.fn().mockResolvedValue(fetchedPosts),
      claimStore: {
        getOperationBinding,
        getClaimOwners: vi.fn().mockResolvedValue(owners),
        claimBoundEvidence,
      },
    };
  }

  const input = (overrides: Partial<Parameters<typeof claimPadletEvidenceForTask>[0]> = {}) => ({
    tasks: [task({})], taskId: 'T1', studentId: 'S1', studentName: ' 김민준 ', operationId: 'operation-1',
    now: '2026-08-28T00:00:00.000Z', ...overrides,
  });

  const completedCycle = () => ({
    ...task({}).currentCycle,
    students: [{ studentId: 'S1', assigned: true, completed: true, assignmentOrigin: 'EVENT' as const, completionOrigin: 'EVENT' as const }],
  });

  it('excludes inactive, unavailable, and unassigned siblings from completion allocation', async () => {
    const onlyPost = [posts[0]];
    const deps = claimDependencies({ fetchedPosts: onlyPost, owners: new Map([['POST2', null]]) });
    const assigned = task({ taskId: 'TARGET', sortOrder: 99 });
    const unassignedCycle = {
      ...task({}).currentCycle,
      students: [{ studentId: 'S1', assigned: false, completed: false, assignmentOrigin: 'DEFAULT' as const, completionOrigin: 'DEFAULT' as const }],
    };
    const siblings = [
      task({ taskId: 'INACTIVE', sortOrder: 0, isActive: false }),
      task({ taskId: 'UNAVAILABLE', sortOrder: 1, availableFrom: '2026-08-29T00:00:00.000Z' }),
      task({ taskId: 'UNASSIGNED', sortOrder: 2, currentCycle: unassignedCycle }),
      assigned,
    ];

    await expect(claimPadletEvidenceForTask(input({ tasks: siblings, taskId: 'TARGET' }), deps))
      .resolves.toMatchObject({ evidencePostId: 'POST2' });
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledOnce();
  });

  it('claims only the target deterministic allocation and returns its canonical snapshot', async () => {
    const fetchedPosts = [
      { id: 'POST3', approved: true, createdAt: '2026-08-27T03:00:00.000Z', author: { fullName: ' 김민준 ' } },
      ...posts,
    ];
    const deps = claimDependencies({ fetchedPosts, owners: new Map(fetchedPosts.map(({ id }) => [id, null])) });
    const tasks = [
      task({ taskId: 'DEEP', sortOrder: 0, prerequisiteTaskId: 'CHILD' }),
      task({ taskId: 'CHILD', sortOrder: 0, prerequisiteTaskId: 'ROOT' }),
      task({ taskId: 'ROOT', sortOrder: 99, currentCycle: completedCycle() }),
    ];

    const result = await claimPadletEvidenceForTask(input({ tasks, taskId: 'CHILD' }), deps);

    expect(result).toEqual({
      evidenceProvider: 'PADLET', evidenceBoardId: 'BOARD000000000001', evidencePostId: 'POST1',
      evidenceCreatedAt: '2026-08-27T01:00:00.000Z', evidenceAuthorFullName: '김민준',
    });
    expect(deps.fetchBoardPosts).toHaveBeenCalledOnce();
    expect(deps.fetchBoardPosts).toHaveBeenCalledWith({ boardId: 'BOARD000000000001' });
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledOnce();
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledWith({
      operationId: 'operation-1', taskId: 'CHILD', studentId: 'S1',
      cycleStartsAt: '2026-08-27T00:00:00.000Z', evidence: expect.objectContaining({
        evidenceBoardId: 'BOARD000000000001', evidencePostId: 'POST1',
      }),
    });
  });

  it('applies approval, exact case-sensitive trimmed author, and per-task cycle filters', async () => {
    const fetchedPosts = [
      { id: 'wrong-case', approved: true, createdAt: '2026-08-28T02:00:00.000Z', author: { fullName: 'kim' } },
      { id: 'pending', approved: false, createdAt: '2026-08-28T02:00:00.000Z', author: { fullName: ' Kim ' } },
      { id: 'old', approved: true, createdAt: '2026-08-27T23:59:59.999Z', author: { fullName: 'Kim' } },
      { id: 'valid', approved: true, createdAt: '2026-08-28T00:00:00.000Z', author: { fullName: ' Kim ' } },
    ];
    const deps = claimDependencies({ fetchedPosts, owners: new Map(fetchedPosts.map(({ id }) => [id, null])) });
    const target = task({ currentCycle: { ...task({}).currentCycle, startsAt: '2026-08-28T00:00:00.000Z' } });

    const result = await claimPadletEvidenceForTask(input({ tasks: [target], studentName: ' Kim ' }), deps);

    expect(result).toMatchObject({ evidencePostId: 'valid', evidenceAuthorFullName: 'Kim' });
  });

  it('excludes posts owned by another operation', async () => {
    const deps = claimDependencies({ owners: new Map([['POST1', 'other-operation'], ['POST2', null]]) });

    const result = await claimPadletEvidenceForTask(input(), deps);

    expect(result.evidencePostId).toBe('POST2');
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidence: expect.objectContaining({ evidencePostId: 'POST2' }),
    }));
  });

  it('recomputes deterministically after one conflict without refetching and stays bounded', async () => {
    const fetchedPosts = [...posts,
      { id: 'POST3', approved: true, createdAt: '2026-08-27T03:00:00.000Z', author: { fullName: '김민준' } }];
    const deps = claimDependencies({
      fetchedPosts,
      owners: new Map(fetchedPosts.map(({ id }) => [id, null])),
      claimStatuses: ['CONFLICT', 'CLAIMED'],
    });
    const tasks = [
      task({ taskId: 'ROOT', currentCycle: completedCycle() }),
      task({ taskId: 'TARGET', prerequisiteTaskId: 'ROOT' }),
    ];

    const result = await claimPadletEvidenceForTask(input({ tasks, taskId: 'TARGET' }), deps);

    expect(result.evidencePostId).toBe('POST2');
    expect(deps.fetchBoardPosts).toHaveBeenCalledOnce();
    expect(deps.claimStore.getClaimOwners).toHaveBeenCalledOnce();
    expect(deps.claimStore.claimBoundEvidence.mock.calls.map(([call]) => call.evidence.evidencePostId)).toEqual(['POST1', 'POST2']);
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledTimes(2);
  });

  it('stops after every candidate conflicts without refetching or exceeding the candidate bound', async () => {
    const fetchedPosts = [...posts,
      { id: 'POST3', approved: true, createdAt: '2026-08-27T03:00:00.000Z', author: { fullName: '김민준' } }];
    const deps = claimDependencies({
      fetchedPosts,
      owners: new Map(fetchedPosts.map(({ id }) => [id, null])),
      claimStatuses: fetchedPosts.map(() => 'CONFLICT' as const),
    });

    await expect(claimPadletEvidenceForTask(input(), deps))
      .rejects.toMatchObject({ code: 'SUBMISSION_REQUIRED' });
    expect(deps.fetchBoardPosts).toHaveBeenCalledOnce();
    expect(deps.claimStore.getClaimOwners).toHaveBeenCalledOnce();
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledTimes(fetchedPosts.length);
    expect(deps.claimStore.claimBoundEvidence.mock.calls.map(([call]) => call.evidence.evidencePostId)).toEqual(['POST1', 'POST2', 'POST3']);
  });

  it('accepts an idempotent claim owned by the same operation', async () => {
    const deps = claimDependencies({
      owners: new Map([['POST1', 'operation-1'], ['POST2', null]]), claimStatuses: ['IDEMPOTENT'],
    });

    const result = await claimPadletEvidenceForTask(input(), deps);

    expect(result.evidencePostId).toBe('POST1');
  });

  it('returns only a safe SUBMISSION_REQUIRED error when no post is allocated', async () => {
    const deps = claimDependencies({ fetchedPosts: [], owners: new Map() });

    const thrown = await claimPadletEvidenceForTask(input(), deps).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PadletTaskVerificationError);
    expect(thrown).toMatchObject({ code: 'SUBMISSION_REQUIRED', message: 'Padlet submission is required.' });
    expect(thrown).not.toHaveProperty('cause');
    expect(JSON.stringify(thrown)).not.toContain('김민준');
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['Padlet', { fetchBoardPosts: vi.fn().mockRejectedValue(new Error('provider credential secret')) }],
    ['Redis owners', { claimStore: { getOperationBinding: vi.fn().mockResolvedValue(null), getClaimOwners: vi.fn().mockRejectedValue(new Error('redis secret')), claimBoundEvidence: vi.fn() } }],
    ['Redis claim', { claimStore: { getOperationBinding: vi.fn().mockResolvedValue(null), getClaimOwners: vi.fn().mockResolvedValue(new Map([['POST1', null], ['POST2', null]])), claimBoundEvidence: vi.fn().mockRejectedValue(new Error('redis secret')) } }],
  ])('fails closed with a cause-free safe error for %s failure', async (_label, override) => {
    const deps = claimDependencies();
    Object.assign(deps, override);

    const thrown = await claimPadletEvidenceForTask(input(), deps).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PadletTaskVerificationError);
    expect(thrown).toMatchObject({ code: 'CHECK_UNAVAILABLE', message: 'Padlet verification is unavailable.' });
    expect(thrown).not.toHaveProperty('cause');
    expect(JSON.stringify(thrown)).not.toMatch(/secret|김민준|POST1/);
  });

  it.each([
    ['unknown target', input({ taskId: 'UNKNOWN' }), 'POLICY'],
    ['unlinked target', input({ tasks: [task({ padletBoardId: undefined })] }), 'POLICY'],
    ['completed target', input({ tasks: [task({ currentCycle: {
      ...task({}).currentCycle,
      students: [{ studentId: 'S1', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' }],
    } })] }), 'POLICY'],
    ['missing cycle', input({ tasks: [task({ currentCycle: undefined as never })] }), 'CHECK_UNAVAILABLE'],
    ['invalid cycle', input({ tasks: [task({ currentCycle: { ...task({}).currentCycle, startsAt: 'invalid' } })] }), 'CHECK_UNAVAILABLE'],
  ])('does not fetch or claim for %s', async (_label, request, code) => {
    const deps = claimDependencies();

    const thrown = await claimPadletEvidenceForTask(request, deps).catch((error: unknown) => error);

    expect(thrown).toMatchObject({ code });
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['empty student ID', input({ studentId: '   ' })],
    ['empty student name', input({ studentName: '   ' })],
    ['empty operation ID', input({ operationId: '   ' })],
  ])('does not fetch or claim for %s', async (_label, request) => {
    const deps = claimDependencies();

    await expect(claimPadletEvidenceForTask(request, deps))
      .rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it('returns the original binding on retry without Padlet, MGET, or a new claim', async () => {
    const original = {
      taskId: 'T1',
      studentId: 'S1',
      cycleStartsAt: '2026-08-27T00:00:00.000Z',
      evidence: {
        evidenceProvider: 'PADLET' as const, evidenceBoardId: 'BOARD000000000001', evidencePostId: 'ORIGINAL_POST',
        evidenceCreatedAt: '2026-08-27T04:00:00.000Z', evidenceAuthorFullName: '김민준',
      },
    };
    const deps = claimDependencies({ operationBinding: original, fetchedPosts: [{ ...posts[0], id: 'NEW_POST' }] });
    await expect(claimPadletEvidenceForTask(input(), deps)).resolves.toEqual(original.evidence);
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it('rejects the same operation for another target without external mutation', async () => {
    const original = {
      taskId: 'T1',
      studentId: 'S1',
      cycleStartsAt: '2026-08-27T00:00:00.000Z',
      evidence: {
        evidenceProvider: 'PADLET' as const, evidenceBoardId: 'BOARD000000000001', evidencePostId: 'ORIGINAL_POST',
        evidenceCreatedAt: '2026-08-27T04:00:00.000Z', evidenceAuthorFullName: '김민준',
      },
    };
    const deps = claimDependencies({ operationBinding: original });
    await expect(claimPadletEvidenceForTask(input({
      tasks: [task({ taskId: 'T1' }), task({ taskId: 'T2' })], taskId: 'T2',
    }), deps)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it('rejects the same operation for the same task moved to another board', async () => {
    const original = {
      taskId: 'T1',
      studentId: 'S1',
      cycleStartsAt: '2026-08-27T00:00:00.000Z',
      evidence: {
        evidenceProvider: 'PADLET' as const, evidenceBoardId: 'BOARD000000000001', evidencePostId: 'ORIGINAL_POST',
        evidenceCreatedAt: '2026-08-27T04:00:00.000Z', evidenceAuthorFullName: '김민준',
      },
    };
    const deps = claimDependencies({ operationBinding: original });

    await expect(claimPadletEvidenceForTask(input({
      tasks: [task({ padletBoardId: 'BOARD000000000002' })],
    }), deps)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['another student', { studentId: 'S2' }, {}],
    ['another cycle', {}, { currentCycle: { ...task({}).currentCycle, startsAt: '2026-08-28T00:00:00.000Z' } }],
  ])('rejects the same operation for %s', async (_label, inputOverride, taskOverride) => {
    const original = {
      taskId: 'T1', studentId: 'S1', cycleStartsAt: '2026-08-27T00:00:00.000Z',
      evidence: {
        evidenceProvider: 'PADLET' as const, evidenceBoardId: 'BOARD000000000001', evidencePostId: 'ORIGINAL_POST',
        evidenceCreatedAt: '2026-08-27T04:00:00.000Z', evidenceAuthorFullName: '김민준',
      },
    };
    const deps = claimDependencies({ operationBinding: original });
    await expect(claimPadletEvidenceForTask(input({
      tasks: [task(taskOverride)],
      ...inputOverride,
    }), deps)).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it('recovers the original immutable binding when EVAL observes a binding after the initial GET', async () => {
    const deps = claimDependencies();
    const original = {
      taskId: 'T1',
      studentId: 'S1',
      cycleStartsAt: '2026-08-27T00:00:00.000Z',
      evidence: {
        evidenceProvider: 'PADLET' as const, evidenceBoardId: 'BOARD000000000001', evidencePostId: 'ORIGINAL_POST',
        evidenceCreatedAt: '2026-08-27T04:00:00.000Z', evidenceAuthorFullName: '김민준',
      },
    };
    deps.claimStore.claimBoundEvidence.mockResolvedValue({ status: 'OPERATION_CONFLICT', binding: original });
    await expect(claimPadletEvidenceForTask(input(), deps)).resolves.toEqual(original.evidence);
    expect(deps.fetchBoardPosts).toHaveBeenCalledOnce();
    expect(deps.claimStore.claimBoundEvidence).toHaveBeenCalledOnce();
  });

  it('rejects duplicate task ids and invalid sibling cycles before external calls', async () => {
    for (const tasks of [
      [task({}), task({ sortOrder: 2 })],
      [task({}), task({ taskId: 'BAD', currentCycle: { ...task({}).currentCycle, startsAt: 'invalid' } })],
    ]) {
      const deps = claimDependencies();
      await expect(claimPadletEvidenceForTask(input({ tasks }), deps))
        .rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
      expect(deps.claimStore.getOperationBinding).not.toHaveBeenCalled();
      expect(deps.fetchBoardPosts).not.toHaveBeenCalled();
    }
  });

  it.each([
    [{ fetchedPosts: [{ ...posts[0] }, { ...posts[0] }] }],
    [{ fetchedPosts: [{ ...posts[0], id: 'bad/id' }] }],
    [{ fetchedPosts: [{ ...posts[0], id: 'x'.repeat(129) }] }],
    [{ fetchedPosts: [{ ...posts[0], createdAt: '2026-08-27' }] }],
    [{ fetchedPosts: [{ ...posts[0], createdAt: '2026-02-31T00:00:00Z' }] }],
    [{ fetchedPosts: [{ ...posts[0], createdAt: '2026-08-27T01:00:00' }] }],
  ])('rejects invalid fetched collection %# without Redis allocation', async ({ fetchedPosts }) => {
    const deps = claimDependencies({ fetchedPosts });
    await expect(claimPadletEvidenceForTask(input(), deps)).rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
    expect(deps.claimStore.getClaimOwners).not.toHaveBeenCalled();
    expect(deps.claimStore.claimBoundEvidence).not.toHaveBeenCalled();
  });

  it('enforces task, post, and conflict-attempt bounds with one fetch', async () => {
    const taskDeps = claimDependencies();
    await expect(claimPadletEvidenceForTask(input({
      tasks: Array.from({ length: MAX_PADLET_TASKS_PER_BOARD + 1 }, (_, index) => task({ taskId: `T${index}` })),
      taskId: 'T0',
    }), taskDeps)).rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
    expect(taskDeps.fetchBoardPosts).not.toHaveBeenCalled();

    const globalTaskDeps = claimDependencies();
    await expect(claimPadletEvidenceForTask(input({
      tasks: Array.from({ length: MAX_PADLET_TASKS_PER_BOARD + 1 }, (_, index) => task({
        taskId: `GLOBAL${index}`,
        padletBoardId: `BOARD${String(index).padStart(11, '0')}`,
      })),
      taskId: 'GLOBAL0',
    }), globalTaskDeps)).rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
    expect(globalTaskDeps.claimStore.getOperationBinding).not.toHaveBeenCalled();
    expect(globalTaskDeps.fetchBoardPosts).not.toHaveBeenCalled();

    const tooManyPosts = Array.from({ length: MAX_PADLET_POSTS + 1 }, (_, index) => ({ ...posts[0], id: `POST_${index}` }));
    const postDeps = claimDependencies({ fetchedPosts: tooManyPosts });
    await expect(claimPadletEvidenceForTask(input(), postDeps)).rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
    expect(postDeps.claimStore.getClaimOwners).not.toHaveBeenCalled();

    const candidates = Array.from({ length: MAX_CLAIM_ATTEMPTS + 1 }, (_, index) => ({ ...posts[0], id: `POST_${index}` }));
    const capDeps = claimDependencies({
      fetchedPosts: candidates,
      owners: new Map(candidates.map(({ id }) => [id, null])),
      claimStatuses: Array.from({ length: MAX_CLAIM_ATTEMPTS }, () => 'CONFLICT'),
    });
    await expect(claimPadletEvidenceForTask(input(), capDeps)).rejects.toMatchObject({ code: 'CHECK_UNAVAILABLE' });
    expect(capDeps.fetchBoardPosts).toHaveBeenCalledOnce();
    expect(capDeps.claimStore.getClaimOwners).toHaveBeenCalledOnce();
    expect(capDeps.claimStore.claimBoundEvidence).toHaveBeenCalledTimes(MAX_CLAIM_ATTEMPTS);
  });
});
