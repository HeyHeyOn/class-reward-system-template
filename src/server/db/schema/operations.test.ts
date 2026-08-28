import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { getTableColumns, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  auditEvents,
  exports,
  migrationJobs,
  migrationSnapshots,
  migrationSourceRecords,
  migrationSources,
  operations,
  padletClaimDigestTombstones,
  padletEvidenceClaims,
  reconciliationResults,
} from '@/server/db/schema';

const T1 = '20000000-0000-4000-8000-000000000001';
const T2 = '20000000-0000-4000-8000-000000000002';
const U1 = '10000000-0000-4000-8000-000000000001';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const TASK4_TABLES = [
  'operations', 'migration_jobs', 'migration_sources', 'migration_source_records',
  'migration_snapshots', 'reconciliation_results', 'audit_events', 'exports',
] as const;

let db: PGlite;
let migrationSql: string;

const digest = (boardId: string, postId: string) => createHash('sha256')
  .update(boardId, 'utf8').update('\0').update(postId, 'utf8').digest('hex');

async function seedBase() {
  await db.query(`INSERT INTO users (id, google_subject, canonical_email)
    VALUES ($1, 'subject-one', 'owner@example.com')`, [U1]);
  await db.query(`INSERT INTO tenants (id, slug, display_name) VALUES
    ($1, 'tenant-one', 'Tenant One'), ($2, 'tenant-two', 'Tenant Two')`, [T1, T2]);
}

async function operation(tenant: string, id: string) {
  await db.query(`INSERT INTO operations
    (tenant_id, operation_id, operation_kind, payload_hash)
    VALUES ($1, $2, 'MIGRATION_IMPORT', $3)`, [tenant, id, HASH_A]);
}

async function job(tenant: string, id: string) {
  await db.query(`INSERT INTO migration_jobs (tenant_id, job_id) VALUES ($1, $2)`, [tenant, id]);
}

async function source(tenant: string, jobId: string, sourceId: string, external = sourceId) {
  await db.query(`INSERT INTO migration_sources
    (tenant_id, job_id, source_id, provider, external_source_id, source_fingerprint)
    VALUES ($1, $2, $3, 'GOOGLE_SHEETS', $4, $5)`, [tenant, jobId, sourceId, external, HASH_A]);
}

function ids(suffix: string) {
  return {
    operation: `op-${suffix}`, job: `job-${suffix}`, source: `source-${suffix}`,
    record: `record-${suffix}`, snapshot: `snapshot-${suffix}`, result: `result-${suffix}`,
    audit: `audit-${suffix}`, export: `export-${suffix}`,
  };
}

async function seedTask4Tenant(tenant: string, suffix: string) {
  const value = ids(suffix);
  await operation(tenant, value.operation);
  await job(tenant, value.job);
  await source(tenant, value.job, value.source, `sheet-${suffix}`);
  await db.query(`INSERT INTO migration_source_records
    (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
     source_row_hash,redacted_record,warning_details,error_details)
    VALUES ($1,$2,$3,$4,'Students',$5,$6,'{}','[]','[]')`,
  [tenant, value.job, value.source, value.record, `row-${suffix}`, HASH_A]);
  await db.query(`INSERT INTO migration_snapshots
    (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
    VALUES ($1,$2,$3,$4,'PREFLIGHT',$5,'{}',1)`,
  [tenant, value.job, value.source, value.snapshot, HASH_A]);
  await db.query(`INSERT INTO reconciliation_results
    (tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status,diagnostics)
    VALUES ($1,$2,$3,'STUDENTS',1,1,0,'MATCH','[]')`,
  [tenant, value.job, value.result]);
  await db.query(`INSERT INTO audit_events
    (tenant_id,event_id,operation_id,job_id,event_type,redacted_details)
    VALUES ($1,$2,$3,$4,'RLS_FIXTURE','{}')`,
  [tenant, value.audit, value.operation, value.job]);
  await db.query(`INSERT INTO exports
    (tenant_id,export_id,job_id,kind,status,redacted_metadata)
    VALUES ($1,$2,$3,'CSV','PENDING','{}')`, [tenant, value.export, value.job]);
}

