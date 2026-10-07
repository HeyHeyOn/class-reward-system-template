import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredStudentMutation } from '@/server/repositories/configuredStudentMutation';
import { createConfiguredStudentDeletion, readStudentDeletionBody, studentDeletionFailure } from '@/server/repositories/configuredStudentDeletion';
import { StudentAdminConflictError } from '@/server/repositories/database/studentCommands';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const payload: unknown = await request.json();
    const command = await createConfiguredStudentMutation(request);
    const result = await command.updateBatch(payload);

    return Response.json(result);
  } catch (error) {
    if (error instanceof StudentAdminConflictError) {
      return Response.json({ code: error.code, error: '학생 정보 또는 저장 요청이 변경되었습니다. 새로고침 후 다시 편집해 주세요.' }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : '학생 명단을 일괄 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const body = await readStudentDeletionBody(request);
    const command = await createConfiguredStudentDeletion(request);
    return Response.json(await command.deleteBatch(body));
  } catch (error) {
    return studentDeletionFailure(error);
  }
}
