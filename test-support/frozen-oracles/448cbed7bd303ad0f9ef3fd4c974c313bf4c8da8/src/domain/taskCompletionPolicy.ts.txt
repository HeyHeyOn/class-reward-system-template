export type TaskCompletionPolicyTask = {
  taskId: string;
  reward: number;
  createdAt?: string;
};

export type TaskCompletionPolicyStudent = {
  studentId: string;
  balance: number;
};

export type TaskCompletionPolicyCompletion = {
  taskId: string;
  studentId: string;
  status: string;
  timestamp?: string;
  taskInstanceId?: string;
  cycleId?: string;
  source?: string;
};

export type TaskCompletionPolicyResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; message: '이미 완료한 과제입니다.' };

export function evaluateTaskCompletion({
  task,
  student,
  completions,
  taskInstanceId,
  cycleId,
}: {
  task: TaskCompletionPolicyTask;
  student: TaskCompletionPolicyStudent;
  completions: TaskCompletionPolicyCompletion[];
  taskInstanceId?: string;
  cycleId?: string;
}): TaskCompletionPolicyResult {
  const versionedRows = taskInstanceId && cycleId
    ? completions.filter((completion) =>
      completion.taskInstanceId === taskInstanceId
      && completion.cycleId === cycleId
      && completion.studentId === student.studentId)
    : [];
  const effectiveVersioned = versionedRows.at(-1);
  const alreadyCompleted = effectiveVersioned
    ? effectiveVersioned.source !== 'ADMIN_RESET' && effectiveVersioned.status === 'SUCCESS'
    : completions.some(
      (completion) =>
        !completion.taskInstanceId
        && isCompletionForTaskInstance(completion, task)
        && completion.studentId === student.studentId
        && completion.status === 'SUCCESS',
    );

  if (alreadyCompleted) {
    return { ok: false, message: '이미 완료한 과제입니다.' };
  }

  return { ok: true, balanceAfter: student.balance + task.reward };
}

export function isCompletionForTaskInstance(
  completion: Pick<TaskCompletionPolicyCompletion, 'taskId' | 'timestamp'>,
  task: Pick<TaskCompletionPolicyTask, 'taskId' | 'createdAt'>,
): boolean {
  if (completion.taskId !== task.taskId) return false;
  const taskCreatedAt = parseIsoTimestamp(task.createdAt);
  if (taskCreatedAt === null) return true;

  const completionTimestamp = parseIsoTimestamp(completion.timestamp);
  return completionTimestamp !== null && completionTimestamp >= taskCreatedAt;
}

function parseIsoTimestamp(value?: string): number | null {
  const trimmed = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
