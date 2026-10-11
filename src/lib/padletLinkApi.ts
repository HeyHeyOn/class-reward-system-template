import type { PadletPostOutcome } from '@/domain/padlet';
import { parseTaskIds, TaskLedgerRequestError, type AdminTaskDto } from './taskLedgerApi';

/** Padlet links between tasks and Padlet boards (see src/domain/padlet.ts). Shared by the routes and the screens. */

export type PadletErrorCode =
  | 'NO_KEY' | 'KEY_UNREADABLE' | 'INVALID_KEY' | 'NOT_PAYING' | 'NOT_ADMIN' | 'NOT_FOUND' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNAVAILABLE';

export const PADLET_ERROR_MESSAGES: Readonly<Record<PadletErrorCode, string>> = {
  NO_KEY: 'Padlet API 키를 먼저 넣어 주세요.',
  KEY_UNREADABLE: '저장된 Padlet API 키를 읽을 수 없어요. 키를 다시 넣어 주세요.',
  INVALID_KEY: 'Padlet이 이 API 키를 받지 않아요. 키를 다시 확인해 주세요.',
  NOT_PAYING: 'Padlet API는 유료(Gold·Platinum) 계정의 키로만 쓸 수 있어요.',
  NOT_ADMIN: '이 게시판을 관리하는 계정의 API 키가 필요해요.',
  NOT_FOUND: '게시판을 찾지 못했어요. 주소를 다시 확인해 주세요.',
  RATE_LIMITED: 'Padlet에 요청이 많아요. 1분 뒤에 다시 해 주세요.',
  TIMEOUT: 'Padlet이 늦게 답해요. 잠시 뒤에 다시 해 주세요.',
  UNAVAILABLE: 'Padlet에 연결하지 못했어요. 잠시 뒤에 다시 해 주세요.',
};

export type PadletKeyStatusDto = Readonly<{ saved: boolean; hint: string | null; readable: boolean }>;

/** What one post did; `results` is keyed by task ID. */
export type PadletPostDto = Omit<PadletPostOutcome, 'results'> & Readonly<{ studentName: string | null; results: Readonly<Record<string, string>> }>;

export type PadletBoardStatusDto = Readonly<{
  boardId: string;
  title: string;
  url: string;
  /** The tasks linked to this board. */
  taskIds: readonly string[];
  checkedAt: string | null;
  succeededAt: string | null;
  error: PadletErrorCode | null;
  /** Recent posts, newest first. */
  posts: readonly PadletPostDto[];
}>;

export type PadletStatusDto = Readonly<{ now: string; key: PadletKeyStatusDto; boards: readonly PadletBoardStatusDto[] }>;

export type PadletBoardPreviewDto = Readonly<{
  boardId: string;
  title: string;
  url: string;
  sections: ReadonlyArray<Readonly<{ id: string; title: string }>>;
  postCount: number;
}>;

export type PadletTasksDto = Readonly<{ tasks: readonly AdminTaskDto[] }>;

function fail(message: string): never { throw new TaskLedgerRequestError(message); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('요청 형식이 올바르지 않습니다.');
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`알 수 없는 항목(${key})이 있습니다.`);
}

function address(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) fail('게시판 주소를 넣어 주세요.');
  return value.trim();
}

export function parsePadletKeyRequest(value: unknown): { apiKey: string | null } {
  const raw = record(value);
  only(raw, ['apiKey']);
  if (raw.apiKey === null) return { apiKey: null };
  if (typeof raw.apiKey !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(raw.apiKey.trim())) fail('Padlet API 키를 그대로 붙여 넣어 주세요.');
  return { apiKey: raw.apiKey.trim() };
}

export function parsePadletPreviewRequest(value: unknown): { address: string } {
  const raw = record(value);
  only(raw, ['address']);
  return { address: address(raw.address) };
}

export function parsePadletLinkRequest(value: unknown): { taskIds: string[]; address: string; sectionId: string | null } {
  const raw = record(value);
  only(raw, ['taskIds', 'address', 'sectionId']);
  const sectionId = raw.sectionId ?? null;
  if (sectionId !== null && (typeof sectionId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(sectionId))) fail('섹션이 올바르지 않습니다.');
  return { taskIds: parseTaskIds(raw.taskIds), address: address(raw.address), sectionId };
}

export function parsePadletUnlinkRequest(value: unknown): { taskIds: string[] } {
  const raw = record(value);
  only(raw, ['taskIds']);
  return { taskIds: parseTaskIds(raw.taskIds) };
}
