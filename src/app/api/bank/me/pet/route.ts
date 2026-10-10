import { petFailure } from '@/server/petHttp';
import { createConfiguredPets } from '@/server/repositories/configuredPets';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

/** The logged-in student's pet screen: the pet, its room, the 꾸미기/상점 and the 도감. */
export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const pets = await createConfiguredPets(request);
    return studentBankJson({ balance: checked.student.balance, pet: await pets.studentView(checked.student.studentId) });
  } catch (error) {
    return petFailure(error, 'bank-view');
  }
}
