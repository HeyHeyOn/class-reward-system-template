import 'server-only';

import { PetError } from '@/server/repositories/database/pets';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function petJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function petAdminRequired(): Response {
  return petJson({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
}

/** Reads a small JSON object body; returns a ready error response when it is not one. */
export async function readPetJson(request: Request): Promise<{ value: Record<string, unknown> } | Response> {
  const invalid = () => petJson({ error: '요청 형식이 올바르지 않아요. 화면을 새로 고친 뒤 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, 400);
  if (new URL(request.url).search !== ''
    || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return invalid();
  const text = await request.text();
  if (text.length > 20_000) return invalid();
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return { value: value as Record<string, unknown> };
  } catch {
    return invalid();
  }
}

/** Whether the body has exactly these keys (and nothing else). */
export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Maps a failure to a Korean message; unexpected errors are logged with their site. */
export function petFailure(error: unknown, label: string): Response {
  if (error instanceof PetError) return petJson({ error: error.message, code: error.code }, error.status);
  console.error(`[pet:${label}] unexpected failure`, error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
  return petJson({ error: '처리하지 못했어요. 잠시 후 다시 눌러 주세요.', code: 'UNEXPECTED' }, 500);
}
