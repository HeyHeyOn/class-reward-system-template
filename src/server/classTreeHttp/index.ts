import 'server-only';

import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { ClassTreeError } from '@/server/repositories/database/classTree';
import { logFailure } from '@/server/log';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function classTreeJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function classTreeAdminRequired(): Response {
  return classTreeJson({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
}

/** Reads a small JSON object body; returns a ready error response when it is not one. */
export async function readClassTreeJson(request: Request): Promise<{ value: Record<string, unknown> } | Response> {
  const invalid = (status = 400) => classTreeJson({ error: '요청 형식이 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, status);
  if (new URL(request.url).search !== ''
    || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return invalid();
  try {
    const text = await readBoundedRequestText(request, 10_000);
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return { value: value as Record<string, unknown> };
  } catch (error) {
    return invalid(error instanceof RequestBodyError ? error.status : 400);
  }
}

/** Maps a failure to a Korean message; unexpected errors are logged with their site. */
export function classTreeFailure(error: unknown, label: string): Response {
  if (error instanceof ClassTreeError) return classTreeJson({ error: error.message, code: error.code }, error.status);
  logFailure(`[class-tree:${label}] unexpected failure`, error);
  return classTreeJson({ error: '처리하지 못했어요. 잠시 후 다시 눌러 주세요.', code: 'UNEXPECTED' }, 500);
}
