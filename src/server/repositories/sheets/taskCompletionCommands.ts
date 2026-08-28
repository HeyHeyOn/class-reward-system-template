import { createHash } from 'node:crypto';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, Student, TaskCompletion, TaskCompletionEvidence, Transaction } from '@/domain/types';
import { buildTaskCompletionAppendRow, buildTransactionAppendRow, createHeaderIndex, parseStudentRow } from '@/server/sheetsRows';
import type { RecurringSchemaMigrationStore } from '@/server/storage/tabularStore';
import { migrateRecurringTaskSchema } from './recurringSchemaMigrator';
import { mutateTaskAssignmentNow } from './taskAssignmentCommands';
import { enqueueTaskCommand, taskCommandQueueKey } from './taskCommandQueue';
import { readTaskAssignmentsIfPresent, readTaskCompletions, readTaskCompletionsFresh } from './taskCycleQueries';

export type TaskCompletionMutation = {
  store: RecurringSchemaMigrationStore;
  task: ClassTask;
  taskRowNumber: number;
  student: Student;
  studentRowNumber: number;
  completed: boolean;
  source: 'BANK' | 'ADMIN';
  /** Immutable logical-operation key for resumable BANK calls. */
  operationId?: string;
  /** Canonical lower-case payload digest; paired with operationId for BANK calls. */
  operationPayloadHash?: string;
  /** Server-selected immutable evidence; never accepted from the client payload directly. */
  evidence?: TaskCompletionEvidence;
  /** Invoked only after assignment/policy checks and immediately before PENDING. */
  resolveEvidence?: () => Promise<TaskCompletionEvidence>;
  /** Caller verified canonical recurring headers from a primed request snapshot. */
  schemaReady?: boolean;
  now?: string;
};

export type TaskCompletionMutationResult = {
  changed: boolean;
  completion: TaskCompletion | null;
  balanceAfter: number;
};

export class TaskCompletionReconciliationError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'TaskCompletionReconciliationError';
    this.cause = cause;
  }
}

const TRANSACTION_HEADERS = ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'];

/** Process-local sequential retry protection; no cross-process exactly-once guarantee is made. */
export function mutateTaskCompletion(mutation: TaskCompletionMutation): Promise<TaskCompletionMutationResult> {
  return enqueueTaskCommand(
    taskCommandQueueKey(mutation.task.taskId, mutation.task.taskInstanceId),
    () => mutateTaskCompletionNow(mutation),
  );
}

