import 'server-only';
import { parseTenantSlug } from './tenantContext';
import { readClassMutationRequest, classMutationReply as reply, UUID_V4 } from './classMutationRequest';
import type { ClassManagementAction, ClassManagementCommand } from './repositories/database/classDashboard';
import { hasTeacherSessionBinding } from './teacherSession';

export async function handleClassManagement(request: Request, slug: unknown, command: ClassManagementCommand) {
  const parsed = await readClassMutationRequest(request);
  if (parsed instanceof Response) return parsed;
  try { if (parseTenantSlug(slug).needsRedirect) throw new Error(); }
  catch { return reply(400, { error: '내 학급 목록에서 다시 선택해 주세요.' }); }
  const { body, session } = parsed;
  if (!hasTeacherSessionBinding(session)) return reply(401, { error: '로그인이 필요하거나 만료됐어요. 다시 로그인해 주세요.' });
  if (Object.keys(body).length !== 4 || Object.keys(body).some(k => !['operationId','action','name','expectedVersion'].includes(k))
    || typeof body.operationId !== 'string' || !UUID_V4.test(body.operationId)
    || !['RENAME','DUPLICATE','DELETE','RESTORE','PURGE'].includes(String(body.action))
    || typeof body.name !== 'string' || body.name !== body.name.trim() || body.name.length < 1 || body.name.length > 80
    || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(body.name) || typeof body.expectedVersion !== 'string'
    || !/^[1-9][0-9]*$/.test(body.expectedVersion) || !Number.isSafeInteger(Number(body.expectedVersion))
    || Number(body.expectedVersion) >= Number.MAX_SAFE_INTEGER) {
    return reply(400, { error: '학급 이름과 요청을 확인해 주세요. 이름은 1~80자로 입력할 수 있어요.' });
  }
  try {
    return reply(200, await command.execute({ operationId: body.operationId, slug: slug as string,
      subject: session.subject, accountGeneration: session.accountGeneration, sessionId: session.sessionId,
      action: body.action as ClassManagementAction, name: body.name, expectedVersion: body.expectedVersion }));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === '28000') return reply(401, { error: '로그인이 필요하거나 만료됐어요. 다시 로그인해 주세요.' });
    if (code === '42501') return reply(403, { error: '학급 소유자만 이 작업을 할 수 있어요.' });
    if (code === '23505') return reply(409, { error: '학급 상태가 변경됐어요. 목록을 새로고침한 뒤 다시 확인해 주세요.' });
    if (code === '22023') return reply(400, { error: '학급 이름과 요청을 확인해 주세요.' });
    return reply(503, { error: '처리 결과를 확인하지 못했어요. 같은 요청으로 다시 확인하거나 목록을 새로고침해 주세요.', retryable: true });
  }
}
