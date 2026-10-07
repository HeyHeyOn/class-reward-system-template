import 'server-only';

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isTaskAvailable } from '@/domain/taskAvailability';
import type {
  ClassTask,
  TaskCompletionEvidence,
  TaskSchedule,
} from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import type { DatabasePadletClaimRepository } from './padletClaims';
import { appendOperationAudit, assertOperationAudit } from './operationAudit';
import { ensureTaskLedger } from './taskLedger/migration';
import { readCurrentLedgerStates } from './taskLedger/currentState';
import { readCompletionTasks } from './taskLedger/locking';
import { rewardAssignment, writeCarriedAssignmentIfMissing } from './taskLedger/reward';
import {
  clockNow,
  LEDGER_CYCLE_ID,
  LEDGER_CYCLE_START,
  LEDGER_RULE_VERSION,
  latestEvent,
  readLedgerFrom,
  stageOf,
  type LedgerEventRow,
  type LedgerTask,
} from './taskLedger/store';
import { ledgerEventId } from './taskLedger/writes';

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
  completedAt: string;
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
  | 'EVIDENCE_CONFLICT'
  | 'NOT_READY';

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
      await ensureTaskLedger({ tenantId: dependencies.tenantId, runTenantTransaction: dependencies.runTenantTransaction });

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
            // A post counts when it is newer than the student's previous completion of this task.
            cycleStartsAt: initial.evidenceSince,
            cycleEndsAt: null,
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
        // LOCK ORDER: existing operation; shared graph gate; dependency task rows by ID; student/account; finally the
        // privileged global claim seam. Progress events are append-only and take no lock: every
        // writer of a task's progress holds that task's row first (see readLedgerTasks).
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
        await writeCarriedAssignmentIfMissing(tx, dependencies.tenantId, {
          assignment: { assignmentId: fresh.assignmentId, existing: fresh.assignmentExists },
          task: fresh.ledgerTask, studentId: fresh.studentId });

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
             evidence_author_full_name, created_at)
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
             ${evidence?.evidenceAuthorFullName ?? null}, clock_timestamp())
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
          completedAt: nowIso,
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


type AccountRow = {
  student_id: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  balance: string;
};



type RewardSnapshotRow = {
  completion_id: string;
  completed_at: Date | string;
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
  ledgerTask: LedgerTask;
  studentId: string;
  studentName: string;
  balance: number;
  boardId: string | null;
  assignmentId: string;
  /** False when a carried 완료 가능 row has to be written first (see rewardAssignment). */
  assignmentExists: boolean;
  cycleId: string;
  cycleStartsAt: string;
  cycleEndsAt: string | null;
  ruleVersion: number;
  /** Padlet posts must be newer than this (the student's previous completion of the task). */
  evidenceSince: string;
};

function isCompletion(event: LedgerEventRow): event is LedgerEventRow & { kind: 'COMPLETED' } {
  return event.kind === 'COMPLETED';
}

/**
 * A student may complete a task (and receive its reward) only at 완료 가능: the task is live and
 * available, the student is active, and its prerequisite (if any) is 완료 for the student.
 */