export async function mutateTaskCompletionNow(mutation: TaskCompletionMutation): Promise<TaskCompletionMutationResult> {
  const { store, task } = mutation;
  if (!task.taskInstanceId || !task.schedule) throw new Error('task completion mutation requires a task instance and schedule');
  const now = mutation.now ?? new Date().toISOString();
  let bankOperation = mutation.source === 'BANK' ? normalizeBankOperation(mutation) : null;

  // Migration and assignment validation/materialization must finish before balance or completion mutation.
  if (!mutation.schemaReady) await migrateRecurringTaskSchema(store);
  const preloadedBankCompletions = bankOperation ? await readTaskCompletionsFresh(store) : null;
  if (bankOperation && !mutation.evidence) {
    const storedEvidence = preloadedBankCompletions
      ?.filter((event) => event.operationId === bankOperation?.operationId)
      .map(taskCompletionEvidence)
      .find((evidence): evidence is TaskCompletionEvidence => evidence !== null);
    if (storedEvidence) {
      bankOperation = {
        operationId: bankOperation.operationId,
        operationPayloadHash: bindEvidenceToPayloadHash(bankOperation.operationPayloadHash, storedEvidence),
        ...storedEvidence,
      };
    }
  }
  const bankOperationId = bankOperation?.operationId;
  const hasStoredOperation = Boolean(bankOperationId
    && preloadedBankCompletions?.some((event) => event.operationId === bankOperationId));
  const studentRows = await store.getRows('Students');
  const studentHeaders = studentRows[0];
  if (!studentHeaders) throw new Error('학생 정보를 찾을 수 없습니다.');
  const studentIndex = createHeaderIndex(studentHeaders);
  const observed = studentRows.slice(1).map((row, index) => ({ student: parseStudentRow(row, studentIndex), rowNumber: index + 2 }))
    .find((record) => record.student?.studentId === mutation.student.studentId);
  if (!observed?.student || (!hasStoredOperation && observed.student.status !== 'ACTIVE')) throw new Error('학생 정보를 찾을 수 없습니다.');
  const student = observed.student;
  const studentRowNumber = observed.rowNumber;
  let assignments = await readTaskAssignmentsIfPresent(store);
  let completions = preloadedBankCompletions ?? await readTaskCompletions(store);
  if (bankOperation) {
    const storedOperationEvents = selectStoredOperationEvents(completions, bankOperation, task.taskId, student.studentId);
    if (storedOperationEvents.length > 0) {
      const existingSuccess = storedOperationEvents.findLast((event) => event.status === 'SUCCESS');
      if (existingSuccess) return aliasLogicalSuccess(existingSuccess, bankOperation);
      const pending = storedOperationEvents.findLast((event) => event.status === 'PENDING');
      if (!pending) {
        throw new TaskCompletionReconciliationError('TASK_COMPLETION_PENDING_CHECKPOINT_MISSING', storedOperationEvents);
      }
      const headers = (await store.getRows('TaskCompletions'))[0];
      if (!headers) throw new Error('TaskCompletions 시트에 헤더가 없습니다.');
      return finishBankOperation(store, task, studentRowNumber, headers, storedOperationEvents, pending);
    }
  }
  let state = projectTaskCycleState({ task, now, assignments, completions });
  let studentState = state.students[student.studentId];
  if (bankOperation) {
    const logicalSuccess = findLogicalBankSuccess(completions, bankOperation, task.taskId, task.taskInstanceId, state.cycle.cycleId, student.studentId);
    if (logicalSuccess) return aliasLogicalSuccess(logicalSuccess, bankOperation);
    assertNoConflictingLogicalBankOperation(completions, bankOperation, task.taskId, task.taskInstanceId, state.cycle.cycleId, student.studentId);
  }
  let operationEvents = bankOperation
    ? validateAndSelectOperationEvents(completions, bankOperation, task.taskInstanceId, state.cycle.cycleId, student.studentId)
    : [];
  const existingSuccess = operationEvents.findLast((event) => event.status === 'SUCCESS');
  if (existingSuccess) {
    return { changed: false, completion: existingSuccess, balanceAfter: existingSuccess.balanceAfter };
  }
  const resetCompletionEvent = mutation.source === 'ADMIN' && !mutation.completed
    && studentState?.completed && !studentState.assigned
    ? studentState.completionEvent ?? null
    : null;
  const resetAssignmentId = resetCompletionEvent
    ? resetCompletionEvent.assignmentId || legacyCompletionReference(resetCompletionEvent.completionId)
    : '';
  let assignmentId: string;

  if (resetCompletionEvent) {
    // A reset negates the effective completion event. It retains that event's assignment
    // snapshot, or an explicit stable legacy reference, and never creates an assignment.
    assignmentId = resetAssignmentId;
  } else {
    if (state.assignedStudentIds.length === 0) throw new Error('부여된 학생이 없습니다.');
    if (!(studentState?.assigned ?? false)) throw new Error('허가되지 않은 과제입니다.');
    if (mutation.source === 'BANK' && bankOperation && task.padletBoardId
      && !taskCompletionEvidence(bankOperation)) {
      if (!mutation.resolveEvidence) throw new Error('PADLET_EVIDENCE_REQUIRED');
      const evidence = await mutation.resolveEvidence();
      if (evidence.evidenceProvider !== 'PADLET' || evidence.evidenceBoardId !== task.padletBoardId) {
        throw new Error('PADLET_EVIDENCE_REQUIRED');
      }
      bankOperation = {
        operationId: bankOperation.operationId,
        operationPayloadHash: bindEvidenceToPayloadHash(bankOperation.operationPayloadHash, evidence),
        ...evidence,
      };
    }

    await mutateTaskAssignmentNow(store, {
      task,
      taskRowNumber: mutation.taskRowNumber,
      studentId: student.studentId,
      assigned: true,
      source: 'ADMIN',
      now,
      note: 'completion assignment materialization',
      schemaReady: mutation.schemaReady,
    });
    assignments = await readTaskAssignmentsIfPresent(store);
    completions = bankOperation
      ? await readTaskCompletionsFresh(store)
      : await readTaskCompletions(store);
    state = projectTaskCycleState({ task, now, assignments, completions });
    studentState = state.students[student.studentId];
    if (bankOperation) {
      const logicalSuccess = findLogicalBankSuccess(completions, bankOperation, task.taskId, task.taskInstanceId, state.cycle.cycleId, student.studentId);
      if (logicalSuccess) return aliasLogicalSuccess(logicalSuccess, bankOperation);
      assertNoConflictingLogicalBankOperation(completions, bankOperation, task.taskId, task.taskInstanceId, state.cycle.cycleId, student.studentId);
      operationEvents = validateAndSelectOperationEvents(
        completions, bankOperation, task.taskInstanceId, state.cycle.cycleId, student.studentId,
      );
    }
    assignmentId = studentState?.assignmentEvent?.assignmentId ?? '';
    if (!studentState?.assigned || !assignmentId) throw new Error('허가되지 않은 과제입니다.');
  }

  const schedule = resolveTaskSchedule({ currentSchedule: task.schedule, pendingSchedule: task.pendingSchedule ?? null, now });
  const headers = (await store.getRows('TaskCompletions'))[0];
  if (!headers) throw new Error('TaskCompletions 시트에 헤더가 없습니다.');

  if (!resetCompletionEvent
    && (studentState.completionOrigin === 'CARRY' || studentState.completionOrigin === 'LEGACY')
    && studentState.completionEvent) {
    const carry = createCompletion({
      task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
      assignmentId, timestamp: now, source: 'CARRY_FORWARD', status: studentState.completed ? 'SUCCESS' : 'RESET',
      reward: 0, balanceBefore: student.balance, balanceAfter: student.balance, note: 'materialized cycle carry',
    });
    await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, carry));
    completions.push(carry);
    state = projectTaskCycleState({ task, now, assignments, completions });
  }

  const effectiveCompleted = state.students[student.studentId]?.completed ?? false;
  if (mutation.source === 'BANK' && effectiveCompleted) throw new Error('이미 완료한 과제입니다.');
  if (mutation.source === 'ADMIN' && effectiveCompleted === mutation.completed) {
    return { changed: false, completion: state.students[student.studentId]?.completionEvent ?? null, balanceAfter: student.balance };
  }
  if (mutation.source === 'BANK' && !mutation.completed) throw new Error('과제 완료 요청 형식이 올바르지 않습니다.');

  if (mutation.source === 'BANK' && bankOperation) {
    return completeBankOperation({
      store, task, student, studentRowNumber, headers, state, schedule, assignmentId, now,
      operation: bankOperation, operationEvents,
      logicalCompletionId: logicalCompletionBaseId(completions, task.taskId, task.taskInstanceId, state.cycle.cycleId, student.studentId),
    });
  }

  const isReward = mutation.source === 'BANK';
  const balanceAfter = isReward ? student.balance + task.reward : student.balance;
  const source = mutation.source === 'ADMIN' && !mutation.completed ? 'ADMIN_RESET' : mutation.source;
  const completion = createCompletion({
    task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
    assignmentId, timestamp: now, source, status: mutation.completed ? 'SUCCESS' : 'RESET',
    reward: isReward ? task.reward : 0, balanceBefore: student.balance, balanceAfter,
    note: source === 'BANK' ? 'bank-self-completion' : source === 'ADMIN' ? 'admin-completion' : 'admin-reset',
  });

  if (isReward) {
    // Compatibility path for callers not yet supplying operation metadata.
    await completeLegacyBank(store, task, studentRowNumber, headers, completion);
  } else {
    await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, completion));
  }
  return { changed: true, completion, balanceAfter };
}

