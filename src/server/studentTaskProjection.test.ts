import { describe, expect, it } from 'vitest';
import type { TaskCycleProjectionDto } from '@/server/repositories/sheets/taskHistoryQueries';
import { buildEnrichedStudentTaskProjection, buildStudentTaskProjection } from './studentTaskProjection';

const NOW = '2026-08-27T12:00:00.000Z';

function task(overrides: Partial<TaskCycleProjectionDto> = {}): TaskCycleProjectionDto {
  return {
    taskId: 'T1',
    taskInstanceId: 'instance-T1',
    title: '읽기',
    description: '10쪽 읽기',
    reward: 5,
    isActive: true,
    sortOrder: 1,
    allowedStudentIds: ['S1', 'S2'],
    createdAt: '2026-08-01T00:00:00.000Z',
    currentCycle: {
      cycleId: 'cycle-T1',
      startsAt: '2026-08-27T00:00:00.000Z',
      endsAt: '2026-08-28T00:00:00.000Z',
      transition: 'NATURAL_BOUNDARY',
      assignedStudentIds: ['S1', 'S2'],
      completedStudentIds: ['S2'],
      students: [
        { studentId: 'S1', assigned: true, completed: false, assignmentOrigin: 'LEGACY', completionOrigin: 'DEFAULT' },
        { studentId: 'S2', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' },
      ],
    },
    ...overrides,
  } as TaskCycleProjectionDto;
}

describe('buildStudentTaskProjection', () => {
  it('matches the established DTO while applying active and [availableFrom, dueAt) visibility', () => {
    const schedule = {
      ruleVersion: 1,
      effectiveFrom: '2026-08-01T00:00:00.000Z',
      timeZone: 'UTC',
      recurrence: { type: 'DAILY' as const, time: '09:00' },
      resetCompletionOnCycle: true,
      resetAssignmentOnCycle: false,
    };
    const pendingSchedule = {
      ...schedule,
      ruleVersion: 2,
      effectiveFrom: '2026-08-27T00:00:00.000Z',
      recurrence: { type: 'WEEKLY' as const, weekdays: [1, 4] as const, time: '10:00' },
    };

    const result = buildStudentTaskProjection([
      task({ availableFrom: NOW, dueAt: '2026-08-27T13:00:00.000Z', schedule, pendingSchedule }),
      task({ taskId: 'INACTIVE', isActive: false }),
      task({ taskId: 'FUTURE', availableFrom: '2026-08-27T12:00:00.001Z' }),
      task({ taskId: 'DUE', dueAt: NOW }),
    ], 'S1', NOW);

    expect(result).toEqual([{
      taskId: 'T1',
      title: '읽기',
      description: '10쪽 읽기',
      reward: 5,
      sortOrder: 1,
      availableFrom: NOW,
      dueAt: '2026-08-27T13:00:00.000Z',
      recurrence: { type: 'WEEKLY', weekdays: [1, 4], time: '10:00' },
      studentStatus: { studentId: 'S1', assigned: true, completed: false },
    }]);
  });

  it('uses an allowlist DTO that denies cycle, schedule, provider, balance, and other-student data', () => {
    const projection = task({
      scheduleReadWarnings: ['INVALID_CURRENT_SCHEDULE'],
      studentStatus: {
        studentId: 'S2', assigned: true, completed: true,
        assignmentOrigin: 'EVENT', completionOrigin: 'EVENT',
      },
      spreadsheetRow: 42,
      providerToken: 'secret',
      balance: 999,
    } as Partial<TaskCycleProjectionDto>);

    const [result] = buildStudentTaskProjection([projection], 'S1', NOW);
    const serialized = JSON.stringify(result);
    const denied = [
      'taskInstanceId', 'isActive', 'allowedStudentIds', 'createdAt', 'currentCycle',
      'cycleId', 'startsAt', 'endsAt', 'transition', 'assignedStudentIds',
      'completedStudentIds', 'students', 'schedule', 'pendingSchedule',
      'scheduleReadWarnings', 'spreadsheetRow', 'providerToken', 'balance',
      'assignmentOrigin', 'completionOrigin', 'S2',
    ];

    for (const key of denied) expect(serialized).not.toContain(key);
    expect(result).toEqual({
      taskId: 'T1', title: '읽기', description: '10쪽 읽기', reward: 5, sortOrder: 1,
      studentStatus: { studentId: 'S1', assigned: true, completed: false },
    });
  });

  it('links only visible assigned prerequisites while retaining safe prerequisite semantics', () => {
    const projections = [
      task({ taskId: 'A', title: '완료한 선행', currentCycle: {
        ...task().currentCycle,
        students: [{ studentId: 'S1', assigned: true, completed: true, assignmentOrigin: 'EVENT', completionOrigin: 'EVENT' }],
      } }),
      task({ taskId: 'B', title: '연결된 후행', prerequisiteTaskId: 'A' }),
      task({ taskId: 'C', title: '미배정 선행', currentCycle: {
        ...task().currentCycle,
        students: [{ studentId: 'S1', assigned: false, completed: false, assignmentOrigin: 'DEFAULT', completionOrigin: 'DEFAULT' }],
      } }),
      task({ taskId: 'D', title: '연결 안 된 후행', prerequisiteTaskId: 'C' }),
      task({ taskId: 'E', title: '비활성 선행', isActive: false }),
      task({ taskId: 'F', title: '불가능한 후행', prerequisiteTaskId: 'E' }),
    ];

    const result = buildStudentTaskProjection(projections, 'S1', NOW);

    expect(result.find(({ taskId }) => taskId === 'B')).toMatchObject({
      prerequisiteTaskId: 'A', prerequisiteTitle: '완료한 선행', prerequisiteStatus: 'SATISFIED',
    });
    expect(result.find(({ taskId }) => taskId === 'B')).not.toHaveProperty('prerequisiteMessage');
    expect(result.find(({ taskId }) => taskId === 'D')).toMatchObject({
      prerequisiteTitle: '미배정 선행', prerequisiteStatus: 'REQUIRED',
      prerequisiteMessage: "선행 과제 '미배정 선행'을(를) 먼저 완료해 주세요.",
    });
    expect(result.find(({ taskId }) => taskId === 'D')).not.toHaveProperty('prerequisiteTaskId');
    expect(result.find(({ taskId }) => taskId === 'F')).toMatchObject({
      prerequisiteTitle: '비활성 선행', prerequisiteStatus: 'UNAVAILABLE',
      prerequisiteMessage: "선행 과제 '비활성 선행'을(를) 완료할 수 없습니다. 교사에게 문의해 주세요.",
    });
    expect(result.find(({ taskId }) => taskId === 'F')).not.toHaveProperty('prerequisiteTaskId');
  });

  it('retains legacy assignment fallback when partial current-cycle arrays omit the student', () => {
    const projection = task({
      allowedStudentIds: ['S1', 'S2'],
      currentCycle: {
        ...task().currentCycle,
        assignedStudentIds: ['S2'],
        completedStudentIds: [],
        students: [{ studentId: 'S2', assigned: true, completed: false, assignmentOrigin: 'EVENT', completionOrigin: 'DEFAULT' }],
      },
    });

    expect(buildStudentTaskProjection([projection], 'S1', NOW)[0].studentStatus).toEqual({
      studentId: 'S1', assigned: false, completed: false,
    });

    const legacyProjection = task({ currentCycle: { cycleId: 'legacy-cycle' } as TaskCycleProjectionDto['currentCycle'] });
    expect(buildStudentTaskProjection([legacyProjection], 'S1', NOW)[0].studentStatus).toEqual({
      studentId: 'S1', assigned: true,
    });
  });
});

describe('buildEnrichedStudentTaskProjection', () => {
  it('adds only safe Padlet eligibility fields while leaving non-Padlet tasks unchanged', async () => {
    const verifyPadlet = async () => new Map([['PADLET', {
      status: 'READY' as const,
      message: 'Padlet 게시물이 확인되어 완료할 수 있습니다.',
    }]]);
    const projections = [
      task({ taskId: 'PADLET', padletBoardId: 'BOARD000000000001' }),
      task({ taskId: 'PLAIN', padletBoardId: undefined }),
    ];

    const result = await buildEnrichedStudentTaskProjection(
      projections, 'S1', '김민준', NOW, { verifyPadlet },
    );

    expect(result.find(({ taskId }) => taskId === 'PADLET')).toMatchObject({
      padletEligibility: 'READY',
      padletEligibilityMessage: 'Padlet 게시물이 확인되어 완료할 수 있습니다.',
    });
    expect(result.find(({ taskId }) => taskId === 'PLAIN')).not.toHaveProperty('padletEligibility');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('BOARD000000000001');
    expect(serialized).not.toContain('postId');
    expect(serialized).not.toContain('author');
  });
});
