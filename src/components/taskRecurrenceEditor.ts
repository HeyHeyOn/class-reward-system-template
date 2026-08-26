import type { TaskCurrentCycleStatusDto } from '@/domain/taskHistoryDtos';
import { DEFAULT_CLASS_TIME_ZONE, resolveTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, DayOfMonth, IsoWeekday, TaskRecurrence, TaskSchedule } from '@/domain/types';

export type NormalizedAdminTask = ClassTask & { currentCycle?: TaskCurrentCycleStatusDto };

export function resolveEffectiveAdminTaskSchedule(
  task: Pick<ClassTask, 'schedule' | 'pendingSchedule'>,
  now = new Date().toISOString(),
): TaskSchedule | undefined {
  if (!task.schedule) return undefined;
  return resolveTaskSchedule({
    currentSchedule: task.schedule,
    pendingSchedule: task.pendingSchedule ?? null,
    now,
  });
}

export function normalizeAdminTask(task: NormalizedAdminTask): NormalizedAdminTask {
  return {
    ...task,
    title: task.title ?? '',
    description: task.description ?? '',
    reward: Number.isFinite(task.reward) ? task.reward : 0,
    isActive: Boolean(task.isActive),
    sortOrder: Number.isFinite(task.sortOrder) ? task.sortOrder : 0,
    allowedStudentIds: Array.isArray(task.allowedStudentIds) ? task.allowedStudentIds : [],
  };
}

export type RecurrenceType = TaskRecurrence['type'];
export type TaskRecurrenceForm = {
  type: RecurrenceType;
  time: string;
  weekday: string;
  dayOfMonth: string;
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
  taskInstanceId: string;
  ruleVersion: number;
  effectiveFrom: string;
};

export type TaskScheduleEditPayload = Pick<TaskSchedule, 'recurrence' | 'timeZone' | 'resetCompletionOnCycle' | 'resetAssignmentOnCycle'>;

export const EMPTY_RECURRENCE_FORM: TaskRecurrenceForm = {
  type: 'NONE',
  time: '09:00',
  weekday: '1',
  dayOfMonth: '1',
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
  taskInstanceId: '',
  ruleVersion: 1,
  effectiveFrom: '',
};

export function scheduleDtoToForm(
  schedule?: TaskSchedule | null,
  additive: { taskInstanceId?: string } = {},
): TaskRecurrenceForm {
  const recurrence = schedule?.recurrence;
  return {
    type: recurrence?.type ?? 'NONE',
    time: recurrence && recurrence.type !== 'NONE' ? recurrence.time : EMPTY_RECURRENCE_FORM.time,
    weekday: recurrence?.type === 'WEEKLY' ? String(recurrence.weekday) : EMPTY_RECURRENCE_FORM.weekday,
    dayOfMonth: recurrence?.type === 'MONTHLY' ? String(recurrence.dayOfMonth) : EMPTY_RECURRENCE_FORM.dayOfMonth,
    resetCompletionOnCycle: schedule?.resetCompletionOnCycle ?? false,
    resetAssignmentOnCycle: schedule?.resetAssignmentOnCycle ?? false,
    taskInstanceId: additive.taskInstanceId ?? '',
    ruleVersion: schedule?.ruleVersion ?? 1,
    effectiveFrom: schedule?.effectiveFrom ?? '',
  };
}

export function validateRecurrenceForm(form: TaskRecurrenceForm): string | null {
  if (form.type === 'NONE') return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.time)) return '시간은 HH:mm 형식으로 입력해 주세요.';
  if (form.type === 'WEEKLY') {
    const weekday = Number(form.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) return '요일을 선택해 주세요.';
  }
  if (form.type === 'MONTHLY') {
    const day = Number(form.dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 31) return '날짜는 1일부터 31일까지 입력해 주세요.';
  }
  return null;
}

export function scheduleFormToPayload(form: TaskRecurrenceForm):
  | { ok: true; payload: TaskScheduleEditPayload }
  | { ok: false; error: string } {
  const error = validateRecurrenceForm(form);
  if (error) return { ok: false, error };
  let recurrence: TaskRecurrence;
  if (form.type === 'NONE') recurrence = { type: 'NONE' };
  else if (form.type === 'DAILY') recurrence = { type: 'DAILY', time: form.time };
  else if (form.type === 'WEEKLY') recurrence = { type: 'WEEKLY', time: form.time, weekday: Number(form.weekday) as IsoWeekday };
  else recurrence = { type: 'MONTHLY', time: form.time, dayOfMonth: Number(form.dayOfMonth) as DayOfMonth };
  return {
    ok: true,
    payload: {
      recurrence,
      timeZone: DEFAULT_CLASS_TIME_ZONE,
      resetCompletionOnCycle: form.resetCompletionOnCycle,
      resetAssignmentOnCycle: form.resetAssignmentOnCycle,
    },
  };
}

const WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'];

export function formatRecurrenceSummary(formOrSchedule: TaskRecurrenceForm | TaskSchedule | null | undefined): string {
  if (!formOrSchedule) return '반복 없음';
  const recurrence = 'recurrence' in formOrSchedule ? formOrSchedule.recurrence : formToRecurrence(formOrSchedule);
  if (recurrence.type === 'NONE') return '반복 없음';
  if (recurrence.type === 'DAILY') return `매일 ${recurrence.time}`;
  if (recurrence.type === 'WEEKLY') return `매주 ${WEEKDAYS[recurrence.weekday - 1]}요일 ${recurrence.time}`;
  return `매월 ${recurrence.dayOfMonth}일 ${recurrence.time}`;
}

function formToRecurrence(form: TaskRecurrenceForm): TaskRecurrence {
  if (form.type === 'NONE') return { type: 'NONE' };
  if (form.type === 'DAILY') return { type: 'DAILY', time: form.time };
  if (form.type === 'WEEKLY') return { type: 'WEEKLY', time: form.time, weekday: Number(form.weekday) as IsoWeekday };
  return { type: 'MONTHLY', time: form.time, dayOfMonth: Number(form.dayOfMonth) as DayOfMonth };
}
