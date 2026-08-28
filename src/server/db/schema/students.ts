import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { tenants } from './tenants';

export const studentStatuses = ['ACTIVE', 'INACTIVE'] as const;

export const students = pgTable('students', {
  tenantId: uuid('tenant_id').notNull(),
  studentId: text('student_id').notNull(),
  name: text('name').notNull(),
  status: text('status').$type<(typeof studentStatuses)[number]>().default('ACTIVE').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'students_pkey', columns: [table.tenantId, table.studentId] }),
  foreignKey({ name: 'students_tenant_fk', columns: [table.tenantId], foreignColumns: [tenants.id] }).onDelete('cascade'),
  check('students_id_check', sql`${table.studentId} = btrim(${table.studentId}) AND length(${table.studentId}) > 0`),
  check('students_name_check', sql`length(btrim(${table.name})) > 0`),
  check('students_status_check', sql`${table.status} IN ('ACTIVE', 'INACTIVE')`),
  index('students_active_name_idx').on(table.tenantId, table.name)
    .where(sql`${table.status} = 'ACTIVE'`),
]);

export const accounts = pgTable('accounts', {
  tenantId: uuid('tenant_id').notNull(),
  studentId: text('student_id').notNull(),
  balance: bigint('balance', { mode: 'bigint' }).default(sql`0`).notNull(),
  version: bigint('version', { mode: 'bigint' }).default(sql`1`).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'accounts_pkey', columns: [table.tenantId, table.studentId] }),
  foreignKey({
    name: 'accounts_student_fk',
    columns: [table.tenantId, table.studentId],
    foreignColumns: [students.tenantId, students.studentId],
  }),
  check('accounts_balance_safe_check', sql`${table.balance} BETWEEN -9007199254740991 AND 9007199254740991`),
  check('accounts_version_check', sql`${table.version} >= 1 AND ${table.version} <= 9007199254740991`),
]);
