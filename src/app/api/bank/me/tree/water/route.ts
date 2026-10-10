import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredClassTree } from '@/server/repositories/configuredClassTree';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { classTreeFailure, readClassTreeJson } from '@/server/classTreeHttp';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

/** The logged-in student waters the class tree. The body carries only the operation ID. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  const body = await readClassTreeJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body.value).length !== 1 || typeof body.value.operationId !== 'string') {
    return studentBankJson({ error: '요청 형식이 올바르지 않아요. 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const tree = await createConfiguredClassTree(request);
    const result = await tree.water({ studentId: checked.student.studentId, operationId: body.value.operationId });
    return studentBankJson({ result, tree: await tree.studentView(checked.student.studentId) });
  } catch (error) {
    return classTreeFailure(error, 'water');
  }
}
