import { createConfiguredStudentBankReader, STUDENT_BANK_TRANSACTION_LIMIT } from '@/server/repositories/configuredStudentBank';
import {
  authenticateStudentBankRequest,
  confirmStudentBankStudent,
  studentBankJson,
  studentBankUnavailable,
} from '@/server/studentBankSession';
import { projectStudentBankTransactions } from '@/server/studentBankViews';

export const dynamic = 'force-dynamic';

/** The logged-in student's own transaction history, newest first. Identity comes from the session only. */
export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    const studentId = checked.student.studentId;
    const transactions = await reader.getTransactions(studentId);
    return studentBankJson({
      balance: checked.student.balance,
      transactions: projectStudentBankTransactions(transactions, studentId),
      limit: STUDENT_BANK_TRANSACTION_LIMIT,
    });
  } catch {
    return studentBankUnavailable();
  }
}
