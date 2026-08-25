import { describe, expect, it, vi } from 'vitest';
import type { ClassTask } from '@/domain/types';
import { readTaskCycleHistory, readTaskCycleState } from './taskCycleQueries';

const assignmentHeaders = ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'];
const completionHeaders = ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion'];
const task: ClassTask = {
  taskId: 'T1', taskInstanceId: 'I1', title: 'Read', description: '', reward: 5, isActive: true,
  sortOrder: 1, allowedStudentIds: [], createdAt: '2026-08-20T00:00:00Z',
  schedule: { ruleVersion: 1, effectiveFrom: '2026-08-20T00:00:00Z', timeZone: 'UTC', recurrence: { type: 'DAILY', time: '00:00' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false },
};

describe('task cycle sheet queries', () => {
  it('reads ledger rows in physical order and performs no writes or migration/materialization', async () => {
    const store = {
      getRows: vi.fn(async (sheet: string) => sheet === 'TaskAssignments'
        ? [assignmentHeaders,
            ['A1', 'T1', 'I1', 'v1|I1|r1|2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '1', 'UTC', 'S1', 'ASSIGNED', 'ADMIN', '', '2026-08-24T23:00:00Z', '2', ''],
            ['A2', 'T1', 'I1', 'v1|I1|r1|2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '1', 'UTC', 'S1', 'UNASSIGNED', 'ADMIN', 'A1', '2026-08-24T01:00:00Z', '2', '']]
        : [completionHeaders]),
      appendRow: vi.fn(), updateCell: vi.fn(), updateCells: vi.fn(), updateHeaderRow: vi.fn(),
      migrateRecurringSchema: vi.fn(), materializeTaskCycle: vi.fn(),
    };
    const state = await readTaskCycleState(store, task, '2026-08-24T12:00:00Z');
    expect(state.students.S1.assigned).toBe(false);
    expect(store.getRows).toHaveBeenCalledTimes(2);
    expect(store.appendRow).not.toHaveBeenCalled();
    expect(store.updateCell).not.toHaveBeenCalled();
    expect(store.updateCells).not.toHaveBeenCalled();
    expect(store.updateHeaderRow).not.toHaveBeenCalled();
    expect(store.migrateRecurringSchema).not.toHaveBeenCalled();
    expect(store.materializeTaskCycle).not.toHaveBeenCalled();
  });

  it('keeps the source from the latest physical assignment ledger row in the current projection', async () => {
    const store = {
      getRows: vi.fn(async (sheet: string) => sheet === 'TaskAssignments'
        ? [assignmentHeaders,
            ['A1', 'T1', 'I1', 'v1|I1|r1|2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '1', 'UTC', 'S1', 'ASSIGNED', 'ADMIN', '', '2026-08-24T10:00:00Z', '2', ''],
            ['A2', 'T1', 'I1', 'v1|I1|r1|2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '1', 'UTC', 'S1', 'ASSIGNED', 'QR', 'A1', '2026-08-24T01:00:00Z', '2', '']]
        : [completionHeaders]),
    };

    const state = await readTaskCycleState(store, task, '2026-08-24T12:00:00Z');
    expect(state.students.S1).toMatchObject({
      assigned: true,
      assignmentOrigin: 'EVENT',
      assignmentEvent: { assignmentId: 'A2', source: 'QR' },
    });
  });

  it('uses allowedStudentIds when the adapter represents a missing TaskAssignments sheet as []', async () => {
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') return [];
        return [completionHeaders];
      },
    };
    const state = await readTaskCycleState(reader, { ...task, allowedStudentIds: ['S2'] }, '2026-08-24T12:00:00Z');
    expect(state.students.S2).toMatchObject({ assigned: true, assignmentOrigin: 'LEGACY' });
  });

  it('propagates arbitrary TaskAssignments read failures instead of treating them as a missing sheet', async () => {
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') throw new Error('authorization/network failure');
        return [completionHeaders];
      },
    };

    await expect(readTaskCycleState(reader, task, '2026-08-24T12:00:00Z'))
      .rejects.toThrow('authorization/network failure');
  });

  it('fails fast when a present TaskAssignments sheet is missing a required header', async () => {
    const malformedHeaders = assignmentHeaders.filter((header) => header !== 'status');
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') return [malformedHeaders];
        return [completionHeaders];
      },
    };

    await expect(readTaskCycleState(reader, task, '2026-08-24T12:00:00Z'))
      .rejects.toThrow('TaskAssignments 시트에 필수 컬럼이 없습니다: status');
  });

  it('accepts unknown trailing TaskAssignments columns', async () => {
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') return [
          [...assignmentHeaders, 'futureMetadata'],
          ['A1', 'T1', 'I1', 'v1|I1|r1|2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '1', 'UTC', 'S1', 'ASSIGNED', 'ADMIN', '', '2026-08-24T01:00:00Z', '2', '', 'preserve-compatible-read'],
        ];
        return [completionHeaders];
      },
    };

    await expect(readTaskCycleState(reader, task, '2026-08-24T12:00:00Z')).resolves.toMatchObject({
      students: { S1: { assigned: true } },
    });
  });

  it('fails fast when TaskCompletions is missing a required header', async () => {
    const malformedHeaders = completionHeaders.filter((header) => header !== 'status');
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') return [];
        return [
          malformedHeaders,
          ['C1', '2026-08-24T02:00:00Z', 'T1', 'S1', 'One', '5', '0', '5', '', 'I1'],
        ];
      },
    };

    await expect(readTaskCycleState(reader, task, '2026-08-24T12:00:00Z'))
      .rejects.toThrow('TaskCompletions 시트에 필수 컬럼이 없습니다: status');
  });

  it('accepts unknown trailing TaskCompletions columns', async () => {
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') return [];
        return [
          [...completionHeaders, 'futureMetadata'],
          ['C1', '2026-08-24T02:00:00Z', 'T1', 'S1', 'One', '5', '0', '5', 'SUCCESS', '', 'I1', 'v1|I1|r1|2026-08-24T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-25T00:00:00Z', '1', 'UTC', 'BANK', '', '2', 'preserve-compatible-read'],
        ];
      },
    };

    await expect(readTaskCycleState(reader, task, '2026-08-24T12:00:00Z')).resolves.toMatchObject({
      students: { S1: { completed: true } },
    });
  });

  it('restores deleted-task history DTOs solely from assignment/completion event snapshots', async () => {
    const reader = {
      async getRows(sheet: string) {
        if (sheet === 'TaskAssignments') return [assignmentHeaders,
          ['A9', 'DELETED', 'OLD-I', 'old-cycle', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', '3', 'Asia/Seoul', 'S9', 'ASSIGNED', 'QR', '', '2026-08-01T00:01:00Z', '2', 'snapshot only']];
        return [completionHeaders,
          ['C9', '2026-08-01T01:00:00Z', 'DELETED', 'S9', 'Past Student', '7', '10', '17', 'SUCCESS', 'done', 'OLD-I', 'old-cycle', '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', '3', 'Asia/Seoul', 'BANK', 'A9', '2']];
      },
    };
    const history = await readTaskCycleHistory(reader, { taskInstanceId: 'OLD-I' });
    expect(history).toEqual([
      expect.objectContaining({ eventType: 'ASSIGNMENT', eventId: 'A9', taskId: 'DELETED', taskInstanceId: 'OLD-I', cycleId: 'old-cycle', studentId: 'S9', assignmentStatus: 'ASSIGNED' }),
      expect.objectContaining({ eventType: 'COMPLETION', eventId: 'C9', taskId: 'DELETED', taskInstanceId: 'OLD-I', cycleId: 'old-cycle', studentId: 'S9', studentName: 'Past Student', reward: 7, completionSource: 'BANK' }),
    ]);
    expect(history[0]).not.toHaveProperty('taskTitle');
  });
});
