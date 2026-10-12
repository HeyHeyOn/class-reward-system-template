import type { TaskStage } from '@/domain/taskStage';
import type { IsoWeekday, TaskRecurrence } from '@/domain/types';

/**
 * Task API without cycles (PostgreSQL classes). Every write states the result it wants
 * ("these students at this stage"), so repeating a request after any failure is safe: a write
 * that already happened changes nothing the second time. There is nothing to "confirm" later.
 */

export const TASK_STAGES: readonly TaskStage[] = ['UNASSIGNED', 'PENDING', 'READY', 'COMPLETED'];

export type TaskRepeatSettingDto = Readonly<{
  recurrence: TaskRecurrence;
  /** The stage every student who has the task moves to at each reset; null = never reset. */
  resetStage: TaskStage | null;
}>;

export type TaskRepeatDto = TaskRepeatSettingDto & Readonly<{
  /** The next automatic reset, or null when the task does not reset. */
  nextResetAt: string | null;
  /** The latest automatic reset that already happened under the current setting, or null. */
  lastResetAt: string | null;
}>;

export type TaskStudentStageDto = Readonly<{
  studentId: string;
  stage: TaskStage;
  /** When the current stage began; null when the student never had the task. */
  since: string | null;
  /** True when the current stage comes from an automatic reset. */
  byReset: boolean;
}>;

export type TaskDefinitionDto = Readonly<{
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  availableFrom: string | null;
  dueAt: string | null;
  prerequisiteTaskId: string | null;
}>;

/** The Padlet board a task is linked to (see src/domain/padlet.ts). */
export type TaskPadletLinkDto = Readonly<{
  boardId: string;
  boardTitle: string;
  boardUrl: string;
  /** Only posts in this section count; null = the whole board. */
  sectionId: string | null;
  sectionTitle: string | null;
  /** When the board was last read successfully. */
  lastReadAt: string | null;
  /** Why the last read failed (a PadletErrorCode), or null. */
  error: string | null;
  checking?: boolean;
  retryAt?: string | null;
}>;

export type AdminTaskDto = TaskDefinitionDto & Readonly<{
  taskId: string;
  taskInstanceId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  repeat: TaskRepeatDto;
  /** Every active student (stage may be 미부여) and inactive students who still have the task. */
  students: readonly TaskStudentStageDto[];
  /** Stage counts over active students. */
  counts: Readonly<Record<TaskStage, number>>;
  /** The linked Padlet board; absent or null when not linked. */
  padlet?: TaskPadletLinkDto | null;
}>;

export type TaskBoardDto = Readonly<{ now: string; tasks: readonly AdminTaskDto[] }>;

export type TaskStageChangeDto = Readonly<{
  taskId: string;
  studentId: string;
  stage: TaskStage;
  /** Only for 완료: also pay the task reward (as if the student completed it in the bank). */
  withReward?: boolean;
}>;

export type TaskHistoryCause = 'TEACHER' | 'QR' | 'PADLET' | 'BANK' | 'RESET' | 'AUTO_RESET' | 'CANCELLED' | 'IMPORTED';

export type TaskHistoryEntryDto = Readonly<{
  id: string;
  at: string;
  studentId: string;
  studentName: string;
  stage: TaskStage;
  previousStage: TaskStage | null;
  cause: TaskHistoryCause;
  /** Reward paid with this change (bank completion or teacher completion with reward). */
  reward: number | null;
}>;

export type TaskHistoryPageRequest = Readonly<{ limit?: number; cursor?: string | null; studentId?: string }>;
export type TaskHistoryDto = Readonly<{
  taskId: string; title: string; entries: readonly TaskHistoryEntryDto[]; truncated: boolean;
  /** Older clients can still read entries; current clients continue the frozen snapshot. */
  nextCursor?: string | null;
  snapshotAt?: string;
}>;

// ---------- requests ----------

export type CreateTaskRequest = Readonly<{
  operationId: string;
  task: TaskDefinitionDto;
  repeat: TaskRepeatSettingDto;
  /** Students to give the task right away (stage defaults to 완료 가능 when omitted). */
  students?: readonly Readonly<{ studentId: string; stage: TaskStage }>[];
}>;

export type UpdateTaskRequest = Readonly<{ operationId: string; task: TaskDefinitionDto }>;
export type DeleteTasksRequest = Readonly<{ operationId: string; taskIds: readonly string[] }>;
export type SetStagesRequest = Readonly<{ operationId: string; changes: readonly TaskStageChangeDto[] }>;
export type ResetTasksRequest = Readonly<{ operationId: string; taskIds: readonly string[]; stage: TaskStage }>;
export type SetRepeatRequest = Readonly<{ operationId: string; taskIds: readonly string[]; repeat: TaskRepeatSettingDto }>;
export type QrStageRequest = Readonly<{ operationId: string; taskId: string; studentQr: string; stage: TaskStage; withReward?: boolean }>;

