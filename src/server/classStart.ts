import 'server-only';
import { parseTenantSlug } from '@/server/tenantContext';
import type { ClassStartRepository } from '@/server/repositories/database/classStart';
import { readClassMutationRequest, classMutationReply as reply, UUID_V4 } from './classMutationRequest';
import { hasTeacherSessionBinding } from './teacherSession';

export async function handleClassStart(request: Request, slug: unknown, repository: ClassStartRepository) {
  const parsed = await readClassMutationRequest(request);
  if (parsed instanceof Response) return parsed;
  const { body, session } = parsed;
  if (!hasTeacherSessionBinding(session)) return reply(401, { error: '로그인이 필요하거나 만료되었습니다. 다시 로그인해 주세요.' });
  try {
    const canonical = parseTenantSlug(slug);
    if (canonical.needsRedirect) throw new Error('Noncanonical slug.');
  } catch { return reply(400, { error: '내 학급 목록에서 다시 선택해 주세요.' }); }
  if (Object.keys(body).length !== 1 || typeof body.operationId !== 'string' || !UUID_V4.test(body.operationId)) {
    return reply(400, { error: '사용 시작 요청을 확인해 주세요.' });
  }
  try {
    const result = await repository.start({ operationId: body.operationId, slug: slug as string, subject: session.subject,
      accountGeneration: session.accountGeneration, sessionId: session.sessionId });
    return reply(200, result);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === '28000') return reply(401, { error: '로그인이 필요하거나 만료되었습니다. 다시 로그인해 주세요.' });
    if (code === '42501') return reply(403, { error: '새 학급의 소유자만 사용을 시작할 수 있습니다.' });
    if (code === '23505') return reply(409, { error: '학급 상태가 변경됐거나 이전할 자료가 있습니다. 내 학급 목록을 확인해 주세요.' });
    return reply(503, { error: '결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하거나 내 학급 목록을 열어 주세요.', retryable: true });
  }
}
