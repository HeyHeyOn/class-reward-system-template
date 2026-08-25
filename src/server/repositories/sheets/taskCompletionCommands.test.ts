import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTaskCycle } from '@/domain/taskRecurrence';
import type { ClassTask, Student, TaskCompletion } from '@/domain/types';
import { getTaskAssignmentStatus, resetTaskCompletionsBatch, updateTaskAssignmentStatus } from '@/server/sheetsRepository';
import { TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS, TASK_SCHEMA_HEADERS } from './recurringSchemaMigrator';
import { mutateTaskCompletion, TaskCompletionReconciliationError } from './taskCompletionCommands';

const task: ClassTask = {
  taskId: 'T1', taskInstanceId: 'I1', title: 'Read', description: '', reward: 5, isActive: true,
  sortOrder: 1, allowedStudentIds: ['S1'], createdAt: '2026-08-20T00:00:00.000Z',
  schedule: { ruleVersion: 1, effectiveFrom: '2026-08-20T00:00:00.000Z', timeZone: 'UTC', recurrence: { type: 'DAILY', time: '00:00' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: true },
};
const student: Student = { studentId: 'S1', name: 'Kim', balance: 10, status: 'ACTIVE' };
const NOW = '2026-08-25T12:00:00.000Z';
const NEXT = '2026-08-26T12:00:00.000Z';

class Store {
  rows: Record<string, string[][]>;
  updateCell = vi.fn(async (sheet: string, row: number, column: string, value: string | number) => {
    const index = this.rows[sheet][0].indexOf(column);
    this.rows[sheet][row - 1][index] = String(value);
  });
  appendRow = vi.fn(async (sheet: string, values: string[]) => { this.rows[sheet].push([...values]); });
  updateCells = vi.fn(); updateHeaderRow = vi.fn(); deleteRow = vi.fn(); deleteRows = vi.fn();
  lookupSheet = vi.fn(async (name: string) => ({ found: true as const, info: { sheetId: 1, title: name, columnCount: this.rows[name][0].length } }));
  createSheetWithHeader = vi.fn(); ensureColumnCount = vi.fn(); writeHeaderCells = vi.fn(); verifyHeaderCells = vi.fn(); verifyAndWriteHeaderCells = vi.fn();
  getRows = vi.fn(async (sheet: string) => this.rows[sheet].map((row) => [...row]));

  constructor(readonly configuredTask: ClassTask = task) {
    this.rows = {
      Tasks: [[...TASK_SCHEMA_HEADERS], taskRow(configuredTask)],
      TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS], assignmentRow(configuredTask, NOW)],
      TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS]],
      Students: [['studentId', 'name', 'balance', 'status'], ['S1', 'Kim', '10', 'ACTIVE']],
      Transactions: [['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator']],
    };
  }
}

function assignmentRow(valueTask: ClassTask, now: string): string[] {
  const cycle = getTaskCycle({ taskInstanceId: valueTask.taskInstanceId!, schedule: valueTask.schedule!, taskCreatedAt: valueTask.createdAt, now });
  const value: Record<string, string> = {
    assignmentId: 'A1', taskId: valueTask.taskId, taskInstanceId: valueTask.taskInstanceId!,
    cycleId: cycle.cycleId, cycleStartsAt: cycle.startsAt, cycleEndsAt: cycle.endsAt ?? '',
    ruleVersion: String(valueTask.schedule!.ruleVersion), timeZone: valueTask.schedule!.timeZone,
    studentId: 'S1', status: 'ASSIGNED', source: 'ADMIN', previousAssignmentId: '',
    createdAt: now, schemaVersion: '2', note: '',
  };
  return TASK_ASSIGNMENT_HEADERS.map((header) => value[header] ?? '');
}

