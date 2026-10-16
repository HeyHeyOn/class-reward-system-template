import type { PadletBoardPreviewDto, PadletBoardStatusDto, PadletErrorCode, PadletStatusDto } from '@/lib/padletLinkApi';
import { tenantFetch } from '@/lib/tenantApiPath';
import {
  TASK_STAGES,
  type AdminTaskDto, type CreateTaskRequest, type DeleteTasksRequest, type QrStageRequest, type QrStageResultDto,
  type ResetTasksRequest, type SetRepeatRequest, type SetStagesRequest, type TaskBoardDto, type TaskHistoryDto,
  type TaskHistoryEntryDto, type TaskHistoryPageRequest, type TaskPadletLinkDto, type UpdateTaskRequest,
} from '@/lib/taskLedgerApi';
import type { TaskStage } from '@/domain/taskStage';
import type { BoardChoiceDto, BoardLinkStatusDto } from '@/lib/boardLinkApi';

/*
 * Calls for the stage-ledger task API (PostgreSQL classes). Nothing here is remembered between
 * calls: every write states the result it wants, so sending it again after a failure is safe.
 */

export const SAVE_FAILED = '저장하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';
export const LOAD_FAILED = '과제 정보를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

export type LedgerFailure = { ok: false; error: string; code: string | null; status: number | null };
export type LedgerResult<T> = { ok: true; data: T } | LedgerFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const isStage = (value: unknown): value is TaskStage => typeof value === 'string' && (TASK_STAGES as readonly string[]).includes(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readTask(value: unknown): AdminTaskDto | null {
  if (!isRecord(value)) return null;
  const { repeat, students, counts } = value;
  if (!isText(value.taskId) || !value.taskId || !isText(value.title) || !isCount(value.reward) || typeof value.isActive !== 'boolean'
    || !isCount(value.sortOrder) || !isTextOrNull(value.availableFrom ?? null) || !isTextOrNull(value.dueAt ?? null)
    || !isTextOrNull(value.prerequisiteTaskId ?? null)) return null;
  if (!isRecord(repeat) || !isRecord(repeat.recurrence) || !isText(repeat.recurrence.type)
    || !(repeat.resetStage === null || repeat.resetStage === undefined || isStage(repeat.resetStage))
    || !isTextOrNull(repeat.nextResetAt ?? null) || !isTextOrNull(repeat.lastResetAt ?? null)) return null;
  if (!Array.isArray(students) || !students.every((row) => isRecord(row) && isText(row.studentId) && isStage(row.stage)
    && isTextOrNull(row.since ?? null))) return null;
  if (!isRecord(counts) || !TASK_STAGES.every((stage) => isCount(counts[stage]))) return null;
  return {
    ...(value as AdminTaskDto),
    description: isText(value.description) ? value.description : '',
    availableFrom: (value.availableFrom as string | null | undefined) ?? null,
    dueAt: (value.dueAt as string | null | undefined) ?? null,
    prerequisiteTaskId: (value.prerequisiteTaskId as string | null | undefined) ?? null,
    repeat: { ...(repeat as AdminTaskDto['repeat']), resetStage: (repeat.resetStage as TaskStage | null | undefined) ?? null,
      nextResetAt: (repeat.nextResetAt as string | null | undefined) ?? null, lastResetAt: (repeat.lastResetAt as string | null | undefined) ?? null },
    students: students.map((row) => ({ ...(row as AdminTaskDto['students'][number]), since: (row.since as string | null | undefined) ?? null, byReset: row.byReset === true })),
    padlet: readPadletLink(value.padlet),
  };
}

function readPadletLink(value: unknown): TaskPadletLinkDto | null {
  if (!isRecord(value) || !isText(value.boardId) || !isText(value.boardUrl)) return null;
  return {
    boardId: value.boardId, boardTitle: isText(value.boardTitle) ? value.boardTitle : '', boardUrl: value.boardUrl,
    sectionId: isText(value.sectionId) ? value.sectionId : null, sectionTitle: isText(value.sectionTitle) ? value.sectionTitle : null,
    lastReadAt: isText(value.lastReadAt) ? value.lastReadAt : null, error: isText(value.error) ? value.error : null,
    checking: value.checking === true, retryAt: isText(value.retryAt) ? value.retryAt : null,
  };
}

function readTasks(value: unknown): AdminTaskDto[] | null {
  if (!Array.isArray(value)) return null;
  const tasks = value.map(readTask);
  return tasks.every((task): task is AdminTaskDto => task !== null) ? tasks : null;
}

function readTasksEnvelope(value: unknown): AdminTaskDto[] | null {
  return isRecord(value) ? readTasks(value.tasks) : null;
}

function readTaskEnvelope(value: unknown): AdminTaskDto | null {
  return isRecord(value) ? readTask(value.task) : null;
}

function readBoard(value: unknown): TaskBoardDto | null {
  if (!isRecord(value) || !isText(value.now)) return null;
  const tasks = readTasks(value.tasks);
  return tasks ? { now: value.now, tasks } : null;
}

function readHistory(value: unknown): TaskHistoryDto | null {
  if (!isRecord(value) || !isText(value.taskId) || !Array.isArray(value.entries)) return null;
  if (value.nextCursor !== undefined && !isTextOrNull(value.nextCursor)) return null;
  if (value.snapshotAt !== undefined && (!isText(value.snapshotAt) || !Number.isFinite(Date.parse(value.snapshotAt)))) return null;
  const entries = value.entries.filter((entry): entry is TaskHistoryEntryDto => isRecord(entry) && isText(entry.id) && isText(entry.at)
    && isText(entry.studentId) && isStage(entry.stage));
  if (entries.length !== value.entries.length) return null;
  return { taskId: value.taskId, title: isText(value.title) ? value.title : '', entries, truncated: value.truncated === true,
    ...(value.nextCursor !== undefined ? { nextCursor: value.nextCursor as string | null } : {}),
    ...(value.snapshotAt !== undefined ? { snapshotAt: value.snapshotAt as string } : {}) };
}

function readQr(value: unknown): QrStageResultDto | null {
  if (!isRecord(value) || !isRecord(value.student) || !isText(value.student.studentId) || !isStage(value.stage) || !isStage(value.previousStage)) return null;
  const task = readTask(value.task);
  if (!task) return null;
  return { task, student: { studentId: value.student.studentId, name: isText(value.student.name) ? value.student.name : value.student.studentId },
    previousStage: value.previousStage, stage: value.stage, changed: value.changed === true };
}

function readPadletStatus(value: unknown): PadletStatusDto | null {
  if (!isRecord(value) || !isText(value.now) || !isRecord(value.key) || !Array.isArray(value.boards)) return null;
  const boards = value.boards.filter((board): board is PadletBoardStatusDto => isRecord(board) && isText(board.boardId)
    && Array.isArray(board.taskIds) && board.taskIds.every(isText) && Array.isArray(board.posts)
    && board.posts.every((post) => isRecord(post) && isText(post.postId) && isText(post.at) && isRecord(post.results)));
  if (boards.length !== value.boards.length) return null;
  return {
    now: value.now,
    key: { saved: value.key.saved === true, hint: isText(value.key.hint) ? value.key.hint : null, readable: value.key.readable === true },
    boards: boards.map((board) => ({ ...board, title: isText(board.title) ? board.title : '', url: isText(board.url) ? board.url : '',
      checkedAt: isText(board.checkedAt) ? board.checkedAt : null, succeededAt: isText(board.succeededAt) ? board.succeededAt : null,
      error: isText(board.error) ? board.error as PadletErrorCode : null,
      checking: board.checking === true, retryAt: isText(board.retryAt) ? board.retryAt : null })),
  };
}

function readPadletPreview(value: unknown): PadletBoardPreviewDto | null {
  if (!isRecord(value) || !isText(value.boardId) || !isText(value.url) || !Array.isArray(value.sections)) return null;
  const sections = value.sections.filter((section): section is { id: string; title: string } => isRecord(section) && isText(section.id) && isText(section.title));
  return { boardId: value.boardId, title: isText(value.title) ? value.title : '', url: value.url, sections,
    postCount: isCount(value.postCount) ? value.postCount : 0 };
}

function readDeleted(value: unknown): string[] | null {
  return isRecord(value) && Array.isArray(value.deletedTaskIds) && value.deletedTaskIds.every(isText) ? value.deletedTaskIds as string[] : null;
}

async function call<T>(path: string, init: RequestInit, read: (value: unknown) => T | null, fallback: string): Promise<LedgerResult<T>> {
  let response: Response;
  try {
    response = await tenantFetch(path, init);
  } catch {
    return { ok: false, error: fallback, code: null, status: null };
  }
  let payload: unknown = null;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    const message = isRecord(payload) && isText(payload.error) && payload.error.trim() ? payload.error : fallback;
    const code = isRecord(payload) && isText(payload.code) ? payload.code : null;
    return { ok: false, error: message, code, status: response.status };
  }
  const data = read(payload);
  return data === null ? { ok: false, error: fallback, code: null, status: response.status } : { ok: true, data };
}

