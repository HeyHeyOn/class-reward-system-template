import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskAssignments, taskCompletions, tasks } from '@/server/db/schema';

const T1 = '20000000-0000-4000-8000-000000000001';
const T2 = '20000000-0000-4000-8000-000000000002';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const BASE = [
  '0001_identity_tenants.sql', '0002_operational.sql',
  '0003_operations_migrations.sql', '0004_admin_operation_kinds.sql',
  '0005_mutable_entity_versions.sql',
] as const;
const TARGET = '0010_task_admin_invariants.sql';
let db: PGlite;

const migration = (name: string) => readFile(resolve(
  process.cwd(), 'src/server/db/migrations', name,
), 'utf8');

async function apply(names: readonly string[]) {
  for (const name of names) await db.exec(await migration(name));
}

const normalizeCheck = (definition: string) => definition
  .replace(/^CHECK\s*/i, '')
  .replaceAll('"', '')
  .replace(/\b(?:tasks|task_assignments|task_completions)\./gi, '')
  .replace(/::text\b/gi, '')
  .replace(/\b(btrim|length)\s*\(\s*([a-z_][a-z0-9_]*)\s*\)/gi, '$1{$2}')
  .replace(/[()]/g, '')
  .replace(/\b(btrim|length)\{([^}]+)\}/gi, '$1($2)')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

async function seedDefinitions() {
  await db.exec(`
    INSERT INTO tenants (id,slug,display_name) VALUES
      ('${T1}','task-admin-one','Task Admin One'),
      ('${T2}','task-admin-two','Task Admin Two');
    INSERT INTO students (tenant_id,student_id,name,status) VALUES
      ('${T1}','student-1','Student One','ACTIVE'),
      ('${T2}','student-1','Student Two','ACTIVE');
    INSERT INTO tasks
      (tenant_id,task_instance_id,task_id,title,description,current_schedule)
    VALUES
      ('${T1}','task-instance-1','task-1','Task One','',
       '{"ruleVersion":1,"effectiveFrom":"2026-01-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}'),
      ('${T2}','task-instance-1','task-1','Task Two','',
       '{"ruleVersion":1,"effectiveFrom":"2026-01-01","timeZone":"Asia/Seoul","recurrence":{},"resetCompletionOnCycle":false,"resetAssignmentOnCycle":false}');
  `);
}

async function insertAssignment(
  id: string, source: string, operationId: string | null, hash: string | null, tenant = T1,
) {
  return db.query(`INSERT INTO task_assignments
    (tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,
     rule_version,timezone,student_id,event_type,source,admin_operation_id,admin_operation_hash)
    VALUES ($1,$2,'task-1','task-instance-1','cycle-1','2026-01-01T00:00:00Z',
      1,'Asia/Seoul','student-1','ASSIGNED',$3,$4,$5)`,
  [tenant, id, source, operationId, hash]);
}

async function insertCompletion(
  id: string, source: string | null, operationId: string | null, hash: string | null,
  bankOperationId: string | null = null,
) {
  return db.query(`INSERT INTO task_completions
    (tenant_id,completion_id,completed_at,task_instance_id,task_id_snapshot,task_name_snapshot,
     student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status,
     cycle_id,cycle_start_at,rule_version,timezone,source,operation_id,operation_hash,
     admin_operation_id,admin_operation_hash)
    VALUES ($1,$2,'2026-01-01T01:00:00Z','task-instance-1','task-1','Task One',
      'student-1','Student One',0,0,0,
      CASE WHEN $3 = 'ADMIN_RESET' THEN 'CANCELLED' ELSE 'COMPLETED' END,
      'cycle-1','2026-01-01T00:00:00Z',
      1,'Asia/Seoul',$3,$4,$5,$6,$7)`,
  [T1, id, source, bankOperationId, bankOperationId ? HASH_B : null, operationId, hash]);
}

beforeEach(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await apply(BASE);
});
afterEach(async () => db?.close());