function taskRow(valueTask: ClassTask): string[] {
  const schedule = valueTask.schedule!;
  const pending = valueTask.pendingSchedule;
  const value: Record<string, string> = {
    taskId: valueTask.taskId, title: valueTask.title, description: valueTask.description,
    reward: String(valueTask.reward), isActive: 'TRUE', sortOrder: String(valueTask.sortOrder),
    createdAt: valueTask.createdAt ?? '', updatedAt: valueTask.createdAt ?? '',
    allowedStudentIds: valueTask.allowedStudentIds.join(','), taskInstanceId: valueTask.taskInstanceId!,
    ruleVersion: String(schedule.ruleVersion), scheduleEffectiveFrom: schedule.effectiveFrom,
    recurrenceTimeZone: schedule.timeZone, recurrenceType: schedule.recurrence.type,
    recurrenceTime: schedule.recurrence.type === 'NONE' ? '' : schedule.recurrence.time,
    resetCompletionOnCycle: schedule.resetCompletionOnCycle ? 'TRUE' : 'FALSE',
    resetAssignmentOnCycle: schedule.resetAssignmentOnCycle ? 'TRUE' : 'FALSE',
    pendingRuleVersion: pending ? String(pending.ruleVersion) : '', pendingEffectiveFrom: pending?.effectiveFrom ?? '',
    pendingTimeZone: pending?.timeZone ?? '', pendingRecurrenceType: pending?.recurrence.type ?? '',
    pendingRecurrenceTime: pending && pending.recurrence.type !== 'NONE' ? pending.recurrence.time : '',
    pendingResetCompletionOnCycle: pending ? (pending.resetCompletionOnCycle ? 'TRUE' : 'FALSE') : '',
    pendingResetAssignmentOnCycle: pending ? (pending.resetAssignmentOnCycle ? 'TRUE' : 'FALSE') : '',
  };
  return TASK_SCHEMA_HEADERS.map((header) => value[header] ?? '');
}

