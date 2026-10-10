import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { hasExactKeys, petFailure, readPetJson } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

/** The logged-in student picks an egg of a species and names it. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  const body = await readPetJson(request);
  if (body instanceof Response) return body;
  if (!hasExactKeys(body.value, ['operationId', 'species', 'name']) || typeof body.value.operationId !== 'string') {
    return studentBankJson({ error: '요청 형식이 올바르지 않아요. 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const pets = await createConfiguredPets(request);
    const studentId = checked.student.studentId;
    const result = await pets.adopt({ studentId, operationId: body.value.operationId as string, species: body.value.species, name: body.value.name });
    const pet = await pets.studentView(studentId);
    return studentBankJson({ result, balance: checked.student.balance, pet });
  } catch (error) {
    return petFailure(error, 'adopt');
  }
}
