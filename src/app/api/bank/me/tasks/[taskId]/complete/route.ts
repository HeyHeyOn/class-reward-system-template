import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import {
  createConfiguredTaskCompletion,
  parseConfiguredTaskCompletionResult,
} from '@/server/repositories/configuredTaskCompletion';
import {
  authenticateStudentBankRequest,
  confirmStudentBankStudent,
  studentBankJson,
  studentBankUnavailable,
} from '@/server/studentBankSession';
import {
  STUDENT_BANK_OPERATION_ID,
  studentBankCompletionErrorResponse,
} from '@/server/studentBankTaskCompletion';
import { projectStudentBankTasks } from '@/server/studentBankViews';

type RouteContext = { params: Promise<{ taskId: string }> };

export const dynamic = 'force-dynamic';

const INVALID_REQUEST = { error: '과제 완료 요청이 올바르지 않아요. 다시 시도해 주세요.', code: 'INVALID_REQUEST' };

/**
 * Completes one task for the logged-in student and pays its reward through the same configured
 * completion command as the old bank (idempotent operationId, Padlet evidence, prerequisite and
 * stage policy). The body carries only the operation ID; the student comes from the session.
 */
export async function POST(request: Request, context: RouteContext) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  const auth = authenticateStudentBankRequest(request);
  if (!auth.ok) return auth.response;

  let taskId: string;
  let operationId: string;
  try {
    if (new URL(request.url).search !== ''
      || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
      return studentBankJson(INVALID_REQUEST, { status: 400 });
    }
    const params: unknown = await context.params;
    const encodedTaskId = params && typeof params === 'object' ? (params as Record<string, unknown>).taskId : undefined;
    if (typeof encodedTaskId !== 'string') return studentBankJson(INVALID_REQUEST, { status: 400 });
    taskId = decodeURIComponent(encodedTaskId).trim();
    const body: unknown = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'operationId')) {
      return studentBankJson(INVALID_REQUEST, { status: 400 });
    }
    const rawOperationId: unknown = (body as Record<string, unknown>).operationId;
    if (typeof rawOperationId !== 'string' || !STUDENT_BANK_OPERATION_ID.test(rawOperationId)
      || !taskId || taskId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(taskId)) {
      return studentBankJson(INVALID_REQUEST, { status: 400 });
    }
    operationId = rawOperationId;
  } catch {
    return studentBankJson(INVALID_REQUEST, { status: 400 });
  }

  let reader: Awaited<ReturnType<typeof createConfiguredStudentBankReader>>;
  let studentId: string;
  try {
    reader = await createConfiguredStudentBankReader(request);
    const checked = await confirmStudentBankStudent(auth, reader);
    if (!checked.ok) return checked.response;
    studentId = checked.student.studentId;
  } catch {
    return studentBankUnavailable();
  }

  let result: ReturnType<typeof parseConfiguredTaskCompletionResult>;
  try {
    const command = await createConfiguredTaskCompletion(request);
    const raw: unknown = await command.execute({ requestId: crypto.randomUUID(), operationId, taskId, studentId });
    result = parseConfiguredTaskCompletionResult(raw, { taskId, studentId, operationId });
  } catch (error) {
    return studentBankCompletionErrorResponse(error, operationId);
  }

  // The reward is committed; a failed balance re-read only means the client refreshes it.
  let student: { name: string; balance: number } | undefined;
  try {
    const lookup = await reader.confirmStudent(studentId);
    if (lookup.status === 'FOUND') student = { name: lookup.student.name, balance: lookup.student.balance };
  } catch {
    student = undefined;
  }
  // Likewise the task list: an empty one tells the client to re-read it, never that the reward is unknown.
  let tasks: ReturnType<typeof projectStudentBankTasks> = [];
  try {
    tasks = projectStudentBankTasks(result.tasks, new Date().toISOString());
  } catch (error) {
    console.error('[bank-completion] task list after a committed completion could not be shaped',
      error instanceof Error ? error.message : 'unknown');
  }
  return studentBankJson({
    operation: result.operation,
    task: result.task,
    tasks,
    ...(student ? { student } : {}),
  });
}