describe('cycle-aware completion command', () => {
  afterEach(() => vi.useRealTimers());

  it('runs ADMIN complete -> no-op -> ADMIN_RESET -> BANK reward -> retry blocked', async () => {
    const store = new Store();
    const input = { store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2, now: NOW };
    const admin = await mutateTaskCompletion({ ...input, completed: true, source: 'ADMIN' });
    const retry = await mutateTaskCompletion({ ...input, completed: true, source: 'ADMIN' });
    const reset = await mutateTaskCompletion({ ...input, completed: false, source: 'ADMIN' });
    const bank = await mutateTaskCompletion({ ...input, completed: true, source: 'BANK' });
    await expect(mutateTaskCompletion({ ...input, completed: true, source: 'BANK' })).rejects.toThrow('이미 완료한 과제입니다.');
    expect(admin).toMatchObject({ changed: true, completion: { source: 'ADMIN', reward: 0, balanceBefore: 10, balanceAfter: 10 } });
    expect(retry).toMatchObject({ changed: false });
    expect(reset).toMatchObject({ changed: true, completion: { source: 'ADMIN_RESET', reward: 0 } });
    expect(bank).toMatchObject({ changed: true, completion: { source: 'BANK', reward: 5, assignmentId: 'A1' }, balanceAfter: 15 });
    expect(store.rows.Students[1][2]).toBe('15');
    expect(store.rows.Transactions).toHaveLength(2);
  });

  it('pays BANK again after ADMIN_RESET and blocks each immediate retry', async () => {
    const store = new Store();
    const input = { store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2, now: NOW };
    await mutateTaskCompletion({ ...input, completed: true, source: 'BANK' });
    await expect(mutateTaskCompletion({ ...input, completed: true, source: 'BANK' })).rejects.toThrow('이미 완료한 과제입니다.');
    await mutateTaskCompletion({ ...input, completed: false, source: 'ADMIN' });
    const second = await mutateTaskCompletion({ ...input, completed: true, source: 'BANK' });
    await expect(mutateTaskCompletion({ ...input, completed: true, source: 'BANK' })).rejects.toThrow('이미 완료한 과제입니다.');
    expect(second).toMatchObject({ balanceAfter: 20, completion: { balanceBefore: 15, balanceAfter: 20, reward: 5 } });
    expect(store.rows.Students[1][2]).toBe('20');
    expect(store.rows.Transactions).toHaveLength(3);
  });

  it('rewards again at the next natural cycle when resetCompletionOnCycle is true', async () => {
    const store = new Store();
    const input = { store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2 };
    await mutateTaskCompletion({ ...input, completed: true, source: 'BANK', now: NOW });
    const next = await mutateTaskCompletion({ ...input, completed: true, source: 'BANK', now: NEXT });
    expect(next).toMatchObject({ balanceAfter: 20, completion: { source: 'BANK', reward: 5, balanceBefore: 15 } });
    expect(store.rows.Transactions).toHaveLength(3);
  });

  it('materializes zero-reward completion carry and blocks BANK when cycle reset is false', async () => {
    const carryTask = { ...task, schedule: { ...task.schedule!, resetCompletionOnCycle: false } };
    const store = new Store(carryTask);
    const input = { store: store as never, task: carryTask, taskRowNumber: 2, student, studentRowNumber: 2 };
    await mutateTaskCompletion({ ...input, completed: true, source: 'BANK', now: NOW });
    await expect(mutateTaskCompletion({ ...input, completed: true, source: 'BANK', now: NEXT })).rejects.toThrow('이미 완료한 과제입니다.');
    expect(completionRecords(store).at(-1)).toMatchObject({ source: 'CARRY_FORWARD', reward: 0, balanceBefore: 15, balanceAfter: 15, status: 'SUCCESS' });
    expect(store.rows.Students[1][2]).toBe('15');
    expect(store.rows.Transactions).toHaveLength(2);
  });

  it('forces carry in the first immediately-effective schedule/time-zone cycle regardless of reset', async () => {
    const changedTask: ClassTask = {
      ...task,
      pendingSchedule: {
        ruleVersion: 2, effectiveFrom: '2026-08-26T00:00:00.000Z', timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '09:00' }, resetAssignmentOnCycle: true, resetCompletionOnCycle: true,
      },
    };
    const store = new Store(changedTask);
    const input = { store: store as never, task: changedTask, taskRowNumber: 2, student, studentRowNumber: 2 };
    await mutateTaskCompletion({ ...input, completed: true, source: 'BANK', now: NOW });
    await expect(mutateTaskCompletion({ ...input, completed: true, source: 'BANK', now: '2026-08-26T00:00:00.000Z' })).rejects.toThrow('이미 완료한 과제입니다.');
    expect(completionRecords(store).at(-1)).toMatchObject({ source: 'CARRY_FORWARD', reward: 0, ruleVersion: 2, timeZone: 'Asia/Seoul' });
    expect(store.rows.Transactions).toHaveLength(2);
  });

  it('materializes legacy NONE completion as zero-reward carry and preserves the old BANK block', async () => {
    const permanentTask: ClassTask = {
      ...task,
      schedule: { ruleVersion: 1, effectiveFrom: '1970-01-01T00:00:00.000Z', timeZone: 'UTC', recurrence: { type: 'NONE' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false },
    };
    const store = new Store(permanentTask);
    store.rows.TaskCompletions.push(completionRow({ completionId: 'OLD', timestamp: '2026-08-21T00:00:00.000Z', taskId: 'T1', studentId: 'S1', studentName: 'Kim', reward: 5, balanceBefore: 5, balanceAfter: 10, status: 'SUCCESS', note: '' }));
    await expect(mutateTaskCompletion({ store: store as never, task: permanentTask, taskRowNumber: 2, student, studentRowNumber: 2, completed: true, source: 'BANK', now: NOW })).rejects.toThrow('이미 완료한 과제입니다.');
    expect(completionRecords(store).at(-1)).toMatchObject({ source: 'CARRY_FORWARD', reward: 0, balanceBefore: 10, balanceAfter: 10, status: 'SUCCESS' });
    expect(store.rows.Transactions).toHaveLength(1);
  });

  it('snapshots all task instance, cycle, schedule, and assignment coordinates', async () => {
    const store = new Store();
    const result = await mutateTaskCompletion({ store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2, completed: true, source: 'BANK', now: NOW });
    expect(result.completion).toMatchObject({
      taskInstanceId: 'I1', cycleId: expect.stringContaining('|I1|r1|'),
      cycleStartsAt: '2026-08-25T00:00:00Z', cycleEndsAt: '2026-08-26T00:00:00Z',
      ruleVersion: 1, timeZone: 'UTC', assignmentId: 'A1',
    });
  });

  it('requires a current assignment before mutating', async () => {
    const store = new Store();
    store.rows.TaskAssignments = [[...TASK_ASSIGNMENT_HEADERS]];
    await expect(mutateTaskCompletion({ store: store as never, task: { ...task, allowedStudentIds: [] }, taskRowNumber: 2, student, studentRowNumber: 2, completed: true, source: 'BANK', now: NOW })).rejects.toThrow('부여된 학생이 없습니다.');
    expect(store.updateCell).not.toHaveBeenCalled();
  });

  it('serializes rewards for two task instances sharing one student balance across store wrappers', async () => {
    const secondTask: ClassTask = { ...task, taskId: 'T2', taskInstanceId: 'I2', title: 'Write', reward: 7 };
    const firstStore = new Store();
    const secondStore = new Store();
    firstStore.rows.Tasks.push(taskRow(secondTask));
    firstStore.rows.TaskAssignments.push(assignmentRow(secondTask, NOW));
    secondStore.rows = firstStore.rows;

    let firstBalanceUpdateStarted!: () => void;
    const firstBalanceUpdate = new Promise<void>((resolve) => { firstBalanceUpdateStarted = resolve; });
    let releaseFirstBalanceUpdate!: () => void;
    const firstBalanceGate = new Promise<void>((resolve) => { releaseFirstBalanceUpdate = resolve; });
    firstStore.updateCell.mockImplementation(async (sheet: string, row: number, column: string, value: string | number) => {
      if (sheet === 'Students' && column === 'balance') {
        firstBalanceUpdateStarted();
        await firstBalanceGate;
      }
      const index = firstStore.rows[sheet][0].indexOf(column);
      firstStore.rows[sheet][row - 1][index] = String(value);
    });

    const first = mutateTaskCompletion({
      store: firstStore as never, task, taskRowNumber: 2, student, studentRowNumber: 2,
      completed: true, source: 'BANK', now: NOW,
    });
    await firstBalanceUpdate;
    const second = mutateTaskCompletion({
      store: secondStore as never, task: secondTask, taskRowNumber: 3, student, studentRowNumber: 2,
      completed: true, source: 'BANK', now: NOW,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirstBalanceUpdate();
    await Promise.all([first, second]);

    expect(firstStore.rows.Students[1][2]).toBe('22');
    expect(completionRecords(firstStore).filter((event) => event.source === 'BANK')).toHaveLength(2);

    await expect(mutateTaskCompletion({
      store: firstStore as never, task, taskRowNumber: 2, student, studentRowNumber: 2,
      completed: true, source: 'BANK', now: NOW,
    })).rejects.toThrow('이미 완료한 과제입니다.');
  });

  it('compensates the reward balance when the canonical completion append fails, then rewards exactly once on retry', async () => {
    const store = new Store();
    store.appendRow.mockRejectedValueOnce(new Error('canonical completion failed'));
    const input = { store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2, completed: true as const, source: 'BANK' as const, now: NOW };

    await expect(mutateTaskCompletion(input)).rejects.toThrow('canonical completion failed');
    expect(store.rows.Students[1][2]).toBe('10');
    expect(completionRecords(store)).toHaveLength(0);

    await expect(mutateTaskCompletion(input)).resolves.toMatchObject({ balanceAfter: 15 });
    expect(store.rows.Students[1][2]).toBe('15');
    expect(completionRecords(store).filter((event) => event.source === 'BANK')).toHaveLength(1);
    expect(store.rows.Transactions).toHaveLength(2);
  });

  it('does not overwrite a concurrent balance change while reconciling a failed completion append', async () => {
    const store = new Store();
    store.appendRow.mockImplementationOnce(async () => {
      store.rows.Students[1][2] = '20';
      throw new Error('canonical completion failed after another balance change');
    });

    await expect(mutateTaskCompletion({
      store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2,
      completed: true, source: 'BANK', now: NOW,
    })).rejects.toMatchObject({
      name: 'TaskCompletionReconciliationError',
      message: 'TASK_COMPLETION_BALANCE_CHANGED_BEFORE_COMPENSATION',
    } satisfies Partial<TaskCompletionReconciliationError>);
    expect(store.rows.Students[1][2]).toBe('20');
    expect(store.updateCell).not.toHaveBeenCalledWith('Students', 2, 'balance', 10);
  });

  it('accepts an ambiguous canonical append that wrote the completion before throwing', async () => {
    const store = new Store();
    store.appendRow.mockImplementationOnce(async (sheet: string, values: string[]) => {
      store.rows[sheet].push([...values]);
      throw new Error('response lost after write');
    });

    await expect(mutateTaskCompletion({
      store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2,
      completed: true, source: 'BANK', now: NOW,
    })).resolves.toMatchObject({ balanceAfter: 15 });
    expect(store.rows.Students[1][2]).toBe('15');
    expect(completionRecords(store).filter((event) => event.source === 'BANK')).toHaveLength(1);
    expect(store.rows.Transactions).toHaveLength(2);
  });

  it('throws a distinct reconciliation error when balance compensation also fails', async () => {
    const store = new Store();
    store.appendRow.mockRejectedValueOnce(new Error('canonical completion failed'));
    let balanceUpdates = 0;
    store.updateCell.mockImplementation(async (sheet: string, row: number, column: string, value: string | number) => {
      if (sheet === 'Students' && column === 'balance' && balanceUpdates++ > 0) {
        throw new Error('compensation failed');
      }
      const index = store.rows[sheet][0].indexOf(column);
      store.rows[sheet][row - 1][index] = String(value);
    });

    await expect(mutateTaskCompletion({
      store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2,
      completed: true, source: 'BANK', now: NOW,
    })).rejects.toMatchObject({
      name: 'TaskCompletionReconciliationError',
      message: 'TASK_COMPLETION_BALANCE_COMPENSATION_FAILED',
    } satisfies Partial<TaskCompletionReconciliationError>);
  });

  it('runs combined ADMIN reset then unassign in one command and appends both events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const store = new Store();
    const cycle = getTaskCycle({ taskInstanceId: 'I1', schedule: task.schedule!, taskCreatedAt: task.createdAt, now: NOW });
    store.rows.TaskCompletions.push(completionRow({
      completionId: 'DONE', timestamp: NOW, taskId: 'T1', studentId: 'S1', studentName: 'Kim', reward: 5,
      balanceBefore: 5, balanceAfter: 10, status: 'SUCCESS', note: '', taskInstanceId: 'I1',
      cycleId: cycle.cycleId, cycleStartsAt: cycle.startsAt, cycleEndsAt: cycle.endsAt,
      ruleVersion: 1, timeZone: 'UTC', source: 'BANK', assignmentId: 'A1', schemaVersion: 2,
    }));
    const result = await updateTaskAssignmentStatus(store as never, 'T1', { studentId: 'S1', assigned: false, completed: false, source: 'ADMIN' });
    expect(result.students).toContainEqual(expect.objectContaining({
      studentId: 'S1', name: 'Kim', assigned: false, completed: false, assignmentSource: 'ADMIN',
    }));
    expect(completionRecords(store).at(-1)).toMatchObject({ source: 'ADMIN_RESET', status: 'RESET' });
    const assignmentHeaders = store.rows.TaskAssignments[0];
    const lastAssignment = Object.fromEntries(assignmentHeaders.map((header, index) => [header, store.rows.TaskAssignments.at(-1)![index]]));
    expect(lastAssignment).toMatchObject({ status: 'UNASSIGNED', source: 'ADMIN' });
  });

  it('resets through an append-only ADMIN_RESET event without deleting completion history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const store = new Store();
    const cycle = getTaskCycle({ taskInstanceId: 'I1', schedule: task.schedule!, taskCreatedAt: task.createdAt, now: NOW });
    store.rows.TaskCompletions.push(completionRow({
      completionId: 'DONE', timestamp: NOW, taskId: 'T1', studentId: 'S1', studentName: 'Kim', reward: 5,
      balanceBefore: 5, balanceAfter: 10, status: 'SUCCESS', note: '', taskInstanceId: 'I1',
      cycleId: cycle.cycleId, cycleStartsAt: cycle.startsAt, cycleEndsAt: cycle.endsAt,
      ruleVersion: 1, timeZone: 'UTC', source: 'BANK', assignmentId: 'A1', schemaVersion: 2,
    }));

    await expect(resetTaskCompletionsBatch(store as never, ['T1'])).resolves.toEqual({
      taskIds: ['T1'], resetEventsAppended: 1, deletedCount: 1,
    });
    expect(completionRecords(store)).toMatchObject([
      { completionId: 'DONE', status: 'SUCCESS' },
      { source: 'ADMIN_RESET', status: 'RESET' },
    ]);
    expect(store.deleteRow).not.toHaveBeenCalled();
    expect(store.deleteRows).not.toHaveBeenCalled();
  });

  it('resets a completed but currently unassigned student without reassigning them', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const store = completedThenUnassignedStore();

    const result = await updateTaskAssignmentStatus(
      store as never,
      'T1',
      { studentId: 'S1', completed: false, source: 'ADMIN' },
    );

    expect(result.students).toContainEqual(expect.objectContaining({
      studentId: 'S1', name: 'Kim', assigned: false, completed: false, assignmentSource: 'ADMIN',
    }));
    expect(store.rows.TaskAssignments).toHaveLength(3);
    expect(completionRecords(store)).toMatchObject([
      { completionId: 'DONE', status: 'SUCCESS', assignmentId: 'A1' },
      { source: 'ADMIN_RESET', status: 'RESET', assignmentId: 'A1' },
    ]);
  });

  it('keeps BANK and ADMIN completion gated by the current assignment after unassignment', async () => {
    const store = completedThenUnassignedStore();
    const base = { store: store as never, task, taskRowNumber: 2, student, studentRowNumber: 2, completed: true as const, now: NOW };

    await expect(mutateTaskCompletion({ ...base, source: 'BANK' })).rejects.toThrow('부여된 학생이 없습니다.');
    await expect(mutateTaskCompletion({ ...base, source: 'ADMIN' })).rejects.toThrow('부여된 학생이 없습니다.');
    expect(store.rows.TaskAssignments).toHaveLength(3);
  });

  it('batch-resets completed but currently unassigned rows and retains assignment and completion history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const store = completedThenUnassignedStore();

    await expect(resetTaskCompletionsBatch(store as never, ['T1'])).resolves.toEqual({
      taskIds: ['T1'], resetEventsAppended: 1, deletedCount: 1,
    });
    expect(store.rows.TaskAssignments).toHaveLength(3);
    expect(completionRecords(store)).toMatchObject([
      { completionId: 'DONE', status: 'SUCCESS', assignmentId: 'A1' },
      { source: 'ADMIN_RESET', status: 'RESET', assignmentId: 'A1' },
    ]);
  });

  it('directly resets a cycle-less legacy completion without creating an assignment or carry event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const store = legacyCompletedUnassignedStore();

    const result = await updateTaskAssignmentStatus(
      store as never,
      'T1',
      { studentId: 'S1', completed: false, source: 'ADMIN' },
    );

    expect(result.students).toContainEqual(expect.objectContaining({
      studentId: 'S1', name: 'Kim', assigned: false, completed: false,
    }));
    expect(store.rows.TaskAssignments).toHaveLength(1);
    expect(completionRecords(store)).toMatchObject([
      { completionId: 'LEGACY-DONE', status: 'SUCCESS', assignmentId: '' },
      { source: 'ADMIN_RESET', status: 'RESET', assignmentId: 'LEGACY_COMPLETION:LEGACY-DONE' },
    ]);
  });

  it('batch-resets a cycle-less legacy completion on a fresh store without creating an assignment or carry event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const store = legacyCompletedUnassignedStore();

    await expect(resetTaskCompletionsBatch(store as never, ['T1']))
      .resolves.toEqual({ taskIds: ['T1'], resetEventsAppended: 1, deletedCount: 1 });

    expect((await getTaskAssignmentStatus(store as never, 'T1')).students)
      .toContainEqual(expect.objectContaining({ studentId: 'S1', name: 'Kim', assigned: false, completed: false }));
    expect(store.rows.TaskAssignments).toHaveLength(1);
    expect(completionRecords(store)).toMatchObject([
      { completionId: 'LEGACY-DONE', status: 'SUCCESS', assignmentId: '' },
      { source: 'ADMIN_RESET', status: 'RESET', assignmentId: 'LEGACY_COMPLETION:LEGACY-DONE' },
    ]);
  });
});

