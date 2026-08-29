import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity';

export const tenantLifecycles = [
  'DRAFT',
  'IMPORTING',
  'READY',
  'ACTIVE',
  'MIGRATION_READ_ONLY',
  'SUSPENDED',
] as const;

export const tenantMembershipRoles = ['OWNER', 'ADMIN'] as const;
export const tenantAuthSecretKinds = ['ADMIN_PASSWORD', 'RECOVERY_CODE'] as const;

export const tenants = pgTable('tenants', {
  id: uuid('id').defaultRandom().primaryKey(),
  slug: text('slug').notNull(),
  displayName: text('display_name').notNull(),
  lifecycle: text('lifecycle').$type<(typeof tenantLifecycles)[number]>().default('DRAFT').notNull(),
  timezone: text('timezone').default('Asia/Seoul').notNull(),
  credentialVersion: integer('credential_version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('tenants_slug_unique').on(table.slug),
  check('tenants_slug_canonical_check', sql`${table.slug} ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'`),
  check('tenants_display_name_check', sql`length(btrim(${table.displayName})) > 0`),
  check('tenants_lifecycle_check', sql`${table.lifecycle} IN (${sql.join(tenantLifecycles.map((value) => sql`${value}`), sql`, `)})`),
  check('tenants_timezone_check', sql`${table.timezone} = 'Asia/Seoul'`),
  check('tenants_credential_version_check', sql`${table.credentialVersion} >= 1`),
]);

export const tenantMemberships = pgTable('tenant_memberships', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').defaultRandom().notNull(),
  userId: uuid('user_id').notNull(),
  role: text('role').$type<(typeof tenantMembershipRoles)[number]>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'tenant_memberships_pkey', columns: [table.tenantId, table.id] }),
  foreignKey({
    name: 'tenant_memberships_tenant_fk',
    columns: [table.tenantId],
    foreignColumns: [tenants.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'tenant_memberships_user_fk',
    columns: [table.userId],
    foreignColumns: [users.id],
  }).onDelete('cascade'),
  unique('tenant_memberships_tenant_user_unique').on(table.tenantId, table.userId),
  unique('tenant_memberships_binding_unique').on(table.tenantId, table.id, table.userId),
  check('tenant_memberships_role_check', sql`${table.role} IN ('OWNER', 'ADMIN')`),
]);

export const tenantAuthSecrets = pgTable('tenant_auth_secrets', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').defaultRandom().notNull(),
  kind: text('kind').$type<(typeof tenantAuthSecretKinds)[number]>().notNull(),
  secretHash: text('secret_hash').notNull(),
  hashAlgorithm: text('hash_algorithm').notNull(),
  version: integer('version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'tenant_auth_secrets_pkey', columns: [table.tenantId, table.id] }),
  foreignKey({
    name: 'tenant_auth_secrets_tenant_fk',
    columns: [table.tenantId],
    foreignColumns: [tenants.id],
  }).onDelete('cascade'),
  unique('tenant_auth_secrets_kind_version_unique').on(table.tenantId, table.kind, table.version),
  check('tenant_auth_secrets_kind_check', sql`${table.kind} IN ('ADMIN_PASSWORD', 'RECOVERY_CODE')`),
  check('tenant_auth_secrets_hash_check', sql`length(btrim(${table.secretHash})) > 0`),
  check('tenant_auth_secrets_algorithm_check', sql`length(btrim(${table.hashAlgorithm})) > 0`),
  check('tenant_auth_secrets_version_check', sql`${table.version} >= 1`),
  check(
    'tenant_auth_secrets_revocation_chronology_check',
    sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
  ),
]);

export const tenantSessions = pgTable('tenant_sessions', {
  tenantId: uuid('tenant_id').notNull(),
  id: uuid('id').defaultRandom().notNull(),
  membershipId: uuid('membership_id').notNull(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  credentialVersion: integer('credential_version').notNull(),
  sessionVersion: integer('session_version').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  primaryKey({ name: 'tenant_sessions_pkey', columns: [table.tenantId, table.id] }),
  foreignKey({
    name: 'tenant_sessions_tenant_fk',
    columns: [table.tenantId],
    foreignColumns: [tenants.id],
  }).onDelete('cascade'),
  foreignKey({
    name: 'tenant_sessions_membership_fk',
    columns: [table.tenantId, table.membershipId, table.userId],
    foreignColumns: [tenantMemberships.tenantId, tenantMemberships.id, tenantMemberships.userId],
  }).onDelete('cascade'),
  unique('tenant_sessions_token_hash_unique').on(table.tokenHash),
  check('tenant_sessions_token_hash_check', sql`length(btrim(${table.tokenHash})) > 0`),
  check('tenant_sessions_credential_version_check', sql`${table.credentialVersion} >= 1`),
  check('tenant_sessions_session_version_check', sql`${table.sessionVersion} >= 1`),
  check('tenant_sessions_expiry_check', sql`${table.expiresAt} > ${table.createdAt}`),
  check(
    'tenant_sessions_revocation_chronology_check',
    sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
  ),
]);

export const tenantSettings = pgTable('tenant_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  schemaVersion: integer('schema_version').default(1).notNull(),
  version: bigint('version', { mode: 'bigint' }).default(sql`1`).notNull(),
  settings: jsonb('settings').$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    name: 'tenant_settings_tenant_fk',
    columns: [table.tenantId],
    foreignColumns: [tenants.id],
  }).onDelete('cascade'),
  check('tenant_settings_schema_version_check', sql`${table.schemaVersion} >= 1`),
  check('tenant_settings_version_check', sql`${table.version} BETWEEN 1 AND 9007199254740991`),
  check('tenant_settings_object_check', sql`jsonb_typeof(${table.settings}) = 'object'`),
]);

export const tenantSettingExtras = pgTable('tenant_setting_extras', {
  tenantId: uuid('tenant_id').notNull(),
  settingKey: text('setting_key').notNull(),
  settingValue: jsonb('setting_value').$type<unknown>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ name: 'tenant_setting_extras_pkey', columns: [table.tenantId, table.settingKey] }),
  foreignKey({
    name: 'tenant_setting_extras_tenant_fk',
    columns: [table.tenantId],
    foreignColumns: [tenants.id],
  }).onDelete('cascade'),
  check(
    'tenant_setting_extras_key_canonical_check',
    sql`${table.settingKey} = btrim(${table.settingKey}) AND length(${table.settingKey}) > 0`,
  ),
]);
