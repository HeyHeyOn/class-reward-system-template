import 'server-only';

import { getDatabaseClient } from '@/server/db/client';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import type {
  TenantAdminContextDependencies,
  TenantMembership,
  TenantMembershipRole,
} from '@/server/tenantAuth';
import type { TenantLifecycle, TenantRecord } from '@/server/tenantContext';

type QueryResult = Readonly<{ rows: unknown[] }>;
type Queryable = Readonly<{
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}>;

type TenantRow = Readonly<{
  id: unknown;
  slug: unknown;
  display_name: unknown;
  lifecycle: unknown;
  timezone: unknown;
}>;

type MembershipRow = Readonly<{
  id: unknown;
  tenant_id: unknown;
  user_id: unknown;
  google_subject: unknown;
  role: unknown;
}>;

const tenantLifecycles = new Set<TenantLifecycle>([
  'DRAFT',
  'IMPORTING',
  'READY',
  'ACTIVE',
  'MIGRATION_READ_ONLY',
  'SUSPENDED',
]);
const membershipRoles = new Set<TenantMembershipRole>(['OWNER', 'ADMIN']);

export function createTenantAccessDependencies(
  queryable: Queryable,
  getSession: TenantAdminContextDependencies['getSession'],
): TenantAdminContextDependencies {
  return {
    async findBySlug(slug) {
      const result = await queryable.query(
        'SELECT * FROM public.platform_find_tenant_by_slug($1)',
        [slug],
      );
      return projectTenant(result.rows[0]);
    },
    async findByTenantAndSubject(tenantId, googleSubject) {
      const result = await queryable.query(
        'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)',
        [tenantId, googleSubject],
      );
      return projectMembership(result.rows[0]);
    },
    getSession,
  };
}

export function getProductionTenantAccessDependencies(): TenantAdminContextDependencies {
  return createTenantAccessDependencies(
    { query: (text, values) => getDatabaseClient().pool.query(text, values) },
    getGoogleSessionFromRequest,
  );
}

function projectTenant(value: unknown): TenantRecord | null {
  if (!isRecord(value)) return null;
  const row = value as TenantRow;
  if (typeof row.id !== 'string'
    || typeof row.slug !== 'string'
    || typeof row.display_name !== 'string'
    || !tenantLifecycles.has(row.lifecycle as TenantLifecycle)
    || row.timezone !== 'Asia/Seoul') {
    return null;
  }
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    lifecycle: row.lifecycle as TenantLifecycle,
    timezone: 'Asia/Seoul',
  };
}

function projectMembership(value: unknown): TenantMembership | null {
  if (!isRecord(value)) return null;
  const row = value as MembershipRow;
  if (typeof row.id !== 'string'
    || typeof row.tenant_id !== 'string'
    || typeof row.user_id !== 'string'
    || typeof row.google_subject !== 'string'
    || !membershipRoles.has(row.role as TenantMembershipRole)) {
    return null;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    googleSubject: row.google_subject,
    role: row.role as TenantMembershipRole,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
