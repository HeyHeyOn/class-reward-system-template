// @vitest-environment node
// Logical backup rehearsal in owned native PostgreSQL; not managed-provider PITR.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { dumpOriginalOwnedDatabase, executeOwnedRestore, inspectArchiveDatabase } from '@/server/db/testing/ownedPgArchive';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { createDatabaseTaskCompletionCommand } from '@/server/repositories/database/taskCompletionCommands';
import { createDatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { createLegacyFullSnapshotImporter } from './importLegacyFullSnapshot';
import { createLegacyRedisSnapshotStager, publishLegacyClaimsInternal } from './legacyClaimPublication';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' && process.env.CRS_PRIVATE_BASELINE ? describe : describe.skip;
const owned: DisposablePostgres[] = [];
const archives = ['legacy_transaction_origins', 'legacy_task_origins', 'legacy_full_snapshot_archives',
  'legacy_redis_snapshot_archives', 'legacy_claim_publications'];
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Query = Pick<Pool, 'query'>;

async function witness(q: Query) {
  const tables: Record<string, { count: number; sha256: string }> = {};
  for (const { tablename } of (await q.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
    const { count, wire } = (await q.query(`SELECT count(*)::int AS count,
      COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS wire
      FROM public.${identifier(tablename)} t`)).rows[0];
    tables[tablename] = { count, sha256: sha256(wire) };
  }
  const guards = (await q.query(`SELECT jsonb_agg(v ORDER BY v::text)::text AS wire FROM (
    SELECT jsonb_build_array('table',c.relname,c.relrowsecurity,c.relforcerowsecurity) v
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
    UNION ALL SELECT jsonb_build_array('trigger',t.tgrelid::regclass::text,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
    -- Pretty deparsing normalizes redundant AND parentheses introduced by
    -- BETWEEN expansion on the initial parse; retain operator precedence.
    UNION ALL SELECT jsonb_build_array('constraint',c.conrelid::regclass::text,c.conname,c.convalidated,pg_get_constraintdef(c.oid,true))
      FROM pg_constraint c WHERE c.connamespace='public'::regnamespace
    UNION ALL SELECT jsonb_build_array('policy',to_jsonb(p)) FROM pg_policies p WHERE schemaname='public'
    UNION ALL SELECT jsonb_build_array('grant',to_jsonb(g)) FROM information_schema.role_table_grants g WHERE table_schema='public'
  ) s`)).rows[0].wire;
  const sequences: Record<string, unknown> = {};
  for (const { sequencename } of (await q.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
    sequences[sequencename] = (await q.query(`SELECT last_value::text,is_called FROM public.${identifier(sequencename)}`)).rows;
  }
  return { tables, sequences, guards: sha256(guards), guardRows: JSON.parse(guards) as unknown[] };
}

suite('whole native backup of imported legacy history', () => {
  afterAll(async () => {
    for (const db of owned) expect(await db.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
  }, 60_000);

  it('restores every row and guard after deleting its source, preserves readers and duplicate reward protection', async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const source = await createDisposablePostgres(); owned.push(source);
    await source.owner.query(`GRANT SELECT,INSERT ON ${archives.join(',')} TO app_runtime`);
    const tenantId = randomUUID(), migrationJobId = randomUUID(), sourceId = randomUUID(), redisSourceId = randomUUID();
    const gridJson = await readFile(process.env.CRS_PRIVATE_BASELINE!, 'utf8');
    await source.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Restore rehearsal','IMPORTING')", [tenantId, 'restore-' + tenantId]);
    await source.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [tenantId, migrationJobId]);
    await source.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint,schema_version)
      VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5,4)`, [tenantId, migrationJobId, sourceId, sha256(tenantId), sha256(gridJson)]);
    await createLegacyFullSnapshotImporter(source.runTenantTransaction)({ tenantId, migrationJobId, sourceId, gridJson, capturedAt: '2026-09-29T09:36:55.078Z' });
    const evidence = { evidenceProvider: 'PADLET' as const, evidenceBoardId: 'BOARD000000000001', evidencePostId: 'restored-used-post',
      evidenceCreatedAt: '2026-09-01T00:00:00.000Z', evidenceAuthorFullName: 'Synthetic author' };
    const operationId = randomUUID(), tuple = sha256(`${evidence.evidenceBoardId}\0${evidence.evidencePostId}`);
    const binding = { taskId: 'synthetic-task', studentId: 'synthetic-student', cycleStartsAt: '2026-09-01T00:00:00.000Z', evidence };
    const snapshot = await captureRedisClaimSnapshot({ getRevision: async () => 'restore-fixture-1',
      hscan: async () => ({ cursor: '0', entries: [[`claim:${tuple}`, operationId],
        [`op:${sha256(operationId)}`, JSON.stringify({ binding, claimField: `claim:${tuple}` })]] }),
      scan: async () => ({ cursor: '0', keys: [`padlet:evidence-claim:v1:${sha256('restore-v1')}`] }), get: async () => 'old-owner' },
    { capturedAt: '2026-09-29T09:36:55.078Z' });
    await source.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
      VALUES($1,$2,$3,'LEGACY_REDIS_BRIDGE',$4,$5)`, [tenantId, migrationJobId, redisSourceId, sha256(redisSourceId), snapshot.digest]);
    await createLegacyRedisSnapshotStager(source.runTenantTransaction)({ tenantId, migrationJobId, sourceId: redisSourceId, snapshot });
    // Fixture preparation only. This is not evidence of live source exclusion or C activation.
    for (const status of ['IMPORTING', 'RECONCILING', 'READY', 'FREEZING', 'FINAL_IMPORT']) {
      await source.owner.query(`UPDATE migration_jobs SET status=$2,state_version=state_version+1,updated_at=now(),
        freeze_started_at=CASE WHEN $2='FREEZING' THEN now() ELSE freeze_started_at END,
        freeze_verified_at=CASE WHEN $2='FINAL_IMPORT' THEN now() ELSE freeze_verified_at END WHERE tenant_id=$1`, [tenantId, status]);
    }
    await source.runTenantTransaction(tenantId, async tx => {
      await publishLegacyClaimsInternal(tx, { tenantId, migrationJobId, sourceId: redisSourceId,
        expectedStateVersion: '6', expectedSourceDigest: snapshot.digest });
      await tx.execute(sql`UPDATE tenants SET lifecycle='ACTIVE' WHERE id=${tenantId}`);
    });
    const read = async (db: DisposablePostgres) => ({
      transactions: await createDatabaseTransactionQueries({ tenantId, runTenantTransaction: db.runTenantTransaction }).getTransactions(),
      tasks: await createDatabaseTaskCycleQueries({ tenantId, runTenantSnapshot: db.runTenantTransaction })
        .listTaskCycleProjections({ now: '2026-09-30T00:00:00.000Z' }),
    });
    const beforeRead = await read(source), before = await witness(source.owner);
    expect(beforeRead.transactions).toHaveLength(9); expect(beforeRead.tasks).toHaveLength(2);
    const sourceIdentity = await inspectArchiveDatabase(source), connection = await source.owner.connect();
    let dump: Buffer;
    try {
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const snapshotId = (await connection.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
      dump = await dumpOriginalOwnedDatabase(source, snapshotId);
      await connection.query('COMMIT');
    } finally { connection.release(); }
    expect(await source.close()).toMatchObject({ containerRemoved: true, scratchRemoved: true });
    owned.splice(owned.indexOf(source), 1);
    const restored = await createDisposablePostgres(); owned.push(restored);
    const restoredIdentity = await inspectArchiveDatabase(restored);
    expect(restoredIdentity.systemIdentifier).not.toBe(sourceIdentity.systemIdentifier);
    // Exact, freshly owned target only; restore application DDL/data from pg_dump.
    const start = performance.now();
    await executeOwnedRestore(restored, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC;\n' + dump.toString('utf8'));
    const restoreMs = performance.now() - start;
    const after = await witness(restored.owner);
    expect(after.tables, 'restored table counts and content digests').toEqual(before.tables);
    expect(after.sequences, 'restored sequence positions').toEqual(before.sequences);
    if (after.guards !== before.guards) {
      const oldRows = new Set(before.guardRows.map(row => canonicalJson(row))), newRows = new Set(after.guardRows.map(row => canonicalJson(row)));
      console.info('RESTORE_GUARD_DIFFERENCE', { sourceOnly: [...oldRows].filter(row => !newRows.has(row)),
        restoredOnly: [...newRows].filter(row => !oldRows.has(row)) });
    }
    expect(after.guards, 'restored constraints, triggers, RLS and grants').toEqual(before.guards);
    expect(await read(restored)).toEqual(beforeRead);
    expect(await restored.runTenantTransaction(tenantId, tx => createDatabasePadletClaimRepository().findClaimedPostIds(tx,
      evidence.evidenceBoardId, [evidence.evidencePostId, 'unused']))).toEqual([evidence.evidencePostId]);
    const historical = (await restored.owner.query(`SELECT historical_operation_id AS operation_id,
      projection->>'task_id_snapshot' AS task_id,projection->>'student_id' AS student_id
      FROM legacy_task_origins WHERE tenant_id=$1 AND historical_operation_id IS NOT NULL LIMIT 1`, [tenantId])).rows[0];
    expect(historical).toBeDefined();
    await expect(createDatabaseTaskCompletionCommand({ tenantId, runTenantTransaction: restored.runTenantTransaction,
      padletClaims: createDatabasePadletClaimRepository(), now: () => new Date('2026-10-01T00:00:00.000Z') })
      .execute({ operationId: historical.operation_id, taskId: historical.task_id, studentId: historical.student_id }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    for (const table of archives) {
      await expect(restored.owner.query(`DELETE FROM ${identifier(table)} WHERE tenant_id=$1`, [tenantId])).rejects.toThrow(/immutable/);
      const hidden = await restored.runTenantTransaction(randomUUID(), tx => tx.execute(sql.raw(`SELECT * FROM ${identifier(table)}`)));
      expect(hidden.rows).toEqual([]);
    }
    expect(await witness(restored.owner)).toEqual(before);
    if (process.env.CRS_LEGACY_RESTORE_REPORT) await writeFile(process.env.CRS_LEGACY_RESTORE_REPORT, JSON.stringify({
      scope: 'LOCAL_NATIVE_LOGICAL_RESTORE', managedBackupAccepted: false, realRedisCapture: false,
      sourceDigest: sha256(gridJson), dumpSha256: sha256(dump.toString('utf8')), dumpBytes: dump.length, restoreMs,
      sourceRemovedBeforeRestore: true, differentDatabaseSystem: true, allTablesMatched: true,
      sequencesAndGuardsMatched: true, applicationReadersMatched: true, oldRewardReplayRejected: true,
      historicalClaimsRetained: true, archiveImmutabilityAndIsolationPassed: true,
      tableCount: Object.keys(before.tables).length, totalRows: Object.values(before.tables).reduce((n, t) => n + t.count, 0),
      witnessDigest: sha256(canonicalJson(before)),
    }, null, 2) + '\n', { mode: 0o600 });
  }, 120_000);
});
