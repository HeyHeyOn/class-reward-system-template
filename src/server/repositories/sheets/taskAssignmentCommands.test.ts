import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClassTask } from '@/domain/types';
import type { OperationalSheetName } from '@/server/storage/tabularStore';
import { TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS, TASK_SCHEMA_HEADERS } from './recurringSchemaMigrator';
import { mutateTaskAssignment } from './taskAssignmentCommands';
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
      Tasks: [[...TASK_SCHEMA_HEADERS], TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '')],
      TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS]],
      TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS], ...(options.assignments ?? [])],
    };
  }
  getRows = vi.fn(async (sheet: string) => this.rows[sheet].map((row) => [...row]));
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
    // Migration verification + one command snapshot + one canonical mirror reread stay constant
    // regardless of how many legacy students are materialized.
    expect(assignmentReads).toHaveLength(4);
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
