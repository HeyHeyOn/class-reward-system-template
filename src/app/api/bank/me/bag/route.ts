import { createConfiguredStudentBag } from '@/server/repositories/configuredStudentBag';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { studentBagFailure } from '@/server/studentBagHttp';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

/** The logged-in student's own bag. Identity comes from the session only. */
export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const bag = await createConfiguredStudentBag(request);
    return studentBankJson({ bag: await bag.studentBag(checked.student.studentId, { includeUsed: false }) });
  } catch (error) {
    return studentBagFailure(error, 'bank-bag');
  }
}
