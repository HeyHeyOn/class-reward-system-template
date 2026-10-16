import 'server-only';

import { createHmac, randomBytes } from 'node:crypto';
import { hubLoginEnabled } from './hub';

// The class server calling the 딴쌤 board server (ddanssaem-hub/docs/app-links.md 8-2): the teacher's boards,
// linking a board's roster to the class, and the posts or submissions that count for a student. Signed like
// the board's own calls (hex HMAC-SHA256 of the body with DDANSSAEM_LINK_SECRET, iat within five minutes).
// The student's way in from the bank is a 60-second ticket the board checks (8-3).

type Env = Readonly<Record<string, string | undefined>>;

export const BOARD_TIMEOUT_MS = 8_000;
export const BOARD_TICKET_SECONDS = 60;
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOARD_CODE = /^[A-Za-z0-9_-]{1,32}$/;
const FORMATS = new Set(['mini', 'group', 'quiz', 'survey']);

export type BoardFormat = 'mini' | 'group' | 'quiz' | 'survey';
export type BoardSummary = Readonly<{
  id: string; code: string; title: string; format: BoardFormat;
  groups: readonly Readonly<{ id: string; name: string }>[]; linkedClassId: string | null;
}>;
export type BoardEvidenceItem = Readonly<{ id: string; createdAt: string }>;

export type BoardLinkErrorCode = 'NOT_CONFIGURED' | 'NOT_FOUND' | 'FORBIDDEN' | 'LINKED_ELSEWHERE' | 'RATE_LIMITED' | 'TIMEOUT' | 'UNAVAILABLE';

export class BoardLinkError extends Error {
  constructor(readonly code: BoardLinkErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = 'BoardLinkError';
  }
}

export const BOARD_LINK_MESSAGES: Readonly<Record<BoardLinkErrorCode, string>> = {
  NOT_CONFIGURED: '딴쌤 보드 연결을 쓸 수 없어요.',
  NOT_FOUND: '딴쌤 보드를 찾지 못했어요. 보드가 지워졌거나 보드를 관리할 수 없는 계정이에요.',
  FORBIDDEN: '보드를 만든 선생님만 명단을 학급과 연결할 수 있어요.',
  LINKED_ELSEWHERE: '이 보드는 다른 학급 명단과 연결돼 있어요.',
  RATE_LIMITED: '딴쌤 보드가 잠시 바빠요. 조금 뒤에 다시 확인해요.',
  TIMEOUT: '딴쌤 보드가 늦게 답해요. 조금 뒤에 다시 확인해요.',
  UNAVAILABLE: '딴쌤 보드에 연결하지 못했어요. 조금 뒤에 다시 확인해요.',
};

const STATUS: Readonly<Record<BoardLinkErrorCode, number>> = {
  NOT_CONFIGURED: 404, NOT_FOUND: 404, FORBIDDEN: 403, LINKED_ELSEWHERE: 409, RATE_LIMITED: 429, TIMEOUT: 504, UNAVAILABLE: 502,
};
export const boardLinkError = (code: BoardLinkErrorCode) => new BoardLinkError(code, BOARD_LINK_MESSAGES[code], STATUS[code]);

function linkSecret(env: Env): string | null {
  const secret = env.DDANSSAEM_LINK_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

/** The board server's origin (https, or http on localhost for development), or null. */
export function boardOrigin(env: Env = process.env): string | null {
  const raw = env.DDANSSAEM_BOARD_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    return url.protocol === 'https:' || local ? url.origin : null;
  } catch {
    return null;
  }
}

