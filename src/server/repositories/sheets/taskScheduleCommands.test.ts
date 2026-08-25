import { describe, expect, it } from 'vitest';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { serializeTaskScheduleCells } from '@/domain/taskSchedule';
import type { TaskAssignment, TaskCompletion, TaskSchedule } from '@/domain/types';
import { getSheetSettings, getTaskRecords } from '@/server/sheetsRepository';
import { SheetProviderError } from '@/server/storage/tabularStore';
import { changeClassTimeZone } from './taskScheduleCommands';
import {
  TASK_ASSIGNMENT_HEADERS,
  TASK_COMPLETION_SCHEMA_HEADERS,
  TASK_SCHEMA_HEADERS,
} from './recurringSchemaMigrator';
import type {
  CrossSheetCellUpdate,
  OperationalSheetName,
  RecurringSchemaMigrationStore,
  SheetLookupResult,
} from '@/server/storage/tabularStore';

const changedAt = '2026-08-25T10:00:00.000Z';
const current: TaskSchedule = {
  ruleVersion: 2,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'DAILY', time: '09:00' },
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: false,
};
const effectivePending: TaskSchedule = {
  ...current,
  ruleVersion: 3,
  effectiveFrom: '2026-08-20T00:00:00.000Z',
  recurrence: { type: 'WEEKLY', time: '10:30', weekday: 2 },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: true,
};
const none: TaskSchedule = {
  ruleVersion: 7,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'NONE' },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
};

function taskRow(taskId: string, taskInstanceId: string, schedule: TaskSchedule, pendingSchedule: TaskSchedule | null) {
  const values: Record<string, string> = {
    taskId, title: taskId, description: '', reward: '10', isActive: 'TRUE', sortOrder: '1',
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: 'legacy-tail', allowedStudentIds: 'S1',
    ...serializeTaskScheduleCells({ taskInstanceId, currentSchedule: schedule, pendingSchedule }),
  };
  return TASK_SCHEMA_HEADERS.map((header) => values[header] ?? '');
}

class AtomicFake implements RecurringSchemaMigrationStore {
  rows: Partial<Record<OperationalSheetName, string[][]>> = {
    Settings: [['unknown', ' value ', 'key'], ['keep', 'won', 'currencyUnit']],
    Tasks: [
      [...TASK_SCHEMA_HEADERS, 'unknownTail'],
      [...taskRow('T1', 'instance-1', current, effectivePending), 'preserve-me'],
      [...taskRow('T2', 'instance-2', none, null), 'none-byte-stable'],
    ],
    TaskCompletions: [[...TASK_COMPLETION_SCHEMA_HEADERS]],
    TaskAssignments: [[...TASK_ASSIGNMENT_HEADERS]],
  };
  atomicCalls: CrossSheetCellUpdate[][] = [];
  primitiveWrites = 0;
  failAtomic = false;

  async getRows(name: OperationalSheetName) { return structuredClone(this.rows[name] ?? []); }
  async updateCell() { this.primitiveWrites += 1; }
  async appendRow() { this.primitiveWrites += 1; }
  async lookupSheet(name: OperationalSheetName): Promise<SheetLookupResult> {
    if (name === 'Settings' && this.rows.Settings) {
      return { found: true, info: { sheetId: 4, title: name, columnCount: 10 } };
    }
    if (name === 'Tasks') return { found: true, info: { sheetId: 1, title: name, columnCount: 30 } };
    if (name === 'TaskCompletions') return { found: true, info: { sheetId: 2, title: name, columnCount: 19 } };
    if (name === 'TaskAssignments') return { found: true, info: { sheetId: 3, title: name, columnCount: 15 } };
    return { found: false, reason: 'SHEET_NOT_FOUND' };
  }
  async createSheetWithHeader(name: OperationalSheetName, headers: readonly string[]) {
    this.primitiveWrites += 1;
    this.rows[name] = [[...headers]];
  }
  async ensureColumnCount() { this.primitiveWrites += 1; }
  async writeHeaderCells() { this.primitiveWrites += 1; }
  async verifyHeaderCells() {}
  async verifyAndWriteHeaderCells() { this.primitiveWrites += 1; }
  async updateCellsAtomicallyAcrossSheets(updates: CrossSheetCellUpdate[]) {
    this.atomicCalls.push(structuredClone(updates));
    if (this.failAtomic) throw new Error('injected atomic failure');
    const next = structuredClone(this.rows);
    for (const update of updates) {
      const rows = (next[update.sheetName] ??= []);
      while (rows.length < update.rowNumber) rows.push([]);
      rows[update.rowNumber - 1][update.columnNumber - 1] = String(update.value);
    }
    this.rows = next;
  }
}

