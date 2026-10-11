import { getNextNaturalTaskBoundary } from '@/domain/taskRecurrence';
import { TASK_STAGE_LABELS, type TaskStage } from '@/domain/taskStage';
import type { DayOfMonth, IsoWeekday, TaskRecurrence } from '@/domain/types';
import {
  parseRepeatSetting, parseTaskDefinition, TASK_STAGES,
  type AdminTaskDto, type TaskDefinitionDto, type TaskHistoryCause, type TaskHistoryEntryDto, type TaskRepeatSettingDto,
} from '@/lib/taskLedgerApi';

/* Pure helpers for the stage-ledger task screen: Seoul dates, Korean wording, form <-> DTO. */

export const SEOUL = 'Asia/Seoul';
export { TASK_STAGES };

type Parts = { year: number; month: number; day: number; weekday: string; hour: number; minute: number };

function seoulParts(instant: string): Parts | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: SEOUL, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return { year: Number(value('year')), month: Number(value('month')), day: Number(value('day')), weekday: value('weekday'),
    hour: Number(value('hour')) % 24, minute: Number(value('minute')) };
}

/** "오전 9:00" from "09:00". */
export function formatClock(time: string): string {
  const [hour, minute] = time.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return time;
  const shown = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour < 12 ? '오전' : '오후'} ${shown}:${String(minute).padStart(2, '0')}`;
}

/** "10월 7일(수) 오전 9:00" (the year is added when it is not this year). */
export function formatInstant(instant: string, now?: string | null): string {
  const parts = seoulParts(instant);
  if (!parts) return instant;
  const current = now ? seoulParts(now) : null;
  const year = current && current.year !== parts.year ? `${parts.year}년 ` : '';
  return `${year}${parts.month}월 ${parts.day}일(${parts.weekday}) ${formatClock(`${parts.hour}:${parts.minute}`)}`;
}

/** "10월 7일(수)" */
export function formatDay(instant: string, now?: string | null): string {
  const parts = seoulParts(instant);
  if (!parts) return instant;
  const current = now ? seoulParts(now) : null;
  const year = current && current.year !== parts.year ? `${parts.year}년 ` : '';
  return `${year}${parts.month}월 ${parts.day}일(${parts.weekday})`;
}

export function seoulDayKey(instant: string): string {
  const parts = seoulParts(instant);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : instant.slice(0, 10);
}

/** "오늘 · 10월 6일(화)", "어제 · 10월 5일(월)", "10월 3일(토)" */
export function formatDayHeading(instant: string, now: string): string {
  const label = formatDay(instant, now);
  if (seoulDayKey(instant) === seoulDayKey(now)) return `오늘 · ${label}`;
  const yesterday = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (seoulDayKey(instant) === seoulDayKey(yesterday)) return `어제 · ${label}`;
  return label;
}

export function formatTimeOfDay(instant: string): string {
  const parts = seoulParts(instant);
  return parts ? formatClock(`${parts.hour}:${parts.minute}`) : instant;
}

/** "10/6 09:00부터" */
export function formatSince(instant: string): string {
  const parts = seoulParts(instant);
  if (!parts) return '';
  return `${parts.month}/${parts.day} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}부터`;
}

export function isoToSeoulLocal(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: SEOUL, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function seoulLocalToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(`${value}:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/* ---------------- Korean particles ---------------- */

function hasFinalConsonant(word: string): boolean | null {
  const last = word.trim().at(-1) ?? '';
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 !== 0;
  return null;
}

/** "미완료예요", "완료 가능이에요" */
export function isWord(word: string): string {
  return `${word}${hasFinalConsonant(word) ? '이에요' : '예요'}`;
}

/** "미완료로", "완료 가능으로" (ㄹ takes 로). */
export function toWord(word: string): string {
  const last = word.trim().at(-1) ?? '';
  const code = last.charCodeAt(0);
  const final = code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : 0;
  return `${word}${final === 0 || final === 8 ? '로' : '으로'}`;
}

export function stageLabel(stage: TaskStage): string {
  return TASK_STAGE_LABELS[stage];
}