type BankOperation = { operationId: string; operationPayloadHash: string } & Partial<TaskCompletionEvidence>;

type BankCompletionInput = {
  store: RecurringSchemaMigrationStore;
  task: ClassTask;
  student: Student;
  studentRowNumber: number;
  headers: string[];
  state: ReturnType<typeof projectTaskCycleState>;
  schedule: ReturnType<typeof resolveTaskSchedule>;
  assignmentId: string;
  now: string;
  operation: BankOperation;
  operationEvents: TaskCompletion[];
  logicalCompletionId: string;
};

function normalizeBankOperation(mutation: TaskCompletionMutation): BankOperation | null {
  const operationId = mutation.operationId?.trim() ?? '';
  const operationPayloadHash = mutation.operationPayloadHash?.trim().toLowerCase() ?? '';
  if (!operationId && !operationPayloadHash && !mutation.evidence) return null;
  if (!operationId || !operationPayloadHash) throw new Error('TASK_COMPLETION_OPERATION_METADATA_REQUIRED');
  if (!mutation.evidence) return { operationId, operationPayloadHash };
  return {
    operationId,
    operationPayloadHash: bindEvidenceToPayloadHash(operationPayloadHash, mutation.evidence),
    ...mutation.evidence,
  };
}

function bindEvidenceToPayloadHash(payloadHash: string, evidence: TaskCompletionEvidence): string {
  const stablePayload = JSON.stringify({
    payloadHash,
    evidenceProvider: evidence.evidenceProvider,
    evidenceBoardId: evidence.evidenceBoardId,
    evidencePostId: evidence.evidencePostId,
    evidenceCreatedAt: evidence.evidenceCreatedAt,
    evidenceAuthorFullName: evidence.evidenceAuthorFullName,
  });
  return `sha256:${createHash('sha256').update(stablePayload).digest('hex')}`;
}

