import ExcelJS from 'exceljs';
import { getTaskCycle } from '@/domain/taskRecurrence';
import type { TaskSchedule } from '@/domain/types';

/** Synthetic fixtures only: invented IDs and names, never real class data. */
export type SyntheticCell = string | number | boolean | Date | null;
export type SyntheticWorkbook = Record<string, SyntheticCell[][]>;

const TASK_HEADERS = ['taskId', 'title', 'description', 'reward', 'maxCompletionsPerStudent', 'isActive', 'sortOrder', 'createdAt', 'updatedAt',
  'allowedStudentIds', 'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone', 'recurrenceType',
  'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth', 'resetCompletionOnCycle', 'resetAssignmentOnCycle',
  'pendingRuleVersion', 'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType', 'pendingRecurrenceTime',
  'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth', 'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle',
  'availableFrom', 'dueAt', 'prerequisiteTaskId', 'recurrenceWeekdays', 'pendingRecurrenceWeekdays'];
const ASSIGNMENT_HEADERS = ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion',
  'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'];
const COMPLETION_HEADERS = ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore',
  'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone',
  'source', 'assignmentId', 'schemaVersion', 'operationId', 'operationPayloadHash'];

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

type TaskSpec = {
  taskId: string; title: string; reward: number; isActive: boolean; sortOrder: number; createdAt: string;
  allowed: string[]; schedule: TaskSchedule; prerequisite?: string; availableFrom?: SyntheticCell; dueAt?: SyntheticCell; versioned: boolean;
};

function taskRow(spec: TaskSpec): SyntheticCell[] {
  const values: Record<string, SyntheticCell> = {
    taskId: spec.taskId, title: spec.title, description: `${spec.title} 설명`, reward: spec.reward, maxCompletionsPerStudent: 1,
    isActive: spec.isActive ? 'TRUE' : 'FALSE', sortOrder: spec.sortOrder, createdAt: spec.createdAt, updatedAt: spec.createdAt,
    allowedStudentIds: spec.allowed.join(','), prerequisiteTaskId: spec.prerequisite ?? '',
    availableFrom: spec.availableFrom ?? '', dueAt: spec.dueAt ?? '',
  };
  if (spec.versioned) {
    const recurrence = spec.schedule.recurrence;
    Object.assign(values, {
      taskInstanceId: `legacy:${spec.taskId}:${spec.createdAt}`, ruleVersion: String(spec.schedule.ruleVersion),
      scheduleEffectiveFrom: spec.schedule.effectiveFrom, recurrenceTimeZone: 'Asia/Seoul', recurrenceType: recurrence.type,
      recurrenceTime: recurrence.type === 'NONE' ? '' : recurrence.time,
      recurrenceWeekday: recurrence.type === 'WEEKLY' ? String(recurrence.weekdays[0]) : '',
      recurrenceWeekdays: recurrence.type === 'WEEKLY' ? recurrence.weekdays.join(',') : '',
      resetCompletionOnCycle: spec.schedule.resetCompletionOnCycle ? 'TRUE' : 'FALSE',
      resetAssignmentOnCycle: spec.schedule.resetAssignmentOnCycle ? 'TRUE' : 'FALSE',
    });
  }
  return TASK_HEADERS.map(header => values[header] ?? '');
}

/**
 * A complete synthetic CRS workbook whose current-cycle state is known in advance.
 * `now` anchors every timestamp so the fixture is valid whenever the test runs.
 */
