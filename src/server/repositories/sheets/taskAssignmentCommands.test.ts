import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassTask } from '@/domain/types';
import type { OperationalSheetName } from '@/server/storage/tabularStore';
import { TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS, TASK_SCHEMA_HEADERS } from './recurringSchemaMigrator';
import { mutateTaskAssignment, updateTaskAssignmentsBatch } from './taskAssignmentCommands';
import { readTaskCycleState } from './taskCycleQueries';

const NOW = '2026-08-25T12:00:00.000Z';
const task: ClassTask = {
  taskId: 'T1', taskInstanceId: 'I1', title: 'Read', description: '', reward: 5, isActive: true,
  sortOrder: 1, allowedStudentIds: [], createdAt: '2026-08-20T00:00:00.000Z',
  schedule: { ruleVersion: 1, effectiveFrom: '2026-08-20T00:00:00.000Z', timeZone: 'UTC', recurrence: { type: 'DAILY', time: '00:00' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false },
};

class MemoryStore {
  rows: Record<string, string[][]>;
  appendRow = vi.fn(async (sheet: string, values: string[]) => { this.rows[sheet].push([...values]); });
  updateCell = vi.fn(async (sheet: string, row: number, column: string, value: string | number) => {
    const index = this.rows[sheet][0].indexOf(column);
    this.rows[sheet][row - 1][index] = String(value);
  });
  updateCells = vi.fn();
  updateHeaderRow = vi.fn();
  deleteRow = vi.fn();
  deleteRows = vi.fn();
  lookupSheet = vi.fn(async (name: OperationalSheetName) => ({ found: true as const, info: { sheetId: name === 'Tasks' ? 1 : name === 'TaskCompletions' ? 2 : 3, title: name, columnCount: this.rows[name][0].length } }));
  createSheetWithHeader = vi.fn();
  ensureColumnCount = vi.fn();
  writeHeaderCells = vi.fn();
  verifyHeaderCells = vi.fn();
  verifyAndWriteHeaderCells = vi.fn();

  constructor(options: { allowed?: string[]; assignments?: string[][] } = {}) {
    const allowed = options.allowed ?? [];
    const values: Record<string, string> = {
      taskId: 'T1', title: 'Read', description: '', reward: '5', isActive: 'TRUE', sortOrder: '1',
      createdAt: task.createdAt!, updatedAt: '', allowedStudentIds: allowed.join(','), taskInstanceId: 'I1',
      ruleVersion: '1', scheduleEffectiveFrom: task.schedule!.effectiveFrom, recurrenceTimeZone: 'UTC', recurrenceType: 'DAILY',
      recurrenceTime: '00:00', recurrenceWeekday: '', recurrenceDayOfMonth: '', resetCompletionOnCycle: 'FALSE',
      resetAssignmentOnCycle: 'FALSE', pendingRuleVersion: '', pendingEffectiveFrom: '', pendingTimeZone: '',
      pendingRecurrenceType: '', pendingRecurrenceTime: '', pendingRecurrenceWeekday: '', pendingRecurrenceDayOfMonth: '',
      pendingResetCompletionOnCycle: '', pendingResetAssignmentOnCycle: '',
    };
    this.rows = {
      Students: [['studentId', 'name', 'balance', 'qrValue', 'status', 'note'], ['S1', 'Student 1', '0', 'S1', 'ACTIVE', ''], ['S2', 'Student 2', '0', 'S2', 'ACTIVE', '']],
      Tasks: [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '')],
      TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS]],
      TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS], ...(options.assignments ?? [])],
    };
  }
  getRows = vi.fn(async (sheet: string) => this.rows[sheet].map((row) => [...row]));
  getRowsFresh = vi.fn(async (sheet: string) => this.rows[sheet].map((row) => [...row]));
}

function assignmentRow(overrides: Partial<Record<(typeof TASK_ASSIGNMENT_HEADERS)[number], string>> = {}): string[] {
  const values: Record<string, string> = {
    assignmentId: 'A-prior', taskId: 'T1', taskInstanceId: 'I1', cycleId: 'prior',
    cycleStartsAt: '2026-08-24T00:00:00.000Z', cycleEndsAt: '2026-08-25T00:00:00.000Z', ruleVersion: '1',
    timeZone: 'UTC', studentId: 'S1', status: 'ASSIGNED', source: 'ADMIN', previousAssignmentId: '',
    createdAt: '2026-08-24T01:00:00.000Z', schemaVersion: '2', note: '', ...overrides,
  };
  return TASK_ASSIGNMENT_HEADERS.map((header) => values[header] ?? '');
}

function completionRow(overrides: Partial<Record<(typeof TASK_COMPLETION_SCHEMA_HEADERS)[number], string>> = {}): string[] {
  const values: Record<string, string> = {
    completionId: 'TC-current', timestamp: NOW, taskId: 'T1', studentId: 'S1', studentName: 'Student 1',
    reward: '0', balanceBefore: '0', balanceAfter: '0', status: 'SUCCESS', note: 'admin-completion',
    taskInstanceId: 'I1', cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z',
    cycleStartsAt: '2026-08-25T00:00:00.000Z', cycleEndsAt: '2026-08-26T00:00:00.000Z',
    ruleVersion: '1', timeZone: 'UTC', source: 'ADMIN', assignmentId: 'A-current', schemaVersion: '2',
    ...overrides,
  };
  return TASK_COMPLETION_SCHEMA_HEADERS.map((header) => values[header] ?? '');
}

