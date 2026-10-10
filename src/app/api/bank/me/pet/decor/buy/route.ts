import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { hasExactKeys, petFailure, readPetJson } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

/** The logged-in student buys an item in the 꾸미기/상점 (decor is placed right away; an accessory goes on `petId`). */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  const body = await readPetJson(request);
  if (body instanceof Response) return body;
  const keys = Object.hasOwn(body.value, 'petId') ? ['operationId', 'itemKey', 'petId'] : ['operationId', 'itemKey'];
  if (!hasExactKeys(body.value, keys) || typeof body.value.operationId !== 'string') {
    return studentBankJson({ error: '요청 형식이 올바르지 않아요. 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const pets = await createConfiguredPets(request);
    const studentId = checked.student.studentId;
    const result = await pets.buyDecor({
      studentId, operationId: body.value.operationId as string, itemKey: body.value.itemKey,
      ...(Object.hasOwn(body.value, 'petId') ? { petId: body.value.petId } : {}),
    });
    const pet = await pets.studentView(studentId);
    return studentBankJson({ result, balance: result.balanceAfter ?? checked.student.balance, pet });
  } catch (error) {
    return petFailure(error, 'decor-buy');
  }
}
