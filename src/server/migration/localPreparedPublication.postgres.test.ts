// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeLocalCandidate, prepareLocalCandidateTransition, reconcileLocalPreparedTransition } from './localCandidateMaterialization';
import { deleteFixture, cleanupDeleteFixture, TENANT } from '../../../test-support/task19DeleteFixture';
import { hash, sqlImage, rows, verifySource, verifyDestination, type Image } from '../../../test-support/task19PublicationOracle';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); }}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const REFUSED = 'Local prepared transition refused.';
const DIRECTORY = '.task19-prepared-publication-results';
afterEach(async () => { vi.restoreAllMocks(); await cleanupDeleteFixture(); });
function evidence(name: string, value: unknown) {
  mkdirSync(DIRECTORY,{recursive:true});
  const path = `${DIRECTORY}/${name}-${randomUUID()}.json`;
  writeFileSync(path,JSON.stringify(value),{flag:'wx',mode:0o600});
  console.info('TASK19_PREPARED_PUBLICATION_WITNESS',JSON.stringify({name,path,sha256:hash(value)}));
}
async function fixture() {
  const f = await deleteFixture();
  await f.commitDelete();
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=$1::jsonb
    WHERE tenant=$2 AND tab='Products' AND cells->>0='P1'`,
  [JSON.stringify(['P1','Publication pencil','31','8','TRUE','','school','1']),TENANT]);
  const {binding,next} = await f.stage(await f.capture());
  const source = await sqlImage(f.source), oracle = verifySource(source,f.old,next);
  await materializeLocalCandidate(binding,f.run());
  const destination = await sqlImage(f.destination);
  verifyDestination(destination,binding,f.source.runId,f.destination.runId,f.ownerId);
  const reports = (await f.source.owner.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
    FROM migration_full_reconciliation ORDER BY category`)).rows;
  const intent = {binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
    expectedDestinationStateVersion:'2',expectedReportDigest:hash(reports),
    expectedMaterializationDigest:hash(rows(destination,'migration_local_materializations')[0])};
  return {...f,binding,next,oracle,intent};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const bodies = {
  product:"UPDATE products SET name='Changed after preparation' WHERE tenant_id=NEW.tenant_id AND product_id='P1';",
  audit:"UPDATE audit_events SET redacted_details=jsonb_set(redacted_details,'{activationAllowed}','true') WHERE tenant_id=NEW.tenant_id;",
  receipt:"UPDATE migration_local_materializations SET source_fingerprint=repeat('b',64) WHERE tenant_id=NEW.tenant_id;",
  binding:"UPDATE migration_jobs SET source_fingerprint=repeat('b',64) WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;",
  authority:"UPDATE migration_jobs SET final_fingerprint=repeat('c',64),freeze_started_at=created_at,freeze_verified_at=created_at WHERE tenant_id=NEW.tenant_id AND job_id=NEW.job_id;",
  resurrect:"INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,category,sort_order) VALUES(NEW.tenant_id,'PX','Resurrected after preparation',9,0,true,'school',2);",
  settings:'DELETE FROM tenant_settings WHERE tenant_id=NEW.tenant_id;',
  noop:'PERFORM 1;',
};
type Edge = 'audit' | 'update';
async function trigger(f: Fixture, edge: Edge, fault: keyof typeof bodies, deferred: boolean) {
  // Native owned-PG constraint trigger; only scheduling varies between fault
  // and immediate controls. No mock transaction/SQL result or production role.
  const table = edge === 'audit' ? 'audit_events' : 'migration_jobs';
  const event = edge === 'audit' ? 'INSERT' : 'UPDATE';
  const when = edge === 'audit' ? "NEW.event_type='MIGRATION_LOCAL_PREPARED_STOP'"
    : "OLD.status='IMPORTING' AND NEW.status='RECONCILING'";
  await f.destination.owner.query(`CREATE SEQUENCE prepared_fault_seen;
    CREATE FUNCTION prepared_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
    BEGIN PERFORM nextval('public.prepared_fault_seen'); ${bodies[fault]} RETURN NEW; END $$`);
  await f.destination.owner.query(`CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER prepared_fault AFTER ${event} ON ${table}
    ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION prepared_fault()`);
  const definition = (await f.destination.owner.query("SELECT pg_get_triggerdef(oid) AS definition,tgdeferrable,tginitdeferred FROM pg_trigger WHERE tgname='prepared_fault'")).rows;
  expect(definition).toMatchObject([{tgdeferrable:deferred,tginitdeferred:deferred}]);
  return {table,definition};
}
async function dropFault(f: Fixture, table: string) {
  await f.destination.owner.query(`DROP TRIGGER prepared_fault ON ${table}; DROP FUNCTION prepared_fault(); DROP SEQUENCE prepared_fault_seen`);
}
async function image(f: Fixture) {
  return {source:await sqlImage(f.source),destination:await sqlImage(f.destination),local:await sqlImage(f.local),tuples:await f.state()};
}
function verifyPrepared(f: Fixture, before: Image, after: Image, result: Awaited<ReturnType<typeof prepareLocalCandidateTransition>>) {
  expect(result).toMatchObject({authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN',
    preparation:'PREPARED_STOP_REQUIRED',status:'RECONCILING',stateVersion:'3'});
  for (const table of Object.keys(before).filter(name => !['audit_events','migration_jobs'].includes(name))) {
    expect(after[table],table).toEqual(before[table]);
  }
  const prior = rows(before,'migration_jobs')[0], job = rows(after,'migration_jobs')[0];
  expect(rows(after,'migration_jobs')).toHaveLength(1);
  expect(job).toEqual({...prior,status:'RECONCILING',state_version:3,updated_at:job.updated_at});
  expect(job).toMatchObject({final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null});
  const audits = rows(after,'audit_events'); expect(audits).toHaveLength(1);
  const audit = audits[0], receipt = audit.redacted_details as Record<string,unknown>;
  expect(audit).toMatchObject({tenant_id:f.binding.tenantId,job_id:f.binding.migrationJobId,
    event_id:`local-prepared-stop:${hash(receipt)}`,event_type:'MIGRATION_LOCAL_PREPARED_STOP',
    actor_user_id:null,operation_id:null,entity_type:null,entity_id:null});
  expect(receipt).toMatchObject({intent:f.intent,authority:'NONAUTHORITY',activationAllowed:false,complete:false,
    scope:'LOCAL_PREPARED_STOP',preparation:'PREPARED_STOP_REQUIRED',exclusion:'NOT_PROVEN',
    previousStatus:'IMPORTING',status:'RECONCILING',stateVersion:'3'});
  expect(receipt.sourceJob).toMatchObject({job_id:f.binding.migrationJobId,status:'READY',version:f.binding.expectedStateVersion});
  const materialization = rows(before,'migration_local_materializations')[0];
  expect(receipt.validatedReadbackDigest).toBe(hash(materialization.domain_readback));
}
suite('Task19 deferred prepared publication boundary', () => {
  const cases = [
    {edge:'audit',fault:'product',deferred:true}, {edge:'audit',fault:'audit',deferred:true},
    {edge:'audit',fault:'receipt',deferred:true}, {edge:'update',fault:'binding',deferred:true},
    {edge:'update',fault:'authority',deferred:true}, {edge:'update',fault:'resurrect',deferred:true},
    {edge:'update',fault:'settings',deferred:true},
    {edge:'audit',fault:'product',deferred:false}, {edge:'update',fault:'authority',deferred:false},
  ] as const;
  it.each(cases)('refuses $edge/$fault deferred=$deferred with exact rollback and same-input retry',async ({edge,fault,deferred}) => {
    const f = await fixture(), definition = await trigger(f,edge,fault,deferred);
    const before = await image(f);
    const outcome = await prepareLocalCandidateTransition(f.intent,f.run()).then(value => ({accepted:true,value,error:null}),
      (error: Error) => ({accepted:false,value:null,error:error.message}));
    // Independent native owner connections AFTER awaited transaction completion;
    // complete persisted SQL rows, not the production success/MATCH summaries.
    const after = await image(f);
    const reached = (await f.destination.owner.query('SELECT last_value::text,is_called FROM prepared_fault_seen')).rows;
    evidence(`${edge}-${fault}-${deferred}`,{binding:f.binding,intent:f.intent,definition,body:bodies[fault],reached,
      physical:{source:f.source.evidence,destination:f.destination.evidence},before,after,outcome,sourceOracle:f.oracle});
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    expect(outcome).toEqual({accepted:false,value:null,error:REFUSED});
    expect(after).toEqual(before);
    await dropFault(f,definition.table);
    const retry = await prepareLocalCandidateTransition(f.intent,f.run());
    const retried = await image(f);
    verifyPrepared(f,before.destination,retried.destination,retry);
    expect(retried.source).toEqual(before.source); expect(retried.local).toEqual(before.local);
    expect(retried.tuples.source).toEqual(before.tuples.source);
    // Preparation is one-shot. Only a rolled-back attempt may reuse its input.
    await expect(prepareLocalCandidateTransition(f.intent,f.run())).rejects.toThrow(REFUSED);
    expect(await image(f)).toEqual(retried);
    evidence(`retry-${edge}-${fault}-${deferred}`,{intent:f.intent,before,after:retried,retry});
  },180_000);

  it.each(['audit','update'] as const)('accepts deferred %s no-op and independently reconciles the exact modified/deleted graph',async edge => {
    const f = await fixture(), definition = await trigger(f,edge,'noop',true);
    const before = await image(f);
    const result = await prepareLocalCandidateTransition(f.intent,f.run());
    const after = await image(f);
    const reached = (await f.destination.owner.query('SELECT last_value::text,is_called FROM prepared_fault_seen')).rows;
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    verifyPrepared(f,before.destination,after.destination,result);
    expect(after.source).toEqual(before.source); expect(after.local).toEqual(before.local);
    expect(after.tuples.source).toEqual(before.tuples.source);
    verifySource(after.source,f.old,f.next);
    await dropFault(f,definition.table);
    const lease = (db: Fixture['source']) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId:f.ownerId,
      queryOwner:(text:string,values?:unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
    const recovered = await reconcileLocalPreparedTransition(f.intent,lease(f.source),lease(f.destination));
    expect(recovered).toMatchObject({disposition:'DURABLE_PREPARED_STOP',authority:'NONAUTHORITY',activationAllowed:false,
      complete:false,exclusion:'NOT_PROVEN',repeatMutationAllowed:false,rollbackAllowed:false});
    await expect(prepareLocalCandidateTransition(f.intent,f.run())).rejects.toThrow(REFUSED);
    expect(await image(f)).toEqual(after);
    evidence(`control-${edge}`,{intent:f.intent,definition,reached,before,after,result,recovered,sourceOracle:f.oracle});
  },180_000);
});
