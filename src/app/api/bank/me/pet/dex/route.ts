import { petFailure } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some((key) => key !== 'cursor') || query.getAll('cursor').length > 1) {
    return studentBankJson({ error: '도감을 새로 열어 주세요.', code: 'INVALID_REQUEST' }, { status: 400 });
  }
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const pets = await createConfiguredPets(request);
    return studentBankJson(await pets.dexPage(checked.student.studentId, query.get('cursor')));
  } catch (error) {
    return petFailure(error, 'dex');
  }
}
