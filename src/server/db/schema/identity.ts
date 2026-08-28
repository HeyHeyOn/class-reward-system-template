import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  googleSubject: text('google_subject').notNull(),
  canonicalEmail: text('canonical_email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('users_google_subject_unique').on(table.googleSubject),
  unique('users_canonical_email_unique').on(table.canonicalEmail),
  check(
    'users_google_subject_canonical_check',
    sql`${table.googleSubject} = btrim(${table.googleSubject}) AND length(${table.googleSubject}) > 0`,
  ),
  check(
    'users_canonical_email_check',
    sql`${table.canonicalEmail} = lower(btrim(${table.canonicalEmail})) AND length(${table.canonicalEmail}) > 0`,
  ),
]);
