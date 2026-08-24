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
};

export type TaskCompletionPolicyResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; message: '이미 완료한 과제입니다.' };

export function evaluateTaskCompletion({
  task,
  student,
  completions,
}: {
  task: TaskCompletionPolicyTask;
  student: TaskCompletionPolicyStudent;
  completions: TaskCompletionPolicyCompletion[];
}): TaskCompletionPolicyResult {
  const alreadyCompleted = completions.some(
    (completion) =>
      isCompletionForTaskInstance(completion, task)
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
  if (completionTimestamp === null) return true;
  return completionTimestamp >= taskCreatedAt;
}

function parseIsoTimestamp(value?: string): number | null {
  const trimmed = value?.trim() ?? '';
  if (!/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
