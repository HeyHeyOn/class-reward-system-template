import 'server-only';

import { sql } from 'drizzle-orm';
import { projectTaskCycleState, type TaskCycleState } from '@/domain/taskCycleState';
import {
  projectTaskCycleHistoryFromSnapshot,
  type TaskCycleHistoryEvent,
} from '@/domain/taskCycleHistory';
import {
  buildTaskHistoryDetailDto,
  buildTaskHistoryListDto,
  type TaskHistoryDetailDto,
  type TaskHistoryListDto,
} from '@/domain/taskHistoryDtos';
import type { ClassTask, TaskAssignment, TaskCompletion } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import { isoString, safeInteger } from './queryProjection';
import { readDatabaseTasks } from './taskQueries';

export type TaskCycleLedgerSnapshot = Readonly<{
  assignments: TaskAssignment[];
  completions: TaskCompletion[];
}>;

export type DatabaseTaskCycleQueryDependencies = Readonly<{
  tenantId: string;
  runTenantSnapshot: <TResult>(
    tenantId: string,
    callback: (transaction: TenantTransaction) => Promise<TResult>,
  ) => Promise<TResult>;
}>;

type AssignmentRow = Record<string, unknown>;
type CompletionRow = Record<string, unknown>;
type LedgerRow = Readonly<{
  ledger_kind: unknown;
  payload: unknown;
}>;

type ProjectedCompletion = Readonly<{
  completion: TaskCompletion;
  eventSequence: number;
}>;

export function createDatabaseTaskCycleQueries(
  dependencies: DatabaseTaskCycleQueryDependencies,
) {
  return {
    loadTaskCycleLedgerSnapshot(): Promise<TaskCycleLedgerSnapshot> {
      return dependencies.runTenantSnapshot(
        dependencies.tenantId,
        (transaction) => readLedgerSnapshot(transaction, dependencies.tenantId, 'ledger'),
      );
    },
    getTaskCompletions(): Promise<TaskCompletion[]> {
      return dependencies.runTenantSnapshot(
        dependencies.tenantId,
        async (transaction) => (await readLedgerSnapshot(
          transaction,
          dependencies.tenantId,
          'presentation',
        )).completions,
      );
    },
    async getTaskCycleState(taskId: string, now?: string): Promise<TaskCycleState> {
      assertCanonicalTaskId(taskId);
      const projectionNow = now === undefined
        ? new Date().toISOString()
        : isoString(now, 'Task cycle projection timestamp');
      return dependencies.runTenantSnapshot(
        dependencies.tenantId,
        async (transaction) => {
          const tasks = await readDatabaseTasks(transaction, dependencies.tenantId, {
            activeOnly: false,
            taskId,
          });
          if (tasks.length > 1) throw new Error('Task query returned duplicate tasks.');
          const task = tasks[0];
          if (!task) throw new Error('과제를 찾을 수 없습니다.');
          const snapshot = await readLedgerSnapshot(transaction, dependencies.tenantId, 'ledger');
          return projectTaskCycleState({ task, now: projectionNow, ...snapshot });
        },
      );
    },
    async getTaskCycleHistory(
      filter: { taskId?: string; taskInstanceId?: string } = {},
    ): Promise<TaskCycleHistoryEvent[]> {
      if (filter.taskId !== undefined) assertCanonicalTaskId(filter.taskId);
      if (filter.taskInstanceId !== undefined) {
        assertCanonicalIdentifier(filter.taskInstanceId, 'task instance ID');
      }
      return dependencies.runTenantSnapshot(
        dependencies.tenantId,
        async (transaction) => projectTaskCycleHistoryFromSnapshot(
          await readLedgerSnapshot(transaction, dependencies.tenantId, 'ledger'),
          filter,
        ),
      );
    },
    async listTaskHistory(now?: string): Promise<TaskHistoryListDto[]> {
      const projectionNow = projectionTimestamp(now);
      return dependencies.runTenantSnapshot(dependencies.tenantId, async (transaction) => {
        const tasks = await readDatabaseTasks(transaction, dependencies.tenantId, { activeOnly: false });
        const snapshot = await readLedgerSnapshot(transaction, dependencies.tenantId, 'ledger');
        const events = projectTaskCycleHistoryFromSnapshot(snapshot);
        const tasksById = indexTasksById(tasks);
        const taskIds = new Set([...tasksById.keys(), ...events.map((event) => event.taskId)]);
        return Array.from(taskIds).sort().map((taskId) => {
          const task = tasksById.get(taskId) ?? null;
          return buildTaskHistoryListDto({
            taskId,
            currentTaskDefinitionExists: task !== null,
            currentTaskInstanceId: task?.taskInstanceId ?? null,
            currentCycleState: task?.taskInstanceId && task.schedule
              ? projectTaskCycleState({ task, now: projectionNow, ...snapshot })
              : null,
            events: events.filter((event) => event.taskId === taskId),
          });
        });
      });
    },
    async getTaskHistoryDetail(
      filter: { taskId: string; taskInstanceId?: string },
      now?: string,
    ): Promise<TaskHistoryDetailDto> {
      assertCanonicalTaskId(filter.taskId);
      if (filter.taskInstanceId !== undefined) {
        assertCanonicalIdentifier(filter.taskInstanceId, 'task instance ID');
      }
      const projectionNow = projectionTimestamp(now);
      return dependencies.runTenantSnapshot(dependencies.tenantId, async (transaction) => {
        const tasks = await readDatabaseTasks(transaction, dependencies.tenantId, {
          activeOnly: false,
          taskId: filter.taskId,
        });
        if (tasks.length > 1) throw new Error('Task query returned duplicate tasks.');
        const task = tasks[0] ?? null;
        const snapshot = await readLedgerSnapshot(transaction, dependencies.tenantId, 'ledger');
        return buildTaskHistoryDetailDto({
          taskId: filter.taskId,
          requestedTaskInstanceId: filter.taskInstanceId ?? null,
          currentTaskDefinitionExists: task !== null,
          currentTaskInstanceId: task?.taskInstanceId ?? null,
          currentCycleState: task?.taskInstanceId && task.schedule
            ? projectTaskCycleState({ task, now: projectionNow, ...snapshot })
            : null,
          events: projectTaskCycleHistoryFromSnapshot(snapshot, filter),
        });
      });
    },
  };
}

