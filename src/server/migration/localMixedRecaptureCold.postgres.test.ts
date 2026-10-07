// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { TABLES, TENANT, OTHER, JOB, type MutablePin } from '../../../test-support/task19MutableFixture';
import { APPLICATION, REPORTS, type MixedColdRequest } from '../../../test-support/task19MixedCold';
import { canonicalJson, sha256 } from './validators';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    console.info('TASK19_MIXED_COLD_CLEANUP',JSON.stringify(await db.close()));
  }));
  const errors = results.filter(row => row.status === 'rejected');
  if (errors.length) throw new AggregateError(errors,'Owned mixed cold cleanup failed');
});
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
async function child(request: MixedColdRequest) {
  const prefix = `.task19-mixed-cold-results/${randomUUID()}`;
  mkdirSync('.task19-mixed-cold-results',{recursive:true,mode:0o700});
  writeFileSync(`${prefix}-request.json`,JSON.stringify(request),{flag:'wx',mode:0o600});
  const processChild = spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19MixedColdChild.test.ts',
    '--pool=threads','--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',
    TASK19_MIXED_COLD_REQUEST:`${prefix}-request.json`},stdio:['ignore','pipe','pipe'],timeout:330_000,killSignal:'SIGTERM'});
  let stdout = '', stderr = '';
  processChild.stdout.on('data',chunk => {stdout += chunk;}); processChild.stderr.on('data',chunk => {stderr += chunk;});
  const termination = await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => {
    processChild.once('error',reject); processChild.once('close',(code,signal) => resolve({code,signal}));
  });
  writeFileSync(`${prefix}-process.json`,JSON.stringify({pid:processChild.pid,...termination,stdout,stderr}),{flag:'wx',mode:0o600});
  expect(termination,stdout+stderr).toEqual({code:0,signal:null});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`,'utf8'))).toMatchObject({numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,success:true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`,'utf8'));
  expect(result).toMatchObject({pid:processChild.pid,success:true,poolsClosed:true,phase:request.phase});
  expect(result.pid).not.toBe(process.pid);
  // The close event above is an OS exit witness, not an in-memory retry marker.
  console.info('TASK19_MIXED_COLD_PROCESS',JSON.stringify({prefix,pid:result.pid,phase:request.phase,...termination,backends:result.backends,
    resultSha256:sha256(readFileSync(`${prefix}-result.json`,'utf8'))}));
  return result;
}
async function allocate(ownerId: string, role: 'SOURCE'|'DESTINATION') {
  const db = await createDisposablePostgres(); databases.push(db);
  console.info('TASK19_MIXED_COLD_PG',JSON.stringify(db.evidence));
  await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'cold-one','Synthetic'),($2,'cold-two','Other')",[TENANT,OTHER]);
  await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  for (const table of TABLES.filter(name => name.startsWith('migration_full_'))) await db.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)',[db.runId,ownerId,role,TENANT,JOB]);
  await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
  await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  const pin: MutablePin = {databaseId:db.runId,containerId:String(db.evidence.containerId),imageId:String(db.evidence.imageId),
    systemIdentifier:(await db.owner.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id};
  return {db,pin};
}
async function noWorkerConnections(db: DisposablePostgres) {
  const rows = (await db.owner.query('SELECT pid,backend_start::text,state FROM pg_stat_activity WHERE application_name=$1',[APPLICATION])).rows;
  expect(rows).toEqual([]);
  return rows;
}

suite('Task19 mixed recapture independent cold reopen', () => {
  it.each([false,true])('exits the producer then cold imports and cold retries with fail-closed evidence, tombstone=%s', async tombstone => {
    // Only the allocator lives across phases. It never acquires local source rows,
    // stages a generation or materializes; each actual application phase exits.
    const ownerId = randomUUID(), source = await allocate(ownerId,'SOURCE'), destination = await allocate(ownerId,'DESTINATION');
    const pins = {source:source.pin,destination:destination.pin,ownerId,tombstone};
    const produced = await child({...pins,phase:'produce'});
    await noWorkerConnections(source.db); await noWorkerConnections(destination.db);
    expect((await destination.db.owner.query('SELECT * FROM products')).rows).toEqual([]);
    expect((await destination.db.owner.query('SELECT * FROM migration_local_materializations')).rows).toEqual([]);
    const imported = await child({...pins,phase:'import',binding:produced.binding});
    await noWorkerConnections(source.db); await noWorkerConnections(destination.db);
    const retried = await child({...pins,phase:'retry',binding:produced.binding});
    await noWorkerConnections(source.db); await noWorkerConnections(destination.db);
    expect(new Set([produced.pid,imported.pid,retried.pid]).size).toBe(3);
    for (const db of [source.db,destination.db]) {
      const identities = [produced,imported,retried].flatMap(result => result.backends)
        .filter(row => row.databaseId === db.runId).map(row => canonicalJson([row.pid,row.started]));
      expect(new Set(identities).size).toBe(identities.length);
    }
    expect(imported.sourceWitness).toBe(produced.sourceWitness);
    expect(retried.sourceWitness).toBe(produced.sourceWitness);
    expect(retried.receipt).toEqual(imported.receipt);
    expect(retried.destinationWitness).toBe(imported.destinationWitness);
    const expectedCases = 7 + REPORTS.length * 2 + 8 + (tombstone ? 2 : 0);
    for (const result of [imported,retried]) {
      expect(result.observations).toHaveLength(expectedCases);
      expect(new Set(result.observations.map((row: {name:string}) => row.name)).size).toBe(expectedCases);
    }
    console.info('TASK19_MIXED_COLD_ACCEPTANCE',JSON.stringify({binding:produced.binding,tombstone,expectedCases,
      pids:[produced.pid,imported.pid,retried.pid],sourceWitnessSha256:sha256(produced.sourceWitness),
      destinationWitnessSha256:sha256(imported.destinationWitness),receipt:imported.receipt,
      connectionsAbsent:true,scope:'APPLICATION_PROCESS_EXIT_ONLY_LIVE_OWNED_PG'}));
  },720_000);
});