export function money(amount: number, unit: string): string {
  return `${amount.toLocaleString('ko-KR')}${unit}`;
}

/* ---------------- repeat ---------------- */

const WEEKDAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

export function recurrenceSummary(recurrence: TaskRecurrence): string {
  if (recurrence.type === 'NONE') return '반복 없음';
  const clock = formatClock(recurrence.time);
  if (recurrence.type === 'DAILY') return `매일 ${clock}`;
  if (recurrence.type === 'WEEKLY') return `매주 ${[...recurrence.weekdays].sort((a, b) => a - b).map((day) => WEEKDAY_NAMES[day - 1]).join('·')} ${clock}`;
  return `매월 ${recurrence.dayOfMonth}일 ${clock}`;
}

export function resetStageSummary(resetStage: TaskStage | null): string {
  return resetStage ? `${toWord(stageLabel(resetStage))} 초기화` : '초기화 안 함';
}

export type RepeatType = TaskRecurrence['type'];
export type RepeatForm = {
  /** '' only in the bulk dialog, until the teacher picks one. */
  type: RepeatType | '';
  time: string;
  weekdays: IsoWeekday[];
  dayOfMonth: string;
  /** 'NONE' only for a repeat saved without a reset (old Sheets data); it cannot be saved again. */
  resetStage: TaskStage | 'NONE';
};

export const DEFAULT_RESET_STAGE: TaskStage = 'READY';

export function repeatFormOf(setting: TaskRepeatSettingDto | null): RepeatForm {
  const recurrence = setting?.recurrence ?? { type: 'NONE' as const };
  return {
    type: recurrence.type,
    time: recurrence.type === 'NONE' ? '09:00' : recurrence.time,
    weekdays: recurrence.type === 'WEEKLY' ? [...recurrence.weekdays] : [1],
    dayOfMonth: recurrence.type === 'MONTHLY' ? String(recurrence.dayOfMonth) : '1',
    resetStage: recurrence.type === 'NONE' ? DEFAULT_RESET_STAGE : setting?.resetStage ?? 'NONE',
  };
}