function taskCompletionEvidence(completion: Partial<TaskCompletionEvidence>): TaskCompletionEvidence | null {
  if (completion.evidenceProvider !== 'PADLET'
    || !completion.evidenceBoardId || !completion.evidencePostId
    || !completion.evidenceCreatedAt || !completion.evidenceAuthorFullName) return null;
  return {
    evidenceProvider: completion.evidenceProvider,
    evidenceBoardId: completion.evidenceBoardId,
    evidencePostId: completion.evidencePostId,
    evidenceCreatedAt: completion.evidenceCreatedAt,
    evidenceAuthorFullName: completion.evidenceAuthorFullName,
  };
}

function logicalCompletionBaseId(
  completions: readonly TaskCompletion[],
  taskId: string,
  taskInstanceId: string,
  cycleId: string,
  studentId: string,
): string {
  const latestReset = completions.findLast((event) => event.taskId === taskId
    && event.taskInstanceId === taskInstanceId
    && event.cycleId === cycleId
    && event.studentId === studentId
    && event.source === 'ADMIN_RESET');
  return `TC-BANK-${[taskId, taskInstanceId, cycleId, studentId, latestReset?.completionId ?? 'INITIAL']
    .map((value) => encodeURIComponent(value)).join('-')}`;
}

function findLogicalBankSuccess(
  completions: readonly TaskCompletion[],
  operation: BankOperation,
  taskId: string,
  taskInstanceId: string,
  cycleId: string,
  studentId: string,
): TaskCompletion | null {
  const sameLogicalCompletion = (event: TaskCompletion) => event.taskId === taskId
    && event.taskInstanceId === taskInstanceId
    && event.cycleId === cycleId
    && event.studentId === studentId;
  let latestResetIndex = -1;
  completions.forEach((event, index) => {
    if (sameLogicalCompletion(event) && event.source === 'ADMIN_RESET') latestResetIndex = index;
  });
  const success = completions.slice(latestResetIndex + 1).findLast((event) => sameLogicalCompletion(event)
    && event.source === 'BANK'
    && Boolean(event.operationId)
    && event.status === 'SUCCESS') ?? null;
  if (success && success.operationPayloadHash?.trim().toLowerCase() !== operation.operationPayloadHash) {
    throw new Error('TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT');
  }
  return success;
}

function aliasLogicalSuccess(success: TaskCompletion, operation: BankOperation): TaskCompletionMutationResult {
  return {
    changed: false,
    completion: { ...success, ...operation },
    balanceAfter: success.balanceAfter,
  };
}