describe('task administrator schema invariants', () => {
  it('keeps SQL and Drizzle lifecycle, binding columns, checks, and foreign keys in parity', async () => {
    const sql = await migration(TARGET);
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
    await db.exec(sql);

    for (const table of [taskAssignments, taskCompletions]) {
      const columns = getTableColumns(table);
      expect({ name: columns.adminOperationId.name, notNull: columns.adminOperationId.notNull })
        .toEqual({ name: 'admin_operation_id', notNull: false });
      expect({ name: columns.adminOperationHash.name, notNull: columns.adminOperationHash.notNull })
        .toEqual({ name: 'admin_operation_hash', notNull: false });
    }
    const dialect = new PgDialect();
    const taskChecks = getTableConfig(tasks).checks;
    const expectedTaskChecks = new Map<string, string>();
    for (const name of [
      'tasks_updated_chronology_check',
      'tasks_deleted_chronology_check',
      'tasks_deleted_status_check',
    ]) {
      const check = taskChecks.find((candidate) => candidate.name === name);
      expect(check, name).toBeDefined();
      expectedTaskChecks.set(name, normalizeCheck(dialect.sqlToQuery(check!.value).sql));
    }
    const installedTaskChecks = await db.query<{ constraint_name: string; definition: string }>(`
      SELECT conname AS constraint_name,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname IN ('tasks_updated_chronology_check','tasks_deleted_chronology_check',
        'tasks_deleted_status_check') ORDER BY conname`);
    expect(installedTaskChecks.rows).toHaveLength(expectedTaskChecks.size);
    for (const row of installedTaskChecks.rows) {
      expect(normalizeCheck(row.definition), row.constraint_name)
        .toBe(expectedTaskChecks.get(row.constraint_name));
    }
    for (const [table, prefix] of [
      [taskAssignments, 'task_assignments'], [taskCompletions, 'task_completions'],
    ] as const) {
      const config = getTableConfig(table);
      const foreignKey = config.foreignKeys.find(
        (candidate) => candidate.getName() === `${prefix}_admin_operation_fk`,
      );
      expect(foreignKey, `${prefix} admin operation FK`).toBeDefined();
      const reference = foreignKey!.reference();
      expect(reference.columns.map((column) => column.name)).toEqual([
        'tenant_id', 'admin_operation_id',
      ]);
      expect(reference.foreignColumns.map((column) => column.name)).toEqual([
        'tenant_id', 'operation_id',
      ]);
      expect(config.indexes.some((index) => index.config.unique
        && index.config.columns.some((column) => 'name' in column
          && column.name === 'admin_operation_id'))).toBe(false);

      const expectedChecks = new Map([
        [`${prefix}_admin_operation_pair_check`,
          'admin_operation_id is null = admin_operation_hash is null'],
        [`${prefix}_admin_operation_id_check`,
          'admin_operation_id is null or admin_operation_id = btrim(admin_operation_id) and length(admin_operation_id) > 0'],
        [`${prefix}_admin_operation_hash_check`,
          "admin_operation_hash is null or admin_operation_hash ~ '^[0-9a-f]{64}$'"],
      ]);
      for (const [name, expected] of expectedChecks) {
        const check = config.checks.find((candidate) => candidate.name === name);
        expect(check, name).toBeDefined();
        expect(normalizeCheck(dialect.sqlToQuery(check!.value).sql), name).toBe(expected);
      }
    }

    const columns = await db.query<{ table_name: string; column_name: string; is_nullable: string }>(`
      SELECT table_name,column_name,is_nullable FROM information_schema.columns
      WHERE table_name IN ('task_assignments','task_completions')
        AND column_name IN ('admin_operation_id','admin_operation_hash') ORDER BY 1,2`);
    expect(columns.rows).toHaveLength(4);
    expect(columns.rows.every((column) => column.is_nullable === 'YES')).toBe(true);

    const foreignKeys = await db.query<{
      constraint_name: string; local_columns: string[]; foreign_columns: string[];
      foreign_schema: string; foreign_table: string; update_action: string; delete_action: string;
    }>(`
      SELECT c.conname AS constraint_name,
        array_agg(local_att.attname ORDER BY local_key.ordinality) AS local_columns,
        array_agg(foreign_att.attname ORDER BY local_key.ordinality) AS foreign_columns,
        foreign_ns.nspname AS foreign_schema,foreign_rel.relname AS foreign_table,
        c.confupdtype AS update_action,c.confdeltype AS delete_action
      FROM pg_constraint c
      JOIN pg_class foreign_rel ON foreign_rel.oid = c.confrelid
      JOIN pg_namespace foreign_ns ON foreign_ns.oid = foreign_rel.relnamespace
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS local_key(attnum, ordinality) ON true
      JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS foreign_key(attnum, ordinality)
        ON foreign_key.ordinality = local_key.ordinality
      JOIN pg_attribute local_att ON local_att.attrelid = c.conrelid
        AND local_att.attnum = local_key.attnum
      JOIN pg_attribute foreign_att ON foreign_att.attrelid = c.confrelid
        AND foreign_att.attnum = foreign_key.attnum
      WHERE c.conname IN ('task_assignments_admin_operation_fk',
        'task_completions_admin_operation_fk')
      GROUP BY c.conname,foreign_ns.nspname,foreign_rel.relname,c.confupdtype,c.confdeltype
      ORDER BY c.conname`);
    expect(foreignKeys.rows).toEqual([
      { constraint_name: 'task_assignments_admin_operation_fk',
        local_columns: ['tenant_id', 'admin_operation_id'],
        foreign_columns: ['tenant_id', 'operation_id'], foreign_schema: 'public',
        foreign_table: 'operations', update_action: 'a', delete_action: 'a' },
      { constraint_name: 'task_completions_admin_operation_fk',
        local_columns: ['tenant_id', 'admin_operation_id'],
        foreign_columns: ['tenant_id', 'operation_id'], foreign_schema: 'public',
        foreign_table: 'operations', update_action: 'a', delete_action: 'a' },
    ]);

    expect((await db.query<{ security_definer: boolean; config: string[] }>(`
      SELECT prosecdef AS security_definer,proconfig AS config FROM pg_proc
      WHERE oid='validate_task_admin_event_binding()'::regprocedure`)).rows).toEqual([
      { security_definer: false, config: ['search_path=pg_catalog, public'] },
    ]);

    const catalogChecks = await db.query<{ constraint_name: string; definition: string }>(`
      SELECT conname AS constraint_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname ~ '^task_(assignments|completions)_admin_operation_(pair|id|hash)_check$'
      ORDER BY conname`);
    const expectedCatalogChecks = new Map<string, string>();
    for (const prefix of ['task_assignments', 'task_completions']) {
      expectedCatalogChecks.set(`${prefix}_admin_operation_pair_check`,
        'admin_operation_id is null = admin_operation_hash is null');
      expectedCatalogChecks.set(`${prefix}_admin_operation_id_check`,
        'admin_operation_id is null or admin_operation_id = btrim(admin_operation_id) and length(admin_operation_id) > 0');
      expectedCatalogChecks.set(`${prefix}_admin_operation_hash_check`,
        "admin_operation_hash is null or admin_operation_hash ~ '^[0-9a-f]{64}$'");
    }
    expect(catalogChecks.rows).toHaveLength(expectedCatalogChecks.size);
    for (const row of catalogChecks.rows) {
      expect(normalizeCheck(row.definition), row.constraint_name)
        .toBe(expectedCatalogChecks.get(row.constraint_name));
    }
  });

  it('marks operation evidence, administrator binding, and append-only triggers ENABLE ALWAYS', async () => {
    await db.exec(await migration(TARGET));
    expect((await db.query<{ trigger_name: string; enabled: string }>(`
      SELECT tgname AS trigger_name,tgenabled AS enabled FROM pg_trigger
      WHERE tgname IN ('operations_update_guard','task_assignments_admin_binding',
        'task_completions_admin_binding','task_assignments_append_only',
        'task_completions_append_only')
      ORDER BY tgname`)).rows).toEqual([
      { trigger_name: 'operations_update_guard', enabled: 'A' },
      { trigger_name: 'task_assignments_admin_binding', enabled: 'A' },
      { trigger_name: 'task_assignments_append_only', enabled: 'A' },
      { trigger_name: 'task_completions_admin_binding', enabled: 'A' },
      { trigger_name: 'task_completions_append_only', enabled: 'A' },
    ]);
  });

  it('enforces administrator binding and append-only events in replica mode', async () => {
    await seedDefinitions();
    await db.exec(await migration(TARGET));
    await db.query(`INSERT INTO operations (tenant_id,operation_id,operation_kind,payload_hash)
      VALUES ($1,'task-admin','TASK_ADMIN',$2)`, [T1, HASH_A]);
    await insertAssignment('replica-valid', 'ADMIN', 'task-admin', HASH_A);

    await db.exec(`SET session_replication_role = replica`);
    try {
      await expect(insertAssignment('replica-unbound', 'ADMIN', null, null)).rejects.toThrow();
      await expect(db.exec(`UPDATE task_assignments SET note='changed'
        WHERE assignment_id='replica-valid'`)).rejects.toThrow(/append-only|immutable/i);
      await expect(db.exec(`DELETE FROM task_assignments
        WHERE assignment_id='replica-valid'`)).rejects.toThrow(/append-only|immutable/i);
      await expect(db.exec(`UPDATE operations SET payload_hash='${HASH_B}'
        WHERE tenant_id='${T1}' AND operation_id='task-admin'`))
        .rejects.toThrow(/operation binding is immutable/i);
      await expect(db.exec(`UPDATE operations SET operation_kind='PRODUCT_ADMIN'
        WHERE tenant_id='${T1}' AND operation_id='task-admin'`))
        .rejects.toThrow(/operation binding is immutable/i);
    } finally {
      await db.exec(`SET session_replication_role = origin`);
    }
    expect((await db.query(`SELECT operation_kind,payload_hash FROM operations
      WHERE tenant_id=$1 AND operation_id='task-admin'`, [T1])).rows).toEqual([
      { operation_kind: 'TASK_ADMIN', payload_hash: HASH_A },
    ]);
  });

  it('normalizes lifecycle violations as the non-bypass forced-RLS owner and restores FORCE', async () => {
    await seedDefinitions();
    await db.exec(`
      ALTER TABLE tasks DROP CONSTRAINT tasks_deleted_chronology_check;
      UPDATE tasks SET created_at='2026-01-03Z',updated_at='2026-01-01Z',
        deleted_at='2026-01-02Z',is_active=true;
      CREATE ROLE task_migrator NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE,CREATE ON SCHEMA public TO task_migrator;
      ALTER TABLE tasks OWNER TO task_migrator;
      ALTER TABLE task_assignments OWNER TO task_migrator;
      ALTER TABLE task_completions OWNER TO task_migrator;
      ALTER TABLE operations OWNER TO task_migrator;
      GRANT REFERENCES ON operations TO task_migrator;
      SET ROLE task_migrator;
    `);
    try {
      expect((await db.query(`SELECT task_id FROM tasks`)).rows).toEqual([]);
      await db.exec(await migration(TARGET));
    } finally {
      await db.exec('RESET ROLE');
    }
    const rows = await db.query<{
      created_at: Date; updated_at: Date; deleted_at: Date; is_active: boolean;
    }>(`SELECT created_at,updated_at,deleted_at,is_active FROM tasks ORDER BY tenant_id`);
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.updated_at).toEqual(row.created_at);
      expect(row.deleted_at).toEqual(row.created_at);
      expect(row.is_active).toBe(false);
    }
    expect((await db.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid='tasks'::regclass`,
    )).rows).toEqual([{ relforcerowsecurity: true }]);
  });

  it('rolls back a statement error after NO FORCE under its runner-owned transaction', async () => {
    await seedDefinitions();
    await db.exec(`ALTER TABLE tasks DROP CONSTRAINT tasks_deleted_chronology_check;
      UPDATE tasks SET updated_at=created_at - interval '1 day'`);
    const before = (await db.query(`SELECT tenant_id,task_instance_id,created_at,updated_at
      FROM tasks ORDER BY tenant_id,task_instance_id`)).rows;
    const sql = await migration(TARGET);
    const noForce = 'ALTER TABLE tasks NO FORCE ROW LEVEL SECURITY;';
    expect(sql.split(noForce)).toHaveLength(2);
    const faultingSql = sql.replace(noForce,
      `${noForce}\nSELECT missing_task_admin_migration_probe;`);
    await db.exec('BEGIN');
    try {
      await expect(db.exec(faultingSql)).rejects.toThrow(/missing_task_admin_migration_probe/i);
    } finally {
      await db.exec('ROLLBACK');
    }
    expect((await db.query(`SELECT tenant_id,task_instance_id,created_at,updated_at
      FROM tasks ORDER BY tenant_id,task_instance_id`)).rows).toEqual(before);
    expect((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_constraint
      WHERE conname IN ('tasks_updated_chronology_check','tasks_deleted_chronology_check',
        'tasks_deleted_status_check')`)).rows)
      .toEqual([{ count: '0' }]);
    expect((await db.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM information_schema.columns WHERE table_name IN ('task_assignments','task_completions')
        AND column_name IN ('admin_operation_id','admin_operation_hash')`)).rows)
      .toEqual([{ count: '0' }]);
    expect((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_proc
      WHERE proname IN ('validate_task_admin_event_binding','reject_task_event_change')`)).rows)
      .toEqual([{ count: '0' }]);
    expect((await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_trigger
      WHERE tgname IN ('task_assignments_admin_binding','task_completions_admin_binding',
        'task_assignments_append_only','task_completions_append_only')`)).rows)
      .toEqual([{ count: '0' }]);
    expect((await db.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE oid='tasks'::regclass`,
    )).rows).toEqual([{ relforcerowsecurity: true }]);
    expect((await db.query<{ invalid: boolean }>(
      `SELECT updated_at < created_at AS invalid FROM tasks LIMIT 1`,
    )).rows).toEqual([{ invalid: true }]);
  });

  it('enforces source-specific durable bindings while preserving BANK and append-only events', async () => {
    await seedDefinitions();
    await db.exec(`
      INSERT INTO task_assignments
        (tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,
         rule_version,timezone,student_id,event_type,source)
      VALUES ('${T1}','legacy-admin-assignment','task-1','task-instance-1','cycle-1',
        '2026-01-01Z',1,'Asia/Seoul','student-1','ASSIGNED','ADMIN');
      INSERT INTO task_completions
        (tenant_id,completion_id,completed_at,task_instance_id,task_id_snapshot,
         task_name_snapshot,student_id,student_name_snapshot,reward_snapshot,balance_before,
         balance_after,status,cycle_id,cycle_start_at,rule_version,timezone,source)
      VALUES ('${T1}','legacy-admin-completion','2026-01-01T01:00:00Z','task-instance-1',
        'task-1','Task One','student-1','Student One',0,0,0,'COMPLETED','cycle-1',
        '2026-01-01Z',1,'Asia/Seoul','ADMIN_RESET');
    `);
    await db.exec(await migration(TARGET));
    expect((await db.query(`SELECT admin_operation_id FROM task_assignments
      WHERE assignment_id='legacy-admin-assignment'`)).rows).toEqual([{ admin_operation_id: null }]);
    expect((await db.query(`SELECT admin_operation_id FROM task_completions
      WHERE completion_id='legacy-admin-completion'`)).rows).toEqual([{ admin_operation_id: null }]);
    await db.query(`INSERT INTO operations (tenant_id,operation_id,operation_kind,payload_hash) VALUES
      ($1,'task-admin','TASK_ADMIN',$2),($1,'wrong-kind','PRODUCT_ADMIN',$2),
      ($1,'bank-reward','TASK_REWARD',$3),($4,'other-tenant','TASK_ADMIN',$2)`,
    [T1, HASH_A, HASH_B, T2]);

    await insertAssignment('assignment-1', 'ADMIN', 'task-admin', HASH_A);
    await insertAssignment('assignment-2', 'QR', 'task-admin', HASH_A);
    await insertCompletion('completion-1', 'ADMIN', 'task-admin', HASH_A);
    await insertCompletion('completion-2', 'ADMIN_RESET', 'task-admin', HASH_A);
    await insertCompletion('completion-bank', 'BANK', null, null, 'bank-reward');

    await expect(insertAssignment('missing-pair', 'ADMIN', null, null)).rejects.toThrow();
    await expect(insertAssignment('legacy-pair', 'LEGACY_SEED', 'task-admin', HASH_A)).rejects.toThrow();
    await expect(insertAssignment('wrong-kind', 'ADMIN', 'wrong-kind', HASH_A)).rejects.toThrow();
    await expect(insertAssignment('wrong-hash', 'ADMIN', 'task-admin', HASH_B)).rejects.toThrow();
    await expect(insertAssignment('wrong-tenant', 'ADMIN', 'other-tenant', HASH_A)).rejects.toThrow();
    await expect(insertCompletion('bank-admin-pair', 'BANK', 'task-admin', HASH_A)).rejects.toThrow();
    await expect(insertCompletion('admin-missing', 'ADMIN_RESET', null, null)).rejects.toThrow();
    await expect(insertAssignment('half-pair', 'ADMIN', 'task-admin', null)).rejects.toThrow();
    await expect(insertAssignment('blank-with-hash', 'ADMIN', '', HASH_A)).rejects.toThrow();
    await expect(insertAssignment('whitespace-with-hash', 'ADMIN', '  ', HASH_A)).rejects.toThrow();
    await expect(insertAssignment('blank-half-hash', 'ADMIN', '', null)).rejects.toThrow();
    await expect(insertAssignment('whitespace-half-hash', 'ADMIN', '  ', null)).rejects.toThrow();
    await expect(insertAssignment('bad-hash-shape', 'ADMIN', 'task-admin', HASH_A.toUpperCase()))
      .rejects.toThrow();

    await expect(db.exec(`UPDATE task_assignments SET note='changed' WHERE assignment_id='assignment-1'`))
      .rejects.toThrow(/append-only|immutable/i);
    await expect(db.exec(`DELETE FROM task_assignments WHERE assignment_id='assignment-1'`))
      .rejects.toThrow(/append-only|immutable/i);
    await expect(db.exec(`UPDATE task_completions SET note='changed' WHERE completion_id='completion-1'`))
      .rejects.toThrow(/append-only|immutable/i);
    await expect(db.exec(`DELETE FROM task_completions WHERE completion_id='completion-1'`))
      .rejects.toThrow(/append-only|immutable/i);
    expect((await db.query<{ assignments: string; completions: string }>(`SELECT
      (SELECT count(*)::text FROM task_assignments) AS assignments,
      (SELECT count(*)::text FROM task_completions) AS completions`)).rows)
      .toEqual([{ assignments: '3', completions: '4' }]);
  });
});
