import 'server-only';

import { StudentBagError } from '@/server/repositories/database/studentBag';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function studentBagJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export function studentBagAdminRequired(): Response {
  return studentBagJson({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
}

/** Maps a failure to a Korean message; unexpected errors are logged with their site. */
export function studentBagFailure(error: unknown, label: string): Response {
  if (error instanceof StudentBagError) return studentBagJson({ error: error.message, code: error.code }, error.status);
  console.error(`[student-bag:${label}] unexpected failure`, error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
  return studentBagJson({ error: '처리하지 못했어요. 잠시 후 다시 눌러 주세요.', code: 'UNEXPECTED' }, 500);
}
