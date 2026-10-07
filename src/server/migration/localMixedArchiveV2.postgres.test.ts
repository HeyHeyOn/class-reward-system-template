// @vitest-environment node
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { retainOwnedMutableProvenance } from '@/server/db/testing/task19MutableRetention';
import { readOwnedMixedRetentionV2, retainOwnedMixedProvenanceV2 } from '@/server/db/testing/task19MixedRetentionV2';
import { verifyLocalMixedRetentionV2 } from './localMixedRetentionV2';
import { canonicalJson, sha256 } from './validators';
import { TENANT, type MutablePin, mutableFixture, cleanupMutableFixture } from '../../../test-support/task19MutableFixture';
import { APPLICATION, witness } from '../../../test-support/task19MixedCold';
import { MIXED_ARCHIVE_RESULTS, allocateMixed, type MixedArchiveRequest } from '../../../test-support/task19MixedArchiveV2';
import { REPORTS } from '../../../test-support/task19MixedCold';
vi.mock('server-only', () => ({}));
const databases: DisposablePostgres[] = [];
afterEach(async () => {
  await cleanupMutableFixture();
  const results = await Promise.allSettled(databases.splice(0).reverse().map(async db => {
    console.info('TASK19_MIXED_V2_REPLACEMENT_CLEANUP',JSON.stringify(await db.close()));
  }));
  const failures = results.filter(row => row.status === 'rejected');
  if (failures.length) throw new AggregateError(failures,'Owned archive replacement cleanup failed');
});
async function child(request: MixedArchiveRequest) {
  mkdirSync(MIXED_ARCHIVE_RESULTS,{recursive:true,mode:0o700});
  const prefix = join(MIXED_ARCHIVE_RESULTS,randomUUID());
  writeFileSync(`${prefix}-request.json`,JSON.stringify(request),{flag:'wx',mode:0o600});
  const processChild = spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/task19MixedArchiveV2Child.test.ts',
    '--pool=threads','--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',
    TASK19_MIXED_V2_REQUEST:`${prefix}-request.json`},stdio:['ignore','pipe','pipe'],timeout:330_000,killSignal:'SIGTERM'});
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
  console.info('TASK19_MIXED_V2_PROCESS',JSON.stringify({prefix,pid:result.pid,phase:request.phase,...termination,
    resultSha256:sha256(readFileSync(`${prefix}-result.json`,'utf8'))}));
  return result;
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
suite('Task19 mixed V2 archive source disposal and rebinding', () => {
  it('refuses V1 export/read/relabel admission as V2 without changing any table', async () => {
    const fixture = await mutableFixture();
    const parent = '.task19-mixed-v2-v1-separation';
    mkdirSync(parent,{recursive:true,mode:0o700});
    const before = [await witness(fixture.source),await witness(fixture.destination)], files = readdirSync(parent);
    await expect(retainOwnedMixedProvenanceV2(fixture.source,fixture.ownerId,fixture.binding,parent))
      .rejects.toThrow('Local mixed V2 retention archive refused.');
    expect(readdirSync(parent)).toEqual(files);
    const pin = await retainOwnedMutableProvenance(fixture.source,fixture.ownerId,fixture.binding,parent);
    await expect(readOwnedMixedRetentionV2(pin,fixture.binding)).rejects.toThrow('Local mixed V2 retention archive refused.');
    const evidence = JSON.parse(readFileSync(join(pin.directory,'artifact.json'),'utf8')).evidence;
    expect(() => verifyLocalMixedRetentionV2(canonicalJson(evidence),fixture.binding)).toThrow('Local mixed V2 retention evidence refused.');
    evidence.format = 'TASK19_MIXED_RETENTION_V2';
    expect(() => verifyLocalMixedRetentionV2(canonicalJson(evidence),fixture.binding)).toThrow('Local mixed V2 retention evidence refused.');
    expect([await witness(fixture.source),await witness(fixture.destination)]).toEqual(before);
  },120_000);
  it.each([false,true])('reconstructs mixed archive after original storage disposal, tombstone=%s', async tombstone => {
    const produced = await child({phase:'produce',tombstone});
    // Producer has exited and both original containers + tmpfs were removed.
    // Observe exact absence again in the independent allocator process BEFORE
    // allocating replacements. No in-memory original capture is available here.
    expect(produced.originalPins).toHaveLength(2);
    for (const pin of produced.originalPins) absent(pin);
    const ownerId = randomUUID(), source = await allocateMixed(databases,ownerId,'SOURCE'), destination = await allocateMixed(databases,ownerId,'DESTINATION');
    const newPins = [source.pin,destination.pin];
    expect(new Set([...produced.originalPins,...newPins].map(pin => pin.containerId)).size).toBe(4);
    expect(new Set([...produced.originalPins,...newPins].map(pin => pin.databaseId)).size).toBe(4);
    expect(new Set([...produced.originalPins,...newPins].map(pin => pin.systemIdentifier)).size).toBe(4);
    for (const db of [source.db,destination.db]) {
      expect((await db.owner.query('SELECT * FROM products')).rows).toEqual([]);
      expect((await db.owner.query('SELECT * FROM migration_full_generations')).rows).toEqual([]);
    }
    const recovery = {tombstone,pin:produced.pin,binding:produced.binding,source:source.pin,destination:destination.pin,ownerId};
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
    expect(archived.format).toBe('TASK19_MIXED_RETENTION_V2');
    expect(archived.binding.generationId).toMatch(/^full-recapture-stage:/);
    expect(archived.reconciliation.map((row:{category:string}) => row.category).sort()).toEqual([...REPORTS].sort());
    const entry = (table:string,kind:string) => archived.deltas.find((row:{target_table:string;change_kind:string}) => row.target_table===table && row.change_kind===kind).entry_value;
    const common = {tenantId:TENANT,category:'school',imageUrl:null,isActive:true};
    expect(entry('products','MUTATED').before.target).toEqual({...common,productId:'P1',name:'Pencil',price:20,stock:5,sortOrder:1});
    expect(entry('products','MUTATED').after.target).toEqual({...common,productId:'P1',name:'Cold captured pencil',price:27,stock:5,sortOrder:1});
    expect(entry('products','REMOVED').before.target).toEqual({...common,productId:'PX',name:'Removed cold product',price:9,stock:0,sortOrder:2});
    expect(entry('products','REMOVED').after).toBeNull();
    expect(entry('products','REMOVED').afterDigest).toBeNull();
    expect(entry('settings','MUTATED').before.target).toMatchObject({key:'themeColor',value:'blue'});
    expect(entry('settings','MUTATED').after.target).toMatchObject({key:'themeColor',value:'green'});
    expect(archived.recaptures).toHaveLength(1);
    for (const row of [...archived.deltas,...archived.recaptures]) for (const side of ['before','after']) {
      const image=row.entry_value[side];
      expect(row.entry_value[`${side}Digest`]).toBe(image ? sha256(canonicalJson(image.target)) : null);
    }
    expect(archived.reconciliation.find((row:{category:string}) => row.category==='padlet_claim_digest_tombstones'))
      .toMatchObject({expected_count:tombstone ? 1 : 0,observed_count:tombstone ? 1 : 0,status:'MATCH'});
    for (const result of [rebuilt,retried]) {
      expect(result.immutableEvidence).toEqual(archived);
      expect(result.observations.length).toBeGreaterThanOrEqual(80);
      for (const observation of result.observations) {
        expect(observation.outcome).toBe('Local mixed V2 retention archive refused.');
        expect(observation.after).toEqual(observation.before);
      }
      expect(new Set(result.observations.map((row: {name:string}) => row.name)).size).toBe(result.observations.length);
      expect(result.archiveSha256).toBe(produced.pin.sha256);
      expect(result.stalePhysicalLeaseRefused).toBe(true);
    }
    expect(rebuilt.receipt).toEqual(retried.receipt);
    expect(rebuilt.sourceWitness).toBe(retried.sourceWitness);
    expect(rebuilt.destinationWitness).toBe(retried.destinationWitness);
    console.info('TASK19_MIXED_V2_ACCEPTANCE',JSON.stringify({scope:'MIXED_V2_TEST_RECONSTRUCTION_ONLY',tombstone,
      originalPins:produced.originalPins,replacements:newPins,cleanup:produced.cleanup,pids:[produced.pid,rebuilt.pid,retried.pid],
      binding:produced.binding,archivePin:produced.pin,negativeIntervals:rebuilt.observations.length+retried.observations.length,
      stalePhysicalLeaseIntervals:2,receipt:rebuilt.receipt,atomicRuntimeRestore:'NOT_PROVIDED',independentSupervisor:'NOT_RUN'}));
  },720_000);
});
