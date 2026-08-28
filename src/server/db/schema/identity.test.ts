import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  tenantAuthSecrets,
  tenantMemberships,
  tenantSessions,
  tenants,
  users,
} from '@/server/db/schema';

const USER_ONE = '10000000-0000-4000-8000-000000000001';
const USER_TWO = '10000000-0000-4000-8000-000000000002';
const TENANT_ONE = '20000000-0000-4000-8000-000000000001';
const TENANT_TWO = '20000000-0000-4000-8000-000000000002';
const MEMBERSHIP_ONE = '30000000-0000-4000-8000-000000000001';
const MEMBERSHIP_TWO = '30000000-0000-4000-8000-000000000002';
const SESSION_ONE = '40000000-0000-4000-8000-000000000001';
const SESSION_TWO = '40000000-0000-4000-8000-000000000002';
const SECRET_ONE = '50000000-0000-4000-8000-000000000001';
const SECRET_TWO = '50000000-0000-4000-8000-000000000002';

const migrationPath = resolve(
  process.cwd(),
  'src/server/db/migrations/0001_identity_tenants.sql',
);
let database: PGlite;
let migrationSql: string;

async function seedUsersAndTenants() {
  await database.query(
    `INSERT INTO users (id, google_subject, canonical_email)
     VALUES ($1, 'google-subject-one', 'owner@example.com'),
            ($2, 'google-subject-two', 'admin@example.com')`,
    [USER_ONE, USER_TWO],
  );
  await database.query(
    `INSERT INTO tenants (id, slug, display_name)
     VALUES ($1, 'first-class', 'First Class'), ($2, 'second-class', 'Second Class')`,
    [TENANT_ONE, TENANT_TWO],
  );
}

async function seedMemberships() {
  await seedUsersAndTenants();
  await database.query(
    `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
     VALUES ($1, $2, $3, 'OWNER'), ($4, $5, $6, 'ADMIN')`,
    [TENANT_ONE, MEMBERSHIP_ONE, USER_ONE, TENANT_TWO, MEMBERSHIP_TWO, USER_TWO],
  );
}

async function withRuntimeRoleTransaction<T>(
  tenantId: string | undefined,
  operation: () => Promise<T>,
) {
  await database.exec('BEGIN');
  try {
    await database.exec('SET ROLE app_runtime');
    if (tenantId !== undefined) {
      await database.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    }
    return await operation();
  } finally {
    try {
      await database.exec('ROLLBACK');
    } finally {
      await database.exec('RESET ROLE');
    }
  }
}

beforeEach(async () => {
  migrationSql = await readFile(migrationPath, 'utf8');
  database = new PGlite();
  await database.exec(migrationSql);
});

afterEach(async () => {
  await database?.close();
});

