import { describe, expect, it } from 'vitest';
import type { TaskCycleHistoryEvent } from '@/domain/taskCycleHistory';
import type { TaskHistoryDetailDto, TaskHistoryStudentDto } from '@/domain/taskHistoryDtos';
import { PENDING_ASSIGNMENT_NOTE } from '@/domain/taskStage';
import {
  buildTaskHistoryView,
  formatCycleRange,
  formatDayLabel,
  formatTime,
  withObjectParticle,
  type TaskHistoryView,
} from './adminTaskHistory';

const NOW = '2026-10-06T05:00:00.000Z'; // 2026-10-06(화) 14:00 KST
const LAST_WEEK = {
  cycleId: 'v1|I1|r1|2026-09-27T15:00:00Z', cycleStartsAt: '2026-09-27T15:00:00.000Z',
  cycleEndsAt: '2026-10-04T15:00:00.000Z', ruleVersion: 1,
};
const THIS_WEEK = {
  cycleId: 'v1|I1|r2|2026-10-04T15:00:00Z', cycleStartsAt: '2026-10-04T15:00:00.000Z',
  cycleEndsAt: '2026-10-11T15:00:00.000Z', ruleVersion: 2,
};
type Cycle = typeof THIS_WEEK;

const STUDENTS: TaskHistoryStudentDto[] = [
  { studentId: 'S001', name: '김민준', deleted: false },
  { studentId: 'S002', name: '이서연', deleted: false },
  { studentId: 'S003', name: '박도윤', deleted: false },
  { studentId: 'S004', name: '최하은', deleted: true },
];

function assignment(eventId: string, studentId: string, occurredAt: string, cycle: Cycle, overrides: Partial<Extract<TaskCycleHistoryEvent, { eventType: 'ASSIGNMENT' }>> = {}): TaskCycleHistoryEvent {
  return {
    eventType: 'ASSIGNMENT', eventId, occurredAt, taskId: 'T001', taskInstanceId: 'I1', ...cycle,
    timeZone: 'Asia/Seoul', studentId, assignmentStatus: 'ASSIGNED', assignmentSource: 'ADMIN', note: '', ...overrides,
  };
}

function completion(eventId: string, studentId: string, occurredAt: string, cycle: Cycle, overrides: Partial<Extract<TaskCycleHistoryEvent, { eventType: 'COMPLETION' }>> = {}): TaskCycleHistoryEvent {
  return {
    eventType: 'COMPLETION', eventId, occurredAt, taskId: 'T001', taskInstanceId: 'I1', ...cycle,
    timeZone: 'Asia/Seoul', studentId, studentName: `${studentId} 이름`, completionStatus: 'SUCCESS', completionSource: 'BANK',
    reward: 120, balanceBefore: 1000, balanceAfter: 1120, note: 'bank-self-completion', ...overrides,
  };
}

function detail(events: TaskCycleHistoryEvent[], overrides: Partial<TaskHistoryDetailDto> = {}): TaskHistoryDetailDto {
  return {
    taskId: 'T001',
    requestedTaskInstanceId: null,
    currentLifecycle: {
      taskDefinitionExists: true,
      taskInstanceId: 'I1',
      currentCycleStatus: {
        cycleId: THIS_WEEK.cycleId, startsAt: THIS_WEEK.cycleStartsAt, endsAt: THIS_WEEK.cycleEndsAt,
        transition: 'NATURAL_BOUNDARY', assignedStudentIds: ['S001', 'S002', 'S003'], pendingStudentIds: ['S003'],
        readyStudentIds: ['S002'], completedStudentIds: ['S001'], students: [],
      },
    },
    cumulativeHistory: {
      eventCount: events.length,
      lifecycles: [{
        taskInstanceId: 'I1', isCurrentLifecycle: true, eventCount: events.length,
        firstOccurredAt: events[0]?.occurredAt ?? NOW, lastOccurredAt: events.at(-1)?.occurredAt ?? NOW,
        events: [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)),
      }],
    },
    students: STUDENTS,
    ...overrides,
  };
}

