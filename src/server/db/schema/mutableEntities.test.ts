import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { getTableColumns, type SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type AnyPgTable } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { products, promotions, students, tasks, tenantSettings } from '@/server/db/schema';

const TENANT = '20000000-0000-4000-8000-000000000001';
const BASE_MIGRATIONS = ['0001_identity_tenants.sql', '0002_operational.sql'] as const;
const MUTABLE_ENTITY_MIGRATION = '0005_mutable_entity_versions.sql';
const normalizeSql = (value: string) => value
  .replaceAll('"', '')
  .replace(/\b[a-z_][a-z0-9_]*\./gi, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

let database: PGlite;
let migrationSql: string;

async function applyBase(target: PGlite) {
  for (const name of BASE_MIGRATIONS) {
    await target.exec(await readFile(resolve(
      process.cwd(), 'src/server/db/migrations', name,
    ), 'utf8'));
  }
}

async function seedMutableDefinitions(target: PGlite) {
  await target.query(
    `INSERT INTO tenants (id, slug, display_name) VALUES ($1, 'mutable-probe', 'Mutable Probe')`,
    [TENANT],
  );
  await target.query(
    `INSERT INTO students (tenant_id, student_id, name, status)
     VALUES ($1, 'student-1', 'Student One', 'ACTIVE')`,
    [TENANT],
  );
  await target.query(
    `INSERT INTO products (tenant_id, product_id, name, price, stock)
     VALUES ($1, 'product-1', 'Pencil', 100, 5)`,
    [TENANT],
  );
  await target.query(
    `INSERT INTO promotions
       (tenant_id, promotion_id, name, description, type, n_plus_one_buy_quantity,
        n_plus_one_free_quantity, starts_at, ends_at)
     VALUES ($1, 'promotion-1', 'Two for one', '', 'N_PLUS_ONE', 1, 1,
       '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')`,
    [TENANT],
  );
  await target.query(
    `INSERT INTO tasks
       (tenant_id, task_instance_id, task_id, title, description, current_schedule)
     VALUES ($1, 'task-instance-1', 'task-1', 'Clean board', '',
       '{"ruleVersion":1,"effectiveFrom":"2026-01-01T00:00:00+09:00","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}'::jsonb)`,
    [TENANT],
  );
  await target.query(
    `INSERT INTO tenant_settings (tenant_id, settings) VALUES ($1, '{"storeName":"Class Store"}')`,
    [TENANT],
  );
}

beforeEach(async () => {
  database = new PGlite();
  await applyBase(database);
  migrationSql = await readFile(resolve(
    process.cwd(), 'src/server/db/migrations', MUTABLE_ENTITY_MIGRATION,
  ), 'utf8');
});

afterEach(async () => {
  await database?.close();
});

describe('mutable entity version migration', () => {
  it('keeps Drizzle metadata aligned with versioned mutable definitions and student tombstones', () => {
    expect(Object.keys(getTableColumns(students))).toEqual(expect.arrayContaining([
      'version', 'deletedAt',
    ]));
    for (const table of [products, promotions, tasks, tenantSettings]) {
      expect(Object.keys(getTableColumns(table))).toContain('version');
    }
    const dialect = new PgDialect();
    const expectedChecks: ReadonlyArray<Readonly<{
      table: AnyPgTable;
      names: ReadonlyArray<string>;
    }>> = [
      { table: students, names: ['students_version_check', 'students_deleted_chronology_check', 'students_deleted_status_check'] },
      { table: products, names: ['products_version_check'] },
      { table: promotions, names: ['promotions_version_check'] },
      { table: tasks, names: ['tasks_version_check'] },
      { table: tenantSettings, names: ['tenant_settings_version_check'] },
    ];
    for (const { table, names } of expectedChecks) {
      const version = getTableColumns(table).version;
      expect(version.getSQLType()).toBe('bigint');
      expect(version.notNull).toBe(true);
      expect(version.hasDefault).toBe(true);
      expect(dialect.sqlToQuery(version.default as SQL).sql).toBe('1');
      const checks = getTableConfig(table).checks;
      expect(checks.map((check) => check.name)).toEqual(expect.arrayContaining([...names]));
      for (const name of names) {
        const check = checks.find((candidate) => candidate.name === name);
        expect(check).toBeDefined();
        const rendered = normalizeSql(dialect.sqlToQuery(check!.value).sql);
        if (name.endsWith('_version_check')) {
          expect(rendered).toBe('version between 1 and 9007199254740991');
        } else if (name === 'students_deleted_chronology_check') {
          expect(rendered).toBe('deleted_at is null or deleted_at >= created_at');
        } else {
          expect(rendered).toBe("deleted_at is null or status = 'inactive'");
        }
      }
    }
    const activeIndex = getTableConfig(students).indexes
      .find((index) => index.config.name === 'students_active_name_idx');
    expect(activeIndex).toBeDefined();
    expect(dialect.sqlToQuery(activeIndex!.config.where!).sql).toContain('deleted_at');
  });

  it('upgrades existing definitions without rewriting their values', async () => {
    await seedMutableDefinitions(database);
    await database.exec(migrationSql);

    const student = await database.query<{
      student_id: string; name: string; status: string; version: string; deleted_at: string | null;
    }>(
      `SELECT student_id,name,status,version::text,deleted_at::text
       FROM students WHERE tenant_id=$1`,
      [TENANT],
    );
    expect(student.rows).toEqual([{
      student_id: 'student-1',
      name: 'Student One',
      status: 'ACTIVE',
      version: '1',
      deleted_at: null,
    }]);
    const versionColumns = await database.query<{
      table_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string;
    }>(
      `SELECT table_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema='public' AND column_name='version'
         AND table_name IN ('students', 'products', 'promotions', 'tasks', 'tenant_settings')
       ORDER BY table_name`,
    );
    expect(versionColumns.rows).toHaveLength(5);
    for (const column of versionColumns.rows) {
      expect(column.data_type).toBe('bigint');
      expect(column.is_nullable).toBe('NO');
      expect(column.column_default).toMatch(/^1(?:::\w+)?$/);
    }

    for (const table of ['products', 'promotions', 'tasks', 'tenant_settings']) {
      const version = await database.query<{ version: string }>(
        `SELECT version::text AS version FROM ${table} WHERE tenant_id=$1`, [TENANT],
      );
      expect(version.rows).toEqual([{ version: '1' }]);
      await expect(database.query(
        `UPDATE ${table} SET version=0 WHERE tenant_id=$1`, [TENANT],
      )).rejects.toThrow();
      await expect(database.query(
        `UPDATE ${table} SET version=9007199254740992 WHERE tenant_id=$1`, [TENANT],
      )).rejects.toThrow();
    }

    await expect(database.query(
      `UPDATE students SET version=0 WHERE tenant_id=$1 AND student_id='student-1'`,
      [TENANT],
    )).rejects.toThrow();
    await expect(database.query(
      `UPDATE students SET status='INACTIVE', deleted_at=created_at - interval '1 second'
       WHERE tenant_id=$1 AND student_id='student-1'`,
      [TENANT],
    )).rejects.toThrow();

    await expect(database.query(
      `UPDATE students SET deleted_at=now() WHERE tenant_id=$1 AND student_id='student-1'`,
      [TENANT],
    )).rejects.toThrow();
    await database.query(
      `UPDATE students SET status='INACTIVE', deleted_at=now(), version=version+1
       WHERE tenant_id=$1 AND student_id='student-1'`,
      [TENANT],
    );
    const deleted = await database.query<{ status: string; version: string; deleted: boolean }>(
      `SELECT status,version::text,deleted_at IS NOT NULL AS deleted
       FROM students WHERE tenant_id=$1`,
      [TENANT],
    );
    expect(deleted.rows).toEqual([{ status: 'INACTIVE', version: '2', deleted: true }]);
    const activeIndex = await database.query<{ definition: string }>(
      `SELECT indexdef AS definition FROM pg_indexes
       WHERE schemaname='public' AND indexname='students_active_name_idx'`,
    );
    expect(activeIndex.rows).toHaveLength(1);
    expect(activeIndex.rows[0].definition).toMatch(/status.*ACTIVE.*deleted_at IS NULL/i);
  });

  it('leaves transaction ownership to the migration runner', async () => {
    expect(migrationSql).not.toMatch(/\b(?:BEGIN|COMMIT)\b/i);
    await seedMutableDefinitions(database);

    await database.exec('BEGIN');
    await database.exec(migrationSql);
    await database.exec('ROLLBACK');

    const rolledBack = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='students' AND column_name IN ('version','deleted_at')
       ORDER BY column_name`,
    );
    expect(rolledBack.rows).toEqual([]);

    await database.exec(migrationSql);
    const applied = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='students' AND column_name IN ('version','deleted_at')
       ORDER BY column_name`,
    );
    expect(applied.rows).toEqual([{ column_name: 'deleted_at' }, { column_name: 'version' }]);
  });
});
