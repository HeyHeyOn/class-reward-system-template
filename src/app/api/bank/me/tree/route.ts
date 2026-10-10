import { createConfiguredClassTree } from '@/server/repositories/configuredClassTree';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { classTreeFailure } from '@/server/classTreeHttp';
import { authenticateStudentBankRequest, confirmStudentBankStudent, studentBankJson } from '@/server/studentBankSession';

export const dynamic = 'force-dynamic';

/** The class tree as the logged-in student sees it, with the student's own coupons. */
export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const tree = await createConfiguredClassTree(request);
    return studentBankJson({ balance: checked.student.balance, tree: await tree.studentView(checked.student.studentId) });
  } catch (error) {
    return classTreeFailure(error, 'bank-view');
  }
}
