import { sql } from 'drizzle-orm';
import {
  bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import { students } from './students';
import { tenants } from './tenants';
import { operations } from './operations';

export const taskAssignmentEvents = ['ASSIGNED', 'UNASSIGNED'] as const;
export const taskAssignmentSources = ['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'] as const;

export type TaskScheduleSnapshot = {
  ruleVersion: number;
  effectiveFrom: string;
  timeZone: 'Asia/Seoul';
  recurrence: Record<string, unknown>;
  resetCompletionOnCycle: boolean;
  resetAssignmentOnCycle: boolean;
  [key: string]: unknown;
};

export const tasks = pgTable('tasks', {
  tenantId: uuid('tenant_id').notNull(),
  taskInstanceId: text('task_instance_id').notNull(),
  taskId: text('task_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  reward: bigint('reward', { mode: 'bigint' }).default(sql`0`).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  sortOrder: integer('sort_order').default(0).notNull(),
  availableFrom: timestamp('available_from', { withTimezone: true }),
  availableUntil: timestamp('available_until', { withTimezone: true }),
  dueAt: timestamp('due_at', { withTimezone: true }),
  prerequisiteTaskInstanceId: text('prerequisite_task_instance_id'),
  padletBoardId: text('padlet_board_id'),
  currentSchedule: jsonb('current_schedule').$type<TaskScheduleSnapshot>().notNull(),
  pendingSchedule: jsonb('pending_schedule').$type<TaskScheduleSnapshot>(),
  scheduleSchemaVersion: integer('schedule_schema_version').default(1).notNull(),
  version: bigint('version', { mode: 'bigint' }).default(sql`1`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'tasks_pkey', columns: [table.tenantId, table.taskInstanceId] }),
  foreignKey({ name: 'tasks_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  foreignKey({
    name: 'tasks_prerequisite_fk',
    columns: [table.tenantId, table.prerequisiteTaskInstanceId],
    foreignColumns: [table.tenantId, table.taskInstanceId],
  }),
  uniqueIndex('tasks_active_business_id_unique').on(table.tenantId, table.taskId)
    .where(sql`${table.deletedAt} IS NULL`),
  index('tasks_active_sort_idx').on(table.tenantId, table.sortOrder, table.taskId)
    .where(sql`${table.isActive} AND ${table.deletedAt} IS NULL`),
  check('tasks_id_check', sql`${table.taskId} = btrim(${table.taskId}) AND length(${table.taskId}) > 0`),
  check('tasks_instance_id_check', sql`${table.taskInstanceId} = btrim(${table.taskInstanceId}) AND length(${table.taskInstanceId}) > 0`),
  check('tasks_title_check', sql`length(btrim(${table.title})) > 0`),
  check('tasks_reward_safe_check', sql`${table.reward} BETWEEN 0 AND 9007199254740991`),
  check('tasks_availability_check', sql`${table.availableUntil} IS NULL OR ${table.availableFrom} IS NULL OR ${table.availableUntil} > ${table.availableFrom}`),
  check('tasks_schedule_schema_version_check', sql`${table.scheduleSchemaVersion} >= 1`),
  check('tasks_version_check', sql`${table.version} BETWEEN 1 AND 9007199254740991`),
  check('tasks_current_schedule_check', sql`COALESCE((jsonb_typeof(${table.currentSchedule}) = 'object' AND jsonb_typeof(${table.currentSchedule} -> 'ruleVersion') = 'number' AND (${table.currentSchedule} ->> 'ruleVersion') ~ '^[1-9][0-9]*$' AND (${table.currentSchedule} ->> 'ruleVersion')::numeric BETWEEN 1 AND 9007199254740991 AND jsonb_typeof(${table.currentSchedule} -> 'effectiveFrom') = 'string' AND ${table.currentSchedule} ->> 'timeZone' = 'Asia/Seoul' AND jsonb_typeof(${table.currentSchedule} -> 'recurrence') = 'object' AND jsonb_typeof(${table.currentSchedule} -> 'resetCompletionOnCycle') = 'boolean' AND jsonb_typeof(${table.currentSchedule} -> 'resetAssignmentOnCycle') = 'boolean'), false)`),
  check('tasks_pending_schedule_check', sql`${table.pendingSchedule} IS NULL OR COALESCE((jsonb_typeof(${table.pendingSchedule}) = 'object' AND jsonb_typeof(${table.pendingSchedule} -> 'ruleVersion') = 'number' AND (${table.pendingSchedule} ->> 'ruleVersion') ~ '^[1-9][0-9]*$' AND (${table.pendingSchedule} ->> 'ruleVersion')::numeric BETWEEN 1 AND 9007199254740991 AND jsonb_typeof(${table.pendingSchedule} -> 'effectiveFrom') = 'string' AND ${table.pendingSchedule} ->> 'timeZone' = 'Asia/Seoul' AND jsonb_typeof(${table.pendingSchedule} -> 'recurrence') = 'object' AND jsonb_typeof(${table.pendingSchedule} -> 'resetCompletionOnCycle') = 'boolean' AND jsonb_typeof(${table.pendingSchedule} -> 'resetAssignmentOnCycle') = 'boolean'), false)`),
  check('tasks_not_self_prerequisite_check', sql`${table.prerequisiteTaskInstanceId} IS NULL OR ${table.prerequisiteTaskInstanceId} <> ${table.taskInstanceId}`),
  check('tasks_updated_chronology_check', sql`${table.updatedAt} >= ${table.createdAt}`),
  check('tasks_deleted_chronology_check', sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.updatedAt}`),
  check('tasks_deleted_status_check', sql`${table.deletedAt} IS NULL OR NOT ${table.isActive}`),
]);

export const taskAllowedStudents = pgTable('task_allowed_students', {
  tenantId: uuid('tenant_id').notNull(),
  taskInstanceId: text('task_instance_id').notNull(),
  studentId: text('student_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'task_allowed_students_pkey', columns: [table.tenantId, table.taskInstanceId, table.studentId] }),
  foreignKey({
    name: 'task_allowed_students_task_fk', columns: [table.tenantId, table.taskInstanceId],
    foreignColumns: [tasks.tenantId, tasks.taskInstanceId],
  }),
  foreignKey({
    name: 'task_allowed_students_student_fk', columns: [table.tenantId, table.studentId],
    foreignColumns: [students.tenantId, students.studentId],
  }),
]);

export const taskAssignments = pgTable('task_assignments', {
  tenantId: uuid('tenant_id').notNull(),
  assignmentId: text('assignment_id').notNull(),
  eventSequence: bigint('event_sequence', { mode: 'bigint' }).generatedByDefaultAsIdentity().notNull(),
  taskIdSnapshot: text('task_id_snapshot').notNull(),
  taskInstanceId: text('task_instance_id').notNull(),
  cycleId: text('cycle_id').notNull(),
  cycleStartAt: timestamp('cycle_start_at', { withTimezone: true }).notNull(),
  cycleEndAt: timestamp('cycle_end_at', { withTimezone: true }),
  ruleVersion: integer('rule_version').notNull(),
  timezone: text('timezone').notNull(),
  studentId: text('student_id').notNull(),
  eventType: text('event_type').$type<(typeof taskAssignmentEvents)[number]>().notNull(),
  source: text('source').$type<(typeof taskAssignmentSources)[number]>().notNull(),
  previousAssignmentId: text('previous_assignment_id'),
  adminOperationId: text('admin_operation_id'),
  adminOperationHash: text('admin_operation_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  schemaVersion: integer('schema_version').default(1).notNull(),
  note: text('note'),
}, (table) => [
  primaryKey({ name: 'task_assignments_pkey', columns: [table.tenantId, table.assignmentId] }),
  unique('task_assignments_event_sequence_unique').on(table.tenantId, table.eventSequence),
  foreignKey({ name: 'task_assignments_task_fk', columns: [table.tenantId, table.taskInstanceId], foreignColumns: [tasks.tenantId, tasks.taskInstanceId] }),
  foreignKey({ name: 'task_assignments_student_fk', columns: [table.tenantId, table.studentId], foreignColumns: [students.tenantId, students.studentId] }),
  foreignKey({ name: 'task_assignments_previous_fk', columns: [table.tenantId, table.previousAssignmentId], foreignColumns: [table.tenantId, table.assignmentId] }),
  foreignKey({ name: 'task_assignments_admin_operation_fk', columns: [table.tenantId, table.adminOperationId], foreignColumns: [operations.tenantId, operations.operationId] }),
  index('task_assignments_cycle_student_event_idx').on(table.tenantId, table.taskInstanceId, table.cycleId, table.studentId, table.eventSequence),
  check('task_assignments_id_check', sql`${table.assignmentId} = btrim(${table.assignmentId}) AND length(${table.assignmentId}) > 0`),
  check('task_assignments_task_id_snapshot_check', sql`${table.taskIdSnapshot} = btrim(${table.taskIdSnapshot}) AND length(${table.taskIdSnapshot}) > 0`),
  check('task_assignments_previous_id_check', sql`${table.previousAssignmentId} IS NULL OR (${table.previousAssignmentId} = btrim(${table.previousAssignmentId}) AND length(${table.previousAssignmentId}) > 0)`),
  check('task_assignments_not_self_previous_check', sql`${table.previousAssignmentId} IS NULL OR ${table.previousAssignmentId} <> ${table.assignmentId}`),
  check('task_assignments_cycle_check', sql`${table.cycleEndAt} IS NULL OR ${table.cycleEndAt} > ${table.cycleStartAt}`),
  check('task_assignments_rule_version_check', sql`${table.ruleVersion} >= 1`),
  check('task_assignments_timezone_check', sql`${table.timezone} = 'Asia/Seoul'`),
  check('task_assignments_event_type_check', sql`${table.eventType} IN ('ASSIGNED', 'UNASSIGNED')`),
  check('task_assignments_source_check', sql`${table.source} IN ('ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD')`),
  check('task_assignments_admin_operation_pair_check', sql`(${table.adminOperationId} IS NULL) = (${table.adminOperationHash} IS NULL)`),
  check('task_assignments_admin_operation_id_check', sql`${table.adminOperationId} IS NULL OR (${table.adminOperationId} = btrim(${table.adminOperationId}) AND length(${table.adminOperationId}) > 0)`),
  check('task_assignments_admin_operation_hash_check', sql`${table.adminOperationHash} IS NULL OR ${table.adminOperationHash} ~ '^[0-9a-f]{64}$'`),
  check('task_assignments_schema_version_check', sql`${table.schemaVersion} >= 1`),
]);
