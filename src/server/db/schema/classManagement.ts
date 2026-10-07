import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { tenants } from './tenants';
export const classManagementOperations = pgTable('class_management_operations', {
  operationId: uuid('operation_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  action: text('action').notNull(), payload: jsonb('payload').notNull(), result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [check('class_management_operations_action_check', sql`${table.action} IN ('RENAME','DUPLICATE','DELETE','RESTORE')`)]).enableRLS();
