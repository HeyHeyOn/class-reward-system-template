import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { boardsForStudent } from '@/server/repositories/configuredBoardLinks';
import { padletBoardsForStudent } from '@/server/repositories/configuredPadlet';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';
import {
  authenticateStudentBankRequest,
  confirmStudentBankStudent,
  studentBankJson,
  studentBankUnavailable,
} from '@/server/studentBankSession';
import { projectStudentBankTasks } from '@/server/studentBankViews';
import { buildStudentTaskProjection } from '@/server/studentTaskProjection';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The logged-in student's own tasks from 미완료 upward (never 미부여). */
export async function GET(request: Request) {
  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const bankReader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, bankReader);
    if (!checked.ok) return checked.response;
    const studentId = checked.student.studentId;
    // The authorized student's screen observes new Padlet stages on its next refresh.
    const padletBoards = await padletBoardsForStudent(request, { sync: legacyWriteFreezeResponse() === null });
    const boards = await boardsForStudent({ sync: legacyWriteFreezeResponse() === null });
    const now = new Date().toISOString();
    const taskReader = await createConfiguredTaskReader(request);
    const cycles = await taskReader.listTaskCycleProjections({ includeInactive: true, studentId, now });
    return studentBankJson({ tasks: projectStudentBankTasks(buildStudentTaskProjection(cycles, studentId, now), now, padletBoards, boards) });
  } catch {
    return studentBankUnavailable();
  }
}