function insertCommands(tenant: string, parentSuffix: string, newSuffix: string) {
  const parent = ids(parentSuffix);
  const value = ids(newSuffix);
  return [
    { table: 'operations', sql: `INSERT INTO operations
      (tenant_id,operation_id,operation_kind,payload_hash) VALUES ($1,$2,'EXPORT',$3)`,
    params: [tenant, value.operation, HASH_B] },
    { table: 'migration_jobs', sql: `INSERT INTO migration_jobs (tenant_id,job_id) VALUES ($1,$2)`,
      params: [tenant, value.job] },
    { table: 'migration_sources', sql: `INSERT INTO migration_sources
      (tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
      VALUES ($1,$2,$3,'GOOGLE_SHEETS',$4,$5)`,
    params: [tenant, parent.job, value.source, `sheet-${newSuffix}`, HASH_B] },
    { table: 'migration_source_records', sql: `INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,
       source_row_hash,redacted_record,warning_details,error_details)
      VALUES ($1,$2,$3,$4,'Students',$5,$6,'{}','[]','[]')`,
    params: [tenant, parent.job, parent.source, value.record, `row-${newSuffix}`, HASH_B] },
    { table: 'migration_snapshots', sql: `INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      VALUES ($1,$2,$3,$4,'PREFLIGHT',$5,'{}',0)`,
    params: [tenant, parent.job, parent.source, value.snapshot, HASH_B] },
    { table: 'reconciliation_results', sql: `INSERT INTO reconciliation_results
      (tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status,diagnostics)
      VALUES ($1,$2,$3,'BALANCES',0,0,0,'MATCH','[]')`,
    params: [tenant, parent.job, value.result] },
    { table: 'audit_events', sql: `INSERT INTO audit_events
      (tenant_id,event_id,operation_id,job_id,event_type,redacted_details)
      VALUES ($1,$2,$3,$4,'RLS_INSERT','{}')`,
    params: [tenant, value.audit, parent.operation, parent.job] },
    { table: 'exports', sql: `INSERT INTO exports
      (tenant_id,export_id,job_id,kind,status,redacted_metadata)
      VALUES ($1,$2,$3,'CSV','PENDING','{}')`,
    params: [tenant, value.export, parent.job] },
  ] as const;
}

async function runtime<T>(tenantId: string | undefined, fn: () => Promise<T>) {
  await db.exec('BEGIN');
  try {
    await db.exec('SET ROLE app_runtime');
    if (tenantId) await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    return await fn();
  } finally {
    try { await db.exec('ROLLBACK'); } finally { await db.exec('RESET ROLE'); }
  }
}

beforeEach(async () => {
  const paths = ['0001_identity_tenants.sql', '0002_operational.sql', '0003_operations_migrations.sql'];
  const sql = await Promise.all(paths.map((name) => readFile(resolve(
    process.cwd(), 'src/server/db/migrations', name,
  ), 'utf8')));
  migrationSql = sql[2];
  db = new PGlite({ extensions: { pgcrypto } });
  for (const statement of sql) await db.exec(statement);
  await seedBase();
});

afterEach(async () => { await db?.close(); });

