import type { ClassTask } from '@/domain/types';
import { normalizeAdminTask, scheduleDtoToForm, scheduleFormToPayload } from '../taskRecurrenceEditor';
import type { StudentDraft, TaskDraft } from './adminTypes';
import { isRecord } from './adminResponse';

type AssignmentBatchFailure = { taskId: string; studentId: string; code: 'OPERATION_FAILED' };

type AssignmentBatchNotAttempted = { taskId: string; studentId: string };

type AssignmentBatchWarning = { taskId: string; code: 'LEGACY_MIRROR_UPDATE_FAILED' };

type AssignmentBatchResult = {
  appliedCount: number;
  failures: AssignmentBatchFailure[];
  aborted: boolean;
  notAttempted: AssignmentBatchNotAttempted[];
  warnings: AssignmentBatchWarning[];
};

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length
    && keys.every((key, index) => key === sortedExpected[index]);
}

export function parseAssignmentBatchResult(
  value: unknown,
  taskId: string,
  submittedStudentIds: Set<string>,
  commandCount: number,
): AssignmentBatchResult | null {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !['appliedCount', 'failures', 'aborted', 'notAttempted', 'warnings'].includes(key))
    || !Object.hasOwn(value, 'appliedCount')
    || !Number.isSafeInteger(value.appliedCount)
    || Number(value.appliedCount) < 0
    || Number(value.appliedCount) > commandCount
    || !Object.hasOwn(value, 'failures')
    || !Array.isArray(value.failures)) return null;
  if (Object.hasOwn(value, 'aborted') && typeof value.aborted !== 'boolean') return null;
  if (Object.hasOwn(value, 'notAttempted') && !Array.isArray(value.notAttempted)) return null;
  if (Object.hasOwn(value, 'warnings') && !Array.isArray(value.warnings)) return null;

  const failuresValue = value.failures;
  const notAttemptedValue = Object.hasOwn(value, 'notAttempted') ? value.notAttempted as unknown[] : [];
  const warningsValue = Object.hasOwn(value, 'warnings') ? value.warnings as unknown[] : [];
  const failures: AssignmentBatchFailure[] = [];
  const notAttempted: AssignmentBatchNotAttempted[] = [];
  const warnings: AssignmentBatchWarning[] = [];
  const resultPairs = new Set<string>();
  for (const item of failuresValue) {
    if (!isRecord(item) || !hasExactKeys(item, ['taskId', 'studentId', 'code'])
      || item.taskId !== taskId || typeof item.studentId !== 'string'
      || !submittedStudentIds.has(item.studentId) || item.code !== 'OPERATION_FAILED') return null;
    const pair = `${item.taskId}\u0000${item.studentId}`;
    if (resultPairs.has(pair)) return null;
    resultPairs.add(pair);
    failures.push({ taskId, studentId: item.studentId, code: 'OPERATION_FAILED' });
  }
  for (const item of notAttemptedValue) {
    if (!isRecord(item) || !hasExactKeys(item, ['taskId', 'studentId'])
      || item.taskId !== taskId || typeof item.studentId !== 'string'
      || !submittedStudentIds.has(item.studentId)) return null;
    const pair = `${item.taskId}\u0000${item.studentId}`;
    if (resultPairs.has(pair)) return null;
    resultPairs.add(pair);
    notAttempted.push({ taskId, studentId: item.studentId });
  }
  const warningTaskIds = new Set<string>();
  for (const item of warningsValue) {
    if (!isRecord(item) || !hasExactKeys(item, ['taskId', 'code'])
      || item.taskId !== taskId || item.code !== 'LEGACY_MIRROR_UPDATE_FAILED'
      || warningTaskIds.has(taskId)) return null;
    warningTaskIds.add(taskId);
    warnings.push({ taskId, code: 'LEGACY_MIRROR_UPDATE_FAILED' });
  }
  return {
    appliedCount: Number(value.appliedCount),
    failures,
    aborted: Object.hasOwn(value, 'aborted') ? value.aborted as boolean : false,
    notAttempted,
    warnings,
  };
}

export function buildTaskCreationBody(draft: Omit<TaskDraft, 'taskId'>, taskId: string) {
  const schedule = draft.schedule
    ? scheduleFormToPayload(scheduleDtoToForm(draft.schedule))
    : null;
  return {
    taskId,
    title: draft.title,
    description: draft.description,
    reward: draft.reward,
    isActive: draft.isActive,
    sortOrder: draft.sortOrder,
    allowedStudentIds: draft.allowedStudentIds ?? [],
    availableFrom: draft.availableFrom ?? '',
    dueAt: draft.dueAt ?? '',
    prerequisiteTaskId: draft.prerequisiteTaskId ?? '',
    ...(schedule?.ok ? { schedule: schedule.payload } : {}),
  };
}

