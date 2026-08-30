import 'server-only';

import { sql } from 'drizzle-orm';
import { validateTaskSchedule } from '@/domain/taskSchedule';
import type { ClassTask, TaskSchedule } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  compareTasksLikeSheets,
  isoString,
  nullableIsoString,
  safeInteger,
} from '@/server/repositories/database/queryProjection';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseTaskQueryDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
}>;

type TaskRow = {
  task_instance_id: unknown;
  task_id: unknown;
  title: unknown;
  description: unknown;
  reward: unknown;
  is_active: unknown;
  sort_order: unknown;
  available_from: unknown;
  due_at: unknown;
  prerequisite_task_id: unknown;
  padlet_board_id: unknown;
  current_schedule: unknown;
  pending_schedule: unknown;
  schedule_schema_version: unknown;
  created_at: unknown;
  allowed_student_id: unknown;
};

export type DatabaseTaskReadOptions = Readonly<{
  activeOnly: boolean;
  taskId?: string;
}>;

export async function readDatabaseTasks(
  transaction: TenantTransaction,
  tenantId: string,
  options: DatabaseTaskReadOptions,
): Promise<ClassTask[]> {
  const result = await transaction.execute(sql`
    SELECT t.task_instance_id, t.task_id, t.title, t.description,
           t.reward::text AS reward, t.is_active, t.sort_order,
           t.available_from, t.due_at, prerequisite.task_id AS prerequisite_task_id,
           t.padlet_board_id, t.current_schedule, t.pending_schedule,
           t.schedule_schema_version, t.created_at,
           allowed.student_id AS allowed_student_id
    FROM tasks t
    LEFT JOIN tasks prerequisite
      ON prerequisite.tenant_id = ${tenantId}
     AND prerequisite.task_instance_id = t.prerequisite_task_instance_id
    LEFT JOIN task_allowed_students allowed
      ON allowed.tenant_id = ${tenantId}
     AND allowed.task_instance_id = t.task_instance_id
    WHERE t.tenant_id = ${tenantId}
      AND t.deleted_at IS NULL
      AND (${options.activeOnly} = false OR t.is_active = true)
      AND (${options.taskId ?? null}::text IS NULL OR t.task_id = ${options.taskId ?? null})
    ORDER BY t.created_at, t.task_id, allowed.created_at, allowed.student_id
  `);
  return projectTasks(result.rows as TaskRow[]);
}

export function createDatabaseTaskQueries(dependencies: DatabaseTaskQueryDependencies) {
  const readTasks = async (options: { activeOnly: boolean; taskId?: string }): Promise<ClassTask[]> =>
    dependencies.runTenantTransaction(
      dependencies.tenantId,
      (transaction) => readDatabaseTasks(transaction, dependencies.tenantId, options),
    );

  return {
    getTasks(): Promise<ClassTask[]> {
      return readTasks({ activeOnly: false });
    },

    getActiveTasks(): Promise<ClassTask[]> {
      return readTasks({ activeOnly: true });
    },

    async getTaskById(taskId: string): Promise<ClassTask | null> {
      assertCanonicalTaskId(taskId);
      const tasks = await readTasks({ activeOnly: false, taskId });
      if (tasks.length > 1) throw new Error('Task query returned duplicate tasks.');
      return tasks[0] ?? null;
    },
  };
}

function projectTasks(rows: TaskRow[]): ClassTask[] {
  const projected = new Map<string, { task: ClassTask; allowedStudentIds: Set<string> }>();
  for (const row of rows) {
    const taskInstanceId = requiredTrimmedString(row.task_instance_id, 'Task instance ID');
    const existing = projected.get(taskInstanceId);
    const entry = existing ?? {
      task: toTask(row, taskInstanceId),
      allowedStudentIds: new Set<string>(),
    };
    if (row.allowed_student_id !== null && row.allowed_student_id !== undefined) {
      entry.allowedStudentIds.add(requiredTrimmedString(row.allowed_student_id, 'Allowed student ID'));
    }
    projected.set(taskInstanceId, entry);
  }
  return [...projected.values()]
    .map(({ task, allowedStudentIds }) => ({ ...task, allowedStudentIds: [...allowedStudentIds] }))
    .sort(compareTasksLikeSheets);
}

function toTask(row: TaskRow, taskInstanceId: string): ClassTask {
  if (typeof row.is_active !== 'boolean') throw new Error('Task active state must be boolean.');
  if (safeInteger(row.schedule_schema_version, 'Task schedule schema version') !== 1) {
    throw new Error('Task schedule schema version is unsupported.');
  }
  const padletBoardId = optionalTrimmedString(row.padlet_board_id, 'Task Padlet board ID');
  if (padletBoardId && !/^[A-Za-z0-9]{16,22}$/.test(padletBoardId)) {
    throw new Error('Task Padlet board ID is malformed.');
  }
  return {
    taskId: requiredTrimmedString(row.task_id, 'Task ID'),
    title: requiredTrimmedString(row.title, 'Task title'),
    description: stringValue(row.description, 'Task description').trim(),
    reward: safeInteger(row.reward, 'Task reward'),
    isActive: row.is_active,
    sortOrder: safeInteger(row.sort_order, 'Task sort order'),
    allowedStudentIds: [],
    ...(nullableIsoString(row.available_from, 'Task available-from timestamp')
      ? { availableFrom: nullableIsoString(row.available_from, 'Task available-from timestamp') }
      : {}),
    ...(nullableIsoString(row.due_at, 'Task due timestamp')
      ? { dueAt: nullableIsoString(row.due_at, 'Task due timestamp') }
      : {}),
    ...(optionalTrimmedString(row.prerequisite_task_id, 'Prerequisite task ID')
      ? { prerequisiteTaskId: optionalTrimmedString(row.prerequisite_task_id, 'Prerequisite task ID') }
      : {}),
    createdAt: isoString(row.created_at, 'Task created timestamp'),
    taskInstanceId,
    schedule: projectSchedule(row.current_schedule, 'current'),
    pendingSchedule: row.pending_schedule === null || row.pending_schedule === undefined
      ? null
      : projectSchedule(row.pending_schedule, 'pending'),
  };
}

function projectSchedule(value: unknown, label: string): TaskSchedule {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Task ${label} schedule must be an object.`);
  }
  const source = value as Record<string, unknown>;
  if (source.timeZone !== 'Asia/Seoul') {
    throw new Error(`Task ${label} schedule time zone must be Asia/Seoul.`);
  }
  const ruleVersion = safeInteger(source.ruleVersion, `Task ${label} schedule rule version`);
  if (ruleVersion < 1) throw new Error(`Task ${label} schedule rule version must be positive.`);
  return validateTaskSchedule({
    ruleVersion,
    effectiveFrom: source.effectiveFrom,
    timeZone: source.timeZone,
    recurrence: source.recurrence,
    resetCompletionOnCycle: source.resetCompletionOnCycle,
    resetAssignmentOnCycle: source.resetAssignmentOnCycle,
  });
}

function assertCanonicalTaskId(taskId: string): void {
  if (!taskId || taskId.trim() !== taskId) {
    throw new Error('A canonical task ID is required.');
  }
}

function requiredTrimmedString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonblank string.`);
  return value.trim();
}

function optionalTrimmedString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string when present.`);
  return value.trim() || undefined;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}