describe('identity and tenant schema', () => {
  it('exports typed Drizzle tables without plaintext credential or token columns', () => {
    expect(Object.keys(getTableColumns(users)).toSorted()).toEqual([
      'canonicalEmail', 'createdAt', 'displayName', 'googleSubject', 'id', 'updatedAt',
    ]);
    expect(Object.keys(getTableColumns(tenants))).toContain('credentialVersion');
    expect(Object.keys(getTableColumns(tenantMemberships))).toContain('tenantId');

    const secretColumns = Object.keys(getTableColumns(tenantAuthSecrets));
    expect(secretColumns).toEqual(expect.arrayContaining(['secretHash', 'hashAlgorithm', 'version']));
    expect(secretColumns).not.toEqual(expect.arrayContaining(['password', 'adminPassword', 'secret']));

    const sessionColumns = Object.keys(getTableColumns(tenantSessions));
    expect(sessionColumns).toEqual(expect.arrayContaining([
      'tokenHash', 'credentialVersion', 'sessionVersion', 'membershipId', 'userId',
    ]));
    expect(sessionColumns).not.toContain('token');
  });

  it('requires unique canonical Google subjects and email identities', async () => {
    await database.query(
      `INSERT INTO users (id, google_subject, canonical_email)
       VALUES ($1, 'google-subject-one', 'owner@example.com')`,
      [USER_ONE],
    );

    await expect(database.query(
      `INSERT INTO users (id, google_subject, canonical_email)
       VALUES ($1, 'google-subject-one', 'different@example.com')`,
      [USER_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO users (id, google_subject, canonical_email)
       VALUES ($1, 'google-subject-two', 'owner@example.com')`,
      [USER_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO users (id, google_subject, canonical_email)
       VALUES ($1, ' google-subject-three ', 'third@example.com')`,
      [USER_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO users (id, google_subject, canonical_email)
       VALUES ($1, 'google-subject-three', 'Owner@Example.com')`,
      [USER_TWO],
    )).rejects.toThrow();
  });

  it('enforces unique canonical slugs, lifecycle values, and the fixed Asia/Seoul timezone', async () => {
    await database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'first-class', 'First Class')`,
      [TENANT_ONE],
    );

    const result = await database.query<{
      lifecycle: string;
      timezone: string;
      credential_version: number;
    }>('SELECT lifecycle, timezone, credential_version FROM tenants WHERE id = $1', [TENANT_ONE]);
    expect(result.rows).toEqual([{
      lifecycle: 'DRAFT',
      timezone: 'Asia/Seoul',
      credential_version: 1,
    }]);

    await expect(database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'first-class', 'Duplicate')`,
      [TENANT_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'First-Class', 'Not canonical')`,
      [TENANT_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO tenants (id, slug, display_name, lifecycle) VALUES ($1, 'other', 'Other', 'DELETED')`,
      [TENANT_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO tenants (id, slug, display_name, timezone) VALUES ($1, 'other', 'Other', 'UTC')`,
      [TENANT_TWO],
    )).rejects.toThrow();
  });

  it('allows only OWNER or ADMIN memberships and rejects cross-tenant session bindings', async () => {
    await seedMemberships();

    await database.query(
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, session_version, expires_at)
       VALUES ($1, $2, $3, $4, 'sha256:valid-session', 1, 1, now() + interval '1 hour')`,
      [TENANT_ONE, SESSION_ONE, MEMBERSHIP_ONE, USER_ONE],
    );
    const validSession = await database.query<{ id: string }>(
      'SELECT id FROM tenant_sessions WHERE tenant_id = $1 AND id = $2',
      [TENANT_ONE, SESSION_ONE],
    );
    expect(validSession.rows).toEqual([{ id: SESSION_ONE }]);

    await expect(database.query(
      `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
       VALUES ($1, $2, $3, 'VIEWER')`,
      [TENANT_ONE, '30000000-0000-4000-8000-000000000003', USER_TWO],
    )).rejects.toThrow();

    await expect(database.query(
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, session_version, expires_at)
       VALUES ($1, $2, $3, $4, 'sha256:session', 1, 1, now() + interval '1 hour')`,
      [
        TENANT_TWO,
        SESSION_TWO,
        MEMBERSHIP_ONE,
        USER_ONE,
      ],
    )).rejects.toThrow();

    await expect(database.query(
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, session_version, expires_at)
       VALUES ($1, $2, $3, $4, 'sha256:session', 1, 1, now() + interval '1 hour')`,
      [
        TENANT_ONE,
        '40000000-0000-4000-8000-000000000003',
        MEMBERSHIP_ONE,
        USER_TWO,
      ],
    )).rejects.toThrow();
  });

  it('requires nonblank secret hash metadata, token hashes, and positive versions', async () => {
    await seedMemberships();

    await database.query(
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version)
       VALUES ($1, $2, 'ADMIN_PASSWORD', 'argon2id:hash', 'argon2id', 1)`,
      [TENANT_ONE, SECRET_ONE],
    );

    await expect(database.query(
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version)
       VALUES ($1, $2, 'RECOVERY_CODE', '', 'argon2id', 1)`,
      [TENANT_ONE, SECRET_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version)
       VALUES ($1, $2, 'RECOVERY_CODE', 'scrypt:hash', '   ', 1)`,
      [TENANT_ONE, SECRET_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, session_version, expires_at)
       VALUES ($1, $2, $3, $4, '   ', 1, 1, now() + interval '1 hour')`,
      [TENANT_ONE, SESSION_TWO, MEMBERSHIP_ONE, USER_ONE],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE tenants SET credential_version = 0 WHERE id = $1`,
      [TENANT_ONE],
    )).rejects.toThrow();
  });

  it('rejects revocation timestamps earlier than creation timestamps', async () => {
    await seedMemberships();

    expect(getTableConfig(tenantAuthSecrets).checks.map((constraint) => constraint.name))
      .toContain('tenant_auth_secrets_revocation_chronology_check');
    expect(getTableConfig(tenantSessions).checks.map((constraint) => constraint.name))
      .toContain('tenant_sessions_revocation_chronology_check');

    await expect(database.query(
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version, created_at, revoked_at)
       VALUES ($1, $2, 'ADMIN_PASSWORD', 'scrypt:hash', 'scrypt', 2,
               '2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [TENANT_ONE, SECRET_TWO],
    )).rejects.toThrow();
    await expect(database.query(
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version,
          session_version, created_at, expires_at, revoked_at)
       VALUES ($1, $2, $3, $4, 'sha256:impossible-chronology', 1, 1,
               '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z')`,
      [TENANT_ONE, SESSION_TWO, MEMBERSHIP_ONE, USER_ONE],
    )).rejects.toThrow();
  });

  it('keeps one canonical settings row and unique tenant-scoped legacy extras', async () => {
    await seedUsersAndTenants();
    await database.query(
      `INSERT INTO tenant_settings (tenant_id, schema_version, settings)
       VALUES ($1, 1, '{"currency":"KRW"}'::jsonb)`,
      [TENANT_ONE],
    );
    await expect(database.query(
      `INSERT INTO tenant_settings (tenant_id, schema_version, settings)
       VALUES ($1, 1, '{}'::jsonb)`,
      [TENANT_ONE],
    )).rejects.toThrow();

    await database.query(
      `INSERT INTO tenant_setting_extras (tenant_id, setting_key, setting_value)
       VALUES ($1, 'teacherCustom', '{"preserved":true}'::jsonb)`,
      [TENANT_ONE],
    );
    await expect(database.query(
      `INSERT INTO tenant_setting_extras (tenant_id, setting_key, setting_value)
       VALUES ($1, 'teacherCustom', 'null'::jsonb)`,
      [TENANT_ONE],
    )).rejects.toThrow();
  });

  it('enforces runtime tenant isolation for every tenant-owned table', async () => {
    const tenantOwnedTables = [
      'tenants',
      'tenant_memberships',
      'tenant_auth_secrets',
      'tenant_sessions',
      'tenant_settings',
      'tenant_setting_extras',
    ];
    const tenantThree = '20000000-0000-4000-8000-000000000003';
    const tenantFour = '20000000-0000-4000-8000-000000000004';
    const membershipThree = '30000000-0000-4000-8000-000000000003';

    await seedMemberships();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'third-class', 'Third Class')`,
      [tenantThree],
    );
    await database.query(
      `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [tenantThree, membershipThree, USER_ONE],
    );
    await database.query(
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version)
       VALUES ($1, $2, 'ADMIN_PASSWORD', 'scrypt:one', 'scrypt', 1),
              ($3, $4, 'ADMIN_PASSWORD', 'sha256:two', 'sha256', 1)`,
      [TENANT_ONE, SECRET_ONE, TENANT_TWO, SECRET_TWO],
    );
    await database.query(
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, expires_at)
       VALUES ($1, $2, $3, $4, 'sha256:one', 1, now() + interval '1 hour'),
              ($5, $6, $7, $8, 'sha256:two', 1, now() + interval '1 hour')`,
      [
        TENANT_ONE, SESSION_ONE, MEMBERSHIP_ONE, USER_ONE,
        TENANT_TWO, SESSION_TWO, MEMBERSHIP_TWO, USER_TWO,
      ],
    );
    await database.query(
      `INSERT INTO tenant_settings (tenant_id, settings)
       VALUES ($1, '{"tenant":1}'::jsonb), ($2, '{"tenant":2}'::jsonb)`,
      [TENANT_ONE, TENANT_TWO],
    );
    await database.query(
      `INSERT INTO tenant_setting_extras (tenant_id, setting_key, setting_value)
       VALUES ($1, 'fixture', '1'::jsonb), ($2, 'fixture', '2'::jsonb)`,
      [TENANT_ONE, TENANT_TWO],
    );

    await database.exec('CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS');
    await database.exec(`GRANT USAGE ON SCHEMA public TO app_runtime`);
    await database.exec(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${tenantOwnedTables.join(', ')} TO app_runtime`,
    );

    await withRuntimeRoleTransaction(undefined, async () => {
      for (const table of tenantOwnedTables) {
        const result = await database.query(`SELECT * FROM ${table}`);
        expect(result.rows, `${table} must fail closed without app.tenant_id`).toEqual([]);
      }
    });

    const missingContextInserts = [
      `INSERT INTO tenants (id, slug, display_name) VALUES ('${tenantFour}', 'fourth-class', 'Fourth Class')`,
      `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
       VALUES ('${tenantThree}', '30000000-0000-4000-8000-000000000004', '${USER_TWO}', 'ADMIN')`,
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version)
       VALUES ('${tenantThree}', '50000000-0000-4000-8000-000000000003',
               'RECOVERY_CODE', 'scrypt:three', 'scrypt', 1)`,
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, expires_at)
       VALUES ('${tenantThree}', '40000000-0000-4000-8000-000000000003',
               '${membershipThree}', '${USER_ONE}', 'sha256:three', 1, now() + interval '1 hour')`,
      `INSERT INTO tenant_settings (tenant_id, settings) VALUES ('${tenantThree}', '{}'::jsonb)`,
      `INSERT INTO tenant_setting_extras (tenant_id, setting_key, setting_value)
       VALUES ('${tenantThree}', 'missingContext', 'true'::jsonb)`,
    ];
    for (const statement of missingContextInserts) {
      await expect(withRuntimeRoleTransaction(undefined, () => database.exec(statement)))
        .rejects.toThrow(/row-level security policy/i);
    }

    await withRuntimeRoleTransaction(TENANT_ONE, async () => {
      for (const table of tenantOwnedTables) {
        const tenantColumn = table === 'tenants' ? 'id' : 'tenant_id';
        const ownRows = await database.query(
          `SELECT ${tenantColumn}::text AS tenant_id FROM ${table}`,
        );
        expect(ownRows.rows, `${table} must expose the current tenant fixture`).toEqual([
          { tenant_id: TENANT_ONE },
        ]);
      }

      await database.query(
        `INSERT INTO tenant_setting_extras (tenant_id, setting_key, setting_value)
         VALUES ($1, 'runtimeAllowed', 'true'::jsonb)`,
        [TENANT_ONE],
      );
      const allowedWrite = await database.query(
        `SELECT setting_key FROM tenant_setting_extras
         WHERE tenant_id = $1 AND setting_key = 'runtimeAllowed'`,
        [TENANT_ONE],
      );
      expect(allowedWrite.rows).toEqual([{ setting_key: 'runtimeAllowed' }]);
    });

    await withRuntimeRoleTransaction(TENANT_ONE, async () => {
      for (const table of tenantOwnedTables) {
        const tenantColumn = table === 'tenants' ? 'id' : 'tenant_id';
        const otherRows = await database.query(
          `SELECT * FROM ${table} WHERE ${tenantColumn} = $1`,
          [TENANT_TWO],
        );
        expect(otherRows.rows, `${table} must hide tenant-two rows`).toEqual([]);
      }

      const blockedUpdates = [
        `UPDATE tenants SET display_name = 'blocked' WHERE id = '${TENANT_TWO}' RETURNING id`,
        `UPDATE tenant_memberships SET role = 'OWNER' WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `UPDATE tenant_auth_secrets SET hash_algorithm = 'blocked' WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `UPDATE tenant_sessions SET session_version = session_version + 1 WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `UPDATE tenant_settings SET schema_version = schema_version + 1 WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `UPDATE tenant_setting_extras SET setting_value = '3'::jsonb WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
      ];
      const blockedDeletes = [
        `DELETE FROM tenants WHERE id = '${TENANT_TWO}' RETURNING id`,
        `DELETE FROM tenant_memberships WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `DELETE FROM tenant_auth_secrets WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `DELETE FROM tenant_sessions WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `DELETE FROM tenant_settings WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
        `DELETE FROM tenant_setting_extras WHERE tenant_id = '${TENANT_TWO}' RETURNING tenant_id`,
      ];
      for (const statement of [...blockedUpdates, ...blockedDeletes]) {
        const result = await database.query(statement);
        expect(result.rows).toEqual([]);
      }
    });

    await database.query('DELETE FROM tenants WHERE id = $1', [TENANT_TWO]);
    await expect(withRuntimeRoleTransaction(
      TENANT_ONE,
      () => database.exec(
        `INSERT INTO tenants (id, slug, display_name)
         VALUES ('${TENANT_TWO}', 'second-class', 'Second Class')`,
      ),
    )).rejects.toThrow(/row-level security policy/i);

    await database.query(
      `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'second-class', 'Second Class')`,
      [TENANT_TWO],
    );
    await database.query(
      `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
       VALUES ($1, $2, $3, 'ADMIN')`,
      [TENANT_TWO, MEMBERSHIP_TWO, USER_TWO],
    );
    const blockedInserts = [
      `INSERT INTO tenant_memberships (tenant_id, id, user_id, role)
       VALUES ('${TENANT_TWO}', '30000000-0000-4000-8000-000000000004', '${USER_ONE}', 'ADMIN')`,
      `INSERT INTO tenant_auth_secrets
         (tenant_id, id, kind, secret_hash, hash_algorithm, version)
       VALUES ('${TENANT_TWO}', '50000000-0000-4000-8000-000000000003',
               'RECOVERY_CODE', 'scrypt:blocked', 'scrypt', 1)`,
      `INSERT INTO tenant_sessions
         (tenant_id, id, membership_id, user_id, token_hash, credential_version, expires_at)
       VALUES ('${TENANT_TWO}', '40000000-0000-4000-8000-000000000003',
               '${MEMBERSHIP_TWO}', '${USER_TWO}', 'sha256:blocked', 1, now() + interval '1 hour')`,
      `INSERT INTO tenant_settings (tenant_id, settings) VALUES ('${TENANT_TWO}', '{}'::jsonb)`,
      `INSERT INTO tenant_setting_extras (tenant_id, setting_key, setting_value)
       VALUES ('${TENANT_TWO}', 'blockedInsert', 'true'::jsonb)`,
    ];
    for (const statement of blockedInserts) {
      await expect(withRuntimeRoleTransaction(TENANT_ONE, () => database.exec(statement)))
        .rejects.toThrow(/row-level security policy/i);
    }
  });

  it('enables and forces RLS for every tenant-owned table', () => {
    const tenantOwnedTables = [
      'tenants',
      'tenant_memberships',
      'tenant_auth_secrets',
      'tenant_sessions',
      'tenant_settings',
      'tenant_setting_extras',
    ];

    for (const table of tenantOwnedTables) {
      expect(migrationSql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(migrationSql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
      expect(migrationSql).toMatch(new RegExp(`CREATE POLICY ${table}_tenant_isolation`, 'i'));
    }
    expect(migrationSql).toContain("current_setting('app.tenant_id', true)");
    expect(migrationSql).not.toMatch(/current_setting\('app\.tenant_id'\)(?!,)/);
  });
});