describe('operations and migration schema', () => {
  it('exports every required public Drizzle table without evidence body or secret-shaped columns', () => {
    const tables = [operations, padletEvidenceClaims, padletClaimDigestTombstones,
      migrationJobs, migrationSources, migrationSourceRecords, migrationSnapshots,
      reconciliationResults, auditEvents, exports];
    expect(tables).toHaveLength(10);
    expect(Object.keys(getTableColumns(operations))).not.toContain('payload');
    expect(Object.keys(getTableColumns(padletEvidenceClaims))).not.toEqual(
      expect.arrayContaining(['body', 'permalink']),
    );
    const forbidden = /(^|_)(recovery|password|secret|token|plaintext|credential|raw)(_|$)/i;
    for (const table of tables) {
      expect(Object.values(getTableColumns(table)).map((column) => column.name)
        .filter((name) => forbidden.test(name))).toEqual([]);
    }
  });

  it('keeps SQL columns, defaults, constraints, and indexes aligned with Drizzle', async () => {
    const tables = [
      operations, padletEvidenceClaims, padletClaimDigestTombstones, migrationJobs,
      migrationSources, migrationSourceRecords, migrationSnapshots,
      reconciliationResults, auditEvents, exports,
    ];
    const dialect = new PgDialect();
    const materialSnapshot: unknown[] = [];
    const serializedDefault = (value: unknown) => {
      if (value instanceof SQL) {
        const query = dialect.sqlToQuery(value);
        return { sql: query.sql, params: query.params.map((item) => (
          typeof item === 'bigint' ? item.toString() : item
        )) };
      }
      return typeof value === 'bigint' ? value.toString() : value;
    };
    for (const table of tables) {
      const config = getTableConfig(table);
      const columns = await db.query<{
        column_name: string; data_type: string; is_nullable: 'YES' | 'NO'; column_default: string | null;
      }>(`SELECT column_name,data_type,is_nullable,column_default
          FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [config.name]);
      expect(columns.rows.map((column) => ({
        name: column.column_name,
        type: column.data_type,
        notNull: column.is_nullable === 'NO',
        hasDefault: column.column_default !== null,
      })), `${config.name} columns`).toEqual(config.columns.map((column) => ({
        name: column.name,
        type: column.getSQLType(),
        notNull: column.notNull,
        hasDefault: column.hasDefault,
      })));

      const constraints = await db.query<{ conname: string; contype: string; definition: string }>(`
        SELECT conname,contype,pg_get_constraintdef(pg_constraint.oid,true) AS definition
        FROM pg_constraint JOIN pg_class ON pg_class.oid=pg_constraint.conrelid
        JOIN pg_namespace ON pg_namespace.oid=pg_class.relnamespace
        WHERE pg_namespace.nspname='public' AND pg_class.relname=$1
          AND pg_constraint.contype<>'n' ORDER BY conname`, [config.name]);
      const expectedConstraints = [
        ...config.checks.map((constraint) => constraint.name),
        ...config.primaryKeys.map((constraint) => constraint.getName()),
        ...config.uniqueConstraints.map((constraint) => constraint.name),
        ...config.foreignKeys.map((constraint) => constraint.getName()),
        ...(config.columns.some((column) => column.primary) ? [`${config.name}_pkey`] : []),
      ].sort();
      expect(constraints.rows.map(({ conname }) => conname), `${config.name} constraints`)
        .toEqual(expectedConstraints);

      const indexes = await db.query<{ indexname: string; indexdef: string }>(`
        SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename=$1
          AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname=indexname
            AND conrelid=('public.' || $1)::regclass)
        ORDER BY indexname`, [config.name]);
      expect(indexes.rows.map(({ indexname }) => indexname), `${config.name} indexes`)
        .toEqual(config.indexes.map((index) => index.config.name).sort());

      materialSnapshot.push({
        table: config.name,
        catalog: {
          columns: columns.rows,
          constraints: constraints.rows,
          indexes: indexes.rows,
        },
        drizzle: {
          columns: config.columns.map((column) => ({
            name: column.name, type: column.getSQLType(), notNull: column.notNull,
            default: serializedDefault(column.default), primary: column.primary,
          })),
          checks: config.checks.map((check) => ({
            name: check.name, definition: dialect.sqlToQuery(check.value),
          })),
          primaryKeys: config.primaryKeys.map((key) => ({
            name: key.getName(), columns: key.columns.map((column) => column.name),
          })),
          uniques: config.uniqueConstraints.map((key) => ({
            name: key.name, columns: key.columns.map((column) => column.name),
            nullsNotDistinct: key.nullsNotDistinct,
          })),
          foreignKeys: config.foreignKeys.map((key) => {
            const reference = key.reference();
            return {
              name: key.getName(), columns: reference.columns.map((column) => column.name),
              foreignTable: getTableConfig(reference.foreignTable).name,
              foreignColumns: reference.foreignColumns.map((column) => column.name),
              onDelete: key.onDelete ?? null, onUpdate: key.onUpdate ?? null,
            };
          }),
          indexes: config.indexes.map((index) => ({
            name: index.config.name, unique: index.config.unique, method: index.config.method,
            columns: index.config.columns.map((column) => {
              if (column instanceof SQL) {
                return { name: dialect.sqlToQuery(column).sql, config: null };
              }
              const indexed = column as { name: string; indexConfig: unknown };
              return { name: indexed.name, config: indexed.indexConfig };
            }),
          })),
        },
      });
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(materialSnapshot)).digest('hex');
    expect(fingerprint).toBe('6045d4b7bf2f3cc4399baee9e6d22783ce017f5bed6b058d5a95253969b4b72f');
  });

  it('binds an arbitrary non-UUID operation ID to one payload and enforces terminal shapes', async () => {
    await operation(T1, 'checkout/request:legacy 001');
    await expect(operation(T1, 'checkout/request:legacy 001')).rejects.toThrow();
    await expect(db.query(`INSERT INTO operations
      (tenant_id, operation_id, operation_kind, payload_hash)
      VALUES ($1, 'bad hash', 'CHECKOUT', 'ABC')`, [T1])).rejects.toThrow();
    await expect(db.query(`UPDATE operations SET status='SUCCEEDED', finished_at=now()
      WHERE tenant_id=$1 AND operation_id='checkout/request:legacy 001'`, [T1])).rejects.toThrow();
    await db.query(`UPDATE operations SET status='SUCCEEDED', result_snapshot='{}'::jsonb,
      finished_at=now(), updated_at=now()
      WHERE tenant_id=$1 AND operation_id='checkout/request:legacy 001'`, [T1]);
    await expect(db.query(`UPDATE operations SET result_snapshot='[]'::jsonb
      WHERE tenant_id=$1 AND operation_id='checkout/request:legacy 001'`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO operations
      (tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,
       started_at,finished_at,created_at,updated_at)
      VALUES ($1,'bad-chronology','EXPORT',$2,'SUCCEEDED','{}',
       '2026-01-01T01:00:00Z','2026-01-01T02:00:00Z',
       '2026-01-01T00:00:00Z','2026-01-01T01:30:00Z')`, [T1, HASH_A])).rejects.toThrow();
    for (const [suffix, assignment] of [
      ['id', `operation_id='rebound-id'`],
      ['kind', `operation_kind='CUTOVER'`],
      ['payload', `payload_hash='${HASH_B}'`],
    ]) {
      const operationId = `immutable-${suffix}`;
      await operation(T1, operationId);
      await expect(db.query(`UPDATE operations SET ${assignment}
        WHERE tenant_id=$1 AND operation_id=$2`, [T1, operationId])).rejects.toThrow(/immutable/i);
    }
    await operation(T1, 'terminal-operation');
    await db.query(`UPDATE operations SET status='SUCCEEDED',result_snapshot='{}',
      finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND operation_id='terminal-operation'`, [T1]);
    await expect(db.query(`UPDATE operations SET status='PENDING',result_snapshot=NULL,
      finished_at=NULL,updated_at=now() WHERE tenant_id=$1 AND operation_id='terminal-operation'`,
    [T1])).rejects.toThrow(/terminal/i);
    await operation(T1, 'failed-operation');
    await db.query(`UPDATE operations SET status='FAILED',failure_code='DECLINED',
      finished_at=now(),updated_at=now() WHERE tenant_id=$1 AND operation_id='failed-operation'`, [T1]);
  });

  it('recomputes the exact legacy Padlet digest in PostgreSQL and rejects mismatches', async () => {
    await operation(T1, 'claim-1');
    const expected = digest('보드/board-1', 'post\u0001-id');
    await db.query(`INSERT INTO padlet_evidence_claims
      (provider, board_id, post_id, tuple_digest, claimed_by_tenant_id,
       claimed_by_operation_id, evidence_created_at, evidence_author_full_name)
      VALUES ('PADLET', $1, $2, $3, $4, 'claim-1', now(), 'Student One')`,
    ['보드/board-1', 'post\u0001-id', expected, T1]);
    const row = await db.query<{ tuple_digest: string }>(
      `SELECT tuple_digest FROM padlet_evidence_claims`,
    );
    expect(row.rows).toEqual([{ tuple_digest: expected }]);
    await operation(T1, 'claim-2');
    await expect(db.query(`INSERT INTO padlet_evidence_claims
      (provider, board_id, post_id, tuple_digest, claimed_by_tenant_id,
       claimed_by_operation_id, evidence_created_at, evidence_author_full_name)
      VALUES ('PADLET', 'board-2', 'post-2', $1, $2, 'claim-2', now(), 'Student')`,
    [HASH_A, T1])).rejects.toThrow(/digest/i);
  });

  it('enforces global tuple uniqueness and immutable claims across tenants', async () => {
    await operation(T1, 'claim-one');
    await operation(T2, 'claim-two');
    const tupleDigest = digest('board', 'post');
    await db.query(`INSERT INTO padlet_evidence_claims
      (provider, board_id, post_id, tuple_digest, claimed_by_tenant_id,
       claimed_by_operation_id, evidence_created_at, evidence_author_full_name)
      VALUES ('PADLET', 'board', 'post', $1, $2, 'claim-one', now(), 'One')`, [tupleDigest, T1]);
    await expect(db.query(`INSERT INTO padlet_evidence_claims
      (provider, board_id, post_id, tuple_digest, claimed_by_tenant_id,
       claimed_by_operation_id, evidence_created_at, evidence_author_full_name)
      VALUES ('PADLET', 'board', 'post', $1, $2, 'claim-two', now(), 'Two')`, [tupleDigest, T2])).rejects.toThrow();
    await expect(db.exec(`UPDATE padlet_evidence_claims SET evidence_author_full_name='Changed'`))
      .rejects.toThrow(/immutable/i);
    await expect(db.exec(`DELETE FROM padlet_evidence_claims`)).rejects.toThrow(/immutable/i);
  });

  it('makes claim and tombstone digests mutually exclusive in either insertion order and immutable', async () => {
    await operation(T1, 'claim-a');
    await operation(T1, 'claim-b');
    const a = digest('board-a', 'post-a');
    const b = digest('board-b', 'post-b');
    await db.query(`INSERT INTO padlet_claim_digest_tombstones
      (tuple_digest, source_provenance) VALUES ($1, 'legacy redis v1')`, [a]);
    await expect(db.query(`INSERT INTO padlet_evidence_claims
      (provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,
       evidence_created_at,evidence_author_full_name)
      VALUES ('PADLET','board-a','post-a',$1,$2,'claim-a',now(),'One')`, [a, T1])).rejects.toThrow();
    await db.query(`INSERT INTO padlet_evidence_claims
      (provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,
       evidence_created_at,evidence_author_full_name)
      VALUES ('PADLET','board-b','post-b',$1,$2,'claim-b',now(),'One')`, [b, T1]);
    await expect(db.query(`INSERT INTO padlet_claim_digest_tombstones
      (tuple_digest, source_provenance) VALUES ($1, 'legacy redis v1')`, [b])).rejects.toThrow();
    await expect(db.exec(`UPDATE padlet_claim_digest_tombstones SET source_provenance='changed'`))
      .rejects.toThrow(/immutable/i);
    await expect(db.exec(`DELETE FROM padlet_claim_digest_tombstones`)).rejects.toThrow(/immutable/i);
  });

  it('enforces source ownership, exact tenant bindings, idempotent record mappings, and redacted JSON shapes', async () => {
    await job(T1, 'job-one'); await job(T2, 'job-two');
    await source(T1, 'job-one', 'source-one', 'sheet-global');
    await expect(source(T2, 'job-two', 'source-two', 'sheet-global')).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-two','source-one','record-x','Students','1',$2,'{}','[]','[]')`,
    [T2, HASH_A])).rejects.toThrow();
    await db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,canonical_record,mapping_status,target_table,target_id,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-1','Students','1',$2,
       '{"name":"Redacted"}','{"studentId":"1"}','IMPORTED','students','1','[]','[]')`, [T1, HASH_A]);
    await db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-2','Students','2',$2,'{}','[]','[]')`,
    [T1, HASH_A]);
    const duplicateContents = await db.query<{ source_record_id: string }>(
      `SELECT source_record_id FROM migration_source_records
       WHERE tenant_id=$1 AND source_id='source-one' AND source_row_hash=$2
       ORDER BY source_record_id`, [T1, HASH_A],
    );
    expect(duplicateContents.rows).toEqual([{ source_record_id: '1' }, { source_record_id: '2' }]);
    await expect(db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-retry','Students','1',$2,'{}','[]','[]')`,
    [T1, HASH_B])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-3','Students','3',$2,'[]','[]','[]')`,
    [T1, HASH_B])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-4','Students','4',$2,
       '{"password":"not allowed"}','[]','[]')`, [T1, 'c'.repeat(64)])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-5','Settings','5',$2,
       '{"Recovery":"not allowed"}','[]','[]')`, [T1, 'd'.repeat(64)])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_source_records
      (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_hash,
       redacted_record,warning_details,error_details)
      VALUES ($1,'job-one','source-one','record-6','Settings','6',$2,
       '{"api_token":"not allowed"}','[]','[]')`, [T1, 'e'.repeat(64)])).rejects.toThrow();
    for (const assignment of [
      `source_record_id='changed'`, `source_row_hash='${HASH_B}'`,
      `redacted_record='{"name":"Changed"}'::jsonb`,
    ]) {
      await expect(db.query(`UPDATE migration_source_records SET ${assignment}
        WHERE tenant_id=$1 AND record_id='record-1'`, [T1])).rejects.toThrow(/immutable/i);
    }
  });

  it('rejects invalid migration activation, snapshot counts, reconciliation arithmetic, and export shapes', async () => {
    await expect(db.query(`INSERT INTO migration_jobs
      (tenant_id,job_id,status,final_fingerprint,completed_at)
      VALUES ($1,'active-bad','ACTIVE',$2,now())`, [T1, HASH_A])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_jobs
      (tenant_id,job_id,status,final_fingerprint,freeze_started_at,freeze_verified_at,
       created_at,completed_at,updated_at)
      VALUES ($1,'active-bad-order','ACTIVE',$2,
       '2026-01-01T01:00:00Z','2026-01-01T02:00:00Z',
       '2026-01-01T00:00:00Z','2026-01-01T01:30:00Z','2026-01-01T03:00:00Z')`,
    [T1, HASH_A])).rejects.toThrow();
    await job(T1, 'job-one'); await source(T1, 'job-one', 'source-one');
    await expect(db.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      VALUES ($1,'job-one','source-one','snap','PREFLIGHT',$2,'{}',-1)`, [T1, HASH_A])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      VALUES ($1,'job-one','source-one','snap-sensitive','PREFLIGHT',$2,
       '{"TOKEN":"not allowed"}',0)`, [T1, HASH_A])).rejects.toThrow();
    await expect(db.query(`INSERT INTO reconciliation_results
      (tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status,diagnostics)
      VALUES ($1,'job-one','result','STUDENTS',2,1,0,'MATCH','[]')`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO reconciliation_results
      (tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status,diagnostics)
      VALUES ($1,'job-one','negative','BALANCES',-1,-1,0,'MATCH','[]')`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO reconciliation_results
      (tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status,diagnostics)
      VALUES ($1,'job-one',' ','STOCK',0,0,0,'MATCH','[]')`, [T1])).rejects.toThrow();
    await db.query(`INSERT INTO reconciliation_results
      (tenant_id,job_id,result_id,category,expected_count,actual_count,delta,status,diagnostics)
      VALUES ($1,'job-one','result','STUDENTS',2,1,-1,'MISMATCH','[]')`, [T1]);
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,artifact_digest,artifact_path,redacted_metadata)
      VALUES ($1,'export','CSV','PENDING',$2,'private/file','{}')`, [T1, HASH_A])).rejects.toThrow();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,redacted_metadata)
      VALUES ($1,'export-sensitive','CSV','PENDING','{"Recovery":"not allowed"}')`,
    [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,artifact_digest,artifact_path,redacted_metadata)
      VALUES ($1,'ready-no-completion','CSV','READY',$2,'private/file','{}')`,
    [T1, HASH_A])).rejects.toThrow();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,completed_at,redacted_metadata)
      VALUES ($1,'pending-completed','CSV','PENDING',now(),'{}')`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,completed_at,redacted_metadata)
      VALUES ($1,'failed-valid','CSV','FAILED',now(),'{}')`, [T1])).resolves.toBeDefined();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,completed_at,redacted_metadata)
      VALUES ($1,'expired-no-expiry','CSV','EXPIRED',now(),'{}')`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,kind,status,created_at,expires_at,completed_at,redacted_metadata)
      VALUES ($1,'expired-valid','CSV','EXPIRED',now()-interval '2 minutes',
       now()-interval '1 minute',now(),'{}')`, [T1])).resolves.toBeDefined();
  });

  it('rejects cross-tenant job, source, operation, audit, and export references', async () => {
    await operation(T2, 'other-op'); await job(T2, 'other-job'); await source(T2, 'other-job', 'other-source');
    await expect(db.query(`INSERT INTO audit_events
      (tenant_id,event_id,operation_id,event_type,redacted_details)
      VALUES ($1,'audit','other-op','TEST','{}')`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO exports
      (tenant_id,export_id,job_id,kind,status,redacted_metadata)
      VALUES ($1,'export','other-job','CSV','PENDING','{}')`, [T1])).rejects.toThrow();
    await expect(db.query(`INSERT INTO migration_snapshots
      (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
      VALUES ($1,'other-job','other-source','snap','PREFLIGHT',$2,'{}',0)`, [T1, HASH_A])).rejects.toThrow();
  });

  it('keeps audit events append-only', async () => {
    await db.query(`INSERT INTO audit_events
      (tenant_id,event_id,actor_user_id,event_type,entity_type,entity_id,redacted_details)
      VALUES ($1,'audit-1',$2,'MIGRATION_STARTED','migration_job','job-1','{}')`, [T1, U1]);
    await expect(db.exec(`UPDATE audit_events SET event_type='CHANGED'`)).rejects.toThrow(/immutable/i);
    await expect(db.exec(`DELETE FROM audit_events`)).rejects.toThrow(/immutable/i);
    await expect(db.query(`INSERT INTO audit_events
      (tenant_id,event_id,event_type,redacted_details)
      VALUES ($1,'audit-sensitive','TEST','{"Password":"not allowed"}')`, [T1])).rejects.toThrow();
  });

  it('behaviorally enforces forced fail-closed RLS over every Task 4 tenant table', async () => {
    await seedTask4Tenant(T1, 'one');
    await seedTask4Tenant(T2, 'two');
    await db.exec('CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS');
    await db.exec('GRANT USAGE ON SCHEMA public TO app_runtime');
    await db.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${TASK4_TABLES.join(',')} TO app_runtime`);

    await runtime(undefined, async () => {
      for (const table of TASK4_TABLES) {
        expect((await db.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
        expect((await db.query(`UPDATE ${table} SET tenant_id=tenant_id RETURNING tenant_id`)).rows)
          .toEqual([]);
        expect((await db.query(`DELETE FROM ${table} RETURNING tenant_id`)).rows).toEqual([]);
      }
    });
    for (const [index, command] of insertCommands(T1, 'one', 'missing').entries()) {
      await expect(runtime(undefined, () => db.query(command.sql, [...command.params])),
        `${command.table} insert must fail without context (${index})`)
        .rejects.toThrow(/row-level security/i);
    }

    await runtime(T1, async () => {
      for (const table of TASK4_TABLES) {
        expect((await db.query(`SELECT DISTINCT tenant_id::text AS tenant_id FROM ${table}`)).rows)
          .toEqual([{ tenant_id: T1 }]);
        if (table !== 'audit_events') {
          expect((await db.query(
            `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1 RETURNING tenant_id`, [T1],
          )).rows).toHaveLength(1);
        }
      }
      for (const command of insertCommands(T1, 'one', 'same')) {
        expect((await db.query(command.sql, [...command.params])).affectedRows,
          `${command.table} must permit same-tenant insert`).toBe(1);
      }
    });

    await runtime(T1, async () => {
      for (const table of TASK4_TABLES) {
        expect((await db.query(`SELECT * FROM ${table} WHERE tenant_id=$1`, [T2])).rows).toEqual([]);
        expect((await db.query(
          `UPDATE ${table} SET tenant_id=tenant_id WHERE tenant_id=$1 RETURNING tenant_id`, [T2],
        )).rows).toEqual([]);
        expect((await db.query(`DELETE FROM ${table} WHERE tenant_id=$1 RETURNING tenant_id`, [T2])).rows)
          .toEqual([]);
      }
    });
    for (const command of insertCommands(T2, 'two', 'cross')) {
      await expect(runtime(T1, () => db.query(command.sql, [...command.params])),
        `${command.table} must reject cross-tenant insert`).rejects.toThrow(/row-level security/i);
    }
  });

  it('enables and forces RLS in the migration for every tenant-owned table', () => {
    for (const table of TASK4_TABLES) {
      expect(migrationSql).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, 'i'));
      expect(migrationSql).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`, 'i'));
      expect(migrationSql).toMatch(new RegExp(`CREATE POLICY ${table}_tenant_isolation`, 'i'));
    }
  });
});