function projectionTimestamp(now: string | undefined): string {
  return now === undefined ? new Date().toISOString() : isoString(now, 'Task history projection timestamp');
}

function indexTasksById(tasks: readonly ClassTask[]): Map<string, ClassTask> {
  const indexed = new Map<string, ClassTask>();
  for (const task of tasks) {
    if (indexed.has(task.taskId)) throw new Error('Task query returned duplicate task IDs.');
    indexed.set(task.taskId, task);
  }
  return indexed;
}

function assertCanonicalTaskId(taskId: string): void {
  assertCanonicalIdentifier(taskId, 'task ID');
}

function assertCanonicalIdentifier(value: string, label: string): void {
  if (!value || value.trim() !== value) throw new Error(`A canonical ${label} is required.`);
}

async function readLedgerSnapshot(
  transaction: TenantTransaction,
  tenantId: string,
  order: 'ledger' | 'presentation',
): Promise<TaskCycleLedgerSnapshot> {
  const result = await transaction.execute(sql`
    SELECT ledger_kind, payload
    FROM (
      SELECT 'assignment'::text AS ledger_kind, event_sequence,
             jsonb_build_object(
               'assignment_id', assignment_id,
               'event_sequence', event_sequence::text,
               'task_id_snapshot', task_id_snapshot,
               'task_instance_id', task_instance_id,
               'cycle_id', cycle_id,
               'cycle_start_at', cycle_start_at,
               'cycle_end_at', cycle_end_at,
               'rule_version', rule_version,
               'timezone', timezone,
               'student_id', student_id,
               'event_type', event_type,
               'source', source,
               'previous_assignment_id', previous_assignment_id,
               'admin_operation_id', admin_operation_id,
               'admin_operation_hash', admin_operation_hash,
               'created_at', created_at,
               'schema_version', schema_version,
               'note', note
             ) AS payload
      FROM task_assignments
      WHERE tenant_id = ${tenantId}

      UNION ALL

      SELECT 'completion'::text AS ledger_kind, event_sequence,
             jsonb_build_object(
               'completion_id', completion_id,
               'event_sequence', event_sequence::text,
               'completed_at', completed_at,
               'task_instance_id', task_instance_id,
               'task_id_snapshot', task_id_snapshot,
               'task_name_snapshot', task_name_snapshot,
               'student_id', student_id,
               'student_name_snapshot', student_name_snapshot,
               'reward_snapshot', reward_snapshot::text,
               'balance_before', balance_before::text,
               'balance_after', balance_after::text,
               'status', status,
               'note', note,
               'cycle_id', cycle_id,
               'cycle_start_at', cycle_start_at,
               'cycle_end_at', cycle_end_at,
               'rule_version', rule_version,
               'timezone', timezone,
               'source', source,
               'assignment_id', assignment_id,
               'operation_id', operation_id,
               'operation_hash', operation_hash,
               'schema_version', schema_version,
               'evidence_provider', evidence_provider,
               'evidence_board_id', evidence_board_id,
               'evidence_post_id', evidence_post_id,
               'evidence_created_at', evidence_created_at,
               'evidence_author_full_name', evidence_author_full_name
             ) AS payload
      FROM task_completions
      WHERE tenant_id = ${tenantId}
    ) AS ledgers
    ORDER BY ledger_kind ASC, event_sequence ASC
  `);
  const assignmentRows: AssignmentRow[] = [];
  const completionRows: CompletionRow[] = [];
  for (const row of result.rows as LedgerRow[]) {
    if (typeof row.payload !== 'object' || row.payload === null || Array.isArray(row.payload)) {
      throw new Error('Task cycle ledger payload is malformed.');
    }
    if (row.ledger_kind === 'assignment') assignmentRows.push(row.payload as AssignmentRow);
    else if (row.ledger_kind === 'completion') completionRows.push(row.payload as CompletionRow);
    else throw new Error('Task cycle ledger kind is unsupported.');
  }

  const assignmentSequences = assertStrictEventSequences(assignmentRows, 'Task assignment');
  const completionSequences = assertStrictEventSequences(completionRows, 'Task completion');
  const assignments = assignmentRows.map(projectAssignment);
  assertAssignmentProvenance(assignments, assignmentSequences);
  const projectedCompletions = completionRows.map((row, index): ProjectedCompletion => ({
    completion: projectCompletion(row),
    eventSequence: completionSequences[index],
  }));
  assertCompletionAssignments(assignments, projectedCompletions.map(({ completion }) => completion));
  if (order === 'presentation') {
    projectedCompletions.sort((left, right) => (
      right.completion.timestamp.localeCompare(left.completion.timestamp)
      || left.eventSequence - right.eventSequence
    ));
  }
  return {
    assignments,
    completions: projectedCompletions.map(({ completion }) => completion),
  };
}