export type QrStageResultDto = Readonly<{
  task: AdminTaskDto;
  student: Readonly<{ studentId: string; name: string }>;
  previousStage: TaskStage;
  stage: TaskStage;
  changed: boolean;
}>;

export type TaskLedgerErrorDto = Readonly<{ error: string; code: string }>;

export const MAX_STAGE_CHANGES = 2000;
export const MAX_TASK_IDS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[^\s|\u0000-\u001f\u007f][^|\u0000-\u001f\u007f]{0,63}$/;

export class TaskLedgerRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'TaskLedgerRequestError'; }
}

function fail(message: string): never { throw new TaskLedgerRequestError(message); }

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} 형식이 올바르지 않습니다.`);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${label}에 알 수 없는 항목(${key})이 있습니다.`);
}

export function parseOperationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('요청 번호가 올바르지 않습니다.');
  return value;
}

export function parseId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value !== value.trim() || !ID.test(value)) fail(`${label}가 올바르지 않습니다.`);
  return value;
}

export function parseStage(value: unknown): TaskStage {
  if (typeof value !== 'string' || !(TASK_STAGES as readonly string[]).includes(value)) fail('단계가 올바르지 않습니다.');
  return value as TaskStage;
}

function parseInstantOrNull(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`${label}이 올바르지 않습니다.`);
  return new Date(value).toISOString();
}

export function parseRecurrence(value: unknown): TaskRecurrence {
  const raw = record(value, '반복');
  if (raw.type === 'NONE') { onlyKeys(raw, ['type'], '반복'); return { type: 'NONE' }; }
  if (typeof raw.time !== 'string' || !TIME.test(raw.time)) fail('반복 시각이 올바르지 않습니다.');
  if (raw.type === 'DAILY') { onlyKeys(raw, ['type', 'time'], '반복'); return { type: 'DAILY', time: raw.time }; }
  if (raw.type === 'WEEKLY') {
    onlyKeys(raw, ['type', 'time', 'weekdays'], '반복');
    const weekdays = raw.weekdays;
    if (!Array.isArray(weekdays) || weekdays.length < 1 || weekdays.length > 7
      || weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || new Set(weekdays).size !== weekdays.length) {
      fail('반복 요일을 하나 이상 골라 주세요.');
    }
    return { type: 'WEEKLY', time: raw.time, weekdays: [...weekdays as IsoWeekday[]].sort((a, b) => a - b) };
  }
  if (raw.type === 'MONTHLY') {
    onlyKeys(raw, ['type', 'time', 'dayOfMonth'], '반복');
    if (!Number.isInteger(raw.dayOfMonth) || (raw.dayOfMonth as number) < 1 || (raw.dayOfMonth as number) > 31) fail('반복 날짜가 올바르지 않습니다.');
    return { type: 'MONTHLY', time: raw.time, dayOfMonth: raw.dayOfMonth as Extract<TaskRecurrence, { type: 'MONTHLY' }>['dayOfMonth'] };
  }
  return fail('반복 종류가 올바르지 않습니다.');
}

export function parseRepeatSetting(value: unknown): TaskRepeatSettingDto {
  const raw = record(value, '반복 설정');
  onlyKeys(raw, ['recurrence', 'resetStage'], '반복 설정');
  const recurrence = parseRecurrence(raw.recurrence);
  if (recurrence.type === 'NONE') return { recurrence, resetStage: null };
  if (raw.resetStage === null) return { recurrence, resetStage: null };
  return { recurrence, resetStage: parseStage(raw.resetStage) };
}

export function parseTaskDefinition(value: unknown): TaskDefinitionDto {
  const raw = record(value, '과제');
  onlyKeys(raw, ['title', 'description', 'reward', 'isActive', 'sortOrder', 'availableFrom', 'dueAt', 'prerequisiteTaskId'], '과제');
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (!title) fail('과제 이름을 입력해 주세요.');
  if (title.length > 100) fail('과제 이름은 100자까지 쓸 수 있습니다.');
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length > 2000) fail('설명은 2000자까지 쓸 수 있습니다.');
  if (!Number.isSafeInteger(raw.reward) || (raw.reward as number) < 0) fail('보상은 0 이상의 정수여야 합니다.');
  if (typeof raw.isActive !== 'boolean') fail('공개 여부가 올바르지 않습니다.');
  const sortOrder = raw.sortOrder === undefined ? 0 : raw.sortOrder;
  if (!Number.isSafeInteger(sortOrder) || Math.abs(sortOrder as number) > 1_000_000) fail('목록 순서는 정수여야 합니다.');
  const availableFrom = parseInstantOrNull(raw.availableFrom, '시작 시각');
  const dueAt = parseInstantOrNull(raw.dueAt, '기한');
  if (availableFrom && dueAt && Date.parse(availableFrom) >= Date.parse(dueAt)) fail('시작 시각은 기한보다 빨라야 합니다.');
  const prerequisiteTaskId = raw.prerequisiteTaskId === null || raw.prerequisiteTaskId === undefined || raw.prerequisiteTaskId === ''
    ? null : parseId(raw.prerequisiteTaskId, '선행 과제');
  return { title, description, reward: raw.reward as number, isActive: raw.isActive, sortOrder: sortOrder as number,
    availableFrom, dueAt, prerequisiteTaskId };
}