describe('assignment ledger mutation command', () => {
  afterEach(() => vi.restoreAllMocks());

  it('treats a per-student desired-state retry as a no-op', async () => {
    const current = assignmentRow({ assignmentId: 'A-current', cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z', cycleStartsAt: '2026-08-25T00:00:00.000Z', cycleEndsAt: '2026-08-26T00:00:00.000Z' });
    const store = new MemoryStore({ assignments: [current] });
    const result = await mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW });
    expect(result.changed).toBe(false);
    expect(result.assignment!.assignmentId).toBe('A-current');
    expect(store.appendRow).not.toHaveBeenCalled();
  });

  it('seeds legacy allowedStudentIds once before applying the first mutation', async () => {
    const store = new MemoryStore({ allowed: ['S1'] });
    const first = await mutateTaskAssignment(store, { task: { ...task, allowedStudentIds: ['S1'] }, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW });
    const second = await mutateTaskAssignment(store, { task: { ...task, allowedStudentIds: ['S1'] }, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW });
    expect(first.changed).toBe(false);
    expect(first.assignment!.source).toBe('LEGACY_SEED');
    expect(second.assignment!.assignmentId).toBe(first.assignment!.assignmentId);
    expect(store.rows.TaskAssignments).toHaveLength(2);
  });

  it('uses collision-safe deterministic IDs for punctuation-distinct legacy students', async () => {
    const legacyTask = { ...task, allowedStudentIds: ['S/1', 'S@1'] };
    const store = new MemoryStore({ allowed: legacyTask.allowedStudentIds });

    await mutateTaskAssignment(store, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S/1', assigned: true, source: 'ADMIN', now: NOW,
    });

    const seedIds = store.rows.TaskAssignments.slice(1).map(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('assignmentId')],
    );
    expect(seedIds).toHaveLength(2);
    expect(new Set(seedIds).size).toBe(2);
  });

  it('uses collision-safe deterministic IDs for punctuation-distinct carry students', async () => {
    const store = new MemoryStore({ assignments: [
      assignmentRow({ assignmentId: 'A-prior-slash', studentId: 'S/1' }),
      assignmentRow({ assignmentId: 'A-prior-at', studentId: 'S@1' }),
    ] });

    await mutateTaskAssignment(store, {
      task, taskRowNumber: 2, studentId: 'S/1', assigned: true, source: 'ADMIN', now: NOW,
    });

    const carryIds = store.rows.TaskAssignments.slice(1)
      .filter((row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'CARRY_FORWARD')
      .map((row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('assignmentId')]);
    expect(carryIds).toHaveLength(2);
    expect(new Set(carryIds).size).toBe(2);
  });

  it('bounds TaskAssignments reads for a command that appends multiple seeds', async () => {
    const legacyTask = { ...task, allowedStudentIds: ['S1', 'S2', 'S3'] };
    const store = new MemoryStore({ allowed: legacyTask.allowedStudentIds });

    await mutateTaskAssignment(store, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S4', assigned: false, source: 'ADMIN', now: NOW,
    });

    const assignmentReads = store.getRows.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments');
    // Migration verification + one command snapshot stay constant; the mirror uses one forced fresh read
    // regardless of how many legacy students are materialized.
    expect(assignmentReads).toHaveLength(3);
    expect(store.getRowsFresh.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments')).toHaveLength(1);
  });

  it('retries each deterministic legacy seed after a partial seed append failure', async () => {
    const legacyTask = { ...task, allowedStudentIds: ['S1', 'S2'] };
    const store = new MemoryStore({ allowed: legacyTask.allowedStudentIds });
    store.appendRow
      .mockImplementationOnce(async (sheet: string, values: string[]) => { store.rows[sheet].push([...values]); })
      .mockRejectedValueOnce(new Error('second seed failed'));

    await expect(mutateTaskAssignment(store, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S3', assigned: false, source: 'ADMIN', now: NOW,
    })).rejects.toThrow('second seed failed');
    await mutateTaskAssignment(store, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S3', assigned: false, source: 'ADMIN', now: NOW,
    });

    const seedStudentIds = store.rows.TaskAssignments.slice(1)
      .filter((row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'LEGACY_SEED')
      .map((row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('studentId')]);
    expect(seedStudentIds).toEqual(['S1', 'S2']);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S1,S2');
  });

  it('carries a legacy seed from a prior natural cycle instead of seeding legacy again', async () => {
    const priorSeed = assignmentRow({
      assignmentId: 'A-prior-seed',
      source: 'LEGACY_SEED',
    });
    const store = new MemoryStore({ allowed: ['S1'], assignments: [priorSeed] });
    const legacyTask = { ...task, allowedStudentIds: ['S1'] };

    const result = await mutateTaskAssignment(store, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW,
    });

    expect(result.changed).toBe(false);
    expect(result.assignment).toMatchObject({
      source: 'CARRY_FORWARD',
      previousAssignmentId: 'A-prior-seed',
    });
    expect(store.rows.TaskAssignments.slice(1).filter(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'LEGACY_SEED',
    )).toHaveLength(1);
  });

  it('carries a previous-version legacy seed across an immediate reset=true schedule transition', async () => {
    const priorSeed = assignmentRow({
      assignmentId: 'A-v1-seed',
      source: 'LEGACY_SEED',
      cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z',
      cycleStartsAt: '2026-08-25T00:00:00.000Z',
      cycleEndsAt: '2026-08-26T00:00:00.000Z',
    });
    const store = new MemoryStore({ allowed: ['S1'], assignments: [priorSeed] });
    const changingTask: ClassTask = {
      ...task,
      allowedStudentIds: ['S1'],
      schedule: { ...task.schedule!, resetAssignmentOnCycle: true },
      pendingSchedule: {
        ruleVersion: 2, effectiveFrom: NOW, timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '21:00' }, resetAssignmentOnCycle: true, resetCompletionOnCycle: true,
      },
    };

    const result = await mutateTaskAssignment(store, {
      task: changingTask, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW,
    });

    expect(result.changed).toBe(false);
    expect(result.assignment).toMatchObject({
      source: 'CARRY_FORWARD',
      ruleVersion: 2,
      previousAssignmentId: 'A-v1-seed',
    });
    expect(store.rows.TaskAssignments.slice(1).filter(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'LEGACY_SEED',
    )).toHaveLength(1);
  });

  it('does not restore legacy-only assignments at a reset=true natural boundary', async () => {
    const resetTask = {
      ...task,
      allowedStudentIds: ['S1'],
      schedule: { ...task.schedule!, resetAssignmentOnCycle: true },
    };
    const store = new MemoryStore({ allowed: ['S1'] });

    const result = await mutateTaskAssignment(store, {
      task: resetTask, taskRowNumber: 2, studentId: 'S2', assigned: false, source: 'ADMIN', now: NOW,
    });

    expect(result).toMatchObject({ changed: false, assignment: null, assignedStudentIds: [] });
    expect(store.rows.TaskAssignments).toHaveLength(1);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('');
  });

  it('materializes natural carry when reset=false, while reset=true starts empty', async () => {
    const carryStore = new MemoryStore({ assignments: [assignmentRow()] });
    const carried = await mutateTaskAssignment(carryStore, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'QR', now: NOW });
    expect(carried.changed).toBe(false);
    expect(carried.assignment).toMatchObject({ source: 'CARRY_FORWARD', status: 'ASSIGNED', previousAssignmentId: 'A-prior' });

    const resetStore = new MemoryStore({ assignments: [assignmentRow()] });
    const resetTask = { ...task, schedule: { ...task.schedule!, resetAssignmentOnCycle: true } };
    const reset = await mutateTaskAssignment(resetStore, { task: resetTask, taskRowNumber: 2, studentId: 'S1', assigned: false, source: 'ADMIN', now: NOW });
    expect(reset.changed).toBe(false);
    expect(resetStore.appendRow).not.toHaveBeenCalled();
  });

  it('carries the previous rule into an immediate schedule-transition first cycle despite reset=true', async () => {
    const prior = assignmentRow({
      cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z',
      cycleStartsAt: '2026-08-25T00:00:00.000Z',
      cycleEndsAt: '2026-08-26T00:00:00.000Z',
    });
    const store = new MemoryStore({ assignments: [prior] });
    const changingTask: ClassTask = {
      ...task,
      schedule: { ...task.schedule!, resetAssignmentOnCycle: true },
      pendingSchedule: {
        ruleVersion: 2, effectiveFrom: NOW, timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '21:00' }, resetAssignmentOnCycle: true, resetCompletionOnCycle: true,
      },
    };
    const result = await mutateTaskAssignment(store, { task: changingTask, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW });
    expect(result.changed).toBe(false);
    expect(result.assignment).toMatchObject({ source: 'CARRY_FORWARD', ruleVersion: 2, timeZone: 'Asia/Seoul', previousAssignmentId: 'A-prior' });
  });

  it('records QR as a canonical mutation source', async () => {
    const store = new MemoryStore();
    const result = await mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'QR', now: NOW });
    expect(result.assignment).toMatchObject({ source: 'QR', status: 'ASSIGNED' });
  });

  it('re-reads canonical physical order immediately before updating the legacy mirror', async () => {
    const store = new MemoryStore();
    const concurrentlyObserved = assignmentRow({
      assignmentId: 'A-observed',
      studentId: 'S2',
      cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z',
      cycleStartsAt: '2026-08-25T00:00:00.000Z',
      cycleEndsAt: '2026-08-26T00:00:00.000Z',
    });
    store.appendRow.mockImplementationOnce(async (sheet: string, values: string[]) => {
      store.rows[sheet].push([...values], concurrentlyObserved);
    });

    const result = await mutateTaskAssignment(store, {
      task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW,
    });

    expect(result.assignedStudentIds).toEqual(['S1', 'S2']);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S1,S2');
  });

  it('does not touch the legacy mirror when canonical append fails', async () => {
    const store = new MemoryStore();
    store.appendRow.mockRejectedValueOnce(new Error('canonical failed'));
    await expect(mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW })).rejects.toThrow('canonical failed');
    expect(store.updateCell).not.toHaveBeenCalled();
  });

  it('returns canonical success plus an additive warning when the mirror fails', async () => {
    const store = new MemoryStore();
    store.updateCell.mockRejectedValueOnce(new Error('mirror failed'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW });
    expect(result).toMatchObject({ changed: true, assignment: { studentId: 'S1', status: 'ASSIGNED', source: 'ADMIN' }, legacyMirrorWarning: 'LEGACY_MIRROR_UPDATE_FAILED' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mirror failed'));
  });

  it('reconciles a failed compatibility mirror on the next mutation', async () => {
    const store = new MemoryStore();
    store.updateCell.mockRejectedValueOnce(new Error('mirror failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW });
    const result = await mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S2', assigned: true, source: 'ADMIN', now: NOW });
    expect(result.legacyMirrorWarning).toBeUndefined();
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S1,S2');
    vi.restoreAllMocks();
  });

  it('serializes concurrent first mutations so a late legacy seed cannot overwrite desired state', async () => {
    const legacyTask = { ...task, allowedStudentIds: ['S0'] };
    const store = new MemoryStore({ allowed: ['S0'] });
    let seedAttempt = 0;
    store.appendRow.mockImplementation(async (sheet: string, values: string[]) => {
      const source = values[TASK_ASSIGNMENT_HEADERS.indexOf('source')];
      if (source === 'LEGACY_SEED' && seedAttempt++ === 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      store.rows[sheet].push([...values]);
    });

    await Promise.all([
      mutateTaskAssignment(store, {
        task: legacyTask, taskRowNumber: 2, studentId: 'S0', assigned: false, source: 'ADMIN', now: NOW,
      }),
      mutateTaskAssignment(store, {
        task: legacyTask, taskRowNumber: 2, studentId: 'S2', assigned: true, source: 'ADMIN', now: NOW,
      }),
    ]);

    const finalState = await readTaskCycleState(store, legacyTask, NOW);
    expect(finalState.assignedStudentIds).toEqual(['S2']);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S2');
    expect(store.rows.TaskAssignments.slice(1).filter(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'LEGACY_SEED',
    )).toHaveLength(1);
  });

  it('serializes distinct store wrappers sharing one backing ledger and cleans the queue after success', async () => {
    const legacyTask = { ...task, allowedStudentIds: ['S0'] };
    const firstStore = new MemoryStore({ allowed: ['S0'] });
    const secondStore = new MemoryStore();
    secondStore.rows = firstStore.rows;
    let releaseSeed!: () => void;
    const seedGate = new Promise<void>((resolve) => { releaseSeed = resolve; });
    let seedStarted!: () => void;
    const seedStartedPromise = new Promise<void>((resolve) => { seedStarted = resolve; });
    firstStore.appendRow.mockImplementationOnce(async (sheet: string, values: string[]) => {
      seedStarted();
      await seedGate;
      firstStore.rows[sheet].push([...values]);
    });

    const unassign = mutateTaskAssignment(firstStore, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S0', assigned: false, source: 'ADMIN', now: NOW,
    });
    await seedStartedPromise;
    const assign = mutateTaskAssignment(secondStore, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S2', assigned: true, source: 'ADMIN', now: NOW,
    });
    await Promise.resolve();
    releaseSeed();
    await Promise.all([unassign, assign]);

    const finalState = await readTaskCycleState(secondStore, legacyTask, NOW);
    expect(finalState.assignedStudentIds).toEqual(['S2']);
    expect(firstStore.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S2');
    expect(firstStore.rows.TaskAssignments.slice(1).filter(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'LEGACY_SEED',
    )).toHaveLength(1);

    await expect(mutateTaskAssignment(firstStore, {
      task: legacyTask, taskRowNumber: 2, studentId: 'S3', assigned: true, source: 'ADMIN', now: NOW,
    })).resolves.toMatchObject({ changed: true, assignedStudentIds: ['S2', 'S3'] });
  });

  it('preserves different students when two admins mutate without a full-set update', async () => {
    const store = new MemoryStore();
    await Promise.all([
      mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S1', assigned: true, source: 'ADMIN', now: NOW }),
      mutateTaskAssignment(store, { task, taskRowNumber: 2, studentId: 'S2', assigned: true, source: 'ADMIN', now: NOW }),
    ]);
    const statuses = store.rows.TaskAssignments.slice(1).map((row) => [row[8], row[9]]);
    expect(statuses).toEqual(expect.arrayContaining([['S1', 'ASSIGNED'], ['S2', 'ASSIGNED']]));
    const finalState = await readTaskCycleState(store, task, NOW);
    expect(finalState.assignedStudentIds).toEqual(['S1', 'S2']);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S1,S2');
    expect(store.deleteRow).not.toHaveBeenCalled();
    expect(store.deleteRows).not.toHaveBeenCalled();
  });
});

describe('batch explicit assignment command', () => {
  const operation = { studentId: 'S1', assigned: true, source: 'ADMIN' as const };
  const target = { taskId: 'T1', operations: [operation] };

  it('rejects bounded, exact, duplicate, and conflicting grouped targets before reads or writes', async () => {
    const invalidTargets = [
      [],
      [target, target],
      [{ ...target, taskId: 'T1 ' }],
      Array.from({ length: 21 }, (_, index) => ({ taskId: `T${index}`, operations: [operation] })),
      [{ taskId: 'T1', operations: [] }],
      [{ taskId: 'T1', operations: Array.from({ length: 41 }, (_, index) => ({ studentId: `S${index}`, assigned: true, source: 'ADMIN' as const })) }],
      [{ taskId: 'T1', operations: [operation, { ...operation, assigned: false }] }],
      [40, 40, 21].map((count, taskIndex) => ({ taskId: `T${taskIndex}`, operations: Array.from({ length: count }, (_, index) => ({ studentId: `S${index}`, assigned: true, source: 'ADMIN' as const })) })),
    ];
    for (const targets of invalidTargets) {
      const store = new MemoryStore();
      await expect(updateTaskAssignmentsBatch(store, targets, { now: () => NOW })).rejects.toThrow();
      expect(store.getRows).not.toHaveBeenCalled();
      expect(store.appendRow).not.toHaveBeenCalled();
      expect(store.updateCell).not.toHaveBeenCalled();
    }
  });

  it('validates all exact tasks and active students before business writes', async () => {
    const store = new MemoryStore();
    await expect(updateTaskAssignmentsBatch(store, [target, { ...target, taskId: 'NOPE' }], { now: () => NOW }))
      .rejects.toThrow(/NOPE/);
    expect(store.appendRow).not.toHaveBeenCalled();
    expect(store.updateCell).not.toHaveBeenCalled();

    const missingStudent = new MemoryStore();
    await expect(updateTaskAssignmentsBatch(missingStudent, [{ taskId: 'T1', operations: [{ ...operation, studentId: 'NOPE' }] }], { now: () => NOW }))
      .rejects.toThrow(/NOPE|학생/);
    expect(missingStudent.appendRow).not.toHaveBeenCalled();
  });

  it('migrates once before shared snapshots and creates no events for explicit no-ops', async () => {
    const current = assignmentRow({ assignmentId: 'A-current', cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z', cycleStartsAt: '2026-08-25T00:00:00.000Z', cycleEndsAt: '2026-08-26T00:00:00.000Z' });
    const store = new MemoryStore({ assignments: [current] });
    const result = await updateTaskAssignmentsBatch(store, [{ taskId: 'T1', operations: [{
      studentId: 'S1', assigned: true, completed: false, source: 'ADMIN',
    }] }], { now: () => NOW });
    expect(result).toEqual({ appliedCount: 0, failures: [] });
    expect(store.appendRow).not.toHaveBeenCalled();
    expect(store.updateCell).not.toHaveBeenCalled();
    expect(store.lookupSheet.mock.calls.filter(([sheet]) => sheet === 'Tasks')).toHaveLength(1);
    expect(store.getRows.mock.calls.filter(([sheet]) => sheet === 'Students')).toHaveLength(1);
  });

  it('fails migration before any business mutation', async () => {
    const store = new MemoryStore();
    store.lookupSheet.mockRejectedValueOnce(new Error('migration failed private A1:Z99'));
    await expect(updateTaskAssignmentsBatch(store, [target], { now: () => NOW })).rejects.toThrow(/migration/);
    expect(store.appendRow).not.toHaveBeenCalled();
    expect(store.updateCell).not.toHaveBeenCalled();
  });

  it('uses one shared mutable snapshot for a mutating multi-task multi-student batch', async () => {
    const store = new MemoryStore();
    const t2 = store.rows.Tasks[1].map((value) => value);
    t2[TASK_SCHEMA_HEADERS.indexOf('taskId')] = 'T2';
    t2[TASK_SCHEMA_HEADERS.indexOf('taskInstanceId')] = 'I2';
    store.rows.Tasks.push(t2);

    const result = await updateTaskAssignmentsBatch(store, [
      { taskId: 'T1', operations: [
        { studentId: 'S1', assigned: true, completed: true, source: 'ADMIN' },
        { studentId: 'S2', assigned: true, source: 'ADMIN' },
      ] },
      { taskId: 'T2', operations: [
        { studentId: 'S1', assigned: true, source: 'ADMIN' },
        { studentId: 'S2', assigned: true, completed: true, source: 'ADMIN' },
      ] },
    ], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 4, failures: [] });
    expect(store.rows.TaskAssignments.slice(1)).toHaveLength(4);
    expect(store.rows.TaskCompletions.slice(1)).toHaveLength(2);
    // Migration verification contributes one Tasks read, two assignment reads, and one completion read.
    // The batch itself adds one shared snapshot per sheet plus one final assignment reread for mirrors.
    expect(store.getRows.mock.calls.filter(([sheet]) => sheet === 'Tasks')).toHaveLength(2);
    expect(store.getRows.mock.calls.filter(([sheet]) => sheet === 'Students')).toHaveLength(1);
    expect(store.getRows.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments')).toHaveLength(3);
    expect(store.getRowsFresh.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments')).toHaveLength(1);
    expect(store.getRows.mock.calls.filter(([sheet]) => sheet === 'TaskCompletions')).toHaveLength(2);
    expect(store.lookupSheet.mock.calls.filter(([sheet]) => sheet === 'Tasks')).toHaveLength(1);
    expect(store.lookupSheet.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments')).toHaveLength(1);
    expect(store.lookupSheet.mock.calls.filter(([sheet]) => sheet === 'TaskCompletions')).toHaveLength(1);
  });

  it('applies sparse per-task operations with zero reward, balance, or transaction writes', async () => {
    const store = new MemoryStore();
    const t2 = store.rows.Tasks[1].map((value) => value);
    t2[TASK_SCHEMA_HEADERS.indexOf('taskId')] = 'T2';
    t2[TASK_SCHEMA_HEADERS.indexOf('taskInstanceId')] = 'I2';
    store.rows.Tasks.push(t2);
    const result = await updateTaskAssignmentsBatch(store, [
      { taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, completed: true, source: 'ADMIN' }] },
      { taskId: 'T2', operations: [{ studentId: 'S2', assigned: true, source: 'ADMIN' }] },
    ], { now: () => NOW });
    expect(result).toEqual({ appliedCount: 2, failures: [] });
    expect(store.rows.TaskAssignments.slice(1)).toHaveLength(2);
    expect(store.rows.TaskCompletions.slice(1)).toHaveLength(1);
    const completion = store.rows.TaskCompletions[1];
    expect(completion[TASK_COMPLETION_SCHEMA_HEADERS.indexOf('source')]).toBe('ADMIN');
    expect(completion[TASK_COMPLETION_SCHEMA_HEADERS.indexOf('reward')]).toBe('0');
    expect(store.updateCell.mock.calls.some(([sheet, , column]) => sheet === 'Students' && column === 'balance')).toBe(false);
    expect(store.appendRow.mock.calls.some(([sheet]) => sheet === 'Transactions')).toBe(false);
    expect(store.lookupSheet.mock.calls.filter(([sheet]) => sheet === 'Tasks')).toHaveLength(1);
  });

  it('preserves legacy seeding before a shared-snapshot mutation', async () => {
    const store = new MemoryStore({ allowed: ['S1'] });

    const result = await updateTaskAssignmentsBatch(store, [{
      taskId: 'T1', operations: [{ studentId: 'S2', assigned: true, source: 'ADMIN' }],
    }], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 1, failures: [] });
    const events = store.rows.TaskAssignments.slice(1).map((row) => Object.fromEntries(
      TASK_ASSIGNMENT_HEADERS.map((header, index) => [header, row[index]]),
    ));
    expect(events).toMatchObject([
      { studentId: 'S1', source: 'LEGACY_SEED', status: 'ASSIGNED' },
      { studentId: 'S2', source: 'ADMIN', status: 'ASSIGNED' },
    ]);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S1,S2');
  });

  it('reconciles a committed deterministic legacy seed after append response loss without duplicating it on retry', async () => {
    const store = new MemoryStore({ allowed: ['S1'] });
    store.appendRow.mockImplementationOnce(async (sheet: string, values: string[]) => {
      store.rows[sheet].push([...values]);
      throw new Error('response lost after commit');
    });
    const request = [{ taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' as const }] }];

    await expect(updateTaskAssignmentsBatch(store, request, { now: () => NOW }))
      .resolves.toEqual({ appliedCount: 0, failures: [] });
    await expect(updateTaskAssignmentsBatch(store, request, { now: () => NOW }))
      .resolves.toEqual({ appliedCount: 0, failures: [] });

    expect(store.rows.TaskAssignments.slice(1).filter(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'LEGACY_SEED',
    )).toHaveLength(1);
    expect(store.getRowsFresh).toHaveBeenCalledWith('TaskAssignments');
  });

  it('preserves carry-forward semantics while applying a later student mutation from the shared snapshot', async () => {
    const store = new MemoryStore({ assignments: [assignmentRow()] });

    const result = await updateTaskAssignmentsBatch(store, [{
      taskId: 'T1', operations: [{ studentId: 'S2', assigned: true, source: 'ADMIN' }],
    }], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 1, failures: [] });
    const events = store.rows.TaskAssignments.slice(1).map((row) => Object.fromEntries(
      TASK_ASSIGNMENT_HEADERS.map((header, index) => [header, row[index]]),
    ));
    expect(events.slice(-2)).toMatchObject([
      { studentId: 'S1', source: 'CARRY_FORWARD', previousAssignmentId: 'A-prior' },
      { studentId: 'S2', source: 'ADMIN', status: 'ASSIGNED' },
    ]);
    expect(store.rows.Tasks[1][TASK_SCHEMA_HEADERS.indexOf('allowedStudentIds')]).toBe('S1,S2');
  });

  it('reconciles a committed deterministic carry after response loss without duplicating it on retry', async () => {
    const store = new MemoryStore({ assignments: [assignmentRow()] });
    store.appendRow.mockImplementationOnce(async (sheet: string, values: string[]) => {
      store.rows[sheet].push([...values]);
      throw new Error('response lost after carry commit');
    });
    const request = [{ taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' as const }] }];

    await expect(updateTaskAssignmentsBatch(store, request, { now: () => NOW }))
      .resolves.toEqual({ appliedCount: 0, failures: [] });
    await expect(updateTaskAssignmentsBatch(store, request, { now: () => NOW }))
      .resolves.toEqual({ appliedCount: 0, failures: [] });

    expect(store.rows.TaskAssignments.slice(1).filter(
      (row) => row[TASK_ASSIGNMENT_HEADERS.indexOf('source')] === 'CARRY_FORWARD',
    )).toHaveLength(1);
  });

  it('materializes a reaffirmed legacy assignment even when the projected state is already assigned', async () => {
    const store = new MemoryStore({ allowed: ['S1'] });

    const result = await updateTaskAssignmentsBatch(store, [{
      taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' }],
    }], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 0, failures: [] });
    expect(store.rows.TaskAssignments.slice(1)).toHaveLength(1);
    expect(store.rows.TaskAssignments[1][TASK_ASSIGNMENT_HEADERS.indexOf('source')]).toBe('LEGACY_SEED');
  });

  it('materializes a reaffirmed implicit assignment carry without appending an ADMIN duplicate', async () => {
    const store = new MemoryStore({ assignments: [assignmentRow()] });

    const result = await updateTaskAssignmentsBatch(store, [{
      taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' }],
    }], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 0, failures: [] });
    const events = store.rows.TaskAssignments.slice(1).map((row) => ({
      source: row[TASK_ASSIGNMENT_HEADERS.indexOf('source')],
      studentId: row[TASK_ASSIGNMENT_HEADERS.indexOf('studentId')],
    }));
    expect(events).toEqual([
      { source: 'ADMIN', studentId: 'S1' },
      { source: 'CARRY_FORWARD', studentId: 'S1' },
    ]);
  });

  it('materializes reaffirmed implicit assignment and completion carries', async () => {
    const store = new MemoryStore({ assignments: [assignmentRow()] });
    store.rows.TaskCompletions.push(completionRow({
      completionId: 'TC-prior', timestamp: '2026-08-24T02:00:00.000Z', cycleId: 'prior',
      cycleStartsAt: '2026-08-24T00:00:00.000Z', cycleEndsAt: '2026-08-25T00:00:00.000Z',
      assignmentId: 'A-prior',
    }));

    const result = await updateTaskAssignmentsBatch(store, [{
      taskId: 'T1', operations: [{ studentId: 'S1', completed: true, source: 'ADMIN' }],
    }], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 0, failures: [] });
    expect(store.rows.TaskAssignments.at(-1)![TASK_ASSIGNMENT_HEADERS.indexOf('source')]).toBe('CARRY_FORWARD');
    expect(store.rows.TaskCompletions.at(-1)![TASK_COMPLETION_SCHEMA_HEADERS.indexOf('source')]).toBe('CARRY_FORWARD');
  });

  it('resets completion before unassigning and keeps both canonical events', async () => {
    const current = assignmentRow({
      assignmentId: 'A-current', cycleId: 'v1|I1|r1|2026-08-25T00:00:00Z',
      cycleStartsAt: '2026-08-25T00:00:00.000Z', cycleEndsAt: '2026-08-26T00:00:00.000Z',
    });
    const store = new MemoryStore({ assignments: [current] });
    store.rows.TaskCompletions.push(completionRow());
    const appendOrder: string[] = [];
    store.appendRow.mockImplementation(async (sheet: string, values: string[]) => {
      appendOrder.push(sheet);
      store.rows[sheet].push([...values]);
    });

    const result = await updateTaskAssignmentsBatch(store, [{
      taskId: 'T1', operations: [{ studentId: 'S1', assigned: false, completed: false, source: 'ADMIN' }],
    }], { now: () => NOW });

    expect(result).toEqual({ appliedCount: 1, failures: [] });
    expect(appendOrder).toEqual(['TaskCompletions', 'TaskAssignments']);
    expect(store.rows.TaskCompletions.at(-1)![TASK_COMPLETION_SCHEMA_HEADERS.indexOf('source')]).toBe('ADMIN_RESET');
    expect(store.rows.TaskAssignments.at(-1)![TASK_ASSIGNMENT_HEADERS.indexOf('status')]).toBe('UNASSIGNED');
  });

  it('reports mirror failures as sanitized warnings after canonical success and updates each task at most once', async () => {
    const store = new MemoryStore();
    const t2 = store.rows.Tasks[1].map((value) => value);
    t2[TASK_SCHEMA_HEADERS.indexOf('taskId')] = 'T2';
    t2[TASK_SCHEMA_HEADERS.indexOf('taskInstanceId')] = 'I2';
    store.rows.Tasks.push(t2);
    store.updateCell.mockImplementation(async (_sheet: string, row: number) => {
      if (row === 2) throw new Error('provider private A1:Z99');
    });

    const result = await updateTaskAssignmentsBatch(store, [
      { taskId: 'T1', operations: [
        { studentId: 'S1', assigned: true, source: 'ADMIN' },
        { studentId: 'S2', assigned: true, source: 'ADMIN' },
      ] },
      { taskId: 'T2', operations: [{ studentId: 'S1', assigned: true, source: 'ADMIN' }] },
    ], { now: () => NOW });

    expect(result).toEqual({
      appliedCount: 3,
      failures: [],
      warnings: [{ taskId: 'T1', code: 'LEGACY_MIRROR_UPDATE_FAILED' }],
    });
    expect(JSON.stringify(result)).not.toMatch(/provider|A1|Z99/);
    expect(store.getRows.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments')).toHaveLength(3);
    expect(store.getRowsFresh.mock.calls.filter(([sheet]) => sheet === 'TaskAssignments')).toHaveLength(1);
    expect(store.updateCell.mock.calls.filter(([sheet]) => sheet === 'Tasks')).toHaveLength(2);
  });

  it('reports a combined pair failure after its first subwrite and makes the sparse pair exactly retryable', async () => {
    const store = new MemoryStore();
    let failCompletion = true;
    store.appendRow.mockImplementation(async (sheet: string, values: string[]) => {
      if (sheet === 'TaskCompletions' && failCompletion) {
        failCompletion = false;
        throw new Error('provider cells A1:Z999 private');
      }
      store.rows[sheet].push([...values]);
    });
    const retryTarget = { taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, completed: true, source: 'ADMIN' as const }] };

    const first = await updateTaskAssignmentsBatch(store, [retryTarget], { now: () => NOW });
    expect(first).toEqual({
      appliedCount: 0,
      failures: [{ taskId: 'T1', studentId: 'S1', code: 'OPERATION_FAILED' }],
      aborted: true,
      notAttempted: [],
    });
    expect(store.rows.TaskAssignments.slice(1)).toHaveLength(1);
    expect(store.rows.TaskCompletions.slice(1)).toHaveLength(0);
    expect(JSON.stringify(first)).not.toMatch(/provider|A1/);

    const retry = await updateTaskAssignmentsBatch(store, [retryTarget], { now: () => NOW });
    expect(retry).toEqual({ appliedCount: 1, failures: [] });
    expect(store.rows.TaskAssignments.slice(1)).toHaveLength(1);
    expect(store.rows.TaskCompletions.slice(1)).toHaveLength(1);
  });

  it('reconciles a committed completion after response loss and does not append it again on retry', async () => {
    const store = new MemoryStore();
    store.appendRow.mockImplementation(async (sheet: string, values: string[]) => {
      store.rows[sheet].push([...values]);
      if (sheet === 'TaskCompletions') throw new Error('completion response lost');
    });
    const retryTarget = { taskId: 'T1', operations: [{ studentId: 'S1', assigned: true, completed: true, source: 'ADMIN' as const }] };

    await expect(updateTaskAssignmentsBatch(store, [retryTarget], { now: () => NOW }))
      .resolves.toEqual({ appliedCount: 1, failures: [] });
    await expect(updateTaskAssignmentsBatch(store, [retryTarget], { now: () => NOW }))
      .resolves.toEqual({ appliedCount: 0, failures: [] });

    expect(store.rows.TaskCompletions.slice(1)).toHaveLength(1);
    expect(store.getRowsFresh).toHaveBeenCalledWith('TaskCompletions');
  });

  it('circuit-breaks remaining operations after an unreconciled provider append failure', async () => {
    const store = new MemoryStore();
    store.appendRow.mockRejectedValueOnce(new Error('provider unavailable private range'));

    const result = await updateTaskAssignmentsBatch(store, [{ taskId: 'T1', operations: [
      { studentId: 'S1', assigned: true, source: 'ADMIN' },
      { studentId: 'S2', assigned: true, source: 'ADMIN' },
    ] }], { now: () => NOW });

    expect(result).toEqual({
      appliedCount: 0,
      failures: [{ taskId: 'T1', studentId: 'S1', code: 'OPERATION_FAILED' }],
      aborted: true,
      notAttempted: [{ taskId: 'T1', studentId: 'S2' }],
    });
    expect(store.appendRow).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/provider|private|range/);
  });

  it('hard-stops materialization fanout at the canonical append budget', async () => {
    const legacyIds = Array.from({ length: 251 }, (_, index) => `LEGACY-${index}`);
    const store = new MemoryStore({ allowed: legacyIds });

    const result = await updateTaskAssignmentsBatch(store, [{ taskId: 'T1', operations: [
      { studentId: 'S1', assigned: true, source: 'ADMIN' },
    ] }], { now: () => NOW });

    expect(result).toMatchObject({
      appliedCount: 0,
      failures: [{ taskId: 'T1', studentId: 'S1', code: 'OPERATION_FAILED' }],
      aborted: true,
      notAttempted: [],
    });
    expect(store.appendRow).toHaveBeenCalledTimes(250);
  });
});
