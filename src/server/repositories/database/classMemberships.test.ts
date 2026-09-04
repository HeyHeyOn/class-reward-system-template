import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createClassMembershipRepository } from '@/server/repositories/database/classMemberships';

const USER_A = '10000000-0000-4000-8000-000000000001';
const USER_B = '10000000-0000-4000-8000-000000000002';
const TENANT_ACTIVE = '20000000-0000-4000-8000-000000000001';
const TENANT_SUSPENDED = '20000000-0000-4000-8000-000000000002';
const TENANT_B = '20000000-0000-4000-8000-000000000003';

let database: PGlite;

beforeEach(async () => {
  database = new PGlite({ extensions: { pgcrypto } });
  await database.exec(await readFile(resolve(
    process.cwd(),
    'src/server/db/migrations/0001_identity_tenants.sql',
  ), 'utf8'));
  await database.exec(await readFile(resolve(
    process.cwd(),
    'src/server/db/migrations/0012_platform_tenant_discovery.sql',
  ), 'utf8'));
  await database.query(
    `INSERT INTO users (id, google_subject, canonical_email, display_name)
     VALUES ($1, 'subject-a', 'a@example.com', 'Teacher A'),
            ($2, 'subject-b', 'b@example.com', 'Teacher B')`,
    [USER_A, USER_B],
  );
  await database.query(
    `INSERT INTO tenants (id, slug, display_name, lifecycle)
     VALUES ($1, 'active-class', '활성 학급', 'ACTIVE'),
            ($2, 'suspended-class', '중지 학급', 'SUSPENDED'),
            ($3, 'other-class', '다른 교사의 학급', 'ACTIVE')`,
    [TENANT_ACTIVE, TENANT_SUSPENDED, TENANT_B],
  );
  await database.query(
    `INSERT INTO tenant_memberships (tenant_id, user_id, role)
     VALUES ($1, $3, 'OWNER'), ($2, $3, 'ADMIN'), ($4, $5, 'OWNER')`,
    [TENANT_ACTIVE, TENANT_SUSPENDED, USER_A, TENANT_B, USER_B],
  );
});

afterEach(async () => {
  await database.close();
});

describe('class membership repository', () => {
  it('lists only memberships joined to the exact authenticated Google subject', async () => {
    const repository = createClassMembershipRepository({
      query: (text, values) => database.query(text, values),
    });

    await expect(repository.listByGoogleSubject('subject-a')).resolves.toEqual([
      {
        slug: 'active-class', displayName: '활성 학급', role: 'OWNER', lifecycle: 'ACTIVE',
      },
      {
        slug: 'suspended-class', displayName: '중지 학급', role: 'ADMIN', lifecycle: 'SUSPENDED',
      },
    ]);
  });

  it('uses the subject only as a bound exact-match value', async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      void text;
      void values;
      return { rows: [] as unknown[] };
    });
    const repository = createClassMembershipRepository({ query });
    const hostileSubject = "subject-a' OR '1'='1";

    await expect(repository.listByGoogleSubject(hostileSubject)).resolves.toEqual([]);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([hostileSubject]);
    expect(query.mock.calls[0]?.[0]).not.toContain(hostileSubject);
    expect(query.mock.calls[0]?.[0]).toBe(
      'SELECT * FROM public.platform_list_memberships_by_google_subject($1)',
    );
    expect(query.mock.calls[0]?.[0]).not.toMatch(
      /\bFROM\s+(?:public\.)?(?:users|tenant_memberships|tenants)\b/i,
    );
  });
});