export function canonicalTaskCreationBody(body: ReturnType<typeof buildTaskCreationBody>) {
  const canonicalInstant = (value: string) => {
    if (!value.trim()) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value.trim() : parsed.toISOString();
  };
  const schedule = body.schedule ?? {
    recurrence: { type: 'NONE' as const },
    timeZone: 'Asia/Seoul',
    resetCompletionOnCycle: false,
    resetAssignmentOnCycle: false,
  };
  const recurrence = schedule.recurrence.type === 'WEEKLY'
    ? { ...schedule.recurrence, weekdays: [...schedule.recurrence.weekdays].sort((a, b) => a - b) }
    : { ...schedule.recurrence };
  return {
    taskId: body.taskId.trim(),
    title: body.title.trim(),
    description: body.description.trim(),
    reward: body.reward,
    isActive: body.isActive,
    sortOrder: body.sortOrder,
    allowedStudentIds: [...new Set(body.allowedStudentIds.map((id) => id.trim()))].sort(),
    availableFrom: canonicalInstant(body.availableFrom),
    dueAt: canonicalInstant(body.dueAt),
    prerequisiteTaskId: body.prerequisiteTaskId.trim() || null,
    schedule: { ...schedule, recurrence },
  };
}

export function isCreatedTask(
  value: unknown,
  expected: ReturnType<typeof canonicalTaskCreationBody>,
): value is ClassTask {
  if (!isRecord(value)) return false;
  const expectedKeys = [
    'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder',
    'allowedStudentIds', 'createdAt', 'taskInstanceId', 'schedule', 'pendingSchedule',
    ...(expected.availableFrom ? ['availableFrom'] : []),
    ...(expected.dueAt ? ['dueAt'] : []),
    ...(expected.prerequisiteTaskId ? ['prerequisiteTaskId'] : []),
  ].sort();
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || value.taskId !== expected.taskId || value.title !== expected.title
    || value.description !== expected.description || value.reward !== expected.reward
    || value.isActive !== expected.isActive || value.sortOrder !== expected.sortOrder
    || !Array.isArray(value.allowedStudentIds)
    || JSON.stringify(value.allowedStudentIds) !== JSON.stringify(expected.allowedStudentIds)
    || typeof value.createdAt !== 'string' || new Date(value.createdAt).toISOString() !== value.createdAt
    || typeof value.taskInstanceId !== 'string' || !value.taskInstanceId.trim()
    || value.pendingSchedule !== null
    || value.availableFrom !== (expected.availableFrom ?? undefined)
    || value.dueAt !== (expected.dueAt ?? undefined)
    || value.prerequisiteTaskId !== (expected.prerequisiteTaskId ?? undefined)
    || !isRecord(value.schedule)) return false;
  const schedule = value.schedule;
  if (Object.keys(schedule).sort().join(',') !== [
    'effectiveFrom', 'recurrence', 'resetAssignmentOnCycle',
    'resetCompletionOnCycle', 'ruleVersion', 'timeZone',
  ].sort().join(',')) return false;
  return schedule.ruleVersion === 1
    && schedule.effectiveFrom === value.createdAt
    && schedule.timeZone === expected.schedule.timeZone
    && schedule.resetCompletionOnCycle === expected.schedule.resetCompletionOnCycle
    && schedule.resetAssignmentOnCycle === expected.schedule.resetAssignmentOnCycle
    && JSON.stringify(schedule.recurrence) === JSON.stringify(expected.schedule.recurrence);
}

