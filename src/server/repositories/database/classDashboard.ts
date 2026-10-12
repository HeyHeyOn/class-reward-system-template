import 'server-only';
import { getDatabaseClient } from '@/server/db/client';
import { parseTenantSlug, type TenantLifecycle } from '@/server/tenantContext';
import type { ClassMembershipRepository } from './classMemberships';
import type { TeacherSessionBinding } from '@/server/teacherSession';
import { currentLegalRevision } from '@/lib/legalDocuments';

/** PURGE erases a class in the trash for good (every row of it), unlike DELETE (the trash). */
export type ClassManagementAction = 'RENAME' | 'DUPLICATE' | 'DELETE' | 'RESTORE' | 'PURGE';
export type ClassManagementInput = TeacherSessionBinding & Readonly<{
  operationId: string; slug: string; subject: string; action: ClassManagementAction;
  name: string; expectedVersion: string;
}>;
export type ClassManagementResult = Readonly<{
  slug: string; displayName: string; lifecycle: TenantLifecycle;
  managementVersion: string; action: ClassManagementAction; replayed: boolean;
}>;
export type ClassManagementCommand = Readonly<{ execute(input: ClassManagementInput): Promise<ClassManagementResult> }>;
type Queryable = { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
const states = ['DRAFT', 'IMPORTING', 'READY', 'ACTIVE', 'MIGRATION_READ_ONLY', 'SUSPENDED'];
const version = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
function instant(value: unknown) {
  if (!(typeof value === 'string' || value instanceof Date)) throw new Error('Invalid classroom timestamp.');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid classroom timestamp.');
  return date.toISOString();
}
function count(value: unknown) {
  if (!(typeof value === 'string' && /^\d+$/.test(value)) && typeof value !== 'number') throw new Error('Invalid classroom count.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid classroom count.');
  return n;
}
export function createClassDashboardRepository(db: Queryable): ClassMembershipRepository {
  return { async listByGoogleSubject(subject) {
    const { rows } = await db.query('SELECT * FROM public.platform_list_class_dashboard($1)', [subject]);
    return rows.map(row => {
      const slug = parseTenantSlug(row.slug);
      if (slug.needsRedirect || typeof row.display_name !== 'string' || !row.display_name.trim()
        || (row.role !== 'OWNER' && row.role !== 'ADMIN') || !states.includes(String(row.lifecycle))
        || !version(row.management_version)) throw new Error('Invalid classroom dashboard row.');
      return { slug: slug.slug, displayName: row.display_name, role: row.role,
        lifecycle: row.lifecycle as TenantLifecycle, dashboard: {
          deletedAt: row.deleted_at === null ? null : instant(row.deleted_at),
          managementVersion: row.management_version, createdAt: instant(row.created_at),
          studentCount: count(row.student_count), productCount: count(row.product_count), taskCount: count(row.task_count),
        } };
    });
  } };
}
export function createClassManagementCommand(db: Queryable): ClassManagementCommand {
  return { async execute(input) {
    const { rows } = input.action === 'PURGE'
      ? await db.query('SELECT public.platform_purge_class_authenticated($1::uuid,$2,$3,$4,$5::bigint,$6::uuid,$7::uuid,$8) AS result',
        [input.operationId, input.slug, input.subject, input.name, input.expectedVersion,
          input.accountGeneration, input.sessionId, currentLegalRevision().version])
      : await db.query('SELECT public.platform_manage_class_authenticated($1::uuid,$2,$3,$4,$5,$6::bigint,$7::uuid,$8::uuid,$9) AS result',
        [input.operationId, input.slug, input.subject, input.action, input.name, input.expectedVersion,
          input.accountGeneration, input.sessionId, currentLegalRevision().version]);
    const row = rows[0]?.result as Partial<ClassManagementResult> | undefined;
    if (rows.length !== 1 || !row || parseTenantSlug(row.slug).needsRedirect
      || typeof row.displayName !== 'string' || !row.displayName.trim() || row.action !== input.action
      || !states.includes(String(row.lifecycle)) || !version(row.managementVersion) || typeof row.replayed !== 'boolean') {
      throw new Error('Invalid classroom management result.');
    }
    return row as ClassManagementResult;
  } };
}
const production: Queryable = { query: (text, values) => getDatabaseClient().pool.query(text, values) };
export const getProductionClassDashboardRepository = () => createClassDashboardRepository(production);
export const getProductionClassManagementCommand = () => createClassManagementCommand(production);
