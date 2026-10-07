import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

/** Derived, rebuildable raw event prefixes; runtime has SELECT only. */
export const taskLedgerCheckpoints = pgTable('task_ledger_checkpoints', {
  tenantId: uuid('tenant_id').notNull(),
  taskInstanceId: text('task_instance_id').notNull(),
  studentId: text('student_id').notNull(),
  eventTable: text('event_table').notNull(),
  eventId: text('event_id').notNull(),
  eventAt: timestamp('event_at', { withTimezone: true }).notNull(),
  eventKind: smallint('event_kind').notNull(),
  eventSequence: bigint('event_sequence', { mode: 'bigint' }).notNull(),
  eventSource: text('event_source'),
  stage: text('stage').notNull(),
  since: timestamp('since', { withTimezone: true }),
  beforeCompletion: text('before_completion').notNull(),
  beforeCompletionSince: timestamp('before_completion_since', { withTimezone: true }),
  lastCompletionAt: timestamp('last_completion_at', { withTimezone: true }),
  latestAssignmentId: text('latest_assignment_id'),
  latestCompletionId: text('latest_completion_id'),
  completionCount: bigint('completion_count', { mode: 'bigint' }).notNull(),
}, table => [
  primaryKey({ name: 'task_ledger_checkpoints_pkey', columns: [table.tenantId, table.eventTable, table.eventId] }),
  foreignKey({ name: 'task_ledger_checkpoints_tenant_id_fkey', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  index('task_ledger_checkpoints_pair_order_idx').on(table.tenantId, table.taskInstanceId, table.studentId,
    table.eventAt.desc(), table.eventKind.desc(), table.eventSequence.desc()),
  check('task_ledger_checkpoints_event_table_check', sql`${table.eventTable} IN ('A','C')`),
  check('task_ledger_checkpoints_event_kind_check', sql`${table.eventKind} BETWEEN 0 AND 2`),
  check('task_ledger_checkpoints_stage_check', sql`${table.stage} IN ('UNASSIGNED','PENDING','READY','COMPLETED')`),
  check('task_ledger_checkpoints_before_completion_check', sql`${table.beforeCompletion} IN ('UNASSIGNED','PENDING','READY','COMPLETED')`),
  check('task_ledger_checkpoints_completion_count_check', sql`${table.completionCount} >= 0`),
]);