describe('atomic classroom timezone schedule command', () => {
  it('updates only finite tasks whose effective timezone differs and leaves matching rows byte-stable', async () => {
    const store = new AtomicFake();
    const matching = { ...current, timeZone: 'America/New_York' };
    store.rows.Tasks!.splice(2, 0,
      [...taskRow('T-match', 'instance-match', matching, null), 'matching-byte-stable']);
    const matchingBefore = structuredClone(store.rows.Tasks![2]);

    const result = await changeClassTimeZone(store, 'America/New_York', { now: () => changedAt });

    expect(result.updatedTaskCount).toBe(1);
    expect(store.rows.Tasks![2]).toEqual(matchingBefore);
    expect(store.atomicCalls[0].filter((update) => update.sheetName === 'Tasks')
      .every((update) => update.rowNumber === 2)).toBe(true);
  });

  it('changes only Settings when every finite task already uses the requested timezone', async () => {
    const store = new AtomicFake();
    const matchingCurrent = { ...current, timeZone: 'America/New_York' };
    const matchingPending = { ...effectivePending, timeZone: 'America/New_York' };
    store.rows.Tasks![1] = [...taskRow('T1', 'instance-1', matchingCurrent, matchingPending), 'preserve-me'];
    const tasksBefore = structuredClone(store.rows.Tasks);

    const result = await changeClassTimeZone(store, 'America/New_York', { now: () => changedAt });

    expect(result.updatedTaskCount).toBe(0);
    expect(store.rows.Tasks).toEqual(tasksBefore);
    expect(store.atomicCalls).toHaveLength(1);
    expect(store.atomicCalls[0].every((update) => update.sheetName === 'Settings')).toBe(true);
  });

  it('rejects an out-of-order instant before the atomic business write', async () => {
    const store = new AtomicFake();
    const futureCurrent = { ...current, effectiveFrom: '2026-08-25T09:01:00.000Z' };
    store.rows.Tasks![1] = [...taskRow('T1', 'instance-1', futureCurrent, null), 'preserve-me'];
    const before = structuredClone(store.rows);

    await expect(changeClassTimeZone(store, 'UTC', { now: () => '2026-08-25T09:00:00.000Z' }))
      .rejects.toThrow(/순서|earlier|effective/i);

    expect(store.atomicCalls).toEqual([]);
    expect(store.rows).toEqual(before);
  });

  it('rejects an instant before a future finite pending schedule when the current schedule is NONE', async () => {
    const store = new AtomicFake();
    const futurePending: TaskSchedule = {
      ...current,
      ruleVersion: none.ruleVersion + 1,
      effectiveFrom: '2026-08-25T09:01:00.000Z',
      recurrence: { type: 'DAILY', time: '09:01' },
    };
    store.rows.Tasks![1] = [...taskRow('T1', 'instance-1', none, futurePending), 'preserve-me'];
    const settingsBefore = structuredClone(store.rows.Settings);
    const tasksBefore = structuredClone(store.rows.Tasks);

    await expect(changeClassTimeZone(store, 'UTC', { now: () => '2026-08-25T09:00:00.000Z' }))
      .rejects.toThrow(/순서|effectiveFrom/);

    expect(store.rows.Settings).toEqual(settingsBefore);
    expect(store.rows.Tasks).toEqual(tasksBefore);
    expect(store.atomicCalls).toEqual([]);
  });

  it('uses effective pending state, updates only finite recurrence, and upserts a missing setting in one call', async () => {
    const store = new AtomicFake();
    const noneBefore = structuredClone(store.rows.Tasks![2]);

    const result = await changeClassTimeZone(store, 'America/New_York', { now: () => changedAt });

    expect(result).toEqual({ classTimeZone: 'America/New_York', changedAt, updatedTaskCount: 1 });
    expect(store.atomicCalls).toHaveLength(1);
    expect(store.primitiveWrites).toBe(0);
    expect(store.rows.Settings).toEqual([
      ['unknown', ' value ', 'key'],
      ['keep', 'won', 'currencyUnit'],
      [undefined, 'America/New_York', 'classTimeZone'],
    ]);
    expect(store.rows.Tasks![2]).toEqual(noneBefore);
    const headers = store.rows.Tasks![0];
    const row = store.rows.Tasks![1];
    const cell = (name: string) => row[headers.indexOf(name)];
    expect(cell('ruleVersion')).toBe('3');
    expect(cell('recurrenceTimeZone')).toBe('Asia/Seoul');
    expect(cell('recurrenceType')).toBe('WEEKLY');
    expect(cell('pendingRuleVersion')).toBe('4');
    expect(cell('pendingEffectiveFrom')).toBe(changedAt);
    expect(cell('pendingTimeZone')).toBe('America/New_York');
    expect(cell('pendingRecurrenceType')).toBe('WEEKLY');
    expect(cell('pendingResetCompletionOnCycle')).toBe('FALSE');
    expect(cell('pendingResetAssignmentOnCycle')).toBe('TRUE');
    expect(row.at(-1)).toBe('preserve-me');

    const task = (await getTaskRecords(store)).find((record) => record.task.taskId === 'T1')!.task;
    const assignment: TaskAssignment = {
      assignmentId: 'A-old', taskId: 'T1', taskInstanceId: 'instance-1', cycleId: 'old-cycle',
      cycleStartsAt: '2026-08-19T00:00:00.000Z', cycleEndsAt: changedAt, ruleVersion: 3,
      timeZone: 'Asia/Seoul', studentId: 'S1', status: 'ASSIGNED', source: 'ADMIN',
      previousAssignmentId: '', createdAt: '2026-08-20T00:00:00.000Z', schemaVersion: 2, note: '',
    };
    const completion: TaskCompletion = {
      completionId: 'C-old', timestamp: '2026-08-20T01:00:00.000Z', taskId: 'T1', studentId: 'S1',
      studentName: 'Student', reward: 10, balanceBefore: 0, balanceAfter: 10, status: 'SUCCESS', note: '',
      taskInstanceId: 'instance-1', cycleId: 'old-cycle', cycleStartsAt: '2026-08-19T00:00:00.000Z',
      cycleEndsAt: changedAt, ruleVersion: 3, timeZone: 'Asia/Seoul', source: 'BANK',
      assignmentId: 'A-old', schemaVersion: 2,
    };
    const immediate = projectTaskCycleState({ task, now: changedAt, assignments: [assignment], completions: [completion] });
    expect(immediate.transition).toBe('SCHEDULE_CHANGE_FIRST_CYCLE');
    expect(immediate.students.S1).toMatchObject({
      assigned: true, completed: true, assignmentOrigin: 'CARRY', completionOrigin: 'CARRY',
    });
    const natural = projectTaskCycleState({
      task, now: '2026-09-01T15:00:00.000Z', assignments: [assignment], completions: [completion],
    });
    expect(natural.transition).toBe('NATURAL_BOUNDARY');
    expect(natural.students.S1).toMatchObject({ assigned: false, completed: true });
  });

  it('synchronizes every duplicate trimmed classTimeZone key so later-wins reads cannot stay stale', async () => {
    const store = new AtomicFake();
    store.rows.Settings = [
      ['unknown', ' value ', 'key'],
      ['first', 'Asia/Seoul', ' classTimeZone '],
      ['middle', 'won', 'currencyUnit'],
      ['later', 'Europe/Paris', 'classTimeZone'],
    ];

    await changeClassTimeZone(store, 'UTC', { now: () => changedAt });

    expect(store.rows.Settings).toEqual([
      ['unknown', ' value ', 'key'],
      ['first', 'UTC', ' classTimeZone '],
      ['middle', 'won', 'currencyUnit'],
      ['later', 'UTC', 'classTimeZone'],
    ]);
    await expect(getSheetSettings(store)).resolves.toMatchObject({ classTimeZone: 'UTC' });
  });

  it('creates a missing Settings schema, then writes timezone and tasks in exactly one atomic call', async () => {
    const store = new AtomicFake();
    delete store.rows.Settings;

    const result = await changeClassTimeZone(store, 'UTC', { now: () => changedAt });

    expect(result.updatedTaskCount).toBe(1);
    expect(store.primitiveWrites).toBe(1);
    expect(store.atomicCalls).toHaveLength(1);
    expect(store.rows.Settings?.[0]).toEqual(['key', 'value']);
    expect(store.rows.Settings?.[1]).toEqual(['classTimeZone', 'UTC']);
    expect(store.atomicCalls[0].some((update) => update.sheetName === 'Tasks')).toBe(true);
  });

  it('leaves only the empty Settings schema when the final atomic provider call fails', async () => {
    const store = new AtomicFake();
    delete store.rows.Settings;
    const tasksBefore = structuredClone(store.rows.Tasks);
    store.failAtomic = true;

    await expect(changeClassTimeZone(store, 'UTC', { now: () => changedAt })).rejects.toThrow('injected');

    expect(store.rows.Settings).toEqual([['key', 'value']]);
    expect(store.rows.Tasks).toEqual(tasksBefore);
    expect(store.atomicCalls).toHaveLength(1);
  });

  it('validates task chronology before creating a missing Settings sheet', async () => {
    const store = new AtomicFake();
    delete store.rows.Settings;
    const futureCurrent = { ...current, effectiveFrom: '2026-08-25T10:01:00.000Z' };
    store.rows.Tasks![1] = [...taskRow('T1', 'instance-1', futureCurrent, null), 'preserve-me'];

    await expect(changeClassTimeZone(store, 'UTC', { now: () => changedAt })).rejects.toThrow(/순서|effectiveFrom/);

    expect(store.rows.Settings).toBeUndefined();
    expect(store.primitiveWrites).toBe(0);
    expect(store.atomicCalls).toEqual([]);
  });

  it('validates corrupted task schedule data before creating a missing Settings sheet', async () => {
    const store = new AtomicFake();
    delete store.rows.Settings;
    const recurrenceTypeIndex = store.rows.Tasks![0].indexOf('recurrenceType');
    store.rows.Tasks![1][recurrenceTypeIndex] = 'BROKEN';

    await expect(changeClassTimeZone(store, 'UTC', { now: () => changedAt })).rejects.toThrow(/손상|복구/);

    expect(store.rows.Settings).toBeUndefined();
    expect(store.primitiveWrites).toBe(0);
    expect(store.atomicCalls).toEqual([]);
  });

  it('handles a structured concurrent Settings-create race by rereading the canonical sheet', async () => {
    const store = new AtomicFake();
    delete store.rows.Settings;
    store.createSheetWithHeader = async (name, headers) => {
      store.rows[name] = [[...headers]];
      throw new SheetProviderError('SHEET_ALREADY_EXISTS', 'localized provider text');
    };

    await changeClassTimeZone(store, 'UTC', { now: () => changedAt });

    expect(store.rows.Settings?.[1]).toEqual(['classTimeZone', 'UTC']);
    expect(store.atomicCalls).toHaveLength(1);
  });

  it('validates timezone and atomic capability before migration or any write', async () => {
    const invalid = new AtomicFake();
    await expect(changeClassTimeZone(invalid, '+09:00')).rejects.toThrow('올바른 IANA 시간대');
    expect(invalid.primitiveWrites).toBe(0);
    expect(invalid.atomicCalls).toEqual([]);

    const unsupported = new AtomicFake();
    unsupported.updateCellsAtomicallyAcrossSheets = undefined as never;
    await expect(changeClassTimeZone(unsupported, 'UTC')).rejects.toThrow('원자적 다중 시트 업데이트');
    expect(unsupported.primitiveWrites).toBe(0);
  });

  it('stops a failed migration before changing Settings or Tasks business values', async () => {
    const store = new AtomicFake();
    const before = structuredClone(store.rows);
    store.lookupSheet = async () => { throw new Error('injected migration preflight failure'); };

    await expect(changeClassTimeZone(store, 'UTC', { now: () => changedAt }))
      .rejects.toThrow('migration preflight');
    expect(store.rows).toEqual(before);
    expect(store.atomicCalls).toEqual([]);
    expect(store.primitiveWrites).toBe(0);
  });

  it('leaves both Settings and Tasks unchanged for any provider failure', async () => {
    const store = new AtomicFake();
    const before = structuredClone(store.rows);
    store.failAtomic = true;

    await expect(changeClassTimeZone(store, 'UTC', { now: () => changedAt })).rejects.toThrow('injected');
    expect(store.rows).toEqual(before);
    expect(store.atomicCalls).toHaveLength(1);
    expect(store.primitiveWrites).toBe(0);
  });
});
