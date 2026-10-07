import 'server-only';
import { getDatabaseClient } from '@/server/db/client';
import { parseTenantSlug } from '@/server/tenantContext';

export type ClassCreationInput = Readonly<{
  operationId: string; subject: string; email: string; displayName: string;
}>;
export type ClassCreationResult = Readonly<{
  slug: string; displayName: string; lifecycle: 'DRAFT'; role: 'OWNER'; replayed: boolean;
}>;
export type ClassCreationCommand = Readonly<{
  create(input: ClassCreationInput): Promise<ClassCreationResult>;
}>;
type Queryable = Readonly<{ query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> }>;

export function createClassCreationCommand(queryable: Queryable): ClassCreationCommand {
  return {
    async create(input) {
      // One SQL statement is one atomic transaction. Never retry uncertain commits.
      const { rows } = await queryable.query(
        'SELECT * FROM public.platform_create_draft_class($1::uuid, $2, $3, $4)',
        [input.operationId, input.subject, input.email, input.displayName],
      );
      const row = rows[0];
      if (rows.length !== 1 || !row || typeof row !== 'object') throw new Error('Invalid class creation result.');
      const value = row as Record<string, unknown>;
      const slug = parseTenantSlug(value.slug);
      if (slug.needsRedirect || !/^class-[0-9a-f-]{36}$/.test(slug.slug)
        || typeof value.display_name !== 'string' || value.display_name !== input.displayName
        || value.lifecycle !== 'DRAFT' || value.role !== 'OWNER' || typeof value.replayed !== 'boolean') {
        throw new Error('Invalid class creation result.');
      }
      return { slug: slug.slug, displayName: value.display_name, lifecycle: 'DRAFT', role: 'OWNER', replayed: value.replayed };
    },
  };
}
export function getProductionClassCreationCommand(): ClassCreationCommand {
  return createClassCreationCommand({ query: (text, values) => getDatabaseClient().pool.query(text, values) });
}