async function authorize(
  tx: TenantTransaction,
  tenantId: string,
  input: DatabaseTaskCompletionCommandInput,
  now: string,
  lock: boolean,
): Promise<Authorization> {
  const ledgerFrom = await readLedgerFrom(tx, tenantId);
  if (!ledgerFrom) throw new Error('Task ledger start is missing.');
  const tasks = await readCompletionTasks(tx, tenantId, input.taskId, lock);
  const target = tasks.find((task) => task.taskId === input.taskId);
  if (!target) throw new TaskRewardCommandError('POLICY');

  const accountResult = await tx.execute(lock ? sql`
    SELECT s.student_id, s.name, s.status, a.balance::text AS balance
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId} AND s.student_id=${input.studentId} AND s.deleted_at IS NULL
    FOR UPDATE OF s, a
  ` : sql`
    SELECT s.student_id, s.name, s.status, a.balance::text AS balance
    FROM students s
    JOIN accounts a ON a.tenant_id=s.tenant_id AND a.student_id=s.student_id
    WHERE s.tenant_id=${tenantId} AND s.student_id=${input.studentId} AND s.deleted_at IS NULL
  `);
  const account = accountResult.rows[0] as AccountRow | undefined;
  if (!account || account.status !== 'ACTIVE') throw new TaskRewardCommandError('POLICY');

  // Stages follow the database clock that ordered their events (the app clock may lag a little).
  const ledgerNow = await clockNow(tx);
  const events = await readCurrentLedgerStates(tx, tenantId, ledgerNow,
    { taskInstanceIds: tasks.map(task => task.taskInstanceId), studentId: input.studentId });
  const own = events.get(target.taskInstanceId)?.get(input.studentId);
  const state = stageOf(target, own, ledgerNow);
  const availability = {
    ...(target.availableFrom ? { availableFrom: target.availableFrom } : {}),
    ...(target.dueAt ? { dueAt: target.dueAt } : {}),
  };
  if (!target.isActive || !isTaskAvailable(availability, now) || state.stage === 'UNASSIGNED' || state.stage === 'COMPLETED') {
    throw new TaskRewardCommandError('POLICY');
  }
  // 미완료: assigned and visible, but the teacher has not made it completable (완료 가능) yet.
  if (state.stage !== 'READY') throw new TaskRewardCommandError('NOT_READY');
  if (target.prerequisiteTaskInstanceId) {
    const prerequisite = tasks.find((task) => task.taskInstanceId === target.prerequisiteTaskInstanceId);
    if (!prerequisite) throw new TaskRewardCommandError('POLICY');
    const prerequisiteState = stageOf(prerequisite, events.get(prerequisite.taskInstanceId)?.get(input.studentId), ledgerNow);
    if (prerequisiteState.stage !== 'COMPLETED') throw new TaskRewardCommandError('POLICY');
  }
  const assignment = rewardAssignment(own, ledgerEventId('tl-a', 'bank', input.operationId));
  const previousCompletion = latestEvent(own, isCompletion);

  return {
    task: {
      taskId: target.taskId,
      taskInstanceId: target.taskInstanceId,
      title: target.title,
      description: target.description,
      reward: target.reward,
      isActive: target.isActive,
      sortOrder: target.sortOrder,
      allowedStudentIds: [],
      createdAt: target.createdAt,
      schedule: target.currentSchedule,
      ...(target.padletBoardId ? { padletBoardId: target.padletBoardId } : {}),
    } as ClassTask & { taskInstanceId: string; schedule: TaskSchedule },
    ledgerTask: target,
    studentId: account.student_id,
    studentName: account.name.trim(),
    balance: safeInteger(account.balance, 'account balance'),
    boardId: target.padletBoardId ?? null,
    assignmentId: assignment.assignmentId,
    assignmentExists: assignment.existing,
    cycleId: LEDGER_CYCLE_ID,
    cycleStartsAt: LEDGER_CYCLE_START,
    cycleEndsAt: null,
    ruleVersion: LEDGER_RULE_VERSION,
    evidenceSince: new Date(previousCompletion?.at ?? target.createdAt).toISOString(),
  };
}

