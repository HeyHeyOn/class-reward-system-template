import { describe, expect, it, vi } from 'vitest';
import { TASK_ASSIGNMENT_HEADERS, TASK_COMPLETION_SCHEMA_HEADERS, TASK_SCHEMA_HEADERS } from './recurringSchemaMigrator';
import {
  getTaskCycleProjection,
  getTaskHistoryDetail,
  listTaskCycleProjections,
  listTaskHistory,
} from './taskHistoryQueries';
import type { ClassTask } from '@/domain/types';
import * as sheetsRepository from '@/server/sheetsRepository';

const now = '2026-08-25T12:00:00Z';
const currentCycle = 'v1|new-instance|r1|2026-08-25T00:00:00Z';

function task(overrides: Partial<ClassTask> = {}): ClassTask {
  return {
    taskId: 'T1', taskInstanceId: 'new-instance', title: 'Current title', description: 'raw description',
    reward: 7, isActive: true, sortOrder: 1, allowedStudentIds: ['S1'], createdAt: '2026-08-20T00:00:00Z',
    schedule: {
      ruleVersion: 1, effectiveFrom: '2026-08-20T00:00:00Z', timeZone: 'UTC',
      recurrence: { type: 'DAILY', time: '00:00' }, resetAssignmentOnCycle: true, resetCompletionOnCycle: true,
    },
    ...overrides,
  };
}

function taskRow(value: ClassTask): string[] {
  const cells: Record<string, string> = {
    taskId: value.taskId, title: value.title, description: value.description, reward: String(value.reward),
    isActive: value.isActive ? 'TRUE' : 'FALSE', sortOrder: String(value.sortOrder), createdAt: value.createdAt ?? '',
    updatedAt: '', allowedStudentIds: value.allowedStudentIds.join(','),
    taskInstanceId: value.taskInstanceId ?? '', ruleVersion: String(value.schedule?.ruleVersion ?? ''),
    scheduleEffectiveFrom: value.schedule?.effectiveFrom ?? '', recurrenceTimeZone: value.schedule?.timeZone ?? '',
    recurrenceType: value.schedule?.recurrence.type ?? '',
    recurrenceTime: value.schedule?.recurrence.type === 'DAILY' ? value.schedule.recurrence.time : '',
    resetCompletionOnCycle: value.schedule?.resetCompletionOnCycle ? 'TRUE' : 'FALSE',
    resetAssignmentOnCycle: value.schedule?.resetAssignmentOnCycle ? 'TRUE' : 'FALSE',
  };
  return TASK_SCHEMA_HEADERS.map((header) => cells[header] ?? '');
}

function row(headers: readonly string[], cells: Record<string, string>): string[] {
  return headers.map((header) => cells[header] ?? '');
}