export function blankRepeatForm(): RepeatForm {
  return { ...repeatFormOf(null), type: '' };
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export function repeatFromForm(form: RepeatForm): Checked<TaskRepeatSettingDto> {
  if (!form.type) return { ok: false, error: '반복 주기를 골라 주세요.' };
  // A repeat that resets nothing does nothing, so it is not offered; pick a stage or 반복 없음.
  if (form.type !== 'NONE' && form.resetStage === 'NONE') return { ok: false, error: '초기화할 단계를 골라 주세요. 초기화하지 않으려면 ‘반복 없음’을 고르세요.' };
  let recurrence: unknown;
  if (form.type === 'NONE') recurrence = { type: 'NONE' };
  else if (form.type === 'DAILY') recurrence = { type: 'DAILY', time: form.time };
  else if (form.type === 'WEEKLY') recurrence = { type: 'WEEKLY', time: form.time, weekdays: form.weekdays };
  else recurrence = { type: 'MONTHLY', time: form.time, dayOfMonth: form.dayOfMonth.trim() === '' ? NaN : Number(form.dayOfMonth) as DayOfMonth };
  try {
    return { ok: true, value: parseRepeatSetting({ recurrence, resetStage: form.type === 'NONE' || form.resetStage === 'NONE' ? null : form.resetStage }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '반복 설정을 확인해 주세요.' };
  }
}

export function sameRepeat(left: TaskRepeatSettingDto, right: TaskRepeatSettingDto): boolean {
  return JSON.stringify({ recurrence: left.recurrence, resetStage: left.recurrence.type === 'NONE' ? null : left.resetStage })
    === JSON.stringify({ recurrence: right.recurrence, resetStage: right.recurrence.type === 'NONE' ? null : right.resetStage });
}

/** When a saved form would reset next, counted from `now`. Null when it does not reset. */
export function previewNextReset(setting: TaskRepeatSettingDto, now: string): string | null {
  if (setting.recurrence.type === 'NONE' || !setting.resetStage) return null;
  try {
    return getNextNaturalTaskBoundary({ recurrence: setting.recurrence, timeZone: SEOUL, after: now });
  } catch {
    return null;
  }
}

/* ---------------- task definition ---------------- */

export type DefinitionForm = {
  title: string;
  description: string;
  reward: string;
  sortOrder: string;
  isActive: boolean;
  /** Seoul datetime-local values ("2026-10-07T09:00") or ''. */
  availableFrom: string;
  dueAt: string;
  prerequisiteTaskId: string;
};

export const DEFINITION_FIELDS = ['title', 'description', 'reward', 'sortOrder', 'isActive', 'availableFrom', 'dueAt', 'prerequisiteTaskId'] as const;

export function definitionFormOf(task: TaskDefinitionDto): DefinitionForm {
  return {
    title: task.title,
    description: task.description,
    reward: String(task.reward),
    sortOrder: String(task.sortOrder),
    isActive: task.isActive,
    availableFrom: isoToSeoulLocal(task.availableFrom),
    dueAt: isoToSeoulLocal(task.dueAt),
    prerequisiteTaskId: task.prerequisiteTaskId ?? '',
  };
}

function numberOf(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}

export function definitionFromForm(form: DefinitionForm): Checked<TaskDefinitionDto> {
  try {
    return { ok: true, value: parseTaskDefinition({
      title: form.title,
      description: form.description,
      reward: numberOf(form.reward),
      isActive: form.isActive,
      sortOrder: form.sortOrder.trim() === '' ? 0 : Number(form.sortOrder),
      availableFrom: seoulLocalToIso(form.availableFrom),
      dueAt: seoulLocalToIso(form.dueAt),
      prerequisiteTaskId: form.prerequisiteTaskId || null,
    }) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '과제 내용을 확인해 주세요.' };
  }
}

/* ---------------- list ---------------- */

export type TaskStatus = { label: string; tone: 'success' | 'neutral' | 'warning' | 'info' };

export function taskStatus(task: Pick<AdminTaskDto, 'isActive' | 'availableFrom' | 'dueAt'>, now: string | null): TaskStatus {
  if (!task.isActive) return { label: '숨김', tone: 'neutral' };
  const at = now ? Date.parse(now) : NaN;
  if (Number.isFinite(at)) {
    if (task.availableFrom && Date.parse(task.availableFrom) > at) return { label: '시작 전', tone: 'info' };
    if (task.dueAt && Date.parse(task.dueAt) <= at) return { label: '마감됨', tone: 'warning' };
  }
  return { label: '진행 중', tone: 'success' };
}

/** Students who have the task (any stage but 미부여), counted over active students. */
export function holderCount(task: Pick<AdminTaskDto, 'counts'>): number {
  return task.counts.PENDING + task.counts.READY + task.counts.COMPLETED;
}

export function sortTasks(tasks: readonly AdminTaskDto[]): AdminTaskDto[] {
  return [...tasks].sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title, 'ko-KR') || a.taskId.localeCompare(b.taskId));
}

export function compareStudentIds(a: string, b: string): number {
  return a.localeCompare(b, 'ko-KR', { numeric: true });
}

/* ---------------- history ---------------- */

export const CAUSE_LABELS: Record<TaskHistoryCause, string> = {
  TEACHER: '선생님',
  QR: 'QR',
  PADLET: '패들렛',
  BANK: '은행에서 완료',
  RESET: '지금 초기화',
  AUTO_RESET: '자동 초기화',
  CANCELLED: '보상 취소',
  IMPORTED: '옮겨 온 기록',
};

/** "김민준 · 완료 가능 → 완료 · 은행에서 완료 (+120원)" */
export function historySentence(entry: TaskHistoryEntryDto, unit: string): string {
  const name = entry.studentName || entry.studentId;
  const change = entry.previousStage && entry.previousStage !== entry.stage
    ? `${stageLabel(entry.previousStage)} → ${stageLabel(entry.stage)}`
    : stageLabel(entry.stage);
  const reward = entry.reward ? ` (${entry.reward > 0 ? '+' : ''}${money(entry.reward, unit)})` : '';
  return `${name} · ${change} · ${CAUSE_LABELS[entry.cause] ?? entry.cause}${reward}`;
}