function assertNoConflictingLogicalBankOperation(
  completions: readonly TaskCompletion[],
  operation: BankOperation,
  taskId: string,
  taskInstanceId: string,
  cycleId: string,
  studentId: string,
): void {
  const sameLogicalCompletion = (event: TaskCompletion) => event.taskId === taskId
    && event.taskInstanceId === taskInstanceId
    && event.cycleId === cycleId
    && event.studentId === studentId;
  let latestResetIndex = -1;
  completions.forEach((event, index) => {
    if (sameLogicalCompletion(event) && event.source === 'ADMIN_RESET') latestResetIndex = index;
  });
  const conflicting = completions.slice(latestResetIndex + 1).find((event) => sameLogicalCompletion(event)
    && event.source === 'BANK'
    && Boolean(event.operationId)
    && event.operationId !== operation.operationId
    && (event.status === 'PENDING' || event.status === 'BALANCE_APPLIED'));
  if (conflicting) {
    throw new TaskCompletionReconciliationError(
      'TASK_COMPLETION_LOGICAL_OPERATION_IN_PROGRESS_MANUAL_RECONCILIATION_REQUIRED',
      conflicting.completionId,
    );
  }
}

function selectStoredOperationEvents(
  completions: readonly TaskCompletion[],
  operation: BankOperation,
  taskId: string,
  studentId: string,
): TaskCompletion[] {
  const events = completions.filter((event) => event.operationId === operation.operationId);
  const first = events[0];
  for (const event of events) {
    if (event.operationPayloadHash?.trim().toLowerCase() !== operation.operationPayloadHash) {
      throw new Error('TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT');
    }
    if (!hasSameEvidence(event, operation)) {
      throw new Error('TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT');
    }
    if (first && !hasSameCheckpointSnapshot(event, first)) {
      throw new Error('TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT');
    }
    if (event.source !== 'BANK' || event.taskId !== taskId || event.studentId !== studentId
      || (first && (event.taskInstanceId !== first.taskInstanceId || event.cycleId !== first.cycleId))) {
      throw new Error('TASK_COMPLETION_OPERATION_IDENTITY_CONFLICT');
    }
  }
  return events;
}

function validateAndSelectOperationEvents(
  completions: readonly TaskCompletion[],
  operation: BankOperation,
  taskInstanceId: string,
  cycleId: string,
  studentId: string,
): TaskCompletion[] {
  const events = completions.filter((event) => event.operationId === operation.operationId);
  const first = events[0];
  for (const event of events) {
    if (event.operationPayloadHash?.trim().toLowerCase() !== operation.operationPayloadHash) {
      throw new Error('TASK_COMPLETION_OPERATION_PAYLOAD_CONFLICT');
    }
    if (!hasSameEvidence(event, operation)) {
      throw new Error('TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT');
    }
    if (first && !hasSameCheckpointSnapshot(event, first)) {
      throw new Error('TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT');
    }
    if (event.source !== 'BANK' || event.taskInstanceId !== taskInstanceId
      || event.cycleId !== cycleId || event.studentId !== studentId) {
      throw new Error('TASK_COMPLETION_OPERATION_IDENTITY_CONFLICT');
    }
  }
  return events;
}

async function completeLegacyBank(
  store: RecurringSchemaMigrationStore,
  task: ClassTask,
  studentRowNumber: number,
  headers: string[],
  completion: TaskCompletion,
): Promise<void> {
  await store.updateCell('Students', studentRowNumber, 'balance', completion.balanceAfter);
  try {
    await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, completion));
  } catch (appendError) {
    let appendWasObserved: boolean;
    try {
      appendWasObserved = (await readTaskCompletionsFresh(store))
        .some((event) => event.completionId === completion.completionId);
    } catch (readError) {
      throw new TaskCompletionReconciliationError('TASK_COMPLETION_APPEND_OUTCOME_UNKNOWN', readError);
    }
    if (!appendWasObserved) {
      let observedBalance: number;
      try {
        observedBalance = (await readStudentFresh(store, completion.studentId)).balance;
      } catch (readError) {
        throw new TaskCompletionReconciliationError('TASK_COMPLETION_BALANCE_COMPENSATION_STATE_UNKNOWN', readError);
      }
      if (observedBalance !== completion.balanceAfter) {
        throw new TaskCompletionReconciliationError('TASK_COMPLETION_BALANCE_CHANGED_BEFORE_COMPENSATION', appendError);
      }
      try {
        await store.updateCell('Students', studentRowNumber, 'balance', completion.balanceBefore);
      } catch (compensationError) {
        throw new TaskCompletionReconciliationError('TASK_COMPLETION_BALANCE_COMPENSATION_FAILED', compensationError);
      }
      throw appendError;
    }
  }
  await appendRewardTransaction(store, task, completion);
}