function readerFor(tasks: ClassTask[] = [task()]) {
  const writes = {
    appendRow: vi.fn(() => { throw new Error('write forbidden'); }),
    updateCell: vi.fn(() => { throw new Error('write forbidden'); }),
    updateCells: vi.fn(() => { throw new Error('write forbidden'); }),
    deleteRow: vi.fn(() => { throw new Error('write forbidden'); }),
    migrateRecurringSchema: vi.fn(() => { throw new Error('migration forbidden'); }),
    materializeTaskCycle: vi.fn(() => { throw new Error('materialization forbidden'); }),
  };
  const rows: Record<string, string[][]> = {
    Tasks: [[...TASK_SCHEMA_HEADERS], ...tasks.map(taskRow)],
    TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS],
      row(TASK_ASSIGNMENT_HEADERS, {
        assignmentId: 'A-old', taskId: 'T1', taskInstanceId: 'old-instance', cycleId: 'old-cycle',
        cycleStartsAt: '2026-08-24T00:00:00Z', cycleEndsAt: '2026-08-25T00:00:00Z', ruleVersion: '1', timeZone: 'UTC',
        studentId: 'S1', status: 'ASSIGNED', source: 'ADMIN', createdAt: '2026-08-24T01:00:00Z', schemaVersion: '2',
      }),
      row(TASK_ASSIGNMENT_HEADERS, {
        assignmentId: 'A-current', taskId: 'T1', taskInstanceId: 'new-instance', cycleId: currentCycle,
        cycleStartsAt: '2026-08-25T00:00:00Z', cycleEndsAt: '2026-08-26T00:00:00Z', ruleVersion: '1', timeZone: 'UTC',
        studentId: 'S1', status: 'UNASSIGNED', source: 'ADMIN', createdAt: '2026-08-25T01:00:00Z', schemaVersion: '2',
      }),
      row(TASK_ASSIGNMENT_HEADERS, {
        assignmentId: 'A-deleted', taskId: 'DELETED', taskInstanceId: 'deleted-instance', cycleId: 'deleted-cycle',
        cycleStartsAt: '2026-07-01T00:00:00Z', ruleVersion: '1', timeZone: 'UTC', studentId: 'S9',
        status: 'ASSIGNED', source: 'ADMIN', createdAt: '2026-07-01T01:00:00Z', schemaVersion: '2',
      }),
    ],
    TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS],
      row(TASK_COMPLETION_SCHEMA_HEADERS, {
        completionId: 'C-old', timestamp: '2026-08-24T02:00:00Z', taskId: 'T1', studentId: 'S1', studentName: 'One',
        reward: '7', balanceBefore: '0', balanceAfter: '7', status: 'SUCCESS', taskInstanceId: 'old-instance', cycleId: 'old-cycle',
        cycleStartsAt: '2026-08-24T00:00:00Z', cycleEndsAt: '2026-08-25T00:00:00Z', ruleVersion: '1', timeZone: 'UTC',
        source: 'BANK', assignmentId: 'A-old', schemaVersion: '2',
      }),
    ],
    Settings: [['key', 'value']],
  };
  return {
    reader: { getRows: vi.fn(async (sheet: string) => (rows[sheet] ?? []).map((entry) => [...entry])), ...writes },
    writes,
  };
}

function expectNoWrites(writes: ReturnType<typeof readerFor>['writes']) {
  Object.values(writes).forEach((spy) => expect(spy).not.toHaveBeenCalled());
}

function expectSingleLedgerSnapshot(reader: ReturnType<typeof readerFor>['reader']) {
  const sheets = reader.getRows.mock.calls.map(([sheet]) => sheet);
  expect(sheets.filter((sheet) => sheet === 'TaskAssignments')).toHaveLength(1);
  expect(sheets.filter((sheet) => sheet === 'TaskCompletions')).toHaveLength(1);
}

