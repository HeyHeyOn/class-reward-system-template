import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ completeTaskForStudent: vi.fn() }));
vi.mock('@/server/repositories/sheets/taskHistoryQueries', () => ({ listTaskCycleProjections: vi.fn() }));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { listTaskCycleProjections } from '@/server/repositories/sheets/taskHistoryQueries';
import {
  createConfiguredTaskCompletion,
  createTaskCompletionRepositoryCreators,
  type ConfiguredTaskCompletionInput,
} from './configuredTaskCompletion';
import { completeTaskForStudent } from '@/server/sheetsRepository';
import type { TaskRewardSuccess } from '@/server/repositories/database/taskCompletionCommands';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const COMPLETED_AT: TaskRewardSuccess['completedAt'] = '2026-09-01T00:00:00.000Z';
const INPUT: ConfiguredTaskCompletionInput = {
  requestId: 'request-1', operationId: OPERATION_ID, taskId: 'T001', studentId: 'S001',
};

const projectedTask = (completed = true) => ({
  taskId: 'T001', title: '읽기', description: '책', reward: 100, sortOrder: 1,
  studentStatus: { studentId: 'S001', assigned: true, completed },
});

function rawDatabaseResult(overrides: Record<string, unknown> = {}): TaskRewardSuccess {
  return {
    ok: true, operationId: OPERATION_ID, completedAt: COMPLETED_AT,
    taskId: 'T001', taskInstanceId: 'task-instance-1', taskTitle: '읽기',
    studentId: 'S001', studentName: '학생', reward: 100,
    balanceBefore: 50, balanceAfter: 150, cycleId: 'cycle-1',
    transactionId: `task-reward:${OPERATION_ID}`,
    completionId: `task-completion:${OPERATION_ID}`,
    ...overrides,
  } as TaskRewardSuccess;
}

function dependencies(overrides: Record<string, unknown> = {}) {
  const command = { execute: vi.fn(async () => rawDatabaseResult()) };
  const taskQueries = { marker: 'tasks' };
  const cycleQueries = { listTaskCycleProjections: vi.fn(async () => [projectedTask()]) };
  const claims = {
    claim: vi.fn(async () => 'CLAIMED' as const),
    findClaimedPostIds: vi.fn(async () => [] as string[]),
  };
  return {
    createDatabasePadletClaimRepository: vi.fn(() => claims),
    createDatabaseTaskCompletionCommand: vi.fn(() => command),
    createDatabaseTaskQueries: vi.fn(() => taskQueries),
    createDatabaseTaskCycleQueries: vi.fn(() => cycleQueries),
    createPadletCompletionEvidenceResolver: vi.fn((input: { fetchPosts: (boardId: string) => Promise<unknown>; findClaimedPostIds: (boardId: string, ids: string[]) => Promise<string[]> }) =>
      async (resolverInput: { boardId: string }) => {
        await input.fetchPosts(resolverInput.boardId);
        await input.findClaimedPostIds(resolverInput.boardId, ['post-1']);
        return { evidenceProvider: 'PADLET', evidenceBoardId: resolverInput.boardId,
          evidencePostId: 'post-1', evidenceCreatedAt: COMPLETED_AT,
          evidenceAuthorFullName: '학생' };
      }),
    fetchPadletBoardPosts: vi.fn(async () => []),
    withTenantTransaction: vi.fn(),
    withTenantSnapshot: vi.fn(async (_tenantId: string, callback: (tx: unknown) => Promise<unknown>) => callback({ marker: 'snapshot' })),
    createConfiguredSheetsStore: vi.fn(async () => ({ marker: 'sheets' })),
    completeTaskForStudent: vi.fn(),
    sheetsListTaskCycleProjections: vi.fn(),
    buildStudentTaskProjection: vi.fn(() => [projectedTask()]),
    command, taskQueries, cycleQueries, claims,
    ...overrides,
  };
}