async function completeBankOperation(input: BankCompletionInput): Promise<TaskCompletionMutationResult> {
  const { store, task, student, studentRowNumber, headers, state, schedule, assignmentId, now, operation, logicalCompletionId } = input;
  let operationEvents = input.operationEvents;
  const pending = operationEvents.findLast((event) => event.status === 'PENDING') ?? createCompletion({
    task, student, cycle: state.cycle, ruleVersion: schedule.ruleVersion, timeZone: schedule.timeZone,
    assignmentId, timestamp: now, source: 'BANK', status: 'PENDING', reward: task.reward,
    balanceBefore: student.balance, balanceAfter: student.balance + task.reward,
    note: 'bank-self-completion:pending', operation,
    completionId: `${logicalCompletionId}-PENDING`,
  });
  assertCheckpointShape(operationEvents, pending);

  if (!operationEvents.some((event) => event.status === 'PENDING')) {
    await appendCompletionCheckpoint(store, headers, pending);
    operationEvents = [...operationEvents, pending];
  }

  return finishBankOperation(store, task, studentRowNumber, headers, operationEvents, pending);
}

async function finishBankOperation(
  store: RecurringSchemaMigrationStore,
  task: ClassTask,
  studentRowNumber: number,
  headers: string[],
  existingEvents: TaskCompletion[],
  pending: TaskCompletion,
): Promise<TaskCompletionMutationResult> {
  let operationEvents = existingEvents;
  assertCheckpointShape(operationEvents, pending);
  await reconcileBankBalance(store, studentRowNumber, pending);

  if (!operationEvents.some((event) => event.status === 'BALANCE_APPLIED')) {
    const balanceApplied = checkpointFrom(pending, 'BALANCE_APPLIED');
    await appendCompletionCheckpoint(store, headers, balanceApplied);
    operationEvents = [...operationEvents, balanceApplied];
  }

  await appendRewardTransactionReconciled(store, task, pending);

  const success = operationEvents.findLast((event) => event.status === 'SUCCESS')
    ?? checkpointFrom(pending, 'SUCCESS');
  if (!operationEvents.some((event) => event.status === 'SUCCESS')) {
    await appendCompletionCheckpoint(store, headers, success);
  }
  return { changed: true, completion: success, balanceAfter: pending.balanceAfter };
}

function assertCheckpointShape(events: readonly TaskCompletion[], canonical: TaskCompletion): void {
  for (const event of events) {
    if (event.operationId !== canonical.operationId
      || event.operationPayloadHash?.trim().toLowerCase() !== canonical.operationPayloadHash?.trim().toLowerCase()
      || !hasSameCheckpointSnapshot(event, canonical)) {
      throw new Error('TASK_COMPLETION_OPERATION_CHECKPOINT_CONFLICT');
    }
  }
}

function hasSameCheckpointSnapshot(left: TaskCompletion, right: TaskCompletion): boolean {
  return left.timestamp === right.timestamp
    && left.taskId === right.taskId
    && left.studentId === right.studentId
    && left.studentName === right.studentName
    && left.reward === right.reward
    && left.balanceBefore === right.balanceBefore
    && left.balanceAfter === right.balanceAfter
    && left.taskInstanceId === right.taskInstanceId
    && left.cycleId === right.cycleId
    && left.cycleStartsAt === right.cycleStartsAt
    && left.cycleEndsAt === right.cycleEndsAt
    && left.ruleVersion === right.ruleVersion
    && left.timeZone === right.timeZone
    && left.source === right.source
    && left.assignmentId === right.assignmentId
    && left.schemaVersion === right.schemaVersion
    && hasSameEvidence(left, right);
}