function completedThenUnassignedStore(): Store {
  const store = new Store();
  const cycle = getTaskCycle({ taskInstanceId: 'I1', schedule: task.schedule!, taskCreatedAt: task.createdAt, now: NOW });
  store.rows.TaskCompletions.push(completionRow({
    completionId: 'DONE', timestamp: NOW, taskId: 'T1', studentId: 'S1', studentName: 'Kim', reward: 5,
    balanceBefore: 5, balanceAfter: 10, status: 'SUCCESS', note: '', taskInstanceId: 'I1',
    cycleId: cycle.cycleId, cycleStartsAt: cycle.startsAt, cycleEndsAt: cycle.endsAt,
    ruleVersion: 1, timeZone: 'UTC', source: 'BANK', assignmentId: 'A1', schemaVersion: 2,
  }));
  const unassigned = assignmentRow(task, NOW);
  unassigned[TASK_ASSIGNMENT_HEADERS.indexOf('assignmentId')] = 'A2';
  unassigned[TASK_ASSIGNMENT_HEADERS.indexOf('status')] = 'UNASSIGNED';
  unassigned[TASK_ASSIGNMENT_HEADERS.indexOf('previousAssignmentId')] = 'A1';
  store.rows.TaskAssignments.push(unassigned);
  return store;
}

