import { parseTaskIds, TaskLedgerRequestError } from './taskLedgerApi';

/** Linking class tasks to 딴쌤 boards (ddanssaem-hub/docs/app-links.md 8): shapes shared by the routes and the screens. */

export type BoardFormat = 'mini' | 'group' | 'quiz' | 'survey';

/** One of the teacher's boards; `selectable` is false when its roster is linked to another class. */
export type BoardChoiceDto = Readonly<{
  id: string; code: string; title: string; format: BoardFormat;
  groups: readonly Readonly<{ id: string; name: string }>[];
  linkedClassId: string | null; linkedHere: boolean; selectable: boolean;
}>;

export type BoardLinkStatusDto = Readonly<{ enabled: boolean; boards: readonly BoardChoiceDto[] }>;

export const BOARD_FORMAT_LABELS: Readonly<Record<BoardFormat, string>> = { mini: '담벼락', group: '그룹', quiz: '퀴즈', survey: '설문' };

/** What a student does on the board for the task to count: a post, or a submission on a quiz or survey. */
export function boardActionText(format: BoardFormat): string {
  return format === 'quiz' || format === 'survey' ? '제출하면' : '글을 올리면';
}

function fail(message: string): never { throw new TaskLedgerRequestError(message); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('요청 형식이 올바르지 않아요.');
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`알 수 없는 항목(${key})이 있어요.`);
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseBoardLinkRequest(value: unknown): { taskIds: string[]; boardId: string; groupId: string | null } {
  const raw = record(value);
  only(raw, ['taskIds', 'boardId', 'groupId']);
  if (typeof raw.boardId !== 'string' || !ID.test(raw.boardId)) fail('보드를 골라 주세요.');
  const groupId = raw.groupId ?? null;
  if (groupId !== null && (typeof groupId !== 'string' || !ID.test(groupId))) fail('그룹이 올바르지 않아요.');
  return { taskIds: parseTaskIds(raw.taskIds), boardId: raw.boardId, groupId };
}

export function parseBoardUnlinkRequest(value: unknown): { taskIds: string[] } {
  const raw = record(value);
  only(raw, ['taskIds']);
  return { taskIds: parseTaskIds(raw.taskIds) };
}

export function parseBoardTicketRequest(value: unknown): { taskId: string } {
  const raw = record(value);
  only(raw, ['taskId']);
  if (typeof raw.taskId !== 'string' || !raw.taskId || raw.taskId.length > 128 || raw.taskId !== raw.taskId.trim()) fail('과제가 올바르지 않아요.');
  return { taskId: raw.taskId };
}
