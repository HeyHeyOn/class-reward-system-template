import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const TENANT_A = '20000000-0000-4000-8000-000000000001';
const TENANT_B = '20000000-0000-4000-8000-000000000002';
const migrationPath = resolve(
  process.cwd(),
  'src/server/db/migrations/0012_platform_tenant_discovery.sql',
);

let database: PGlite;
let migrationSql: string;

beforeEach(async () => {
  database = new PGlite();
  await database.exec(await readFile(resolve(
    process.cwd(),
    'src/server/db/migrations/0001_identity_tenants.sql',
  ), 'utf8'));
  migrationSql = await readFile(migrationPath, 'utf8');
  await database.exec(migrationSql);

  await database.query(
    `INSERT INTO public.users (id, google_subject, canonical_email)
     VALUES ($1, 'subject-a', 'a@example.com'), ($2, 'subject-b', 'b@example.com')`,
    [USER_A, USER_B],
  );
  await database.query(
    `INSERT INTO public.tenants (id, slug, display_name, lifecycle)
     VALUES ($1, 'alpha-class', 'Alpha', 'ACTIVE'),
            ($2, 'beta-class', 'Beta', 'SUSPENDED')`,
    [TENANT_A, TENANT_B],
  );
  await database.query(
    `INSERT INTO public.tenant_memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'OWNER'), ($3, $2, 'ADMIN'), ($3, $4, 'OWNER')`,
    [TENANT_A, USER_A, TENANT_B, USER_B],
  );

  await database.exec('CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS');
  await database.exec('GRANT USAGE ON SCHEMA public TO app_runtime');
});

afterEach(async () => {
  await database?.close();
});

describe('platform tenant discovery migration', () => {
  it('defines only exact, schema-hardened SECURITY DEFINER lookup functions', async () => {
    expect(migrationSql).toMatch(/SECURITY DEFINER/gi);
    expect(migrationSql).toContain('SET search_path = pg_catalog');
    expect(migrationSql).toContain('public.tenants');
    expect(migrationSql).toContain('public.tenant_memberships');
    expect(migrationSql).toContain('public.users');
    expect(migrationSql).toMatch(/WHERE t\.slug = p_slug/i);
    expect(migrationSql).toMatch(/tm\.tenant_id = p_tenant_id/i);
    expect(migrationSql).toMatch(/u\.google_subject = p_google_subject/i);
    expect(migrationSql).not.toMatch(/ILIKE|LIKE/i);

    const functions = await database.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      owner_can_bypass_rls: boolean;
    }>(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              (r.rolsuper OR r.rolbypassrls) AS owner_can_bypass_rls
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
       WHERE n.nspname = 'public'
         AND p.proname IN (
           'platform_find_tenant_by_slug',
           'platform_find_membership_by_tenant_and_google_subject',
           'platform_list_memberships_by_google_subject'
         )
       ORDER BY p.proname`,
    );
    expect(functions.rows).toHaveLength(3);
    for (const fn of functions.rows) {
      expect(fn.prosecdef).toBe(true);
      expect(fn.proconfig).toContain('search_path=pg_catalog');
      expect(fn.owner_can_bypass_rls).toBe(true);
    }
  });

  it('revokes PUBLIC execution and documents the deferred Task18 runtime grant contract', async () => {
    const privilegesBeforeGrant = await database.query<{ name: string; allowed: boolean }>(
      `SELECT name, pg_catalog.has_function_privilege(
         'app_runtime', 'public.' || name || identity_arguments, 'EXECUTE'
       ) AS allowed
       FROM (VALUES
         ('platform_find_tenant_by_slug', '(text)'),
         ('platform_find_membership_by_tenant_and_google_subject', '(uuid,text)'),
         ('platform_list_memberships_by_google_subject', '(text)')
       ) AS signatures(name, identity_arguments)
       ORDER BY name`,
    );
    expect(privilegesBeforeGrant.rows.every(({ allowed }) => !allowed)).toBe(true);
    expect(migrationSql).toMatch(/REVOKE ALL ON FUNCTION[\s\S]+FROM PUBLIC/i);
    expect(migrationSql.match(/Task18 provisioning contract:/g)).toHaveLength(3);
    expect(migrationSql).not.toMatch(/^\s*GRANT EXECUTE\b/im);
  });

  it('lets a NOSUPERUSER NOBYPASSRLS runtime role use only the narrow lookups without tenant context', async () => {
    await database.exec(`
      GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime;
      GRANT EXECUTE ON FUNCTION public.platform_find_membership_by_tenant_and_google_subject(uuid, text) TO app_runtime;
      GRANT EXECUTE ON FUNCTION public.platform_list_memberships_by_google_subject(text) TO app_runtime;
      SET ROLE app_runtime;
    `);
    try {
      const role = await database.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        `SELECT rolsuper, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = current_user`,
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);

      await expect(database.query('SELECT * FROM public.tenants')).rejects.toThrow(/permission denied/i);

      const tenant = await database.query(
        'SELECT * FROM public.platform_find_tenant_by_slug($1)',
        ['alpha-class'],
      );
      expect(tenant.rows).toEqual([{
        id: TENANT_A,
        slug: 'alpha-class',
        display_name: 'Alpha',
        lifecycle: 'ACTIVE',
        timezone: 'Asia/Seoul',
      }]);
      const nonCanonical = await database.query(
        'SELECT * FROM public.platform_find_tenant_by_slug($1)',
        ['Alpha-Class'],
      );
      expect(nonCanonical.rows).toEqual([]);

      const membership = await database.query(
        'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)',
        [TENANT_A, 'subject-a'],
      );
      expect(membership.rows).toEqual([expect.objectContaining({
        tenant_id: TENANT_A,
        user_id: USER_A,
        google_subject: 'subject-a',
        role: 'OWNER',
      })]);
      const crossSubject = await database.query(
        'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)',
        [TENANT_A, 'subject-b'],
      );
      expect(crossSubject.rows).toEqual([]);

      const memberships = await database.query(
        'SELECT * FROM public.platform_list_memberships_by_google_subject($1)',
        ['subject-a'],
      );
      expect(memberships.rows).toEqual([
        { slug: 'alpha-class', display_name: 'Alpha', role: 'OWNER', lifecycle: 'ACTIVE' },
        { slug: 'beta-class', display_name: 'Beta', role: 'ADMIN', lifecycle: 'SUSPENDED' },
      ]);
    } finally {
      await database.exec('RESET ROLE');
    }
  });
});
