import { describe, expect, it } from 'vitest';
import type { TaskAssignmentStatus } from '@/domain/types';
import { normalizeTaskAssignmentStatus, reconcileTaskAssignmentProjection } from './taskAssignmentProjection';

const status: TaskAssignmentStatus = {
  taskId: 'T001',
  cycleId: 'cycle-2',
  startsAt: '2026-08-25T00:00:00.000Z',
  endsAt: '2026-08-26T00:00:00.000Z',
  transition: 'NATURAL_BOUNDARY',
  students: [
    { studentId: 'S001', name: '김민준', assigned: true, completed: true },
    { studentId: 'S002', name: '이서연', assigned: false, completed: false, assignmentOrigin: 'EVENT', assignmentSource: 'QR', completionOrigin: 'DEFAULT' },
  ],
};

describe('taskAssignmentProjection', () => {
  it('normalizes missing origins and derives assigned/completed ids', () => {
    expect(normalizeTaskAssignmentStatus(status)).toMatchObject({
      assignedIds: ['S001'],
      completedIds: ['S001'],
      statusRows: [
        { studentId: 'S001', assignmentOrigin: 'DEFAULT', completionOrigin: 'DEFAULT' },
        { studentId: 'S002', assignmentOrigin: 'EVENT', assignmentSource: 'QR', completionOrigin: 'DEFAULT' },
      ],
    });
  });

  it('replaces the matching task current-cycle projection without mutating other tasks', () => {
    const tasks = [
      { taskId: 'T001', title: '읽기', description: '', reward: 1, isActive: true, sortOrder: 1, allowedStudentIds: [], currentCycle: { cycleId: 'old', startsAt: 'old-start', endsAt: null, transition: 'PERMANENT' as const, assignedStudentIds: [], completedStudentIds: [], students: [] } },
      { taskId: 'T002', title: '쓰기', description: '', reward: 1, isActive: true, sortOrder: 2, allowedStudentIds: [] },
    ];
    const normalized = normalizeTaskAssignmentStatus(status);
    const result = reconcileTaskAssignmentProjection(tasks, 'T001', normalized);

    expect(result[0]).toMatchObject({
      allowedStudentIds: ['S001'],
      currentCycle: {
        cycleId: 'cycle-2',
        startsAt: '2026-08-25T00:00:00.000Z',
        endsAt: '2026-08-26T00:00:00.000Z',
        transition: 'NATURAL_BOUNDARY',
        assignedStudentIds: ['S001'],
        completedStudentIds: ['S001'],
      },
    });
    expect(result[0].currentCycle?.students[1]).toMatchObject({ assignmentOrigin: 'EVENT', assignmentSource: 'QR' });
    expect(result[1]).toBe(tasks[1]);
  });
});
