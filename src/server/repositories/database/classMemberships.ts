import 'server-only';

import { getDatabaseClient } from '@/server/db/client';
import { parseTenantSlug, type TenantLifecycle } from '@/server/tenantContext';
import type { TenantMembershipRole } from '@/server/tenantAuth';

export type ClassMembership = Readonly<{
  slug: string;
  displayName: string;
  role: TenantMembershipRole;
  lifecycle: TenantLifecycle;
}>;

export type ClassMembershipRepository = Readonly<{
  listByGoogleSubject(googleSubject: string): Promise<ClassMembership[]>;
}>;

type QueryResult = Readonly<{ rows: unknown[] }>;
type Queryable = Readonly<{
  query(text: string, values?: unknown[]): Promise<QueryResult>;
}>;

type ClassMembershipRow = Readonly<{
  slug: unknown;
  display_name: unknown;
  role: unknown;
  lifecycle: unknown;
}>;

const roles = new Set<TenantMembershipRole>(['OWNER', 'ADMIN']);
const lifecycles = new Set<TenantLifecycle>([
  'DRAFT',
  'IMPORTING',
  'READY',
  'ACTIVE',
  'MIGRATION_READ_ONLY',
  'SUSPENDED',
]);

export function createClassMembershipRepository(queryable: Queryable): ClassMembershipRepository {
  return {
    async listByGoogleSubject(googleSubject) {
      const result = await queryable.query(
        'SELECT * FROM public.platform_list_memberships_by_google_subject($1)',
        [googleSubject],
      );
      return result.rows.map(projectMembership);
    },
  };
}

export function getProductionClassMembershipRepository(): ClassMembershipRepository {
  return createClassMembershipRepository({
    query: (text, values) => getDatabaseClient().pool.query(text, values),
  });
}

function projectMembership(value: unknown): ClassMembership {
  if (!isRecord(value)) throw new Error('Class membership row is invalid.');
  const row = value as ClassMembershipRow;
  const parsedSlug = parseTenantSlug(row.slug);
  if (parsedSlug.needsRedirect
    || typeof row.display_name !== 'string'
    || !row.display_name.trim()
    || !roles.has(row.role as TenantMembershipRole)
    || !lifecycles.has(row.lifecycle as TenantLifecycle)) {
    throw new Error('Class membership row is invalid.');
  }
  return {
    slug: parsedSlug.slug,
    displayName: row.display_name.trim(),
    role: row.role as TenantMembershipRole,
    lifecycle: row.lifecycle as TenantLifecycle,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