function hasSameEvidence(left: Partial<TaskCompletionEvidence>, right: Partial<TaskCompletionEvidence>): boolean {
  return left.evidenceProvider === right.evidenceProvider
    && left.evidenceBoardId === right.evidenceBoardId
    && left.evidencePostId === right.evidencePostId
    && left.evidenceCreatedAt === right.evidenceCreatedAt
    && left.evidenceAuthorFullName === right.evidenceAuthorFullName;
}

function checkpointFrom(pending: TaskCompletion, status: 'BALANCE_APPLIED' | 'SUCCESS'): TaskCompletion {
  return {
    ...pending,
    completionId: checkpointIdFromPending(pending.completionId, status),
    status,
    note: `bank-self-completion:${status.toLowerCase()}`,
  };
}

function checkpointIdFromPending(pendingId: string, status: string): string {
  return pendingId.endsWith('-PENDING')
    ? `${pendingId.slice(0, -'-PENDING'.length)}-${status}`
    : `${pendingId}-${status}`;
}

function operationCheckpointId(operationId: string, status: string): string {
  return `TC-OP-${encodeURIComponent(operationId)}-${status}`;
}

async function appendCompletionCheckpoint(
  store: RecurringSchemaMigrationStore,
  headers: string[],
  checkpoint: TaskCompletion,
): Promise<void> {
  try {
    await store.appendRow('TaskCompletions', buildTaskCompletionAppendRow(headers, checkpoint));
  } catch (appendError) {
    let events: TaskCompletion[];
    try {
      events = await readTaskCompletionsFresh(store);
    } catch (readError) {
      throw new TaskCompletionReconciliationError('TASK_COMPLETION_APPEND_OUTCOME_UNKNOWN', readError);
    }
    const observed = events.find((event) => event.operationId === checkpoint.operationId
      && event.status === checkpoint.status);
    if (!observed) throw appendError;
    assertCheckpointShape([observed], checkpoint);
  }
}

async function reconcileBankBalance(
  store: RecurringSchemaMigrationStore,
  studentRowNumber: number,
  checkpoint: TaskCompletion,
): Promise<void> {
  const beforeUpdate = await readStudentFresh(store, checkpoint.studentId);
  if (beforeUpdate.balance === checkpoint.balanceAfter) return;
  if (beforeUpdate.balance !== checkpoint.balanceBefore) {
    throw new TaskCompletionReconciliationError(
      'TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED',
      new Error('persisted balance matches neither checkpoint boundary'),
    );
  }
  try {
    await store.updateCell('Students', studentRowNumber, 'balance', checkpoint.balanceAfter);
  } catch (updateError) {
    const afterAmbiguousUpdate = await readStudentFresh(store, checkpoint.studentId);
    if (afterAmbiguousUpdate.balance === checkpoint.balanceAfter) return;
    if (afterAmbiguousUpdate.balance === checkpoint.balanceBefore) throw updateError;
    throw new TaskCompletionReconciliationError(
      'TASK_COMPLETION_BALANCE_OUTCOME_UNKNOWN_MANUAL_RECONCILIATION_REQUIRED',
      updateError,
    );
  }
}

async function readStudentFresh(store: RecurringSchemaMigrationStore, studentId: string): Promise<Student> {
  const rows = store.getRowsFresh ? await store.getRowsFresh('Students') : await store.getRows('Students');
  const headers = rows[0];
  if (!headers) throw new TaskCompletionReconciliationError('TASK_COMPLETION_STUDENT_STATE_UNKNOWN', new Error('Students header missing'));
  const index = createHeaderIndex(headers);
  const student = rows.slice(1).map((row) => parseStudentRow(row, index))
    .find((candidate) => candidate?.studentId === studentId);
  if (!student) throw new TaskCompletionReconciliationError('TASK_COMPLETION_STUDENT_STATE_UNKNOWN', new Error('Student missing'));
  return student;
}

function legacyCompletionReference(completionId: string): string {
  return `LEGACY_COMPLETION:${encodeURIComponent(completionId)}`;
}