function assertStrictEventSequences(rows: Record<string, unknown>[], label: string): number[] {
  let previous = 0;
  return rows.map((row) => {
    const current = positiveSafeInteger(row.event_sequence, `${label} event sequence`);
    if (current <= previous) throw new Error(`${label} event sequence must be unique and strictly increasing.`);
    previous = current;
    return current;
  });
}

function projectAssignment(row: AssignmentRow): TaskAssignment {
  positiveSafeInteger(row.event_sequence, 'Task assignment event sequence');
  assertSchemaVersion(row.schema_version, 'Task assignment');
  const status = exactValue(row.event_type, ['ASSIGNED', 'UNASSIGNED'] as const, 'Task assignment event');
  const source = exactValue(
    row.source,
    ['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'] as const,
    'Task assignment source',
  );
  if (source === 'ADMIN' || source === 'QR') {
    canonicalRequiredString(row.admin_operation_id, 'Task assignment admin operation ID');
    if (typeof row.admin_operation_hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(row.admin_operation_hash)) {
      throw new Error('Task assignment admin operation hash is invalid.');
    }
  } else if (row.admin_operation_id !== null || row.admin_operation_hash !== null) {
    throw new Error(`${source} task assignment must not have admin operation metadata.`);
  }
  if (row.timezone !== 'Asia/Seoul') throw new Error('Task assignment time zone must be Asia/Seoul.');
  const cycleStartsAt = isoString(row.cycle_start_at, 'Task assignment cycle start');
  const cycleEndsAt = row.cycle_end_at === null
    ? null
    : isoString(row.cycle_end_at, 'Task assignment cycle end');
  if (cycleEndsAt !== null && cycleEndsAt <= cycleStartsAt) {
    throw new Error('Task assignment cycle window is invalid.');
  }
  return {
    assignmentId: canonicalRequiredString(row.assignment_id, 'Task assignment ID'),
    taskId: canonicalRequiredString(row.task_id_snapshot, 'Task assignment task ID'),
    taskInstanceId: canonicalRequiredString(row.task_instance_id, 'Task assignment instance ID'),
    cycleId: canonicalRequiredString(row.cycle_id, 'Task assignment cycle ID'),
    cycleStartsAt,
    cycleEndsAt,
    ruleVersion: positiveSafeInteger(row.rule_version, 'Task assignment rule version'),
    timeZone: 'Asia/Seoul',
    studentId: canonicalRequiredString(row.student_id, 'Task assignment student ID'),
    status,
    source,
    previousAssignmentId: row.previous_assignment_id === null
      ? ''
      : canonicalRequiredString(row.previous_assignment_id, 'Previous task assignment ID'),
    createdAt: isoString(row.created_at, 'Task assignment created timestamp'),
    schemaVersion: 1,
    note: nullableText(row.note, 'Task assignment note'),
  };
}