const texts = (view: TaskHistoryView) => view.sections.flatMap((section) => section.cycles)
  .flatMap((cycle) => cycle.days.flatMap((day) => day.entries.map((entry) => entry.text)));

describe('buildTaskHistoryView', () => {
  it('writes each action as one plain sentence with the student name', () => {
    const view = buildTaskHistoryView(detail([
      assignment('a1', 'S001', '2026-10-05T00:10:00.000Z', THIS_WEEK),
      completion('c1', 'S001', '2026-10-05T01:00:00.000Z', THIS_WEEK),
      assignment('a2', 'S002', '2026-10-05T02:00:00.000Z', THIS_WEEK, { note: PENDING_ASSIGNMENT_NOTE }),
      assignment('a3', 'S002', '2026-10-05T03:00:00.000Z', THIS_WEEK),
      assignment('a4', 'S002', '2026-10-05T04:00:00.000Z', THIS_WEEK, { note: PENDING_ASSIGNMENT_NOTE }),
      assignment('a5', 'S003', '2026-10-05T05:00:00.000Z', THIS_WEEK, { assignmentStatus: 'UNASSIGNED' }),
      completion('c2', 'S003', '2026-10-05T06:00:00.000Z', THIS_WEEK, { completionSource: 'ADMIN', reward: 0, balanceAfter: 1000, note: 'admin-completion' }),
      completion('c3', 'S003', '2026-10-05T07:00:00.000Z', THIS_WEEK, { completionSource: 'ADMIN_RESET', completionStatus: 'RESET', reward: 0, balanceAfter: 1000, note: 'admin-completion-reset' }),
      completion('c4', 'S001', '2026-10-05T08:00:00.000Z', THIS_WEEK, { completionSource: 'ADMIN_RESET', completionStatus: 'RESET', reward: 120, balanceBefore: 1120, balanceAfter: 1000, note: 'cancels-completion:c1' }),
    ]), { now: NOW });

    expect(texts(view)).toEqual([
      '김민준 학생의 보상 120원을 취소했어요',
      '박도윤 학생의 완료 기록을 초기화했어요',
      '선생님이 박도윤 학생을 완료 처리했어요(보상 없음)',
      '박도윤 학생의 과제 부여를 해제했어요',
      '이서연 학생을 미완료로 바꿨어요',
      '이서연 학생을 완료 가능으로 바꿨어요',
      '이서연 학생에게 과제를 미완료로 부여했어요',
      '김민준 학생이 완료해서 보상 120원을 받았어요',
      '김민준 학생에게 과제를 부여했어요',
    ]);
    const kinds = view.sections[0].cycles[0].days[0].entries.map((entry) => entry.kind);
    expect(kinds).toEqual(['cancel', 'reset', 'adminComplete', 'unassign', 'toPending', 'toReady', 'assignPending', 'complete', 'assign']);
    expect(view.sections[0].cycles[0].days[0].entries.at(-1)?.time).toBe('오전 9:10');
  });

  it('uses the class currency unit with the right particle and omits a zero reward', () => {
    const view = buildTaskHistoryView(detail([
      completion('c1', 'S001', '2026-10-05T01:00:00.000Z', THIS_WEEK, { reward: 30 }),
      completion('c2', 'S002', '2026-10-05T02:00:00.000Z', THIS_WEEK, { reward: 0, balanceAfter: 1000 }),
    ]), { now: NOW, currencyUnit: '포인트' });
    expect(texts(view)).toEqual(['이서연 학생이 과제를 완료했어요', '김민준 학생이 완료해서 보상 30포인트를 받았어요']);
    expect(withObjectParticle('1,000원')).toBe('1,000원을');
    expect(withObjectParticle('5')).toBe('5를');
    expect(withObjectParticle('7')).toBe('7을');
  });

  it('names students from the class list, marks removed students, and falls back to snapshots', () => {
    const events = [
      assignment('a1', 'S004', '2026-10-05T00:00:00.000Z', THIS_WEEK),
      completion('c1', 'S005', '2026-10-05T01:00:00.000Z', THIS_WEEK, { studentName: '정우진' }),
      assignment('a2', 'S006', '2026-10-05T02:00:00.000Z', THIS_WEEK),
    ];
    expect(texts(buildTaskHistoryView(detail(events), { now: NOW }))).toEqual([
      '삭제된 학생에게 과제를 부여했어요',
      '정우진(삭제됨) 학생이 완료해서 보상 120원을 받았어요',
      '최하은(삭제됨) 학생에게 과제를 부여했어요',
    ]);
    // Older servers and the Sheets mode send no name list: snapshots, then IDs.
    expect(texts(buildTaskHistoryView(detail(events, { students: undefined }), { now: NOW }))).toEqual([
      'S006 학생에게 과제를 부여했어요',
      '정우진 학생이 완료해서 보상 120원을 받았어요',
      'S004 학생에게 과제를 부여했어요',
    ]);
  });

  it('merges one action on several students at the same minute into one line', () => {
    const view = buildTaskHistoryView(detail([
      assignment('a1', 'S001', '2026-10-05T00:10:00.000Z', THIS_WEEK),
      assignment('a2', 'S002', '2026-10-05T00:10:00.000Z', THIS_WEEK),
      assignment('a3', 'S003', '2026-10-05T00:10:20.000Z', THIS_WEEK),
      assignment('a4', 'S004', '2026-10-05T00:10:30.000Z', THIS_WEEK),
      assignment('a5', 'S005', '2026-10-05T00:11:00.000Z', THIS_WEEK),
    ]), { now: NOW });
    const entries = view.sections[0].cycles[0].days[0].entries;
    expect(entries.map((entry) => entry.text)).toEqual([
      '삭제된 학생에게 과제를 부여했어요',
      '김민준, 이서연, 박도윤 학생 외 1명에게 과제를 부여했어요',
    ]);
    expect(entries[1].students.map((student) => student.studentId)).toEqual(['S001', 'S002', 'S003', 'S004']);
    expect(entries[1].hiddenCount).toBe(1);
    expect(view.counts).toEqual({ all: 2, assign: 2, complete: 0, reset: 0 });
  });

  it('summarises carried-over and seeded rows instead of listing them', () => {
    const view = buildTaskHistoryView(detail([
      assignment('a1', 'S001', '2026-09-28T00:00:00.000Z', LAST_WEEK, { note: PENDING_ASSIGNMENT_NOTE }),
      assignment('seed', 'S002', '2026-09-28T01:00:00.000Z', LAST_WEEK, { assignmentSource: 'LEGACY_SEED', note: '' }),
      assignment('a2', 'S002', '2026-09-28T01:00:00.000Z', LAST_WEEK, { note: PENDING_ASSIGNMENT_NOTE }),
      completion('c1', 'S003', '2026-09-28T02:00:00.000Z', LAST_WEEK),
      assignment('carry1', 'S001', '2026-10-05T00:00:00.000Z', THIS_WEEK, { assignmentSource: 'CARRY_FORWARD', note: PENDING_ASSIGNMENT_NOTE }),
      completion('carry2', 'S003', '2026-10-05T00:00:00.000Z', THIS_WEEK, { completionSource: 'CARRY_FORWARD', reward: 0, balanceAfter: 1000 }),
      assignment('a3', 'S001', '2026-10-05T00:00:00.000Z', THIS_WEEK),
    ]), { now: NOW });

    const [current, previous] = view.sections[0].cycles;
    expect(current.carried.map((student) => student.name)).toEqual(['김민준', '박도윤']);
    expect(current.days.flatMap((day) => day.entries.map((entry) => entry.text))).toEqual(['김민준 학생을 완료 가능으로 바꿨어요']);
    expect(previous.seeded.map((student) => student.name)).toEqual(['이서연']);
    // The seeded 완료 가능 state makes the next 미완료 write a change, not a new assignment.
    expect(previous.days[0].entries.map((entry) => entry.text)).toEqual([
      '박도윤 학생이 완료해서 보상 120원을 받았어요',
      '이서연 학생을 미완료로 바꿨어요',
      '김민준 학생에게 과제를 미완료로 부여했어요',
    ]);
    expect(JSON.stringify(view)).not.toMatch(/CARRY_FORWARD|LEGACY_SEED/);
  });

  it('groups by cycle and day, newest first, with readable ranges and labels', () => {
    const view = buildTaskHistoryView(detail([
      assignment('a1', 'S001', '2026-09-28T00:00:00.000Z', LAST_WEEK),
      assignment('a2', 'S002', '2026-10-05T03:00:00.000Z', THIS_WEEK),
      completion('c1', 'S002', '2026-10-06T00:12:00.000Z', THIS_WEEK),
      completion('c2', 'S001', '2026-10-06T04:30:00.000Z', THIS_WEEK),
    ]), { now: NOW });

    const cycles = view.sections[0].cycles;
    expect(cycles.map((cycle) => [cycle.label, cycle.range, cycle.isCurrent, cycle.scheduleChanged])).toEqual([
      ['이번 회차', '10월 5일(월) ~ 10월 11일(일)', true, true],
      ['지난 회차', '9월 28일(월) ~ 10월 4일(일)', false, false],
    ]);
    expect(cycles[0].days.map((day) => day.label)).toEqual(['오늘 · 10월 6일(화)', '어제 · 10월 5일(월)']);
    expect(cycles[0].days[0].entries.map((entry) => entry.time)).toEqual(['오후 1:30', '오전 9:12']);
    expect(view.summary).toEqual({
      label: '이번 회차', range: '10월 5일(월) ~ 10월 11일(일)', assigned: 3, completed: 1, pending: 1,
    });
    expect(view.singlePermanentCycle).toBe(false);
  });

  it('filters by kind and searches by student name or ID', () => {
    const events = [
      assignment('a1', 'S001', '2026-10-05T00:00:00.000Z', THIS_WEEK),
      assignment('a2', 'S002', '2026-10-05T00:00:00.000Z', THIS_WEEK),
      completion('c1', 'S002', '2026-10-05T01:00:00.000Z', THIS_WEEK),
      completion('c2', 'S002', '2026-10-05T02:00:00.000Z', THIS_WEEK, { completionSource: 'ADMIN_RESET', completionStatus: 'RESET', reward: 0, balanceAfter: 1000 }),
      assignment('carry', 'S003', '2026-10-05T00:00:00.000Z', THIS_WEEK, { assignmentSource: 'CARRY_FORWARD' }),
    ];
    const all = buildTaskHistoryView(detail(events), { now: NOW });
    expect(all.counts).toEqual({ all: 3, assign: 1, complete: 1, reset: 1 });

    const resets = buildTaskHistoryView(detail(events), { now: NOW, filter: 'reset' });
    expect(texts(resets)).toEqual(['이서연 학생의 완료 기록을 초기화했어요']);
    expect(resets.sections[0].cycles[0].carried).toEqual([]);

    const searched = buildTaskHistoryView(detail(events), { now: NOW, query: ' 서 연 ' });
    expect(texts(searched)).toEqual([
      '이서연 학생의 완료 기록을 초기화했어요',
      '이서연 학생이 완료해서 보상 120원을 받았어요',
      '이서연 학생에게 과제를 부여했어요',
    ]);
    expect(texts(buildTaskHistoryView(detail(events), { now: NOW, query: 's001' }))).toEqual(['김민준 학생에게 과제를 부여했어요']);
    const none = buildTaskHistoryView(detail(events), { now: NOW, query: '없는 이름' });
    expect(none.sections).toEqual([]);
    expect(none.visibleCount).toBe(0);
  });

  it('separates earlier tasks with the same ID and pre-cycle legacy rows', () => {
    const legacy: TaskCycleHistoryEvent = {
      eventType: 'COMPLETION', eventId: 'legacy', occurredAt: '2026-03-02T00:00:00.000Z', taskId: 'T001', studentId: 'S001',
      studentName: '김민준', completionStatus: 'SUCCESS', reward: 50, balanceBefore: 0, balanceAfter: 50, note: '',
    };
    const old = assignment('old', 'S002', '2026-04-01T00:00:00.000Z', { ...LAST_WEEK, cycleId: 'old-cycle' }, { taskInstanceId: 'I0' });
    const checkpoint = { ...legacy, eventId: 'legacy-pending', completionStatus: 'PENDING' } as TaskCycleHistoryEvent;
    const base = detail([assignment('a1', 'S001', '2026-10-05T00:00:00.000Z', THIS_WEEK)]);
    const view = buildTaskHistoryView({
      ...base,
      cumulativeHistory: {
        eventCount: 4,
        lifecycles: [
          { taskInstanceId: null, isCurrentLifecycle: false, eventCount: 2, firstOccurredAt: legacy.occurredAt, lastOccurredAt: legacy.occurredAt, events: [checkpoint, legacy] },
          { taskInstanceId: 'I0', isCurrentLifecycle: false, eventCount: 1, firstOccurredAt: old.occurredAt, lastOccurredAt: old.occurredAt, events: [old] },
          ...base.cumulativeHistory.lifecycles,
        ],
      },
    }, { now: NOW });

    expect(view.sections.map((section) => section.title)).toEqual([null, '예전에 같은 번호로 만든 과제', '반복 설정 전 기록']);
    expect(view.sections[2].cycles.map((cycle) => [cycle.label, cycle.range])).toEqual([['예전 기록', null]]);
    expect(view.sections[2].cycles[0].days[0].label).toBe('3월 2일(월)');
    expect(view.sections[2].cycles[0].days[0].entries.map((entry) => entry.text)).toEqual(['김민준 학생이 완료해서 보상 50원을 받았어요']);
  });

  it('shows a task without repeats as one open-ended period', () => {
    const permanent = { cycleId: 'v1|I1|r1|2026-10-01T00:00:00Z', cycleStartsAt: '2026-10-01T00:00:00.000Z', cycleEndsAt: null, ruleVersion: 1 } as unknown as Cycle;
    const base = detail([assignment('a1', 'S001', '2026-10-05T00:00:00.000Z', permanent)]);
    const view = buildTaskHistoryView({
      ...base,
      currentLifecycle: { ...base.currentLifecycle, currentCycleStatus: { ...base.currentLifecycle.currentCycleStatus!, cycleId: permanent.cycleId, startsAt: permanent.cycleStartsAt, endsAt: null, pendingStudentIds: undefined } },
    }, { now: NOW });
    expect(view.singlePermanentCycle).toBe(true);
    expect(view.sections[0].cycles[0].range).toBe('10월 1일(목)부터');
    expect(view.summary).toMatchObject({ label: '지금 상태', range: '10월 1일(목)부터', pending: null });
  });
});

describe('task history date wording', () => {
  it('formats times, days and cycle ranges in Korean', () => {
    expect(formatTime('2026-10-06T00:12:00.000Z')).toBe('오전 9:12');
    expect(formatTime('2026-10-06T03:05:00.000Z')).toBe('오후 12:05');
    expect(formatTime('2026-10-05T15:00:00.000Z')).toBe('오전 12:00');
    expect(formatDayLabel('2026-10-03T00:00:00.000Z', 'Asia/Seoul', NOW)).toBe('10월 3일(토)');
    expect(formatDayLabel('2025-12-30T00:00:00.000Z', 'Asia/Seoul', NOW)).toBe('2025년 12월 30일(화)');
    expect(formatCycleRange('2026-10-05T15:00:00.000Z', '2026-10-06T15:00:00.000Z', 'Asia/Seoul', NOW)).toBe('10월 6일(화)');
    expect(formatCycleRange('2026-10-06T00:00:00.000Z', '2026-10-07T00:00:00.000Z', 'Asia/Seoul', NOW))
      .toBe('10월 6일(화) 오전 9:00 ~ 10월 7일(수) 오전 9:00');
    expect(formatCycleRange(undefined, null, 'Asia/Seoul', NOW)).toBeNull();
  });
});