export function buildSyntheticCrsWorkbook(now: Date = new Date()): {
  workbook: SyntheticWorkbook;
  expected: { tasks: Record<string, { ready: string[]; completed: string[]; completedUnassigned: string[]; isActive: boolean }> };
} {
  const t = now.getTime();
  const schedule = (createdAt: string, recurrence: TaskSchedule['recurrence'], resetCompletion: boolean, resetAssignment: boolean): TaskSchedule =>
    ({ ruleVersion: 1, effectiveFrom: createdAt, timeZone: 'Asia/Seoul', recurrence, resetCompletionOnCycle: resetCompletion, resetAssignmentOnCycle: resetAssignment });
  const ta: TaskSpec = { taskId: 'TA', title: '독서 기록', reward: 2, isActive: true, sortOrder: 1, createdAt: iso(t - 20 * DAY),
    allowed: ['S01', 'S02', 'S03'], schedule: schedule(iso(t - 20 * DAY), { type: 'NONE' }, false, false), versioned: true };
  const tb: TaskSpec = { taskId: 'TB', title: '주간 청소', reward: 1, isActive: true, sortOrder: 2, createdAt: iso(t - 30 * DAY),
    allowed: ['S01', 'S02', 'S03', 'S04'], schedule: schedule(iso(t - 30 * DAY), { type: 'WEEKLY', weekdays: [1], time: '09:00' }, true, false), versioned: true };
  const tc: TaskSpec = { taskId: 'TC', title: '숨긴 과제', reward: 3, isActive: false, sortOrder: 3, createdAt: iso(t - 10 * DAY),
    allowed: ['S01'], schedule: schedule(iso(t - 10 * DAY), { type: 'NONE' }, false, false), prerequisite: 'TA', versioned: true };
  // An unversioned (first-generation) row with real date cells for its availability window.
  const td: TaskSpec = { taskId: 'TD', title: '날짜 과제', reward: 0, isActive: true, sortOrder: 4, createdAt: iso(t - 5 * DAY),
    allowed: [], schedule: schedule(iso(t - 5 * DAY), { type: 'NONE' }, false, false), versioned: false,
    availableFrom: new Date(Date.UTC(2030, 2, 2, 9, 0)), dueAt: new Date(Date.UTC(2030, 2, 9, 18, 30)) };

  const assignments: SyntheticCell[][] = [ASSIGNMENT_HEADERS];
  const completions: SyntheticCell[][] = [COMPLETION_HEADERS];
  const instance = (spec: TaskSpec) => `legacy:${spec.taskId}:${spec.createdAt}`;
  const cycleAt = (spec: TaskSpec, at: number) => getTaskCycle({ taskInstanceId: instance(spec), schedule: spec.schedule,
    taskCreatedAt: spec.createdAt, now: iso(at) });
  let sequence = 0;
  const assign = (spec: TaskSpec, at: number, studentId: string, status: 'ASSIGNED' | 'UNASSIGNED', source: string, previous = '') => {
    const cycle = cycleAt(spec, at);
    const id = `A-${spec.taskId}-${++sequence}`;
    assignments.push([id, spec.taskId, instance(spec), cycle.cycleId, cycle.startsAt, cycle.endsAt ?? '', '1', 'Asia/Seoul', studentId,
      status, source, previous, iso(at), '2', source === 'LEGACY_SEED' ? 'legacy allowedStudentIds seed' : '']);
    return id;
  };
  const complete = (spec: TaskSpec, at: number, studentId: string, assignmentId: string) => {
    const cycle = cycleAt(spec, at);
    completions.push([`C-${spec.taskId}-${++sequence}`, iso(at), spec.taskId, studentId, `학생${studentId}`, String(spec.reward), '0',
      String(spec.reward), 'SUCCESS', 'bank-self-completion', instance(spec), cycle.cycleId, cycle.startsAt, cycle.endsAt ?? '', '1',
      'Asia/Seoul', 'BANK', assignmentId, '2', '', '']);
  };
  // TA (permanent): S01 completed; S04 completed and later unassigned; S02, S03 still to do.
  const taSeed = Object.fromEntries(['S01', 'S02', 'S03', 'S04'].map(id => [id, assign(ta, t - 19 * DAY, id, 'ASSIGNED', 'LEGACY_SEED')]));
  complete(ta, t - 18 * DAY, 'S01', taSeed.S01);
  complete(ta, t - 18 * DAY, 'S04', taSeed.S04);
  assign(ta, t - 17 * DAY, 'S04', 'UNASSIGNED', 'ADMIN', taSeed.S04);
  // TB (weekly, completion resets): S02 completed this week, S03 only last week.
  const current = cycleAt(tb, t), previousAt = Date.parse(current.startsAt) - 3 * 60_000;
  const tbSeed = Object.fromEntries(['S01', 'S02', 'S03', 'S04'].map(id => [id, assign(tb, t - 29 * DAY, id, 'ASSIGNED', 'LEGACY_SEED')]));
  complete(tb, Math.min(t - 1000, Date.parse(current.startsAt) + 60_000), 'S02', tbSeed.S02);
  complete(tb, previousAt, 'S03', tbSeed.S03);
  // TC (hidden): S01 completed.
  const tcSeed = assign(tc, t - 9 * DAY, 'S01', 'ASSIGNED', 'LEGACY_SEED');
  complete(tc, t - 8 * DAY, 'S01', tcSeed);

  const workbook: SyntheticWorkbook = {
    Students: [['studentId', 'name', 'balance', 'status'],
      ['S01', '가람', 12, 'ACTIVE'], ['S02', '나래', 0, 'ACTIVE'], ['S03', '다솜', 5, 'ACTIVE'], ['S04', '라온', 7, 'ACTIVE'],
      ['S05', '마루', 3, 'INACTIVE'], ['0101', '바다', 1, 'ACTIVE'], [null, null, null, null]],
    Products: [['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'],
      ['P1', '연필', 2, 10, true, '', '문구', 1], ['P2', '지우개', 1, 0, false, 'https://example.invalid/eraser.png', '', 2]],
    Settings: [['key', 'value'], ['schemaVersion', '1'], ['systemVersion', '0.4.1'], ['appTitle', '시험 매점'], ['bankTitle', '시험 은행'],
      ['currencyUnit', '점'], ['themeColor', 'blue'], ['className', '시험 학급'], ['fontFamily', 'default'], ['qrManualInputEnabled', true],
      ['adminPasswordHash', 'a'.repeat(64)], ['recoveryCodeHash', 'b'.repeat(64)]],
    Tasks: [TASK_HEADERS, taskRow(ta), taskRow(tb), taskRow(tc), taskRow(td)],
    Promotions: [['promotionId', 'name', 'description', 'type', 'value', 'buyQuantity', 'freeQuantity', 'startsAt', 'endsAt', 'isActive',
      'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion'],
      ['PR1', '연필 할인', '하나 사면 1점 할인', 'FIXED_DISCOUNT', '1', '', '', iso(t - DAY), iso(t + 10 * DAY), 'TRUE', '1', iso(t - DAY), iso(t - DAY), '3']],
    PromotionProducts: [['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'],
      ['L1', 'PR1', 'P1', iso(t - DAY), '3'], ['L2', 'PR1', 'P9', iso(t - DAY), '3']],
    Transactions: [['transactionId', 'timestamp', 'studentId', 'studentName', 'itemsJson', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
      ['T1', iso(t - 3 * DAY), 'S01', '학생S01', '[{"productId":"P1","name":"연필","price":2,"quantity":1,"subtotal":2}]', '2', '14', '12', 'COMPLETED', 'kiosk']],
    Adjustments: [['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator']],
    TaskAssignments: assignments,
    TaskCompletions: completions,
    메모: [['선생님 메모'], ['옮기지 않는 시트']],
  };
  return { workbook, expected: { tasks: {
    TA: { ready: ['S02', 'S03'], completed: ['S01', 'S04'], completedUnassigned: ['S04'], isActive: true },
    TB: { ready: ['S01', 'S03', 'S04'], completed: ['S02'], completedUnassigned: [], isActive: true },
    TC: { ready: [], completed: ['S01'], completedUnassigned: [], isActive: false },
    TD: { ready: [], completed: [], completedUnassigned: [], isActive: true },
  } } };
}

/** Writes the workbook the way Google Sheets exports it (date cells carry a date format). */
export async function writeSyntheticXlsx(workbook: SyntheticWorkbook): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(workbook)) {
    const sheet = book.addWorksheet(name);
    rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
      if (value === null || value === '') return;
      const cell = sheet.getCell(rowIndex + 1, columnIndex + 1);
      cell.value = value;
      if (value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm';
    }));
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}