describe('reader-only task history queries', () => {
  it('keeps every raw task field and adds authoritative current-cycle student status only', async () => {
    const source = task();
    const { reader, writes } = readerFor([source]);
    const dto = await getTaskCycleProjection(reader, source, { studentId: 'S1', now });

    expect(dto).toMatchObject({ ...source, currentCycle: { cycleId: currentCycle } });
    expect(dto.studentStatus).toEqual({
      studentId: 'S1', assigned: false, completed: false,
      assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT',
    });
    expectNoWrites(writes);
  });

  it('lists active definitions by default and adds current cycle without cumulative history', async () => {
    const { reader, writes } = readerFor([task(), task({ taskId: 'INACTIVE', taskInstanceId: 'inactive-i', isActive: false, sortOrder: 2 })]);
    const result = await listTaskCycleProjections(reader, { now });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ taskId: 'T1', title: 'Current title', currentCycle: { cycleId: currentCycle } });
    expect(result[0]).not.toHaveProperty('cumulativeHistory');
    expect(result[0]).not.toHaveProperty('studentStatus');
    expectNoWrites(writes);
  });

  it('projects three tasks from one assignment/completion ledger snapshot', async () => {
    const tasks = [
      task(),
      task({ taskId: 'T2', taskInstanceId: 'instance-2', title: 'Second', sortOrder: 2 }),
      task({ taskId: 'T3', taskInstanceId: 'instance-3', title: 'Third', sortOrder: 3 }),
    ];
    const { reader, writes } = readerFor(tasks);

    const result = await listTaskCycleProjections(reader, { studentId: 'S1', now });

    expect(result.map((item) => item.taskId)).toEqual(['T1', 'T2', 'T3']);
    expect(result[0].studentStatus).toMatchObject({ assigned: false, assignmentOrigin: 'EVENT' });
    expect(result[1].studentStatus).toMatchObject({ assigned: false, assignmentOrigin: 'DEFAULT' });
    expect(result[2].studentStatus).toMatchObject({ assigned: false, assignmentOrigin: 'DEFAULT' });
    expectSingleLedgerSnapshot(reader);
    expectNoWrites(writes);
  });

  it('lists live and deleted taskIds with lifecycle history and performs no writes', async () => {
    const { reader, writes } = readerFor();
    const result = await listTaskHistory(reader, now);

    expect(result.map((item) => item.taskId)).toEqual(['DELETED', 'T1']);
    expect(result[0]).toMatchObject({
      currentLifecycle: { taskDefinitionExists: false, taskInstanceId: null, currentCycleStatus: null },
      cumulativeHistory: { eventCount: 1, lifecycles: [{ taskInstanceId: 'deleted-instance' }] },
    });
    expect(result[1]).toMatchObject({
      currentLifecycle: { taskDefinitionExists: true, taskInstanceId: 'new-instance', currentCycleStatus: { cycleId: currentCycle } },
      cumulativeHistory: { eventCount: 3 },
    });
    expectNoWrites(writes);
  });

  it('lists history for three live tasks plus deleted history from one ledger snapshot', async () => {
    const tasks = [
      task(),
      task({ taskId: 'T2', taskInstanceId: 'instance-2', title: 'Second', sortOrder: 2 }),
      task({ taskId: 'T3', taskInstanceId: 'instance-3', title: 'Third', sortOrder: 3 }),
    ];
    const { reader, writes } = readerFor(tasks);

    const result = await listTaskHistory(reader, now);

    expect(result.map((item) => item.taskId)).toEqual(['DELETED', 'T1', 'T2', 'T3']);
    expect(result.find((item) => item.taskId === 'DELETED')).toMatchObject({
      currentLifecycle: { taskDefinitionExists: false },
      cumulativeHistory: { eventCount: 1 },
    });
    expect(result.find((item) => item.taskId === 'T1')).toMatchObject({
      currentLifecycle: { taskInstanceId: 'new-instance', currentCycleStatus: { cycleId: currentCycle } },
      cumulativeHistory: { eventCount: 3 },
    });
    expectSingleLedgerSnapshot(reader);
    expectNoWrites(writes);
  });

  it('filters cumulative detail to an exact old lifecycle while retaining the reused current definition', async () => {
    const { reader, writes } = readerFor();
    const detail = await getTaskHistoryDetail(reader, { taskId: 'T1', taskInstanceId: 'old-instance' }, now);

    expect(detail.currentLifecycle).toMatchObject({
      taskDefinitionExists: true, taskInstanceId: 'new-instance', currentCycleStatus: { cycleId: currentCycle },
    });
    expect(detail.cumulativeHistory).toMatchObject({
      eventCount: 2,
      lifecycles: [{ taskInstanceId: 'old-instance', isCurrentLifecycle: false, eventCount: 2 }],
    });
    expect(detail.cumulativeHistory.lifecycles.every((item) => item.taskInstanceId === 'old-instance')).toBe(true);
    expectSingleLedgerSnapshot(reader);
    expectNoWrites(writes);
  });

  it('reports an existing legacy definition with no instance ID and no cycle projection', async () => {
    const legacy = task({ taskId: 'LEGACY', taskInstanceId: undefined, schedule: undefined });
    const getTask = vi.spyOn(sheetsRepository, 'getTaskById').mockResolvedValue(legacy);
    const { reader, writes } = readerFor([]);

    const detail = await getTaskHistoryDetail(reader, { taskId: 'LEGACY' }, now);

    expect(detail.currentLifecycle).toEqual({
      taskDefinitionExists: true,
      taskInstanceId: null,
      currentCycleStatus: null,
    });
    expect(detail.cumulativeHistory.eventCount).toBe(0);
    expectNoWrites(writes);
    getTask.mockRestore();
  });
});