export function isCompleteTaskProjection(value: unknown, taskId: string): value is ClassTask {
  if (!isRecord(value) || value.taskId !== taskId
    || typeof value.title !== 'string' || !value.title || value.title.trim() !== value.title
    || typeof value.description !== 'string' || value.description.trim() !== value.description
    || !Number.isSafeInteger(value.reward) || Number(value.reward) < 0
    || typeof value.isActive !== 'boolean'
    || !Number.isInteger(value.sortOrder) || Number(value.sortOrder) < -2147483648
    || Number(value.sortOrder) > 2147483647
    || !Array.isArray(value.allowedStudentIds)
    || value.allowedStudentIds.some((studentId) => typeof studentId !== 'string'
      || !studentId || studentId.trim() !== studentId)
    || new Set(value.allowedStudentIds).size !== value.allowedStudentIds.length
    || value.allowedStudentIds.some((studentId, index, ids) => index > 0 && ids[index - 1] > studentId)
    || typeof value.createdAt !== 'string' || !isCanonicalInstant(value.createdAt)
    || typeof value.taskInstanceId !== 'string' || !value.taskInstanceId
    || value.taskInstanceId.trim() !== value.taskInstanceId
    || !isCanonicalOptionalInstant(value, 'availableFrom')
    || !isCanonicalOptionalInstant(value, 'dueAt')
    || !isCanonicalOptionalId(value, 'prerequisiteTaskId')
    || !isCompleteTaskSchedule(value.schedule)
    || !isCompleteCurrentCycle(value.currentCycle)) return false;
  const availableFrom = typeof value.availableFrom === 'string' ? value.availableFrom : null;
  const dueAt = typeof value.dueAt === 'string' ? value.dueAt : null;
  if (availableFrom && dueAt && Date.parse(dueAt) <= Date.parse(availableFrom)) return false;
  return Object.hasOwn(value, 'pendingSchedule')
    && (value.pendingSchedule === null || isCompleteTaskSchedule(value.pendingSchedule));
}

function isCanonicalOptionalInstant(value: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(value, key)) return true;
  return typeof value[key] === 'string' && isCanonicalInstant(value[key]);
}

function isCanonicalOptionalId(value: Record<string, unknown>, key: string): boolean {
  if (!Object.hasOwn(value, key)) return true;
  return typeof value[key] === 'string' && Boolean(value[key]) && value[key].trim() === value[key];
}

function isCompleteCurrentCycle(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [
    'assignedStudentIds', 'completedStudentIds', 'cycleId', 'endsAt',
    'startsAt', 'students', 'transition',
  ].sort().join(',')
    || typeof value.cycleId !== 'string' || !value.cycleId || value.cycleId.trim() !== value.cycleId
    || typeof value.startsAt !== 'string' || !isCanonicalInstant(value.startsAt)
    || (value.endsAt !== null && (typeof value.endsAt !== 'string' || !isCanonicalInstant(value.endsAt)))
    || (typeof value.endsAt === 'string' && Date.parse(value.endsAt) <= Date.parse(value.startsAt))
    || !['PERMANENT', 'INITIAL_CYCLE', 'SCHEDULE_CHANGE_FIRST_CYCLE', 'NATURAL_BOUNDARY'].includes(String(value.transition))
    || !isCanonicalIdList(value.assignedStudentIds)
    || !isCanonicalIdList(value.completedStudentIds)
    || !Array.isArray(value.students)) return false;
  const origins = ['EVENT', 'CARRY', 'LEGACY', 'DEFAULT'];
  const sources = ['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'];
  const students = value.students;
  if (students.some((student, index) => {
    if (!isRecord(student)) return true;
    const keys = Object.keys(student).sort();
    const expectedKeys = [
      'assigned', 'assignmentOrigin', 'completed', 'completionOrigin', 'studentId',
      ...(Object.hasOwn(student, 'assignmentSource') ? ['assignmentSource'] : []),
    ].sort();
    return keys.length !== expectedKeys.length || keys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
      || typeof student.studentId !== 'string' || !student.studentId
      || student.studentId.trim() !== student.studentId
      || (index > 0 && isRecord(students[index - 1]) && String(students[index - 1].studentId) >= student.studentId)
      || typeof student.assigned !== 'boolean' || typeof student.completed !== 'boolean'
      || !origins.includes(String(student.assignmentOrigin)) || !origins.includes(String(student.completionOrigin))
      || (Object.hasOwn(student, 'assignmentSource') && !sources.includes(String(student.assignmentSource)));
  })) return false;
  const assigned = students.filter((student) => isRecord(student) && student.assigned === true)
    .map((student) => student.studentId);
  const completed = students.filter((student) => isRecord(student) && student.completed === true)
    .map((student) => student.studentId);
  return JSON.stringify(value.assignedStudentIds) === JSON.stringify(assigned)
    && JSON.stringify(value.completedStudentIds) === JSON.stringify(completed);
}

function isCanonicalIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id, index, ids) => typeof id === 'string'
    && Boolean(id) && id.trim() === id && (index === 0 || ids[index - 1] < id));
}