function assertAssignmentProvenance(assignments: TaskAssignment[], eventSequences: number[]): void {
  const indexed = assignments.map((assignment, index) => ({
    assignment,
    eventSequence: eventSequences[index],
  }));
  const byId = new Map(indexed.map((event) => [event.assignment.assignmentId, event]));
  indexed.forEach(({ assignment, eventSequence }) => {
    if (assignment.source === 'ADMIN' || assignment.source === 'QR') {
      const previous = indexed
        .filter((candidate) => candidate.eventSequence < eventSequence
          && candidate.assignment.taskId === assignment.taskId
          && candidate.assignment.taskInstanceId === assignment.taskInstanceId
          && candidate.assignment.studentId === assignment.studentId
          && candidate.assignment.cycleId === assignment.cycleId
          && candidate.assignment.cycleStartsAt === assignment.cycleStartsAt
          && candidate.assignment.cycleEndsAt === assignment.cycleEndsAt
          && candidate.assignment.ruleVersion === assignment.ruleVersion
          && candidate.assignment.timeZone === assignment.timeZone)
        .sort((left, right) => right.eventSequence - left.eventSequence)[0];
      if (assignment.previousAssignmentId !== (previous?.assignment.assignmentId ?? '')
        || (previous && previous.assignment.createdAt > assignment.createdAt)) {
        throw new Error(`${assignment.source} task assignment provenance is invalid.`);
      }
      return;
    }
    if (assignment.source !== 'CARRY_FORWARD') {
      if (assignment.previousAssignmentId !== '') {
        throw new Error('Non-carry task assignment must not have a previous assignment.');
      }
      return;
    }
    if (assignment.status !== 'ASSIGNED' || assignment.previousAssignmentId === '') {
      throw new Error('Carry-forward task assignment requires an assigned previous assignment.');
    }
    const previous = byId.get(assignment.previousAssignmentId);
    if (!previous
      || previous.eventSequence >= eventSequence
      || previous.assignment.status !== 'ASSIGNED'
      || previous.assignment.studentId !== assignment.studentId
      || previous.assignment.taskId !== assignment.taskId
      || previous.assignment.taskInstanceId !== assignment.taskInstanceId
      || previous.assignment.cycleId === assignment.cycleId
      || previous.assignment.cycleStartsAt >= assignment.cycleStartsAt
      || previous.assignment.cycleEndsAt === null
      || previous.assignment.cycleEndsAt > assignment.cycleStartsAt) {
      throw new Error('Carry-forward task assignment provenance is invalid.');
    }
  });
}