async function readOperation(
  tx: TenantTransaction,
  tenantId: string,
  operationId: string,
  lock: boolean,
): Promise<OperationRow | null> {
  const currentOperation = lock ? sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
    FOR UPDATE
  ` : sql`
    SELECT operation_kind, payload_hash, status, result_snapshot, finished_at
    FROM operations
    WHERE tenant_id=${tenantId} AND operation_id=${operationId}
  `;
  // Historical UUIDs must never become a new reward, including after a reset.
  // This is a read-only conflict marker, not a fabricated operations receipt.
  const result = await tx.execute(sql`WITH current_operation AS (${currentOperation})
    SELECT * FROM current_operation
    UNION ALL
    SELECT 'HISTORICAL_TASK_REWARD' AS operation_kind, historical_operation_hash AS payload_hash,
      'SUCCEEDED' AS status, NULL::jsonb AS result_snapshot, imported_at AS finished_at
    FROM legacy_task_origins WHERE tenant_id=${tenantId} AND historical_operation_id=${operationId}`);
  return (result.rows[0] as OperationRow | undefined) ?? null;
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
  const startsAt = new Date(authorization.evidenceSince);
  if (!Number.isFinite(createdAt.getTime())
    || createdAt < startsAt
    || createdAt > now) {
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
    SELECT tc.completion_id, tc.completed_at, tc.task_instance_id, tc.task_id_snapshot,
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
  const completedAt = iso(row.completed_at);
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
    completedAt,
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
  const stored = parseStoredResult(operation.result_snapshot, completedAt);
  if (canonicalResult(stored.result) !== canonicalResult(expected)) {
    throw new Error('Stored task reward result binding is invalid.');
  }
  await assertOperationAudit(
    tx,
    tenantId,
    taskRewardAuditInput(
      input.operationId,
      stored.result,
      requiredAuditDate(operation.finished_at),
      stored.legacy,
    ),
  );
  return stored.result;
}

function taskRewardAuditInput(
  operationId: string,
  result: TaskRewardSuccess,
  occurredAt: Date,
  legacy = false,
) {
  const redactedDetails = {
    ...(!legacy ? { completedAt: result.completedAt } : {}),
    cycleId: result.cycleId,
    reward: result.reward,
    studentId: result.studentId,
    taskId: result.taskId,
    taskInstanceId: result.taskInstanceId,
    transactionId: result.transactionId,
  };
  return {
    operationId,
    eventType: 'TASK_REWARD_COMPLETED',
    entityType: 'TASK_COMPLETION',
    entityId: result.completionId,
    redactedDetails,
    occurredAt,
  } as const;
}

function requiredAuditDate(value: Date | string | null): Date {
  if (value === null) throw new Error('Task reward audit integrity check failed.');
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Task reward audit integrity check failed.');
  return date;
}

type ParsedStoredResult = Readonly<{
  result: TaskRewardSuccess;
  legacy: boolean;
}>;

function parseStoredResult(value: unknown, fallbackCompletedAt: string): ParsedStoredResult {
  const baseKeys = [
    'ok', 'operationId', 'taskId', 'taskInstanceId', 'taskTitle', 'studentId', 'studentName',
    'reward', 'balanceBefore', 'balanceAfter', 'cycleId', 'transactionId', 'completionId',
  ] as const;
  const hasEvidence = isRecord(value) && Object.hasOwn(value, 'evidence');
  const currentKeys = [...baseKeys, 'completedAt', ...(hasEvidence ? ['evidence'] : [])];
  const legacyKeys = [...baseKeys, ...(hasEvidence ? ['evidence'] : [])];
  const current = hasExactKeys(value, currentKeys);
  const legacy = hasExactKeys(value, legacyKeys);
  if ((!current && !legacy) || !isRecord(value) || value.ok !== true
    || !isString(value.operationId) || !isString(value.taskId) || !isString(value.taskInstanceId)
    || !isString(value.taskTitle) || !isString(value.studentId) || !isString(value.studentName)
    || !Number.isSafeInteger(value.reward) || !Number.isSafeInteger(value.balanceBefore)
    || !Number.isSafeInteger(value.balanceAfter) || !isString(value.cycleId)
    || !isString(value.transactionId) || !isString(value.completionId)) {
    throw new Error('Stored task reward result is invalid.');
  }
  const completedAt = current ? value.completedAt : fallbackCompletedAt;
  if (typeof completedAt !== 'string' || !isStrictIsoTimestamp(completedAt)) {
    throw new Error('Stored task reward result is invalid.');
  }
  const evidence = hasEvidence ? normalizePadletEvidence(value.evidence) : undefined;
  return {
    legacy,
    result: {
      ok: true,
      operationId: value.operationId,
      completedAt,
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
    },
  };
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function canonicalResult(result: TaskRewardSuccess): string {
  return JSON.stringify({
    ok: true,
    operationId: result.operationId,
    completedAt: result.completedAt,
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

function isCanonicalPadletPostId(value: string): boolean {
  return value.length >= 3 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isStrictIsoTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
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
    case 'NOT_READY': return 'Task is not completable yet.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