function canonicalUtcMilliseconds(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('TaskCompletion timestamp must be a valid instant');
  return parsed.toISOString();
}

function createCompletion(input: {
  task: ClassTask; student: Student; cycle: { cycleId: string; startsAt: string; endsAt: string | null };
  ruleVersion: number; timeZone: string; assignmentId: string; timestamp: string;
  source: TaskCompletion['source']; status: string; reward: number; balanceBefore: number; balanceAfter: number; note: string;
  operation?: BankOperation;
  completionId?: string;
}): TaskCompletion {
  return {
    completionId: input.completionId ?? (input.operation
      ? operationCheckpointId(input.operation.operationId, input.status)
      : `TC-${crypto.randomUUID()}`),
    timestamp: input.operation ? canonicalUtcMilliseconds(input.timestamp) : input.timestamp,
    taskId: input.task.taskId,
    studentId: input.student.studentId,
    studentName: input.student.name,
    reward: input.reward,
    balanceBefore: input.balanceBefore,
    balanceAfter: input.balanceAfter,
    status: input.status,
    note: input.note,
    taskInstanceId: input.task.taskInstanceId!,
    cycleId: input.cycle.cycleId,
    cycleStartsAt: input.operation ? canonicalUtcMilliseconds(input.cycle.startsAt) : input.cycle.startsAt,
    cycleEndsAt: input.cycle.endsAt === null
      ? null
      : input.operation ? canonicalUtcMilliseconds(input.cycle.endsAt) : input.cycle.endsAt,
    ruleVersion: input.ruleVersion,
    timeZone: input.timeZone,
    source: input.source,
    assignmentId: input.assignmentId,
    schemaVersion: 2,
    ...(input.operation ?? {}),
  };
}

async function appendRewardTransaction(store: RecurringSchemaMigrationStore, task: ClassTask, completion: TaskCompletion): Promise<void> {
  let headers = TRANSACTION_HEADERS;
  try { headers = (await store.getRows('Transactions'))[0] ?? TRANSACTION_HEADERS; } catch { /* canonical fallback */ }
  await store.appendRow('Transactions', buildTransactionAppendRow(headers, rewardTransaction(task, completion)));
}

async function appendRewardTransactionReconciled(
  store: RecurringSchemaMigrationStore,
  task: ClassTask,
  completion: TaskCompletion,
): Promise<void> {
  const transaction = rewardTransaction(task, completion);
  let rows = await readTransactionRowsFresh(store);
  if (hasTransactionId(rows, transaction.transactionId)) return;
  const headers = rows[0] ?? TRANSACTION_HEADERS;
  try {
    await store.appendRow('Transactions', buildTransactionAppendRow(headers, transaction));
  } catch (appendError) {
    rows = await readTransactionRowsFresh(store);
    if (!hasTransactionId(rows, transaction.transactionId)) throw appendError;
  }
}

async function readTransactionRowsFresh(store: RecurringSchemaMigrationStore): Promise<string[][]> {
  return store.getRowsFresh ? store.getRowsFresh('Transactions') : store.getRows('Transactions');
}

function hasTransactionId(rows: string[][], transactionId: string): boolean {
  const [headers, ...data] = rows;
  const index = headers?.findIndex((header) => header.trim() === 'transactionId') ?? -1;
  return index >= 0 && data.some((row) => String(row[index] ?? '').trim() === transactionId);
}

function rewardTransaction(task: ClassTask, completion: TaskCompletion): Transaction {
  return {
    transactionId: completion.operationId
      ? `TASK-LOGICAL-${encodeURIComponent(completion.completionId.replace(/-(PENDING|BALANCE_APPLIED|SUCCESS)$/, ''))}`
      : `TASK-${completion.completionId}`,
    timestamp: completion.timestamp,
    studentId: completion.studentId,
    studentName: completion.studentName,
    items: [{ productId: task.taskId, name: task.title, price: -completion.reward, quantity: 1, subtotal: -completion.reward }],
    totalAmount: -completion.reward,
    balanceBefore: completion.balanceBefore,
    balanceAfter: completion.balanceAfter,
    status: 'TASK_REWARD',
    operator: 'bank',
  };
}
