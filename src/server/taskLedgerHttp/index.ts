import 'server-only';

import { TaskLedgerRequestError } from '@/lib/taskLedgerApi';
import { BoardLinkError } from '@/server/ddanssaem/boardClient';
import { TaskLedgerError } from '@/server/repositories/database/taskLedger/store';
import { logFailure } from '@/server/log';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function taskLedgerJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function taskLedgerAdminRequired(): Response {
  return taskLedgerJson({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
}

/** Reads a JSON body (≤ 1 MB); returns a ready error response when it is not JSON. */
export async function readTaskLedgerJson(request: Request): Promise<{ value: unknown } | Response> {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return taskLedgerJson({ error: '요청 형식이 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, 415);
  }
  const text = await request.text();
  if (text.length > 1_000_000) {
    return taskLedgerJson({ error: '한 번에 너무 많이 바꾸려고 했어요. 나눠서 저장해 주세요.', code: 'TOO_LARGE' }, 413);
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return taskLedgerJson({ error: '요청 형식이 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, 400);
  }
}

/** Maps a failure to the teacher-facing message; unexpected errors are logged with their site. */
export function taskLedgerFailure(error: unknown, label: string): Response {
  if (error instanceof TaskLedgerRequestError) return taskLedgerJson({ error: error.message, code: 'INVALID_REQUEST' }, 400);
  if (error instanceof TaskLedgerError) return taskLedgerJson({ error: error.message, code: error.code }, error.status);
  if (error instanceof BoardLinkError) return taskLedgerJson({ error: error.message, code: `BOARD_${error.code}` }, error.status);
  logFailure(`[task-ledger:${label}] unexpected failure`, error);
  return taskLedgerJson({ error: '저장하지 못했어요. 잠시 후 다시 눌러 주세요.', code: 'UNEXPECTED' }, 500);
}
