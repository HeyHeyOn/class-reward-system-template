// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { backupPreparedDatabase, allocateRestoreTarget, restoreMaterializedDatabase, verifyRestoreRollback } from '@/server/db/testing/materializedRestore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { materializeLocalCandidate, prepareLocalCandidateTransition } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, TENANT } from '../../../test-support/task19DeleteFixture';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(() => { vi.restoreAllMocks(); });
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
async function fixture() {
  const f = await deleteFixture(), q = await f.local.owner.connect();
  try {
    await q.query('BEGIN');
    expect((await q.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Products' AND cells->>0='P1' RETURNING cells",
      [JSON.stringify(['P1','Final modified pencil','27','8','TRUE','','school','1']),TENANT])).rowCount).toBe(1);
    expect((await q.query("DELETE FROM task19_delete_rows WHERE tenant=$1 AND tab='Products' AND cells->>0='PX' RETURNING cells",[TENANT])).rowCount).toBe(1);
    await q.query('UPDATE task19_delete_checkpoint SET revision=revision+1 WHERE tenant=$1',[TENANT]);
    await q.query('COMMIT');
  } catch (error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  const candidate = await f.capture(), {binding} = await f.stage(candidate);
  await materializeLocalCandidate(binding,f.run());
  const reports = (await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
  const materialization = (await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent = {binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
    expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),expectedMaterializationDigest:sha256(canonicalJson(materialization))};
  const lease = (db:typeof f.source) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId:f.ownerId,
    queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
  return {...f,binding,intent,candidate,sourceLease:lease(f.source),destinationLease:lease(f.destination)};
}

suite('Task19 prepared archive complete privilege boundary',() => {
  it.each(['schema-create','function-acl','sequence-acl','column-acl','default-acl','role-admin','role-membership','source-schema'])(
    'refuses %s before native dump, not merely after physical restoration',async fault => {
    const f=await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    if (fault==='schema-create') await f.destination.owner.query('GRANT CREATE ON SCHEMA public TO app_runtime');
    if (fault==='source-schema') await f.source.owner.query('GRANT CREATE ON SCHEMA public TO app_runtime');
    if (fault==='function-acl') await f.destination.owner.query('REVOKE EXECUTE ON FUNCTION public.enforce_migration_job_transition() FROM PUBLIC');
    if (fault==='sequence-acl') await f.destination.owner.query('GRANT UPDATE ON SEQUENCE public.inventory_ledger_event_sequence_seq TO app_runtime');
    if (fault==='column-acl') await f.destination.owner.query('GRANT UPDATE (state_version) ON migration_jobs TO app_runtime');
    if (fault==='default-acl') await f.destination.owner.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_runtime');
    if (fault==='role-admin') await f.destination.owner.query('ALTER ROLE app_runtime CREATEROLE');
    if (fault==='role-membership') await f.destination.owner.query('GRANT pg_read_all_data TO app_runtime');
    const before=await f.state(), dump=vi.spyOn(archive,'dumpOwnedDatabase');
    await expect(backupPreparedDatabase(f.source,f.destination,f.intent)).rejects.toThrow();
    expect(dump).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
  },150_000);
  it.each(['transaction','postcommit'])('refuses %s privilege escalation with rollback or irreversible quarantine',async phase => {
    const f=await fixture(); await prepareLocalCandidateTransition(f.intent,f.run());
    const backup=await backupPreparedDatabase(f.source,f.destination,f.intent), before=await f.state();
    const destination=await createDisposablePostgres();
    try {
      const target=await allocateRestoreTarget(destination,randomUUID(),f.binding), native=archive.executeOwnedRestore;
      const execute=vi.spyOn(archive,'executeOwnedRestore').mockImplementation(async (db,script) => {
        if (phase==='transaction') return native(db,script.replace('SET search_path=pg_catalog,public;',
          'GRANT CREATE ON SCHEMA public TO app_runtime; SET search_path=pg_catalog,public;'));
        await native(db,script); await db.owner.query('GRANT CREATE ON SCHEMA public TO app_runtime');
      });
      await expect(restoreMaterializedDatabase(backup,target)).rejects.toThrow();
      expect(execute).toHaveBeenCalledOnce(); expect(await verifyRestoreRollback(target)).toBe(phase==='transaction');
      if (phase==='transaction') expect((await destination.owner.query("SELECT 1 FROM pg_tables WHERE schemaname='public'")).rows).toEqual([]);
      else await expect(restoreMaterializedDatabase(backup,target)).rejects.toThrow();
      expect(execute).toHaveBeenCalledOnce(); expect(await f.state()).toEqual(before);
    } finally { console.info('TASK19_PRIVILEGE_TARGET_CLEANUP',JSON.stringify(await destination.close())); }
  },180_000);
});
