// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { cleanupDeleteFixture, deleteFixture, TENANT, JOB } from '../../../test-support/task19DeleteFixture';
import { hash, sqlImage, rows, verifySource } from '../../../test-support/task19PublicationOracle';
import { stageLegacyFinalGeneration, inspectLegacyFinalGeneration } from './finalGeneration';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';
import { materializeLocalCandidate, prepareLocalCandidateTransition } from './localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import type { TenantImportTransactionRunner } from './importer';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
afterEach(async () => { vi.restoreAllMocks(); await cleanupDeleteFixture(); });
const DIRECTORY = '.task19-source-deferred-results';
function evidence(name: string, value: unknown) {
  mkdirSync(DIRECTORY,{recursive:true,mode:0o700});
  const path = `${DIRECTORY}/${name}-${randomUUID()}.json`;
  writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600});
  console.info('TASK19_SOURCE_DEFERRED_WITNESS',JSON.stringify({name,path,sha256:hash(value)}));
}
async function fixture() {
  const f = await deleteFixture();
  await f.commitDelete();
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=$1::jsonb
    WHERE tenant=$2 AND tab='Products' AND cells->>0='P1'`,
  [JSON.stringify(['P1','Publication pencil','31','8','TRUE','','school','1']),TENANT]);
  const candidate = await f.capture();
  return {...f,candidate,finalInput:f.input(candidate)};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const bodies = {
  authority:"UPDATE migration_jobs SET final_fingerprint=repeat('c',64),freeze_started_at=created_at,freeze_verified_at=created_at WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;",
  binding:"UPDATE migration_jobs SET source_fingerprint=repeat('b',64) WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;",
  product:"UPDATE products SET name='Changed after source validation' WHERE tenant_id=NEW.tenant_id AND product_id='P1';",
  removedBefore:"UPDATE products SET name='Changed deleted before-image' WHERE tenant_id=NEW.tenant_id AND product_id='PX';",
  settings:'DELETE FROM tenant_settings WHERE tenant_id=NEW.tenant_id;',
  audit:"UPDATE audit_events SET redacted_details='{}'::jsonb WHERE tenant_id=NEW.tenant_id AND event_id=NEW.event_id;",
  noop:'PERFORM 1;',
};
async function install(f: Fixture, fault: keyof typeof bodies, deferred: boolean) {
  // Owner-installed fixture injection, NOT a claim app_runtime can create these.
  // Native immutable/RLS/FK guards remain enabled. Only scheduling is varied.
  await f.source.owner.query(`CREATE SEQUENCE source_u_seen;
    CREATE FUNCTION source_u_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    DECLARE affected integer; BEGIN
      PERFORM nextval('public.source_u_seen'); ${bodies[fault]}
      ${fault === 'noop' ? '' : "GET DIAGNOSTICS affected=ROW_COUNT; IF affected<>1 THEN RAISE EXCEPTION 'source_u_invalid_affected_count'; END IF;"}
      RETURN NEW; END $$;
    CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER source_u_fault AFTER INSERT ON audit_events
      ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW
      WHEN (NEW.event_type='MIGRATION_PREPARATION_PLAN') EXECUTE FUNCTION source_u_fault()`);
  const definition = (await f.source.owner.query(`SELECT pg_get_triggerdef(t.oid) AS definition,tgdeferrable,tginitdeferred,
    p.prosecdef AS security_definer FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE tgname='source_u_fault'`)).rows;
  expect(definition).toMatchObject([{tgdeferrable:deferred,tginitdeferred:deferred,security_definer:true}]);
  const role = (await f.source.runtime.query(`SELECT current_user,rolsuper,rolbypassrls,
    has_table_privilege(current_user,'audit_events','TRIGGER') AS can_install FROM pg_roles WHERE rolname=current_user`)).rows;
  expect(role).toEqual([{current_user:'app_runtime',rolsuper:false,rolbypassrls:false,can_install:false}]);
  return {definition,role,fault,deferred,body:bodies[fault]};
}
async function drop(f: Fixture) {
  await f.source.owner.query('DROP TRIGGER source_u_fault ON audit_events; DROP FUNCTION source_u_fault(); DROP SEQUENCE source_u_seen');
}
async function image(f: Fixture) {
  return {source:await sqlImage(f.source),local:await sqlImage(f.local),destination:await sqlImage(f.destination),tuples:await f.state()};
}
const seen = async (f: Fixture) => (await f.source.owner.query('SELECT last_value::text,is_called FROM source_u_seen')).rows;
function observe(f: Fixture) {
  const completedStatements: string[] = [], callbackReadbacks: unknown[] = [];
  const dialect = new PgDialect();
  const run: TenantImportTransactionRunner = (tenant, callback) => f.source.runTenantTransaction(tenant,async tx => {
    const execute = tx.execute.bind(tx);
    const observedTx = new Proxy(tx, {get(target,key,receiver) {
      if (key !== 'execute') return Reflect.get(target,key,receiver);
      return async (query: Parameters<typeof tx.execute>[0]) => {
        const text = typeof query === 'string' ? query : dialect.sqlToQuery(query.getSQL()).sql;
        const result = await execute(query);
        completedStatements.push(text);
        return result;
      };
    }});
    const result = await callback(observedTx);
    callbackReadbacks.push({job:(await execute(sql`SELECT to_jsonb(j) AS value FROM migration_jobs j`)).rows,
      products:(await execute(sql`SELECT to_jsonb(p) AS value FROM products p ORDER BY product_id`)).rows,
      pending:await seen(f)});
    return result;
  });
  return {run,completedStatements,callbackReadbacks};
}
async function positive(f: Fixture) {
  const before = await image(f);
  const prepared = await stageLegacyFinalGeneration(f.finalInput,{runTransaction:f.source.runTenantTransaction});
  expect(prepared.plan).toMatchObject({status:'DIFF_VALIDATED',blockers:[]});
  expect(prepared.plan.changes.map(row => [row.table,row.identity,row.kind])).toEqual([
    ['products','["P1"]','MUTATED'],['products','["PX"]','REMOVED'],
  ]);
  const staged = await f.stage(f.candidate), after = await image(f);
  expect(staged.staged).toMatchObject({scope:'LOCAL_FULL_MUTABLE_SNAPSHOT',authority:'NONAUTHORITY',
    activationAllowed:false,complete:false,exclusion:'NOT_PROVEN',persistedReadback:'MATCH'});
  const oracle = verifySource(after.source,f.old,staged.next);
  expect(after.local).toEqual(before.local); expect(after.destination).toEqual(before.destination);
  for (const [table,value] of Object.entries(before.source)) {
    if (table==='audit_events' || table.startsWith('migration_full_')) {
      expect(value.every(row => after.source[table].includes(row)),table).toBe(true);
    } else expect(after.source[table],table).toEqual(value);
  }
  expect(await stageLegacyFinalGeneration(f.finalInput,{runTransaction:f.source.runTenantTransaction})).toEqual(prepared);
  expect(await inspectLegacyFinalGeneration(f.finalInput,f.source.runTenantTransaction)).toEqual(prepared);
  expect(await f.stage(f.candidate)).toEqual(staged);
  await expect(stageLocalFullDeltaCheckedPreparation(f.finalInput,f.source.runTenantTransaction)).rejects.toThrow();
  expect(await image(f)).toEqual(after);
  return {before,after,prepared,staged,oracle,exactRetry:true,addedOnlyRefused:true};
}
suite('Task19 source final readback deferred boundary', () => {
  it('bounded negative: armed source trigger is not queued by native materialization retry or preparation readback',async () => {
    const f = await fixture(), staged = await f.stage(f.candidate);
    await materializeLocalCandidate(staged.binding,f.run());
    const trigger = await install(f,'authority',true), before = await image(f);
    // Positive reach control: actual native runtime INSERT + flush + SQL effect,
    // then explicit fixture rollback. No fake query result and no extra grants.
    let reachedJob: unknown;
    await expect(f.source.runTenantTransaction(TENANT,async tx => {
      await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,event_type,redacted_details)
        VALUES(${TENANT},'source-u-native-reach-control',${JOB},'MIGRATION_PREPARATION_PLAN','{}'::jsonb)`);
      await tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      reachedJob = (await tx.execute(sql`SELECT final_fingerprint,freeze_started_at IS NOT NULL AS started,
        freeze_verified_at IS NOT NULL AS verified FROM migration_jobs`)).rows;
      throw new Error('SOURCE_U_CONTROL_ROLLBACK');
    })).rejects.toThrow('SOURCE_U_CONTROL_ROLLBACK');
    expect(reachedJob).toEqual([{final_fingerprint:'c'.repeat(64),started:true,verified:true}]);
    expect(await image(f)).toEqual(before); expect(await seen(f)).toEqual([{last_value:'1',is_called:true}]);
    const observed = observe(f);
    const lease = (db: Fixture['source']) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId:f.ownerId,
      queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),
      runTransaction:db===f.source ? observed.run : db.runTenantTransaction});
    const run = createOwnedLocalMaterializationRunner(TENANT,JOB,lease(f.source),lease(f.destination));
    const retry = await materializeLocalCandidate(staged.binding,run);
    const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
      FROM migration_full_reconciliation ORDER BY category`)).rows;
    const intent = {binding:staged.binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
      expectedDestinationStateVersion:'2',expectedReportDigest:hash(reports),
      expectedMaterializationDigest:hash(rows(before.destination,'migration_local_materializations')[0])};
    const prepared = await prepareLocalCandidateTransition(intent,run), after = await image(f), reached = await seen(f);
    evidence('bounded-readonly',{before,after,trigger,reachedJob,reached,statements:observed.completedStatements,
      callbackReadbacks:observed.callbackReadbacks,retry,prepared,oracle:verifySource(after.source,f.old,staged.next)});
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    expect(observed.completedStatements.length).toBeGreaterThan(0);
    expect(observed.completedStatements.every(text => /^\s*SELECT\b/i.test(text))).toBe(true);
    expect(after.source).toEqual(before.source); expect(after.tuples.source).toEqual(before.tuples.source);
    expect(after.local).toEqual(before.local);
    expect(prepared).toMatchObject({authority:'NONAUTHORITY',activationAllowed:false,complete:false});
  },180_000);

  it.each([
    ['authority',true],['binding',true],['product',true],['removedBefore',true],['settings',true],
    ['product',false],['authority',false],['audit',true],
  ] as const)('refuses native final PLAN %s deferred=%s before returning source preparation',async (fault,deferred) => {
    const f = await fixture(), trigger = await install(f,fault,deferred), before = await image(f), observed = observe(f);
    const outcome = await stageLegacyFinalGeneration(f.finalInput,{runTransaction:observed.run})
      .then(value => ({accepted:true,value,error:null}), (error: Error) => ({accepted:false,value:null,error:error.message}));
    const after = await image(f), reached = await seen(f);
    evidence(`${fault}-${deferred}`,{before,after,outcome,trigger,reached,callbackReadbacks:observed.callbackReadbacks,
      statements:observed.completedStatements,physical:f.source.evidence});
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    expect(outcome).toEqual({accepted:false,value:null,error:'Final generation preparation refused.'});
    expect(after).toEqual(before);
    await drop(f);
    evidence(`retry-${fault}-${deferred}`,await positive(f));
  },180_000);

  it.each([false,true])('accepts native final PLAN noop deferred=%s and exact full modified/deleted retry',async deferred => {
    const f = await fixture(), trigger = await install(f,'noop',deferred), result = await positive(f), reached = await seen(f);
    evidence(`noop-${deferred}`,{trigger,reached,...result});
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
  },180_000);
});
