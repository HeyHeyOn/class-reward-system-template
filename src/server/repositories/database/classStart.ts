import 'server-only';
import { getDatabaseClient } from '@/server/db/client';
import { parseTenantSlug } from '@/server/tenantContext';
import type { TeacherSessionBinding } from '@/server/teacherSession';
import { currentLegalRevision } from '@/lib/legalDocuments';

export type NewClassSetup = Readonly<{ slug: string; displayName: string; lifecycle: 'DRAFT' | 'ACTIVE' }>;
export type ClassStartResult = NewClassSetup & Readonly<{ lifecycle: 'ACTIVE'; replayed: boolean }>;
export type ClassStartRepository = Readonly<{
  getSetup(slug: string, subject: string): Promise<NewClassSetup | null>;
  start(input: TeacherSessionBinding & { operationId: string; slug: string; subject: string }): Promise<ClassStartResult>;
}>;
type Queryable = Readonly<{ query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }>;

function project(row: unknown, slug: string): NewClassSetup {
  if (!row || typeof row !== 'object') throw new Error('Invalid new class result.');
  const value = row as Record<string, unknown>;
  if (parseTenantSlug(value.slug).slug !== slug || value.slug !== slug
    || typeof value.display_name !== 'string' || !value.display_name.trim()
    || !['DRAFT', 'ACTIVE'].includes(String(value.lifecycle))) throw new Error('Invalid new class result.');
  return { slug, displayName: value.display_name, lifecycle: value.lifecycle as 'DRAFT' | 'ACTIVE' };
}

export function createClassStartRepository(queryable: Queryable): ClassStartRepository {
  return {
    async getSetup(slug, subject) {
      const { rows } = await queryable.query('SELECT * FROM public.platform_get_new_class_setup($1,$2)', [slug, subject]);
      if (rows.length > 1) throw new Error('Invalid new class result.');
      return rows.length ? project(rows[0], slug) : null;
    },
    async start({ operationId, slug, subject, accountGeneration, sessionId }) {
      const { rows } = await queryable.query('SELECT * FROM public.platform_start_new_class_authenticated($1::uuid,$2,$3,$4::uuid,$5::uuid,$6)',
        [operationId, slug, subject, accountGeneration, sessionId, currentLegalRevision().version]);
      if (rows.length !== 1) throw new Error('Invalid class start result.');
      const result = project(rows[0], slug);
      const replayed = (rows[0] as Record<string, unknown>).replayed;
      if (result.lifecycle !== 'ACTIVE' || typeof replayed !== 'boolean') throw new Error('Invalid class start result.');
      return { ...result, lifecycle: 'ACTIVE', replayed };
    },
  };
}

export function getProductionClassStartRepository() {
  return createClassStartRepository({ query: (text, values) => getDatabaseClient().pool.query(text, values) });
}
