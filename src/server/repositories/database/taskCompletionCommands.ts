import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isTaskAvailable } from '@/domain/taskAvailability';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import type {
  ClassTask,
  TaskAssignment,
  TaskCompletion,
  TaskCompletionEvidence,
  TaskSchedule,
} from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { isCanonicalPadletPostId, isStrictIsoTimestamp } from '@/server/padletClient';
import type { DatabasePadletClaimRepository } from './padletClaims';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type PadletEvidenceResolutionInput = Readonly<{
  taskId: string;
  taskInstanceId: string;
  studentId: string;
  studentName: string;
  boardId: string;
  cycleId: string;
  cycleStartsAt: string;
  cycleEndsAt: string | null;
  operationId: string;
  now: string;
}>;

export type DatabaseTaskCompletionCommandDependencies = {
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  padletClaims: DatabasePadletClaimRepository;
  /** Provider I/O happens after preauthorization and before the write transaction. */
  resolvePadletEvidence?: (input: PadletEvidenceResolutionInput) => Promise<TaskCompletionEvidence>;
  now?: () => Date;
  /** Fault-injection seam after mutable rows change, before immutable ledgers. */
  afterAccountUpdate?: () => Promise<void>;
};

export type DatabaseTaskCompletionCommandInput = Readonly<{
  operationId: string;
  taskId: string;
  studentId: string;
  /** Optional caller binding; when present it must match the authoritative digest. */
  payloadHash?: string;
}>;

export type TaskRewardSuccess = Readonly<{
  ok: true;
  operationId: string;
  taskId: string;
  taskInstanceId: string;
  taskTitle: string;
  studentId: string;
  studentName: string;
  reward: number;
  balanceBefore: number;
  balanceAfter: number;
  cycleId: string;
  transactionId: string;
  completionId: string;
  evidence?: TaskCompletionEvidence;
}>;

export type TaskRewardCommandErrorCode =
  | 'POLICY'
  | 'CONFLICT'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_PENDING'
  | 'PROVIDER_UNAVAILABLE'
  | 'SUBMISSION_REQUIRED'
  | 'EVIDENCE_CONFLICT';

export class TaskRewardCommandError extends Error {
  constructor(readonly code: TaskRewardCommandErrorCode) {
    super(messageFor(code));
    this.name = 'TaskRewardCommandError';
  }
}

export type TaskRewardPayload = Readonly<{
  taskId: string;
  taskInstanceId: string;
  taskTitle?: string;
  studentId: string;
  studentName?: string;
  assignmentId?: string;
  cycleId: string;
  cycleStartsAt?: string;
  cycleEndsAt?: string | null;
  reward: number;
  evidence?: TaskCompletionEvidence;
}>;