function isCompleteTaskSchedule(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [
    'effectiveFrom', 'recurrence', 'resetAssignmentOnCycle',
    'resetCompletionOnCycle', 'ruleVersion', 'timeZone',
  ].sort().join(',')
    || !Number.isSafeInteger(value.ruleVersion) || Number(value.ruleVersion) < 1
    || typeof value.effectiveFrom !== 'string' || !isCanonicalInstant(value.effectiveFrom)
    || value.timeZone !== 'Asia/Seoul'
    || typeof value.resetCompletionOnCycle !== 'boolean'
    || typeof value.resetAssignmentOnCycle !== 'boolean'
    || !isRecord(value.recurrence)) return false;
  const recurrence = value.recurrence;
  if (recurrence.type === 'NONE') return Object.keys(recurrence).length === 1;
  if (recurrence.type === 'DAILY') return Object.keys(recurrence).length === 2 && isTaskTime(recurrence.time);
  if (recurrence.type === 'WEEKLY') return Object.keys(recurrence).length === 3
    && isTaskTime(recurrence.time) && Array.isArray(recurrence.weekdays)
    && recurrence.weekdays.length > 0
    && recurrence.weekdays.every((day, index, days) => Number.isInteger(day)
      && Number(day) >= 1 && Number(day) <= 7 && (index === 0 || Number(days[index - 1]) < Number(day)));
  return recurrence.type === 'MONTHLY' && Object.keys(recurrence).length === 3
    && isTaskTime(recurrence.time) && Number.isInteger(recurrence.dayOfMonth)
    && Number(recurrence.dayOfMonth) >= 1 && Number(recurrence.dayOfMonth) <= 31;
}

function isTaskTime(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function reconcileTaskProjections(
  current: TaskDraft[],
  serverRows: TaskDraft[],
  targetTaskIds: string[],
  freshTaskIds: string[] = [],
): TaskDraft[] {
  const currentById = new Map(current.map((task) => [task.taskId, task]));
  const targetIds = new Set(targetTaskIds);
  const freshIds = new Set(freshTaskIds);

  return serverRows.map((row) => {
    const serverTask = normalizeAdminTask(row);
    const localTask = currentById.get(serverTask.taskId);
    if (!localTask) return serverTask;
    if (freshIds.has(serverTask.taskId)) return serverTask;
    if (!targetIds.has(serverTask.taskId)) return localTask;

    return {
      ...localTask,
      taskInstanceId: serverTask.taskInstanceId,
      schedule: serverTask.schedule,
      pendingSchedule: serverTask.pendingSchedule,
      availableFrom: serverTask.availableFrom,
      dueAt: serverTask.dueAt,
      prerequisiteTaskId: serverTask.prerequisiteTaskId,
      scheduleReadWarnings: serverTask.scheduleReadWarnings,
      currentCycle: serverTask.currentCycle,
    };
  });
}

export function formatAssignmentFailures(
  failures: Array<{ taskId?: string; studentId?: string; code?: string }>,
  tasks: TaskDraft[],
  students: StudentDraft[],
) {
  return failures.map((failure) => {
    const task = tasks.find((candidate) => candidate.taskId === failure.taskId);
    const student = students.find((candidate) => candidate.studentId === failure.studentId);
    const taskLabel = task ? `${task.title} (${task.taskId})` : failure.taskId ?? '알 수 없는 과제';
    const studentLabel = student ? `${student.name} (${student.studentId})` : failure.studentId ?? '알 수 없는 학생';
    const reason = failure.code === 'OPERATION_FAILED'
      ? '작업 실패'
      : failure.code === 'NOT_ATTEMPTED' ? '미처리' : `작업 실패 (${failure.code ?? 'UNKNOWN'})`;
    return `${taskLabel} · ${studentLabel}: ${reason}`;
  }).join(', ');
}

export function formatTaskWarnings(warnings: Array<{ taskId?: string; code?: string }>, tasks: TaskDraft[]) {
  return warnings.map((warning) => {
    const task = tasks.find((candidate) => candidate.taskId === warning.taskId);
    const label = task ? `${task.title} (${task.taskId})` : warning.taskId ?? '알 수 없는 과제';
    return warning.code === 'LEGACY_MIRROR_UPDATE_FAILED' ? label : `${label}: ${warning.code ?? 'UNKNOWN'}`;
  }).join(', ');
}
