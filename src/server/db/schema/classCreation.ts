import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity';
import { tenants } from './tenants';

// No runtime table privileges/policy: only the exact migration-owned function.
export const classCreationOperations = pgTable('class_creation_operations', {
  operationId: uuid('operation_id').primaryKey(),
  tenantId: uuid('tenant_id').notNull().unique().references(() => tenants.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, table => [
  check('class_creation_operations_display_name_check', sql`length(${table.displayName}) BETWEEN 1 AND 80 AND ${table.displayName} = btrim(${table.displayName})`),
]).enableRLS();