function assertCompletionAssignments(
  assignments: TaskAssignment[],
  completions: TaskCompletion[],
): void {
  const byId = new Map(assignments.map((assignment) => [assignment.assignmentId, assignment]));
  for (const completion of completions) {
    if (completion.source === 'BANK' && !completion.assignmentId) {
      throw new Error('BANK task completion requires an assignment.');
    }
    if (!completion.assignmentId) continue;
    const assignment = byId.get(completion.assignmentId);
    if (!assignment
      || assignment.status !== 'ASSIGNED'
      || assignment.studentId !== completion.studentId
      || assignment.taskId !== completion.taskId
      || assignment.taskInstanceId !== completion.taskInstanceId
      || assignment.cycleId !== completion.cycleId) {
      throw new Error('Task completion assignment provenance is invalid.');
    }
  }
}

function projectCompletion(row: CompletionRow): TaskCompletion {
  positiveSafeInteger(row.event_sequence, 'Task completion event sequence');
  assertSchemaVersion(row.schema_version, 'Task completion');
  const reward = safeInteger(row.reward_snapshot, 'Task completion reward');
  const balanceBefore = safeInteger(row.balance_before, 'Task completion balance before');
  const balanceAfter = safeInteger(row.balance_after, 'Task completion balance after');
  if (reward < 0) throw new Error('Task completion reward must be nonnegative.');
  const storedStatus = canonicalRequiredString(row.status, 'Task completion status');
  const cycleValues = [
    row.task_instance_id, row.cycle_id, row.cycle_start_at,
    row.rule_version, row.timezone, row.source,
  ];
  const hasCycle = cycleValues.every((value) => value !== null);
  if (!hasCycle && cycleValues.some((value) => value !== null)) {
    throw new Error('Task completion cycle metadata must be entirely present or absent.');
  }
  if (!hasCycle && row.cycle_end_at !== null) {
    throw new Error('Task completion cycle end requires cycle metadata.');
  }
  const operationValues = [row.operation_id, row.operation_hash];
  if (operationValues.filter((value) => value !== null).length === 1) {
    throw new Error('Task completion operation ID and hash must be paired.');
  }
  const evidenceValues = [
    row.evidence_provider, row.evidence_board_id, row.evidence_post_id,
    row.evidence_created_at, row.evidence_author_full_name,
  ];
  const evidenceCount = evidenceValues.filter((value) => value !== null).length;
  if (evidenceCount !== 0 && evidenceCount !== evidenceValues.length) {
    throw new Error('Task completion evidence must be entirely present or absent.');
  }
  const completion: TaskCompletion = {
    completionId: canonicalRequiredString(row.completion_id, 'Task completion ID'),
    timestamp: isoString(row.completed_at, 'Task completion timestamp'),
    taskId: canonicalRequiredString(row.task_id_snapshot, 'Task completion task ID'),
    studentId: canonicalRequiredString(row.student_id, 'Task completion student ID'),
    studentName: canonicalRequiredString(row.student_name_snapshot, 'Task completion student name'),
    reward,
    balanceBefore,
    balanceAfter,
    status: storedStatus === 'COMPLETED' ? 'SUCCESS' : storedStatus === 'CANCELLED' ? 'RESET' : storedStatus,
    note: nullableText(row.note, 'Task completion note'),
    schemaVersion: 1,
  };
  if (hasCycle) {
    const source = exactValue(
      row.source,
      ['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'] as const,
      'Task completion source',
    );
    if (row.timezone !== 'Asia/Seoul') throw new Error('Task completion time zone must be Asia/Seoul.');
    const cycleStartsAt = isoString(row.cycle_start_at, 'Task completion cycle start');
    const cycleEndsAt = row.cycle_end_at === null
      ? null
      : isoString(row.cycle_end_at, 'Task completion cycle end');
    if (cycleEndsAt !== null && cycleEndsAt <= cycleStartsAt) {
      throw new Error('Task completion cycle window is invalid.');
    }
    const hasOperation = row.operation_id !== null && row.operation_hash !== null;
    if (source === 'BANK') {
      const expectedBalance = balanceBefore + reward;
      if (storedStatus !== 'COMPLETED'
        || !Number.isSafeInteger(expectedBalance)
        || balanceAfter !== expectedBalance) {
        throw new Error('BANK task completion status or balance shape is invalid.');
      }
      if (!hasOperation
        || typeof row.operation_id !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.operation_id)
        || typeof row.operation_hash !== 'string'
        || !/^[0-9a-f]{64}$/.test(row.operation_hash)) {
        throw new Error('BANK task completion operation metadata is invalid.');
      }
    } else {
      const requiredStatus = source === 'ADMIN_RESET' ? 'CANCELLED' : 'COMPLETED';
      if (storedStatus !== requiredStatus || reward !== 0 || balanceBefore !== balanceAfter) {
        throw new Error(`${source} task completion writer shape is invalid.`);
      }
      if (hasOperation) {
        throw new Error('Task completion operation metadata is only valid for BANK events.');
      }
    }
    completion.taskInstanceId = canonicalRequiredString(row.task_instance_id, 'Task completion instance ID');
    completion.cycleId = canonicalRequiredString(row.cycle_id, 'Task completion cycle ID');
    completion.cycleStartsAt = cycleStartsAt;
    completion.cycleEndsAt = cycleEndsAt;
    completion.ruleVersion = positiveSafeInteger(row.rule_version, 'Task completion rule version');
    completion.timeZone = 'Asia/Seoul';
    completion.source = source;
    completion.assignmentId = row.assignment_id === null
      ? ''
      : canonicalRequiredString(row.assignment_id, 'Task completion assignment ID');
  } else if (row.assignment_id !== null) {
    completion.assignmentId = canonicalRequiredString(row.assignment_id, 'Task completion assignment ID');
  }
  if (row.operation_id !== null && row.operation_hash !== null) {
    if (!hasCycle || completion.source !== 'BANK') {
      throw new Error('Task completion operation metadata requires a BANK cycle event.');
    }
    completion.operationId = canonicalRequiredString(row.operation_id, 'Task completion operation ID');
    completion.operationPayloadHash = canonicalRequiredString(
      row.operation_hash,
      'Task completion operation payload hash',
    );
  }
  if (evidenceCount === evidenceValues.length) {
    if (!hasCycle || completion.source !== 'BANK' || !completion.operationId) {
      throw new Error('Task completion evidence requires a BANK event with operation metadata.');
    }
    if (row.evidence_provider !== 'PADLET') throw new Error('Task completion evidence provider is unsupported.');
    const boardId = canonicalRequiredString(row.evidence_board_id, 'Task completion evidence board ID');
    const postId = canonicalRequiredString(row.evidence_post_id, 'Task completion evidence post ID');
    const author = canonicalRequiredString(row.evidence_author_full_name, 'Task completion evidence author');
    const evidenceCreatedAt = isoString(row.evidence_created_at, 'Task completion evidence timestamp');
    if (!/^[A-Za-z0-9]{16,22}$/.test(boardId)
      || !/^[A-Za-z0-9_-]{3,128}$/.test(postId)
      || author.length > 200) {
      throw new Error('Task completion evidence is malformed.');
    }
    if (author !== completion.studentName
      || evidenceCreatedAt < completion.cycleStartsAt!
      || (completion.cycleEndsAt !== null && evidenceCreatedAt >= completion.cycleEndsAt!)
      || evidenceCreatedAt > completion.timestamp) {
      throw new Error('Task completion evidence provenance is invalid.');
    }
    completion.evidenceProvider = 'PADLET';
    completion.evidenceBoardId = boardId;
    completion.evidencePostId = postId;
    completion.evidenceCreatedAt = evidenceCreatedAt;
    completion.evidenceAuthorFullName = author;
  }
  return completion;
}

function assertSchemaVersion(value: unknown, label: string): void {
  if (safeInteger(value, `${label} schema version`) !== 1) {
    throw new Error(`${label} schema version is unsupported.`);
  }
}

function positiveSafeInteger(value: unknown, label: string): number {
  const result = safeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive.`);
  return result;
}

function canonicalRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${label} must be a canonical nonblank string.`);
  }
  return value;
}

function nullableText(value: unknown, label: string): string {
  if (value === null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text when present.`);
  return value;
}

function exactValue<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
  label: string,
): TValue {
  if (typeof value !== 'string' || !allowed.includes(value as TValue)) {
    throw new Error(`${label} is unsupported.`);
  }
  return value as TValue;
}
