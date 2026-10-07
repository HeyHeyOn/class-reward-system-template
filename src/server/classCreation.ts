import 'server-only';
import type { ClassCreationCommand } from '@/server/repositories/database/classCreation';
import { readClassMutationRequest, classMutationReply as reply, UUID_V4 } from './classMutationRequest';

const forbiddenName = /[\p{Cc}\p{Cf}\p{Cs}]/u;
export async function handleClassCreation(request: Request, command: ClassCreationCommand): Promise<Response> {
  const parsed = await readClassMutationRequest(request);
  if (parsed instanceof Response) return parsed;
  const { body: value, session } = parsed;
  if (Object.keys(value).length !== 2 || Object.keys(value).some(key => key !== 'operationId' && key !== 'displayName')
    || typeof value.operationId !== 'string' || !UUID_V4.test(value.operationId)
    || typeof value.displayName !== 'string' || value.displayName !== value.displayName.trim()
    || value.displayName.length < 1 || value.displayName.length > 80 || forbiddenName.test(value.displayName)) {
    return reply(400, { error: '학급 이름은 앞뒤 공백이나 제어 문자 없이 1~80자로 입력해 주세요.' });
  }
  try {
    const result = await command.create({ operationId: value.operationId, displayName: value.displayName,
      subject: session.subject, email: session.email.trim().toLowerCase() });
    return reply(result.replayed ? 200 : 201, result);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === '23505') return reply(409, { error: '계정 또는 생성 요청이 충돌했습니다. 내 학급 목록을 확인해 주세요.' });
    // The transaction may have committed even if its response was lost.
    return reply(503, { error: '생성 결과를 확인하지 못했습니다. 다시 만들지 말고 내 학급 목록을 먼저 확인해 주세요.' });
  }
}