/** Tasks can link 딴쌤 boards: the board server is set, the link secret too, and teachers sign in with 딴쌤. */
export function boardLinksEnabled(env: Env = process.env): boolean {
  return boardOrigin(env) !== null && linkSecret(env) !== null && hubLoginEnabled(env);
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function parseBoard(value: unknown): BoardSummary | null {
  if (!value || typeof value !== 'object') return null;
  const board = value as Record<string, unknown>;
  const id = text(board.id, 64);
  const code = text(board.code, 32);
  const title = text(board.title, 300);
  if (!id || !BOARD_ID.test(id) || !code || !BOARD_CODE.test(code) || title === null || typeof board.format !== 'string' || !FORMATS.has(board.format)) return null;
  const groups = board.format === 'group' && Array.isArray(board.groups)
    ? board.groups.flatMap((group) => {
      if (!group || typeof group !== 'object') return [];
      const entry = group as Record<string, unknown>;
      const groupId = text(entry.id, 64);
      const name = text(entry.name, 100);
      return groupId && BOARD_ID.test(groupId) && name ? [{ id: groupId, name }] : [];
    }) : [];
  const linked = board.linkedClassId;
  return { id, code, title, format: board.format as BoardFormat, groups,
    linkedClassId: typeof linked === 'string' && linked ? linked.toLowerCase() : null };
}

export type BoardClient = Readonly<{
  listBoards(sub: string, classId: string): Promise<BoardSummary[]>;
  attach(sub: string, boardId: string, classId: string): Promise<{ linkedClassId: string }>;
  evidence(request: Readonly<{ sub: string; boardId: string; groupId: string | null; classId: string; studentId: string;
    from: string; to: string | null }>): Promise<BoardEvidenceItem[]>;
}>;

export function createBoardClient(env: Env = process.env, fetchImpl: typeof fetch = fetch, timeoutMs = BOARD_TIMEOUT_MS): BoardClient {
  async function call(path: string, payload: Record<string, unknown>): Promise<unknown> {
    const origin = boardOrigin(env);
    const secret = linkSecret(env);
    if (!origin || !secret) throw boardLinkError('NOT_CONFIGURED');
    const body = JSON.stringify({ iat: Math.floor(Date.now() / 1000), ...payload });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-ddanssaem-signature': createHmac('sha256', secret).update(body, 'utf8').digest('hex'),
    };
    const bypass = env.DDANSSAEM_BOARD_BYPASS?.trim();
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
    let response: Response;
    try {
      response = await fetchImpl(`${origin}/api/ddanssaem/link/${path}`, {
        method: 'POST', body, headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw boardLinkError(error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ? 'TIMEOUT' : 'UNAVAILABLE');
    }
    if (response.status === 403) throw boardLinkError('FORBIDDEN');
    if (response.status === 404) throw boardLinkError('NOT_FOUND');
    if (response.status === 409) throw boardLinkError('LINKED_ELSEWHERE');
    if (response.status === 429) throw boardLinkError('RATE_LIMITED');
    if (!response.ok) throw boardLinkError('UNAVAILABLE');
    return response.json().catch(() => { throw boardLinkError('UNAVAILABLE'); });
  }
  return {
    async listBoards(sub, classId) {
      const payload = await call('boards', { sub, classId }) as { boards?: unknown };
      if (!Array.isArray(payload?.boards)) throw boardLinkError('UNAVAILABLE');
      return payload.boards.flatMap((board) => parseBoard(board) ?? []);
    },
    async attach(sub, boardId, classId) {
      const payload = await call('attach', { sub, boardId, classId }) as { linkedClassId?: unknown };
      if (typeof payload?.linkedClassId !== 'string') throw boardLinkError('UNAVAILABLE');
      return { linkedClassId: payload.linkedClassId.toLowerCase() };
    },
    async evidence(request) {
      const payload = await call('evidence', { ...request }) as { items?: unknown };
      if (!Array.isArray(payload?.items)) throw boardLinkError('UNAVAILABLE');
      return payload.items.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const entry = item as Record<string, unknown>;
        const id = text(entry.id, 160);
        const createdAt = typeof entry.createdAt === 'string' && Number.isFinite(Date.parse(entry.createdAt)) ? new Date(entry.createdAt).toISOString() : null;
        return id && /^[A-Za-z0-9_.:-]{1,160}$/.test(id) && createdAt ? [{ id, createdAt }] : [];
      });
    },
  };
}

/** 8-3: base64url(JSON) "." hex(HMAC-SHA256(link secret, the base64url part)), good for 60 seconds, used once. */
export function boardTicket(input: Readonly<{ classId: string; studentId: string; boardId: string }>, env: Env = process.env, now = Date.now()): string {
  const secret = linkSecret(env);
  if (!secret) throw boardLinkError('NOT_CONFIGURED');
  const payload = Buffer.from(JSON.stringify({
    v: 1, classId: input.classId, studentId: input.studentId, boardId: input.boardId,
    exp: Math.floor(now / 1000) + BOARD_TICKET_SECONDS, nonce: randomBytes(16).toString('base64url'),
  })).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export function boardEnterUrl(code: string, ticket: string, env: Env = process.env): string {
  const origin = boardOrigin(env);
  if (!origin || !BOARD_CODE.test(code)) throw boardLinkError('NOT_CONFIGURED');
  return `${origin}/${encodeURIComponent(code)}/enter?ticket=${encodeURIComponent(ticket)}`;
}

/** Where a teacher manages the board (a new tab). */
export function boardPageUrl(code: string, env: Env = process.env): string | null {
  const origin = boardOrigin(env);
  return origin && BOARD_CODE.test(code) ? `${origin}/${encodeURIComponent(code)}` : null;
}
