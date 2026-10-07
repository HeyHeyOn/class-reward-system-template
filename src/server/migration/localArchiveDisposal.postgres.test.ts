// @vitest-environment node
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { canonicalJson, sha256 } from './validators';
import { TABLES, TENANT, OTHER, JOB, type MutablePin } from '../../../test-support/task19MutableFixture';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { ARCHIVE_DISPOSAL_RESULTS, PRODUCT_REPORTS, type ArchiveDisposalRequest } from '../../../test-support/task19ArchiveDisposal';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    console.info('TASK19_ARCHIVE_REPLACEMENT_CLEANUP',JSON.stringify(await db.close()));
  }));
  const failures = results.filter(row => row.status === 'rejected');
  if (failures.length) throw new AggregateError(failures,'Owned archive replacement cleanup failed');
});
async function child(request: ArchiveDisposalRequest) {
  mkdirSync(ARCHIVE_DISPOSAL_RESULTS,{recursive:true,mode:0o700});
  const prefix = join(ARCHIVE_DISPOSAL_RESULTS,randomUUID());
  writeFileSync(`${prefix}-request.json`,JSON.stringify(request),{flag:'wx',mode:0o600});
  const processChild = spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19ArchiveDisposalChild.test.ts',
    '--pool=threads','--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',
    TASK19_ARCHIVE_DISPOSAL_REQUEST:`${prefix}-request.json`},stdio:['ignore','pipe','pipe'],timeout:330_000,killSignal:'SIGTERM'});
  let stdout='', stderr='';
  processChild.stdout.on('data',chunk => {stdout+=chunk;}); processChild.stderr.on('data',chunk => {stderr+=chunk;});
  const termination = await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => {
    processChild.once('error',reject); processChild.once('close',(code,signal) => resolve({code,signal}));
  });
  writeFileSync(`${prefix}-process.json`,JSON.stringify({pid:processChild.pid,...termination,stdout,stderr}),{flag:'wx',mode:0o600});
  expect(termination,stdout+stderr).toEqual({code:0,signal:null});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,success:true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`,'utf8'));
  expect(result).toMatchObject({pid:processChild.pid,phase:request.phase,success:true,poolsClosed:true});
  expect(result.pid).not.toBe(process.pid);
  console.info('TASK19_ARCHIVE_DISPOSAL_PROCESS',JSON.stringify({prefix,pid:result.pid,phase:request.phase,...termination,
    resultSha256:sha256(readFileSync(`${prefix}-result.json`,'utf8'))}));
  return result;
}
async function allocate(ownerId: string, role: 'SOURCE'|'DESTINATION') {
  const db = await createDisposablePostgres(); databases.push(db);
  console.info('TASK19_ARCHIVE_REPLACEMENT_PG',JSON.stringify(db.evidence));
  await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'archive-one','Synthetic'),($2,'archive-two','Other')",[TENANT,OTHER]);
  await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  for (const table of TABLES.filter(name => name.startsWith('migration_full_'))) await db.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)',[db.runId,ownerId,role,TENANT,JOB]);
  await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
  await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  const pin: MutablePin = {databaseId:db.runId,containerId:String(db.evidence.containerId),imageId:String(db.evidence.imageId),
    systemIdentifier:(await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id};
  return {db,pin};
}
function absent(pin: MutablePin) {
  expect(pin.containerId).toMatch(/^[a-f0-9]{64}$/);
  const actual = execFileSync('docker',['--host','unix:///var/run/docker.sock','ps','-aq','--no-trunc','--filter',`id=${pin.containerId}`],
    {env:{PATH:process.env.PATH,HOME:'/scratch',DOCKER_CONFIG:'/scratch',LANG:'C',NODE_ENV:'test'},encoding:'utf8',timeout:30_000}).trim();
  expect(actual).toBe(''); // Failed command throws: unavailable Docker != absent PG.
}
async function disconnected(db: DisposablePostgres) {
  expect((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE application_name=$1',[APPLICATION])).rows).toEqual([]);
}
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
suite('Task19 Products-only archive source disposal and rebinding', () => {
  it('reconstructs exact evidence into new physical source and destination, then cold retries after original storage disposal', async () => {
    const produced = await child({phase:'produce'});
    // Producer has exited and both original containers + tmpfs were removed.
    // Observe exact absence again in the independent allocator process BEFORE
    // allocating replacements. No in-memory original capture is available here.
    expect(produced.originalPins).toHaveLength(2);
    for (const pin of produced.originalPins) absent(pin);
    const ownerId = randomUUID(), source = await allocate(ownerId,'SOURCE'), destination = await allocate(ownerId,'DESTINATION');
    const newPins = [source.pin,destination.pin];
    expect(new Set([...produced.originalPins,...newPins].map(pin => pin.containerId)).size).toBe(4);
    expect(new Set([...produced.originalPins,...newPins].map(pin => pin.databaseId)).size).toBe(4);
    expect(new Set([...produced.originalPins,...newPins].map(pin => pin.systemIdentifier)).size).toBe(4);
    for (const db of [source.db,destination.db]) {
      expect((await db.owner.query('SELECT * FROM products')).rows).toEqual([]);
      expect((await db.owner.query('SELECT * FROM migration_full_generations')).rows).toEqual([]);
    }
    const recovery = {pin:produced.pin,binding:produced.binding,source:source.pin,destination:destination.pin,ownerId};
    const rebuilt = await child({...recovery,phase:'rebuild'});
    await disconnected(source.db); await disconnected(destination.db);
    const committed = [await witness(source.db),await witness(destination.db)];
    const retried = await child({...recovery,phase:'retry'});
    await disconnected(source.db); await disconnected(destination.db);
    expect([await witness(source.db),await witness(destination.db)]).toEqual(committed);
    for (const pin of produced.originalPins) absent(pin);
    expect(new Set([produced.pid,rebuilt.pid,retried.pid]).size).toBe(3);
    for (const pin of newPins) {
      const identities = [rebuilt,retried].flatMap(result => result.backends)
        .filter(row => row.databaseId === pin.databaseId).map(row => canonicalJson([row.pid,row.started]));
      expect(identities).toHaveLength(4); expect(new Set(identities).size).toBe(4);
    }
    const bytes = readFileSync(join(produced.pin.directory,'artifact.json'),'utf8');
    expect(sha256(bytes)).toBe(produced.pin.sha256);
    const archived = JSON.parse(bytes).evidence;
    const entry = (id: string) => archived.deltas.find((row: {target_id:string}) => row.target_id === id).entry_value;
    const common = {tenantId:TENANT,category:'school',imageUrl:null,isActive:true};
    expect(entry('P1').before.target).toEqual({...common,productId:'P1',name:'Pencil',price:20,stock:5,sortOrder:1});
    expect(entry('P1').after.target).toEqual({...common,productId:'P1',name:'Mutable pencil',price:27,stock:8,sortOrder:1});
    expect(entry('PX').before.target).toEqual({...common,productId:'PX',name:'Removed unreferenced',price:9,stock:0,sortOrder:2});
    expect(entry('PX').after).toBeNull(); expect(entry('PX').afterDigest).toBeNull();
    expect(entry('PNEW').before).toBeNull(); expect(entry('PNEW').beforeDigest).toBeNull();
    expect(entry('PNEW').after.target).toEqual({...common,productId:'PNEW',name:'Added notebook',price:15,stock:3,sortOrder:2});
    for (const id of ['P1','PX','PNEW']) for (const side of ['before','after']) {
      const image=entry(id)[side]; expect(entry(id)[`${side}Digest`]).toBe(image ? sha256(canonicalJson(image.target)) : null);
    }
    for (const result of [rebuilt,retried]) {
      expect(result.immutableEvidence).toEqual(archived);
      expect(result.observations).toHaveLength(6+5+PRODUCT_REPORTS.length*2+12);
      expect(new Set(result.observations.map((row: {name:string}) => row.name)).size).toBe(result.observations.length);
      expect(result.archiveSha256).toBe(produced.pin.sha256);
      expect(result.stalePhysicalLeaseRefused).toBe(true);
    }
    expect(rebuilt.receipt).toEqual(retried.receipt);
    expect(rebuilt.sourceWitness).toBe(retried.sourceWitness);
    expect(rebuilt.destinationWitness).toBe(retried.destinationWitness);
    console.info('TASK19_ARCHIVE_DISPOSAL_ACCEPTANCE',JSON.stringify({scope:'PRODUCTS_V1_TEST_RECONSTRUCTION_ONLY',
      originalPins:produced.originalPins,replacements:newPins,cleanup:produced.cleanup,pids:[produced.pid,rebuilt.pid,retried.pid],
      binding:produced.binding,archivePin:produced.pin,negativeIntervals:rebuilt.observations.length+retried.observations.length,
      stalePhysicalLeaseIntervals:2,receipt:rebuilt.receipt,mixedArchiveRestore:'NOT_PROVEN',independentSupervisor:'NOT_RUN'}));
  },720_000);
});