export function createTaskRewardPayloadHash(payload: TaskRewardPayload): string {
  const canonical = JSON.stringify({
    kind: 'TASK_REWARD',
    taskId: payload.taskId,
    taskInstanceId: payload.taskInstanceId,
    taskTitle: payload.taskTitle ?? null,
    studentId: payload.studentId,
    studentName: payload.studentName ?? null,
    assignmentId: payload.assignmentId ?? null,
    cycleId: payload.cycleId,
    cycleStartsAt: payload.cycleStartsAt ? canonicalTimestamp(payload.cycleStartsAt) : null,
    cycleEndsAt: payload.cycleEndsAt ? canonicalTimestamp(payload.cycleEndsAt) : null,
    reward: payload.reward,
    source: 'BANK',
    completionStatus: 'COMPLETED',
    transactionKind: 'TASK_REWARD',
    operatorSnapshot: 'bank-task-completion',
    evidence: payload.evidence ? normalizePadletEvidence(payload.evidence) : null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createDatabaseTaskCompletionCommand(
  dependencies: DatabaseTaskCompletionCommandDependencies,
) {
  return {
    async execute(rawInput: DatabaseTaskCompletionCommandInput): Promise<TaskRewardSuccess> {
      const input = canonicalize(rawInput);
      const now = dependencies.now?.() ?? new Date();
      if (!Number.isFinite(now.getTime())) throw new Error('A valid task reward timestamp is required.');
      const nowIso = now.toISOString();

      const preflight = await dependencies.runTenantTransaction<
        { existing: TaskRewardSuccess } | { authorization: Authorization }
      >(dependencies.tenantId, async (tx) => {
        const existing = await readOperation(tx, dependencies.tenantId, input.operationId, false);
        if (existing) {
          return {
            existing: await resolveExistingOperation(
              tx, dependencies.tenantId, existing, input,
            ),
          };
        }
        return { authorization: await authorize(tx, dependencies.tenantId, input, nowIso, false) };
      });
      if ('existing' in preflight) {
        return preflight.existing;
      }

      let evidence: TaskCompletionEvidence | undefined;
      const initial = preflight.authorization;
      if (initial.boardId) {
        if (!dependencies.resolvePadletEvidence) throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
        try {
          evidence = normalizePadletEvidence(await dependencies.resolvePadletEvidence({
            taskId: initial.task.taskId,
            taskInstanceId: initial.task.taskInstanceId,
            studentId: initial.studentId,
            studentName: initial.studentName,
            boardId: initial.boardId,
            cycleId: initial.cycleId,
            cycleStartsAt: initial.cycleStartsAt,
            cycleEndsAt: initial.cycleEndsAt,
            operationId: input.operationId,
            now: nowIso,
          }));
        } catch (error) {
          if (error instanceof TaskRewardCommandError) throw error;
          throw new TaskRewardCommandError('PROVIDER_UNAVAILABLE');
        }
      }

      const payload = payloadFor(initial, evidence);
      const payloadHash = createTaskRewardPayloadHash(payload);
      if (input.payloadHash && input.payloadHash !== payloadHash) {
        throw new TaskRewardCommandError('OPERATION_CONFLICT');
      }

      return dependencies.runTenantTransaction(dependencies.tenantId, async (tx) => {
        // LOCK ORDER: existing operation; tasks by task_instance_id; student/account;
        // allowed-student rows; assignment events by event_sequence; prerequisite and
        // completion events by event_sequence; finally the privileged global claim seam.
        const inserted = await tx.execute(sql`
          INSERT INTO operations
            (tenant_id, operation_id, operation_kind, payload_hash, status,
             attempt_count, started_at, created_at, updated_at)
          VALUES
            (${dependencies.tenantId}, ${input.operationId}, 'TASK_REWARD', ${payloadHash},
             'PENDING', 1, ${now}, ${now}, ${now})
          ON CONFLICT (tenant_id, operation_id) DO NOTHING
          RETURNING operation_id
        `);
        const operation = await readOperation(tx, dependencies.tenantId, input.operationId, true);
        if (!operation) throw new Error('Task reward operation could not be read.');
        if (operation.operation_kind !== 'TASK_REWARD' || operation.payload_hash !== payloadHash) {
          throw new TaskRewardCommandError('OPERATION_CONFLICT');
        }
        if (inserted.rows.length === 0) {
          return resolveExistingOperation(
            tx, dependencies.tenantId, operation, input,
          );
        }

        const fresh = await authorize(tx, dependencies.tenantId, input, nowIso, true);
        if (createTaskRewardPayloadHash(payloadFor(fresh, evidence)) !== payloadHash) {
          throw new TaskRewardCommandError('CONFLICT');
        }
        validateEvidence(fresh, evidence, now);

        const balanceAfter = checkedSum(fresh.balance, fresh.task.reward);
        await tx.execute(sql`
          UPDATE accounts
          SET balance=${balanceAfter}, version=version+1, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND student_id=${fresh.studentId}
        `);
        await dependencies.afterAccountUpdate?.();

        const transactionId = `task-reward:${input.operationId}`;
        const completionId = `task-completion:${input.operationId}`;
        await tx.execute(sql`
          INSERT INTO transactions
            (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot,
             kind, legacy_total_amount, balance_delta, balance_before, balance_after,
             operator_snapshot, legacy_status_snapshot, operation_id, operation_hash,
             schema_version)
          VALUES
            (${dependencies.tenantId}, ${transactionId}, ${now}, ${fresh.studentId},
             ${fresh.studentName}, 'TASK_REWARD', ${fresh.task.reward}, ${fresh.task.reward},
             ${fresh.balance}, ${balanceAfter}, 'bank-task-completion', 'COMPLETED',
             ${input.operationId}, ${payloadHash}, 1)
        `);
        await tx.execute(sql`
          INSERT INTO task_completions
            (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
             task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
             balance_before, balance_after, status, note, cycle_id, cycle_start_at,
             cycle_end_at, rule_version, timezone, source, assignment_id, transaction_id,
             operation_id, operation_hash, schema_version, evidence_provider,
             evidence_board_id, evidence_post_id, evidence_created_at,
             evidence_author_full_name)
          VALUES
            (${dependencies.tenantId}, ${completionId}, ${now}, ${fresh.task.taskInstanceId},
             ${fresh.task.taskId}, ${fresh.task.title}, ${fresh.studentId}, ${fresh.studentName},
             ${fresh.task.reward}, ${fresh.balance}, ${balanceAfter}, 'COMPLETED',
             'bank-self-completion', ${fresh.cycleId}, ${new Date(fresh.cycleStartsAt)},
             ${fresh.cycleEndsAt ? new Date(fresh.cycleEndsAt) : null}, ${fresh.ruleVersion},
             'Asia/Seoul', 'BANK', ${fresh.assignmentId}, ${transactionId},
             ${input.operationId}, ${payloadHash}, 1, ${evidence?.evidenceProvider ?? null},
             ${evidence?.evidenceBoardId ?? null}, ${evidence?.evidencePostId ?? null},
             ${evidence ? new Date(evidence.evidenceCreatedAt) : null},
             ${evidence?.evidenceAuthorFullName ?? null})
        `);

        if (evidence) {
          const claim = await dependencies.padletClaims.claim(tx, {
            tenantId: dependencies.tenantId,
            operationId: input.operationId,
            evidence,
            claimedAt: now,
          });
          if (claim === 'CONFLICT') throw new TaskRewardCommandError('EVIDENCE_CONFLICT');
        }

        const result: TaskRewardSuccess = {
          ok: true,
          operationId: input.operationId,
          taskId: fresh.task.taskId,
          taskInstanceId: fresh.task.taskInstanceId,
          taskTitle: fresh.task.title,
          studentId: fresh.studentId,
          studentName: fresh.studentName,
          reward: fresh.task.reward,
          balanceBefore: fresh.balance,
          balanceAfter,
          cycleId: fresh.cycleId,
          transactionId,
          completionId,
          ...(evidence ? { evidence } : {}),
        };
        await appendOperationAudit(
          tx,
          dependencies.tenantId,
          taskRewardAuditInput(input.operationId, result, now),
        );
        await tx.execute(sql`
          UPDATE operations
          SET status='SUCCEEDED', result_snapshot=${JSON.stringify(result)}::jsonb,
              finished_at=${now}, updated_at=${now}
          WHERE tenant_id=${dependencies.tenantId} AND operation_id=${input.operationId}
        `);
        return result;
      });
    },
  };
}

type OperationRow = {
  operation_kind: string;
  payload_hash: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  result_snapshot: unknown;
  finished_at: Date | string | null;
};

type TaskRow = {
  task_instance_id: string;
  task_id: string;
  title: string;
  description: string;
  reward: string;
  is_active: boolean;
  sort_order: number;
  available_from: Date | string | null;
  due_at: Date | string | null;
  prerequisite_task_instance_id: string | null;
  padlet_board_id: string | null;
  current_schedule: TaskSchedule;
  pending_schedule: TaskSchedule | null;
  created_at: Date | string;
};

type AccountRow = {
  student_id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  balance: string;
};

type AssignmentRow = {
  assignment_id: string;
  task_id_snapshot: string;
  task_instance_id: string;
  cycle_id: string;
  cycle_start_at: Date | string;
  cycle_end_at: Date | string | null;
  rule_version: number;
  timezone: string;
  student_id: string;
  event_type: 'ASSIGNED' | 'UNASSIGNED';
  source: TaskAssignment['source'];
  previous_assignment_id: string | null;
  created_at: Date | string;
  schema_version: number;
  note: string | null;
};

type CompletionRow = {
  completion_id: string;
  completed_at: Date | string;
  task_instance_id: string | null;
  task_id_snapshot: string;
  student_id: string;
  student_name_snapshot: string;
  reward_snapshot: string;
  balance_before: string;
  balance_after: string;
  status: string;
  note: string | null;
  cycle_id: string | null;
  cycle_start_at: Date | string | null;
  cycle_end_at: Date | string | null;
  rule_version: number | null;
  timezone: string | null;
  source: TaskCompletion['source'] | null;
  assignment_id: string | null;
  operation_id: string | null;
  operation_hash: string | null;
  schema_version: number;
};

type RewardSnapshotRow = {
  completion_id: string;
  task_instance_id: string | null;
  task_id_snapshot: string;
  task_name_snapshot: string;
  student_id: string;
  student_name_snapshot: string;
  reward_snapshot: string;
  completion_balance_before: string;
  completion_balance_after: string;
  completion_status: string;
  completion_source: string | null;
  cycle_id: string | null;
  cycle_start_at: Date | string | null;
  cycle_end_at: Date | string | null;
  assignment_id: string | null;
  completion_operation_hash: string | null;
  evidence_provider: string | null;
  evidence_board_id: string | null;
  evidence_post_id: string | null;
  evidence_created_at: Date | string | null;
  evidence_author_full_name: string | null;
  transaction_id: string;
  transaction_kind: string;
  transaction_student_id: string;
  transaction_student_name_snapshot: string;
  legacy_total_amount: string;
  legacy_status_snapshot: string | null;
  transaction_operation_id: string | null;
  balance_delta: string;
  transaction_balance_before: string;
  transaction_balance_after: string;
  operator_snapshot: string;
  transaction_operation_hash: string | null;
};

type Authorization = {
  task: ClassTask & { taskInstanceId: string; schedule: TaskSchedule };
  studentId: string;
  studentName: string;
  balance: number;
  boardId: string | null;
  assignmentId: string;
  cycleId: string;
  cycleStartsAt: string;
  cycleEndsAt: string | null;
  ruleVersion: number;
};

async function authorize(
  tx: TenantTransaction,
  tenantId: string,
  input: DatabaseTaskCompletionCommandInput,
  now: string,
  lock: boolean,
): Promise<Authorization> {
  const taskResult = await tx.execute(lock ? sql`
    SELECT task_instance_id, task_id, title, description, reward::text AS reward,
           is_active, sort_order, available_from, due_at, prerequisite_task_instance_id,
           padlet_board_id, current_schedule, pending_schedule, created_at
    FROM tasks
    WHERE tenant_id=${tenantId} AND deleted_at IS NULL
    ORDER BY task_instance_id
    FOR UPDATE
  ` : sql`
    SELECT task_instance_id, task_id, title, description, reward::text AS reward,
           is_active, sort_order, available_from, due_at, prerequisite_task_instance_id,
           padlet_board_id, current_schedule, pending_schedule, created_at
    FROM tasks
    WHERE tenant_id=${tenantId} AND deleted_at IS NULL
    ORDER BY task_instance_id
  `);
  const rows = taskResult.rows as TaskRow[];
  const targetRow = rows.find((row) => row.task_id === input.taskId);
  if (!targetRow) throw new TaskRewardCommandError('POLICY');

  const accountResult = await tx.execute(lock ? sql`
    SELECT s.student_id, s.name, s.status, a.balance::text AS balance
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId} AND s.student_id=${input.studentId}
    FOR UPDATE OF s, a
  ` : sql`
    SELECT s.student_id, s.name, s.status, a.balance::text AS balance
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId} AND s.student_id=${input.studentId}
  `);
  const account = accountResult.rows[0] as AccountRow | undefined;
  if (!account || account.status !== 'ACTIVE') throw new TaskRewardCommandError('POLICY');

  const allowedResult = await tx.execute(lock ? sql`
    SELECT task_instance_id, student_id
    FROM task_allowed_students
    WHERE tenant_id=${tenantId}
    ORDER BY task_instance_id, student_id
    FOR UPDATE
  ` : sql`
    SELECT task_instance_id, student_id
    FROM task_allowed_students
    WHERE tenant_id=${tenantId}
    ORDER BY task_instance_id, student_id
  `);
  const allowedByTask = new Map<string, string[]>();
  for (const row of allowedResult.rows as Array<{ task_instance_id: string; student_id: string }>) {
    const ids = allowedByTask.get(row.task_instance_id) ?? [];
    ids.push(row.student_id);
    allowedByTask.set(row.task_instance_id, ids);
  }
  const rowByInstance = new Map(rows.map((row) => [row.task_instance_id, row]));
  const taskByInstance = new Map(rows.map((row) => [
    row.task_instance_id,
    toTask(row, allowedByTask.get(row.task_instance_id) ?? [], rowByInstance),
  ]));
  const task = taskByInstance.get(targetRow.task_instance_id);
  if (!task || !(allowedByTask.get(targetRow.task_instance_id) ?? []).includes(input.studentId)) {
    throw new TaskRewardCommandError('POLICY');
  }

  const assignmentResult = await tx.execute(lock ? sql`
    SELECT assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
           cycle_end_at, rule_version, timezone, student_id, event_type, source,
           previous_assignment_id, created_at, schema_version, note
    FROM task_assignments
    WHERE tenant_id=${tenantId} AND student_id=${input.studentId}
    ORDER BY event_sequence
    FOR UPDATE
  ` : sql`
    SELECT assignment_id, task_id_snapshot, task_instance_id, cycle_id, cycle_start_at,
           cycle_end_at, rule_version, timezone, student_id, event_type, source,
           previous_assignment_id, created_at, schema_version, note
    FROM task_assignments
    WHERE tenant_id=${tenantId} AND student_id=${input.studentId}
    ORDER BY event_sequence
  `);
  const completionResult = await tx.execute(lock ? sql`
    SELECT completion_id, completed_at, task_instance_id, task_id_snapshot, student_id,
           student_name_snapshot, reward_snapshot::text AS reward_snapshot,
           balance_before::text AS balance_before, balance_after::text AS balance_after,
           status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
           source, assignment_id, operation_id, operation_hash, schema_version
    FROM task_completions
    WHERE tenant_id=${tenantId} AND student_id=${input.studentId}
    ORDER BY event_sequence
    FOR UPDATE
  ` : sql`
    SELECT completion_id, completed_at, task_instance_id, task_id_snapshot, student_id,
           student_name_snapshot, reward_snapshot::text AS reward_snapshot,
           balance_before::text AS balance_before, balance_after::text AS balance_after,
           status, note, cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone,
           source, assignment_id, operation_id, operation_hash, schema_version
    FROM task_completions
    WHERE tenant_id=${tenantId} AND student_id=${input.studentId}
    ORDER BY event_sequence
  `);
  const assignments = (assignmentResult.rows as AssignmentRow[]).map(toAssignment);
  const completions = (completionResult.rows as CompletionRow[]).map(toCompletion);
  const state = projectTaskCycleState({ task, now, assignments, completions });
  const effectiveSchedule = resolveTaskSchedule({
    currentSchedule: task.schedule,
    pendingSchedule: task.pendingSchedule ?? null,
    now,
  });
  const studentState = state.students[input.studentId];

  if (!task.isActive || !isTaskAvailable(task, now) || !studentState?.assigned || studentState.completed) {
    throw new TaskRewardCommandError('POLICY');
  }
  if (task.prerequisiteTaskId) {
    const prerequisite = [...taskByInstance.values()].find((candidate) => candidate.taskId === task.prerequisiteTaskId);
    if (!prerequisite) throw new TaskRewardCommandError('POLICY');
    const prerequisiteState = projectTaskCycleState({ task: prerequisite, now, assignments, completions });
    if (!prerequisiteState.students[input.studentId]?.completed) throw new TaskRewardCommandError('POLICY');
  }
  const assignmentId = studentState.assignmentEvent?.assignmentId;
  if (!assignmentId) throw new TaskRewardCommandError('POLICY');

  return {
    task,
    studentId: account.student_id,
    studentName: account.name.trim(),
    balance: safeInteger(account.balance, 'account balance'),
    boardId: task.padletBoardId ?? null,
    assignmentId,
    cycleId: state.cycle.cycleId,
    cycleStartsAt: state.cycle.startsAt,
    cycleEndsAt: state.cycle.endsAt,
    ruleVersion: effectiveSchedule.ruleVersion,
  };
}

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
  lock: boolean,
): Promise<OperationRow | null> {
  const result = await tx.execute(lock ? sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  ` : sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
  `);
  return (result.rows[0] as OperationRow | undefined) ?? null;
}

function toTask(
  row: TaskRow,
  allowedStudentIds: string[],
  rowByInstance: ReadonlyMap<string, TaskRow>,
): ClassTask & { taskInstanceId: string; schedule: TaskSchedule } {
  const prerequisite = row.prerequisite_task_instance_id
    ? rowByInstance.get(row.prerequisite_task_instance_id)
    : undefined;
  return {
    taskId: row.task_id,
    taskInstanceId: row.task_instance_id,
    title: row.title,
    description: row.description,
    reward: safeInteger(row.reward, `reward for ${row.task_id}`),
    isActive: row.is_active,
    sortOrder: row.sort_order,
    allowedStudentIds,
    ...(row.available_from ? { availableFrom: iso(row.available_from) } : {}),
    ...(row.due_at ? { dueAt: iso(row.due_at) } : {}),
    ...(prerequisite ? { prerequisiteTaskId: prerequisite.task_id } : {}),
    ...(row.padlet_board_id ? { padletBoardId: row.padlet_board_id } : {}),
    createdAt: iso(row.created_at),
    schedule: row.current_schedule,
    pendingSchedule: row.pending_schedule,
  };
}

function toAssignment(row: AssignmentRow): TaskAssignment {
  return {
    assignmentId: row.assignment_id,
    taskId: row.task_id_snapshot,
    taskInstanceId: row.task_instance_id,
    cycleId: row.cycle_id,
    cycleStartsAt: iso(row.cycle_start_at),
    cycleEndsAt: row.cycle_end_at ? iso(row.cycle_end_at) : null,
    ruleVersion: row.rule_version,
    timeZone: row.timezone,
    studentId: row.student_id,
    status: row.event_type,
    source: row.source,
    previousAssignmentId: row.previous_assignment_id ?? '',
    createdAt: iso(row.created_at),
    schemaVersion: row.schema_version,
    note: row.note ?? '',
  };
}

function toCompletion(row: CompletionRow): TaskCompletion {
  return {
    completionId: row.completion_id,
    timestamp: iso(row.completed_at),
    taskId: row.task_id_snapshot,
    studentId: row.student_id,
    studentName: row.student_name_snapshot,
    reward: safeInteger(row.reward_snapshot, 'completion reward'),
    balanceBefore: safeInteger(row.balance_before, 'completion balance before'),
    balanceAfter: safeInteger(row.balance_after, 'completion balance after'),
    status: row.status === 'COMPLETED' ? 'SUCCESS' : row.status === 'CANCELLED' ? 'RESET' : row.status,
    note: row.note ?? '',
    ...(row.task_instance_id ? { taskInstanceId: row.task_instance_id } : {}),
    ...(row.cycle_id ? { cycleId: row.cycle_id } : {}),
    ...(row.cycle_start_at ? { cycleStartsAt: iso(row.cycle_start_at) } : {}),
    ...(row.cycle_end_at !== null ? { cycleEndsAt: iso(row.cycle_end_at) } : {}),
    ...(row.rule_version !== null ? { ruleVersion: row.rule_version } : {}),
    ...(row.timezone !== null ? { timeZone: row.timezone } : {}),
    ...(row.source !== null ? { source: row.source } : {}),
    ...(row.assignment_id ? { assignmentId: row.assignment_id } : {}),
    schemaVersion: row.schema_version,
    ...(row.operation_id ? { operationId: row.operation_id } : {}),
    ...(row.operation_hash ? { operationPayloadHash: row.operation_hash } : {}),
  };
}

function payloadFor(authorization: Authorization, evidence?: TaskCompletionEvidence): TaskRewardPayload {
  return {
    taskId: authorization.task.taskId,
    taskInstanceId: authorization.task.taskInstanceId,
    taskTitle: authorization.task.title,
    studentId: authorization.studentId,
    studentName: authorization.studentName,
    assignmentId: authorization.assignmentId,
    cycleId: authorization.cycleId,
    cycleStartsAt: authorization.cycleStartsAt,
    cycleEndsAt: authorization.cycleEndsAt,
    reward: authorization.task.reward,
    ...(evidence ? { evidence } : {}),
  };
}

function normalizePadletEvidence(value: unknown): TaskCompletionEvidence {
  if (!isRecord(value)
    || Object.keys(value).length !== 5
    || value.evidenceProvider !== 'PADLET'
    || typeof value.evidenceBoardId !== 'string'
    || !/^[A-Za-z0-9]{16,22}$/.test(value.evidenceBoardId)
    || typeof value.evidencePostId !== 'string'
    || !isCanonicalPadletPostId(value.evidencePostId)
    || typeof value.evidenceCreatedAt !== 'string'
    || !isStrictIsoTimestamp(value.evidenceCreatedAt)
    || typeof value.evidenceAuthorFullName !== 'string'
    || value.evidenceAuthorFullName !== value.evidenceAuthorFullName.trim()
    || value.evidenceAuthorFullName.length < 1
    || value.evidenceAuthorFullName.length > 200) {
    throw new TaskRewardCommandError('CONFLICT');
  }
  return {
    evidenceProvider: 'PADLET',
    evidenceBoardId: value.evidenceBoardId,
    evidencePostId: value.evidencePostId,
    evidenceCreatedAt: value.evidenceCreatedAt,
    evidenceAuthorFullName: value.evidenceAuthorFullName,
  };
}

function validateEvidence(authorization: Authorization, evidence: TaskCompletionEvidence | undefined, now: Date): void {
  if (!authorization.boardId) {
    if (evidence) throw new TaskRewardCommandError('CONFLICT');
    return;
  }
  if (!evidence
    || evidence.evidenceProvider !== 'PADLET'
    || evidence.evidenceBoardId !== authorization.boardId
    || evidence.evidenceAuthorFullName !== authorization.studentName
    || evidence.evidenceAuthorFullName !== evidence.evidenceAuthorFullName.trim()) {
    throw new TaskRewardCommandError('CONFLICT');
  }
  const createdAt = new Date(evidence.evidenceCreatedAt);
  const startsAt = new Date(authorization.cycleStartsAt);
  const endsAt = authorization.cycleEndsAt ? new Date(authorization.cycleEndsAt) : null;
  if (!Number.isFinite(createdAt.getTime())
    || createdAt < startsAt
    || createdAt > now
    || (endsAt !== null && createdAt >= endsAt)) {
    throw new TaskRewardCommandError('SUBMISSION_REQUIRED');
  }
}

async function resolveExistingOperation(
  tx: TenantTransaction,
  tenantId: string,
  operation: OperationRow,
  input: DatabaseTaskCompletionCommandInput,
): Promise<TaskRewardSuccess> {
  if (operation.operation_kind !== 'TASK_REWARD'
    || (input.payloadHash && input.payloadHash !== operation.payload_hash)) {
    throw new TaskRewardCommandError('OPERATION_CONFLICT');
  }
  if (operation.status === 'PENDING') throw new TaskRewardCommandError('OPERATION_PENDING');
  if (operation.status !== 'SUCCEEDED') throw new TaskRewardCommandError('OPERATION_CONFLICT');

  const snapshotResult = await tx.execute(sql`
    SELECT tc.completion_id, tc.task_instance_id, tc.task_id_snapshot,
           tc.task_name_snapshot, tc.student_id, tc.student_name_snapshot,
           tc.reward_snapshot::text AS reward_snapshot,
           tc.balance_before::text AS completion_balance_before,
           tc.balance_after::text AS completion_balance_after,
           tc.status AS completion_status, tc.source AS completion_source,
           tc.cycle_id, tc.cycle_start_at,
           tc.cycle_end_at, tc.assignment_id,
           tc.operation_hash AS completion_operation_hash,
           tc.evidence_provider, tc.evidence_board_id, tc.evidence_post_id,
           tc.evidence_created_at, tc.evidence_author_full_name,
           tr.transaction_id, tr.kind AS transaction_kind,
           tr.student_id AS transaction_student_id,
           tr.student_name_snapshot AS transaction_student_name_snapshot,
           tr.legacy_total_amount::text AS legacy_total_amount,
           tr.legacy_status_snapshot, tr.operation_id AS transaction_operation_id,
           tr.balance_delta::text AS balance_delta,
           tr.balance_before::text AS transaction_balance_before,
           tr.balance_after::text AS transaction_balance_after,
           tr.operator_snapshot, tr.operation_hash AS transaction_operation_hash
    FROM task_completions tc
    JOIN transactions tr
      ON tr.tenant_id=tc.tenant_id
     AND tr.transaction_id=tc.transaction_id
     AND tr.operation_id=tc.operation_id
    WHERE tc.tenant_id=${tenantId} AND tc.operation_id=${input.operationId}
  `);
  if (snapshotResult.rows.length !== 1) throw new Error('Stored task reward snapshots are invalid.');
  const row = snapshotResult.rows[0] as RewardSnapshotRow;
  if (!row.task_instance_id || !row.cycle_id || !row.cycle_start_at || !row.assignment_id
    || row.completion_status !== 'COMPLETED' || row.completion_source !== 'BANK'
    || row.transaction_kind !== 'TASK_REWARD'
    || row.student_id !== input.studentId || row.transaction_student_id !== input.studentId
    || row.transaction_student_name_snapshot !== row.student_name_snapshot
    || row.task_id_snapshot !== input.taskId
    || row.transaction_operation_id !== input.operationId
    || row.legacy_status_snapshot !== 'COMPLETED'
    || row.transaction_id !== `task-reward:${input.operationId}`
    || row.completion_id !== `task-completion:${input.operationId}`
    || row.completion_operation_hash !== operation.payload_hash
    || row.transaction_operation_hash !== operation.payload_hash
    || row.operator_snapshot !== 'bank-task-completion') {
    throw new Error('Stored task reward snapshots are invalid.');
  }

  const evidenceValues = [
    row.evidence_provider, row.evidence_board_id, row.evidence_post_id,
    row.evidence_created_at, row.evidence_author_full_name,
  ];
  const nonNullEvidence = evidenceValues.filter((value) => value !== null).length;
  if (nonNullEvidence !== 0 && nonNullEvidence !== evidenceValues.length) {
    throw new Error('Stored task reward evidence is invalid.');
  }
  const evidence = nonNullEvidence === 0 ? undefined : normalizePadletEvidence({
    evidenceProvider: row.evidence_provider,
    evidenceBoardId: row.evidence_board_id,
    evidencePostId: row.evidence_post_id,
    evidenceCreatedAt: iso(row.evidence_created_at as Date | string),
    evidenceAuthorFullName: row.evidence_author_full_name,
  });
  const reward = safeInteger(row.reward_snapshot, 'stored task reward');
  const balanceBefore = safeInteger(row.completion_balance_before, 'stored completion balance before');
  const balanceAfter = safeInteger(row.completion_balance_after, 'stored completion balance after');
  if (safeInteger(row.balance_delta, 'stored transaction balance delta') !== reward
    || safeInteger(row.legacy_total_amount, 'stored transaction legacy total') !== reward
    || safeInteger(row.transaction_balance_before, 'stored transaction balance before') !== balanceBefore
    || safeInteger(row.transaction_balance_after, 'stored transaction balance after') !== balanceAfter
    || checkedSum(balanceBefore, reward) !== balanceAfter) {
    throw new Error('Stored task reward balance snapshots are invalid.');
  }

  const payload: TaskRewardPayload = {
    taskId: row.task_id_snapshot,
    taskInstanceId: row.task_instance_id,
    taskTitle: row.task_name_snapshot,
    studentId: row.student_id,
    studentName: row.student_name_snapshot,
    assignmentId: row.assignment_id,
    cycleId: row.cycle_id,
    cycleStartsAt: iso(row.cycle_start_at),
    cycleEndsAt: row.cycle_end_at ? iso(row.cycle_end_at) : null,
    reward,
    ...(evidence ? { evidence } : {}),
  };
  if (createTaskRewardPayloadHash(payload) !== operation.payload_hash) {
    throw new Error('Stored task reward payload binding is invalid.');
  }

  const expected: TaskRewardSuccess = {
    ok: true,
    operationId: input.operationId,
    taskId: row.task_id_snapshot,
    taskInstanceId: row.task_instance_id,
    taskTitle: row.task_name_snapshot,
    studentId: row.student_id,
    studentName: row.student_name_snapshot,
    reward,
    balanceBefore,
    balanceAfter,
    cycleId: row.cycle_id,
    transactionId: row.transaction_id,
    completionId: row.completion_id,
    ...(evidence ? { evidence } : {}),
  };
  const stored = parseStoredResult(operation.result_snapshot);
  if (canonicalResult(stored) !== canonicalResult(expected)) {
    throw new Error('Stored task reward result binding is invalid.');
  }
  await assertOperationAudit(
    tx,
    tenantId,
    taskRewardAuditInput(input.operationId, stored, requiredAuditDate(operation.finished_at)),
  );
  return stored;
}

function taskRewardAuditInput(
  operationId: string,
  result: TaskRewardSuccess,
  occurredAt: Date,
) {
  return {
    operationId,
    eventType: 'TASK_REWARD_COMPLETED',
    entityType: 'TASK_COMPLETION',
    entityId: result.completionId,
    redactedDetails: {
      cycleId: result.cycleId,
      reward: result.reward,
      studentId: result.studentId,
      taskId: result.taskId,
      taskInstanceId: result.taskInstanceId,
      transactionId: result.transactionId,
    },
    occurredAt,
  } as const;
}

function requiredAuditDate(value: Date | string | null): Date {
  if (value === null) throw new Error('Task reward audit integrity check failed.');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Task reward audit integrity check failed.');
  return date;
}

function parseStoredResult(value: unknown): TaskRewardSuccess {
  if (!isRecord(value) || value.ok !== true
    || !isString(value.operationId) || !isString(value.taskId) || !isString(value.taskInstanceId)
    || !isString(value.taskTitle) || !isString(value.studentId) || !isString(value.studentName)
    || !Number.isSafeInteger(value.reward) || !Number.isSafeInteger(value.balanceBefore)
    || !Number.isSafeInteger(value.balanceAfter) || !isString(value.cycleId)
    || !isString(value.transactionId) || !isString(value.completionId)) {
    throw new Error('Stored task reward result is invalid.');
  }
  const hasEvidence = Object.hasOwn(value, 'evidence');
  const expectedKeys = 13 + (hasEvidence ? 1 : 0);
  if (Object.keys(value).length !== expectedKeys) throw new Error('Stored task reward result is invalid.');
  const evidence = hasEvidence ? normalizePadletEvidence(value.evidence) : undefined;
  return {
    ok: true,
    operationId: value.operationId,
    taskId: value.taskId,
    taskInstanceId: value.taskInstanceId,
    taskTitle: value.taskTitle,
    studentId: value.studentId,
    studentName: value.studentName,
    reward: value.reward as number,
    balanceBefore: value.balanceBefore as number,
    balanceAfter: value.balanceAfter as number,
    cycleId: value.cycleId,
    transactionId: value.transactionId,
    completionId: value.completionId,
    ...(evidence ? { evidence } : {}),
  };
}

function canonicalResult(result: TaskRewardSuccess): string {
  return JSON.stringify({
    ok: true,
    operationId: result.operationId,
    taskId: result.taskId,
    taskInstanceId: result.taskInstanceId,
    taskTitle: result.taskTitle,
    studentId: result.studentId,
    studentName: result.studentName,
    reward: result.reward,
    balanceBefore: result.balanceBefore,
    balanceAfter: result.balanceAfter,
    cycleId: result.cycleId,
    transactionId: result.transactionId,
    completionId: result.completionId,
    evidence: result.evidence ? normalizePadletEvidence(result.evidence) : null,
  });
}

function canonicalize(input: DatabaseTaskCompletionCommandInput): DatabaseTaskCompletionCommandInput {
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (typeof input.taskId !== 'string' || !input.taskId.trim()
    || typeof input.studentId !== 'string' || !input.studentId.trim()) {
    throw new Error('Task and student identifiers are required.');
  }
  if (input.payloadHash !== undefined && (typeof input.payloadHash !== 'string' || !SHA256.test(input.payloadHash))) {
    throw new Error('A lowercase SHA-256 payload hash is required.');
  }
  return {
    operationId: input.operationId,
    taskId: input.taskId.trim(),
    studentId: input.studentId.trim(),
    ...(input.payloadHash ? { payloadHash: input.payloadHash } : {}),
  };
}

function safeInteger(value: string | number | bigint, label: string): number {
  const parsed = typeof value === 'bigint' ? value : BigInt(value);
  if (parsed > MAX_SAFE || parsed < MIN_SAFE) throw new Error(`Unsafe integer for ${label}.`);
  return Number(parsed);
}

function checkedSum(left: number, right: number): number {
  const result = BigInt(left) + BigInt(right);
  if (result > MAX_SAFE || result < MIN_SAFE) throw new Error('Unsafe integer for rewarded balance.');
  return Number(result);
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid database timestamp.');
  return date.toISOString();
}

function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid task reward timestamp.');
  return date.toISOString();
}

function messageFor(code: TaskRewardCommandErrorCode): string {
  switch (code) {
    case 'POLICY': return 'Task completion is not allowed.';
    case 'CONFLICT': return 'Task authorization changed.';
    case 'OPERATION_CONFLICT': return 'The operation is bound to another task reward.';
    case 'OPERATION_PENDING': return 'The task reward operation is already pending.';
    case 'PROVIDER_UNAVAILABLE': return 'Evidence verification is unavailable.';
    case 'SUBMISSION_REQUIRED': return 'Valid task evidence is required.';
    case 'EVIDENCE_CONFLICT': return 'Task evidence has already been used.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