export function parseTaskIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TASK_IDS) fail('과제를 하나 이상 골라 주세요.');
  const ids = value.map((id) => parseId(id, '과제 번호'));
  if (new Set(ids).size !== ids.length) fail('같은 과제가 두 번 들어 있습니다.');
  return ids;
}

export function parseCreateTaskRequest(value: unknown): CreateTaskRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'task', 'repeat', 'students'], '요청');
  const students = raw.students === undefined ? [] : raw.students;
  if (!Array.isArray(students) || students.length > 1000) fail('학생 목록이 올바르지 않습니다.');
  const parsedStudents = students.map((entry) => {
    const item = record(entry, '학생');
    onlyKeys(item, ['studentId', 'stage'], '학생');
    return { studentId: parseId(item.studentId, '학생 번호'), stage: item.stage === undefined ? 'READY' as const : parseStage(item.stage) };
  });
  if (new Set(parsedStudents.map((entry) => entry.studentId)).size !== parsedStudents.length) fail('같은 학생이 두 번 들어 있습니다.');
  return { operationId: parseOperationId(raw.operationId), task: parseTaskDefinition(raw.task), repeat: parseRepeatSetting(raw.repeat),
    students: parsedStudents };
}

export function parseUpdateTaskRequest(value: unknown): UpdateTaskRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'task'], '요청');
  return { operationId: parseOperationId(raw.operationId), task: parseTaskDefinition(raw.task) };
}

export function parseDeleteTasksRequest(value: unknown): DeleteTasksRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'taskIds'], '요청');
  return { operationId: parseOperationId(raw.operationId), taskIds: parseTaskIds(raw.taskIds) };
}

export function parseSetStagesRequest(value: unknown): SetStagesRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'changes'], '요청');
  if (!Array.isArray(raw.changes) || raw.changes.length < 1 || raw.changes.length > MAX_STAGE_CHANGES) fail('바꿀 학생을 하나 이상 골라 주세요.');
  const seen = new Set<string>();
  const changes = raw.changes.map((entry) => {
    const item = record(entry, '변경');
    onlyKeys(item, ['taskId', 'studentId', 'stage', 'withReward'], '변경');
    const taskId = parseId(item.taskId, '과제 번호');
    const studentId = parseId(item.studentId, '학생 번호');
    const stage = parseStage(item.stage);
    if (item.withReward !== undefined && typeof item.withReward !== 'boolean') fail('보상 지급 여부가 올바르지 않습니다.');
    if (item.withReward === true && stage !== 'COMPLETED') fail('보상은 완료로 바꿀 때만 지급할 수 있습니다.');
    const key = JSON.stringify([taskId, studentId]);
    if (seen.has(key)) fail('같은 과제의 같은 학생이 두 번 들어 있습니다.');
    seen.add(key);
    return { taskId, studentId, stage, ...(item.withReward === true ? { withReward: true } : {}) };
  });
  return { operationId: parseOperationId(raw.operationId), changes };
}

export function parseResetTasksRequest(value: unknown): ResetTasksRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'taskIds', 'stage'], '요청');
  return { operationId: parseOperationId(raw.operationId), taskIds: parseTaskIds(raw.taskIds), stage: parseStage(raw.stage) };
}

export function parseSetRepeatRequest(value: unknown): SetRepeatRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'taskIds', 'repeat'], '요청');
  return { operationId: parseOperationId(raw.operationId), taskIds: parseTaskIds(raw.taskIds), repeat: parseRepeatSetting(raw.repeat) };
}

export function parseQrStageRequest(value: unknown): QrStageRequest {
  const raw = record(value, '요청');
  onlyKeys(raw, ['operationId', 'taskId', 'studentQr', 'stage', 'withReward'], '요청');
  if (typeof raw.studentQr !== 'string' || !raw.studentQr.trim() || raw.studentQr.length > 512) fail('QR 값이 올바르지 않습니다.');
  const stage = parseStage(raw.stage);
  if (raw.withReward !== undefined && typeof raw.withReward !== 'boolean') fail('보상 지급 여부가 올바르지 않습니다.');
  if (raw.withReward === true && stage !== 'COMPLETED') fail('보상은 완료로 바꿀 때만 지급할 수 있습니다.');
  return { operationId: parseOperationId(raw.operationId), taskId: parseId(raw.taskId, '과제 번호'), studentQr: raw.studentQr.trim(), stage,
    ...(raw.withReward === true ? { withReward: true } : {}) };
}