async function configured(storage: 'sheets' | 'postgresql', deps = dependencies()) {
  const creators = createTaskCompletionRepositoryCreators(deps as never);
  const command = await createConfiguredTaskCompletion({
    env: { CLASS_STORE_STORAGE: storage },
    getCentralTenantContext: () => ({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' }),
    creators,
  });
  return { command, deps, creators };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('configured task completion command root', () => {
  it.each([
    [{ ...INPUT, operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase() }, /operation/i],
    [{ ...INPUT, taskId: ' T001' }, /task/i],
    [{ ...INPUT, studentId: 'S001 ' }, /student/i],
    [{ ...INPUT, requestId: '   ' }, /request/i],
    [{ ...INPUT, extra: true }, /input/i],
  ])('rejects malformed input before opening either backend', async (input, message) => {
    const deps = dependencies();
    const { command } = await configured('postgresql', deps);
    await expect(command.execute(input as never)).rejects.toThrow(message);
    expect(deps.createDatabaseTaskCompletionCommand).not.toHaveBeenCalled();
    expect(deps.createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('recognizes Request first and rejects malformed supplied options before production dependencies', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/tasks/T001/complete', { method: 'POST' });
    Object.defineProperties(request, {
      env: { value: { CLASS_STORE_STORAGE: 'postgresql' } },
      getCentralTenantContext: { value: vi.fn() }, creators: { value: {} },
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({ marker: 'store' } as never);
    vi.mocked(listTaskCycleProjections).mockResolvedValue([] as never);
    vi.mocked(completeTaskForStudent).mockResolvedValue({
      task: { taskId: 'T001', title: '읽기', reward: 100 },
      student: { studentId: 'S001', name: '학생' }, completion: {}, tasks: [projectedTask()],
      operation: { operationId: OPERATION_ID, state: 'SUCCESS' },
    } as never);

    const command = await createConfiguredTaskCompletion(request);
    await command.execute(INPUT);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);

    await expect(createConfiguredTaskCompletion({} as never)).rejects.toThrow(/invalid configured task completion options/i);
  });

  it('recognizes Request before hostile option-like properties without invoking them', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/tasks/T001/complete', { method: 'POST' });
    const hostile = vi.fn(() => { throw new Error('hostile Request getter'); });
    Object.defineProperties(request, {
      env: { enumerable: true, get: hostile },
      getCentralTenantContext: { enumerable: true, get: hostile },
      creators: { enumerable: true, get: hostile },
    });
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({ marker: 'store' } as never);

    await expect(createConfiguredTaskCompletion(request)).resolves.toBeDefined();
    expect(hostile).not.toHaveBeenCalled();
  });

  it('rejects unsafe option descriptors without invoking getters or creators', async () => {
    const invoked = vi.fn();
    const getter = vi.fn(() => { throw new Error('option getter invoked'); });
    const valid = () => ({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(),
      creators: {
        createPostgresql: vi.fn(() => { invoked(); return { execute: vi.fn() }; }),
        createSheets: vi.fn(() => { invoked(); return { execute: vi.fn() }; }),
      },
    });
    const withDescriptor = (key: string, descriptor: PropertyDescriptor) => {
      const value = valid() as Record<string, unknown>;
      Object.defineProperty(value, key, descriptor);
      return value;
    };
    const creatorGetter = valid();
    Object.defineProperty(creatorGetter.creators, 'createSheets', { enumerable: true, get: getter });
    const envGetter = valid();
    Object.defineProperty(envGetter.env, 'CLASS_STORE_STORAGE', { enumerable: true, get: getter });
    const envNonEnumerable = valid();
    Object.defineProperty(envNonEnumerable.env, 'HIDDEN', { value: 'secret' });
    const symbolOption = valid() as Record<PropertyKey, unknown>;
    symbolOption[Symbol('extra')] = true;
    const customOptions = Object.assign(Object.create({}), valid());
    const customEnv = valid();
    customEnv.env = Object.assign(Object.create({}), customEnv.env);
    const customCreators = valid();
    customCreators.creators = Object.assign(Object.create({}), customCreators.creators);

    const malformed: unknown[] = [
      withDescriptor('env', { enumerable: true, get: getter }),
      withDescriptor('creators', { enumerable: true, get: getter }),
      withDescriptor('extra', { value: true }),
      { ...valid(), extra: true },
      symbolOption,
      customOptions,
      { ...valid(), env: null },
      { ...valid(), env: { CLASS_STORE_STORAGE: 1 } },
      envGetter,
      envNonEnumerable,
      { ...valid(), getCentralTenantContext: 'not-a-function' },
      { ...valid(), creators: null },
      { ...valid(), creators: (() => {
        const one = valid().creators;
        return { createPostgresql: one.createPostgresql };
      })() },
      creatorGetter,
      customEnv,
      customCreators,
    ];

    for (const value of malformed) {
      await expect(createConfiguredTaskCompletion(value as never))
        .rejects.toThrow(/invalid configured task completion options/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(invoked).not.toHaveBeenCalled();
  });

  it('keeps explicit Sheets lazy, passes exact Request and legacy hash/projection, and never touches DB getters', async () => {
    const request = new Request('http://localhost/complete');
    const store = { marker: 'sheets' };
    const deps = dependencies({
      createConfiguredSheetsStore: vi.fn(async () => store),
      sheetsListTaskCycleProjections: vi.fn(async () => [{ raw: true }]),
      buildStudentTaskProjection: vi.fn(() => [projectedTask()]),
    });
    deps.completeTaskForStudent.mockImplementation(async (_store: unknown, _task: string, _student: string, operation: { buildSafeProjection(now: string): Promise<unknown> }) => ({
      task: { taskId: 'T001', title: '읽기', reward: 100, secret: 'omit' },
      student: { studentId: 'S001', name: '학생', balance: 150 }, completion: { secret: true },
      tasks: await operation.buildSafeProjection(COMPLETED_AT),
      operation: { operationId: OPERATION_ID, state: 'SUCCESS' },
    }));
    const creators = createTaskCompletionRepositoryCreators(deps as never, request);
    const postgresGetter = vi.fn(() => { throw new Error('unselected PostgreSQL creator invoked'); });
    Object.defineProperty(creators, 'createPostgresql', {
      enumerable: true,
      value: postgresGetter,
    });
    const command = await createConfiguredTaskCompletion({ env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: vi.fn(), creators });
    expect(deps.createConfiguredSheetsStore).not.toHaveBeenCalled();

    await expect(command.execute(INPUT)).resolves.toEqual({
      task: { taskId: 'T001', title: '읽기', reward: 100 },
      student: { studentId: 'S001', name: '학생' }, tasks: [projectedTask()],
      operation: { operationId: OPERATION_ID, state: 'SUCCESS' },
    });
    const expectedHash = `sha256:${createHash('sha256').update(JSON.stringify({ taskId: 'T001', studentId: 'S001' }), 'utf8').digest('hex')}`;
    expect(deps.completeTaskForStudent).toHaveBeenCalledWith(store, 'T001', 'S001', expect.objectContaining({
      requestId: 'request-1', operationId: OPERATION_ID, operationPayloadHash: expectedHash,
    }));
    expect(deps.sheetsListTaskCycleProjections).toHaveBeenCalledWith(store,
      { studentId: 'S001', includeInactive: false, now: COMPLETED_AT });
    expect(postgresGetter).not.toHaveBeenCalled();
  });

  it('fails closed on malformed or crossed Sheets result and projection', async () => {
    for (const result of [
      { task: { taskId: 'OTHER', title: '읽기', reward: 100 }, student: { studentId: 'S001', name: '학생' }, completion: {}, tasks: [projectedTask()], operation: { operationId: OPERATION_ID, state: 'SUCCESS' } },
      { task: { taskId: 'T001', title: '읽기', reward: 100 }, student: { studentId: 'S001', name: '학생' }, completion: {}, tasks: [{ ...projectedTask(), studentStatus: { studentId: 'OTHER', assigned: true, completed: true } }], operation: { operationId: OPERATION_ID, state: 'SUCCESS' } },
    ]) {
      const deps = dependencies({ completeTaskForStudent: vi.fn(async () => result) });
      const { command } = await configured('sheets', deps);
      await expect(command.execute(INPUT)).rejects.toThrow(/integrity/i);
    }
  });

  it('binds PostgreSQL tenant seams, keeps provider I/O lazy, and resolves claims in a tenant snapshot', async () => {
    const deps = dependencies();
    const sheetsGetter = vi.fn(() => { throw new Error('unselected Sheets creator invoked'); });
    const creators = createTaskCompletionRepositoryCreators(deps as never);
    Object.defineProperty(creators, 'createSheets', {
      enumerable: true,
      value: sheetsGetter,
    });
    const command = await createConfiguredTaskCompletion({ env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext: () => ({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' }), creators });
    expect(deps.fetchPadletBoardPosts).not.toHaveBeenCalled();
    await command.execute(INPUT);
    const commandDeps = (deps.createDatabaseTaskCompletionCommand.mock.calls as unknown as Array<[
      { resolvePadletEvidence(input: unknown): Promise<unknown> },
    ]>)[0]?.[0];
    expect(commandDeps).toBeDefined();
    if (!commandDeps) throw new Error('missing configured command dependencies');
    await commandDeps.resolvePadletEvidence({ boardId: 'BOARD123456789012', studentName: '학생', cycleStartsAt: COMPLETED_AT, cycleEndsAt: null, now: COMPLETED_AT });
    expect(deps.fetchPadletBoardPosts).toHaveBeenCalledWith({ boardId: 'BOARD123456789012' });
    expect(deps.withTenantSnapshot).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
    expect(deps.claims.findClaimedPostIds).toHaveBeenCalledWith({ marker: 'snapshot' }, 'BOARD123456789012', ['post-1']);
    expect(sheetsGetter).not.toHaveBeenCalled();
    expect(deps.command.execute).toHaveBeenCalledWith({ operationId: OPERATION_ID, taskId: 'T001', studentId: 'S001' });
  });

  it.each([
    ['extra key', { extra: true }],
    ['wrong operation', { operationId: '22222222-2222-4222-8222-222222222222' }],
    ['crossed task', { taskId: 'OTHER' }],
    ['arithmetic', { balanceAfter: 151 }],
    ['timestamp', { completedAt: '2026-09-01T00:00:00Z' }],
    ['transaction id', { transactionId: 'forged' }],
    ['completion id', { completionId: 'forged' }],
    ['blank physical id', { taskInstanceId: ' ' }],
    ['unsafe reward', { reward: Number.MAX_SAFE_INTEGER + 1 }],
    ['bad evidence', { evidence: { evidenceProvider: 'PADLET', evidenceBoardId: 'BOARD123456789012', evidencePostId: 'bad post', evidenceCreatedAt: COMPLETED_AT, evidenceAuthorFullName: '학생' } }],
  ])('rejects malformed PostgreSQL result: %s', async (_label, patch) => {
    const deps = dependencies();
    deps.command.execute.mockResolvedValue(rawDatabaseResult(patch));
    const { command } = await configured('postgresql', deps);
    await expect(command.execute(INPUT)).rejects.toThrow(/integrity/i);
  });

  it('rejects getter/custom-prototype raw results without invoking coercion hooks', async () => {
    const hooks = vi.fn();
    const getter = rawDatabaseResult();
    Object.defineProperty(getter, 'taskId', { enumerable: true, get: hooks });
    const custom = Object.assign(Object.create({ inherited: true }), rawDatabaseResult());
    for (const raw of [getter, custom, rawDatabaseResult({ reward: { valueOf: hooks } })]) {
      const deps = dependencies();
      deps.command.execute.mockResolvedValue(raw);
      const { command } = await configured('postgresql', deps);
      await expect(command.execute(INPUT)).rejects.toThrow(/integrity/i);
    }
    expect(hooks).not.toHaveBeenCalled();
  });

  it('returns a detached allowlisted task projection with detached nested values', async () => {
    const source = {
      taskId: 'T001', title: '읽기', description: '책', reward: 100, sortOrder: 1,
      availableFrom: '2026-08-31T00:00:00.000Z', dueAt: '2026-09-30T00:00:00.000Z',
      recurrence: { type: 'WEEKLY' as const, weekdays: [1, 3], time: '09:30' },
      prerequisiteTaskId: 'T000', prerequisiteTitle: '준비',
      prerequisiteStatus: 'SATISFIED' as const, prerequisiteMessage: '완료됨',
      studentStatus: { studentId: 'S001', assigned: true, completed: true },
    };
    const deps = dependencies({ buildStudentTaskProjection: vi.fn(() => [source]) });
    const { command } = await configured('postgresql', deps);

    const result = await command.execute(INPUT);
    source.title = 'dependency mutation';
    source.studentStatus.assigned = false;
    source.recurrence.weekdays[0] = 7;
    source.recurrence.time = '22:00';

    expect(result.tasks).toEqual([{
      taskId: 'T001', title: '읽기', description: '책', reward: 100, sortOrder: 1,
      availableFrom: '2026-08-31T00:00:00.000Z', dueAt: '2026-09-30T00:00:00.000Z',
      recurrence: { type: 'WEEKLY', weekdays: [1, 3], time: '09:30' },
      prerequisiteTaskId: 'T000', prerequisiteTitle: '준비',
      prerequisiteStatus: 'SATISFIED', prerequisiteMessage: '완료됨',
      studentStatus: { studentId: 'S001', assigned: true, completed: true },
    }]);

    result.tasks[0].studentStatus.assigned = true;
    const recurrence = result.tasks[0].recurrence;
    if (recurrence?.type !== 'WEEKLY') throw new Error('expected weekly recurrence');
    (recurrence.weekdays as unknown as number[]).push(5);
    expect(source.studentStatus.assigned).toBe(false);
    expect(source.recurrence.weekdays).toEqual([7, 3]);
  });

  it.each([
    ['daily lower time boundary', { type: 'DAILY', time: '00:00' }, true],
    ['daily upper time boundary', { type: 'DAILY', time: '23:59' }, true],
    ['daily empty time', { type: 'DAILY', time: '' }, false],
    ['daily unpadded time', { type: 'DAILY', time: '9:00' }, false],
    ['daily out-of-range hour', { type: 'DAILY', time: '24:00' }, false],
    ['weekly ISO day boundaries', { type: 'WEEKLY', weekdays: [1, 7], time: '00:00' }, true],
    ['weekly empty days', { type: 'WEEKLY', weekdays: [], time: '09:00' }, false],
    ['weekly duplicate days', { type: 'WEEKLY', weekdays: [1, 1], time: '09:00' }, false],
    ['weekly zero day', { type: 'WEEKLY', weekdays: [0, 6], time: '09:00' }, false],
    ['weekly fractional day', { type: 'WEEKLY', weekdays: [1.5], time: '09:00' }, false],
    ['weekly string day', { type: 'WEEKLY', weekdays: ['1'], time: '09:00' }, false],
    ['weekly bad time', { type: 'WEEKLY', weekdays: [1], time: '09:60' }, false],
    ['monthly lower day boundary', { type: 'MONTHLY', dayOfMonth: 1, time: '00:00' }, true],
    ['monthly upper day boundary', { type: 'MONTHLY', dayOfMonth: 31, time: '23:59' }, true],
    ['monthly zero day', { type: 'MONTHLY', dayOfMonth: 0, time: '09:00' }, false],
    ['monthly out-of-range day', { type: 'MONTHLY', dayOfMonth: 32, time: '09:00' }, false],
    ['monthly fractional day', { type: 'MONTHLY', dayOfMonth: 1.5, time: '09:00' }, false],
    ['monthly string day', { type: 'MONTHLY', dayOfMonth: '1', time: '09:00' }, false],
    ['monthly bad time', { type: 'MONTHLY', dayOfMonth: 1, time: 'noon' }, false],
  ])('strictly validates recurrence: %s', async (_label, recurrence, shouldPass) => {
    const deps = dependencies({
      buildStudentTaskProjection: vi.fn(() => [{ ...projectedTask(), recurrence }]),
    });
    const { command } = await configured('postgresql', deps);
    const result = command.execute(INPUT);
    if (shouldPass) {
      await expect(result).resolves.toMatchObject({ tasks: [expect.objectContaining({ recurrence })] });
    } else {
      await expect(result).rejects.toThrow(/integrity/i);
    }
  });

  it('rejects a crossed non-target projection even when the completed target is correct', async () => {
    const deps = dependencies({
      buildStudentTaskProjection: vi.fn(() => [
        projectedTask(),
        {
          taskId: 'T002', title: '쓰기', description: '글', reward: 50, sortOrder: 2,
          studentStatus: { studentId: 'S999', assigned: true, completed: false },
        },
      ]),
    });
    const { command } = await configured('postgresql', deps);

    await expect(command.execute(INPUT)).rejects.toThrow(/integrity/i);
  });

  it('uses one post-commit snapshot projection, requires exactly one completed target, and safely replays after projection failure', async () => {
    const list = vi.fn()
      .mockRejectedValueOnce(new Error('projection unavailable'))
      .mockResolvedValueOnce([projectedTask()]);
    const deps = dependencies({ createDatabaseTaskCycleQueries: vi.fn(() => ({ listTaskCycleProjections: list })) });
    const { command } = await configured('postgresql', deps);
    await expect(command.execute(INPUT)).rejects.toThrow('projection unavailable');
    await expect(command.execute(INPUT)).resolves.toEqual({
      task: { taskId: 'T001', title: '읽기', reward: 100 },
      student: { studentId: 'S001', name: '학생' }, tasks: [projectedTask()],
      operation: { operationId: OPERATION_ID, state: 'SUCCESS' },
    });
    expect(deps.command.execute).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith({ studentId: 'S001', includeInactive: false, now: COMPLETED_AT });
  });
});