function legacyCompletedUnassignedStore(): Store {
  const legacyTask: ClassTask = {
    ...task,
    allowedStudentIds: [],
    schedule: {
      ruleVersion: 1,
      effectiveFrom: '1970-01-01T00:00:00.000Z',
      timeZone: 'UTC',
      recurrence: { type: 'NONE' },
      resetAssignmentOnCycle: false,
      resetCompletionOnCycle: false,
    },
  };
  const store = new Store(legacyTask);
  store.rows.TaskAssignments = [[...TASK_ASSIGNMENT_HEADERS]];
  store.rows.TaskCompletions.push(completionRow({
    completionId: 'LEGACY-DONE', timestamp: '2026-08-21T00:00:00.000Z', taskId: 'T1',
    studentId: 'S1', studentName: 'Kim', reward: 5, balanceBefore: 5, balanceAfter: 10,
    status: 'SUCCESS', note: 'legacy completion',
  }));
  return store;
}

function completionRow(completion: Partial<TaskCompletion> & Pick<TaskCompletion, 'completionId' | 'timestamp' | 'taskId' | 'studentId' | 'studentName' | 'reward' | 'balanceBefore' | 'balanceAfter' | 'status' | 'note'>): string[] {
  return TASK_COMPLETION_SCHEMA_HEADERS.map((header) => {
    const value = completion[header as keyof TaskCompletion];
    return value === null || value === undefined ? '' : String(value);
  });
}

function completionRecords(store: Store): Array<Record<string, string | number>> {
  const [headers, ...rows] = store.rows.TaskCompletions;
  return rows.map((row) => Object.fromEntries(headers.map((header, index) => {
    const value = row[index] ?? '';
    return [header, ['reward', 'balanceBefore', 'balanceAfter', 'ruleVersion', 'schemaVersion'].includes(header) ? Number(value) : value];
  })));
}