const get = (): RequestInit => ({ cache: 'no-store' });
const send = (method: 'POST' | 'PATCH', body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const taskPath = (taskId: string) => `/api/task-ledger/tasks/${encodeURIComponent(taskId)}`;

function historyPath(taskId: string, page: TaskHistoryPageRequest = {}): string {
  const query = new URLSearchParams();
  if (page.limit !== undefined) query.set('limit', String(page.limit));
  if (page.cursor) query.set('cursor', page.cursor);
  if (page.studentId) query.set('studentId', page.studentId);
  return `${taskPath(taskId)}/history${query.size ? `?${query}` : ''}`;
}

/** A fresh request number for each click. Never stored. */
export function newOperationId(): string {
  return crypto.randomUUID();
}

export const ledgerClient = {
  board: () => call('/api/task-ledger', get(), readBoard, LOAD_FAILED),
  history: (taskId: string, page?: TaskHistoryPageRequest) => call(historyPath(taskId, page), get(), readHistory, LOAD_FAILED),
  create: (body: CreateTaskRequest) => call('/api/task-ledger/tasks', send('POST', body), readTaskEnvelope, SAVE_FAILED),
  update: (taskId: string, body: UpdateTaskRequest) => call(taskPath(taskId), send('PATCH', body), readTaskEnvelope, SAVE_FAILED),
  remove: (body: DeleteTasksRequest) => call('/api/task-ledger/tasks/delete', send('POST', body), readDeleted, SAVE_FAILED),
  stages: (body: SetStagesRequest) => call('/api/task-ledger/stages', send('POST', body), readTasksEnvelope, SAVE_FAILED),
  reset: (body: ResetTasksRequest) => call('/api/task-ledger/reset', send('POST', body), readTasksEnvelope, SAVE_FAILED),
  repeat: (body: SetRepeatRequest) => call('/api/task-ledger/repeat', send('POST', body), readTasksEnvelope, SAVE_FAILED),
  qr: (body: QrStageRequest) => call('/api/task-ledger/qr', send('POST', body), readQr, SAVE_FAILED),
};

export const PADLET_LOAD_FAILED = '패들렛 연결 정보를 불러오지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

/** Padlet links (PostgreSQL classes). Linking and 지금 확인 read Padlet, so they can take a few seconds. */
export const padletClient = {
  status: () => call('/api/task-ledger/padlet', get(), readPadletStatus, PADLET_LOAD_FAILED),
  preview: (address: string) => call(`/api/task-ledger/padlet/preview?${new URLSearchParams({ address })}`, get(), readPadletPreview, PADLET_LOAD_FAILED),
  setKey: (apiKey: string | null) => call('/api/task-ledger/padlet/key', send('POST', { apiKey }), readPadletStatus, SAVE_FAILED),
  link: (body: { taskIds: readonly string[]; address: string; sectionId: string | null }) =>
    call('/api/task-ledger/padlet/links', send('POST', body), readTasksEnvelope, SAVE_FAILED),
  unlink: (taskIds: readonly string[]) => call('/api/task-ledger/padlet/unlink', send('POST', { taskIds }), readTasksEnvelope, SAVE_FAILED),
  sync: () => call('/api/task-ledger/padlet/sync', send('POST', {}), readPadletStatus, PADLET_LOAD_FAILED),
};

function readBoardLinkStatus(value: unknown): BoardLinkStatusDto | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !Array.isArray(value.boards)) return null;
  const boards = value.boards.filter((board): board is BoardChoiceDto => isRecord(board) && isText(board.id) && isText(board.code)
    && isText(board.title) && isText(board.format) && Array.isArray(board.groups) && typeof board.selectable === 'boolean');
  return boards.length === value.boards.length ? { enabled: value.enabled, boards } : null;
}

export const BOARD_LOAD_FAILED = '딴쌤 보드 목록을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.';

/** 딴쌤 board links (PostgreSQL classes signed in with 딴쌤). Linking also reads the board, so it can take a few seconds. */
export const boardLinkClient = {
  status: () => call('/api/task-ledger/board', get(), readBoardLinkStatus, BOARD_LOAD_FAILED),
  link: (body: { taskIds: readonly string[]; boardId: string; groupId: string | null }) =>
    call('/api/task-ledger/board/links', send('POST', body), readTasksEnvelope, SAVE_FAILED),
  unlink: (taskIds: readonly string[]) => call('/api/task-ledger/board/unlink', send('POST', { taskIds }), readTasksEnvelope, SAVE_FAILED),
};

