import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import * as store from '@/server/db/testing/coldRestoreStore';
import type { ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import type { ColdWorkerObservation } from '@/server/db/testing/coldProcessWitness';
import type { LocalCandidateBinding } from '@/server/migration/localCandidateMaterialization';
const exec=promisify(execFile);
const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1'};
const serial=['--maxWorkers=1','--no-file-parallelism','--pool=threads','--reporter=default','--reporter=json'];
export type Packet={anchor:ColdAnchor; binding:LocalCandidateBinding; pid:number; sourceDatabaseId:string};
export type Ready={pid:number; databaseId:string; evidence:{containerId:string; imageId:string; runId:string}; sql?:Record<string,unknown>};
export type Worker={child:ChildProcess; ready:Ready; packet:Packet; exit:Promise<{code:number|null; signal:NodeJS.Signals|null}>; observation:ColdWorkerObservation|null; log:()=>string};
const workers:Worker[]=[];
export const control=(f:Packet) => `.cold-restore-control/${f.anchor.id}`;
export const state=(f:Packet) => JSON.parse(readFileSync(`${control(f)}/state.json`,'utf8'));
export async function coldCapture():Promise<Packet> {
  const resultId=randomUUID();
  const output=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldRestoreChild.test.ts',...serial,
    `--outputFile.json=.cold-child-results/${resultId}-vitest.json`],{env:{...environment,COLD_REQUEST:JSON.stringify({phase:'capture',mixed:true,
    policy:{retainUntil:0,expiresAt:Date.now()+3_600_000},resultId})},timeout:150_000,maxBuffer:8_000_000});
  console.info('ORPHAN_CAPTURE',output.stdout,output.stderr);
  const result=JSON.parse(readFileSync(`.cold-child-results/${resultId}.json`,'utf8'));
  expect(result.ok,result.error).toBe(true); expect(result.sourceClosed.containerRemoved).toBe(true);
  mkdirSync('.cold-launcher',{recursive:true,mode:0o700});
  writeFileSync(`.cold-launcher/${result.anchor.id}.json`,JSON.stringify(result),{mode:0o600,flag:'wx'});
  return JSON.parse(readFileSync(`.cold-launcher/${result.anchor.id}.json`,'utf8'));
}
export async function coordinator(f:Packet,extra:Record<string,unknown>={}) {
  const resultId=randomUUID();
  const out=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldOrphanChild.test.ts',...serial,
    `--outputFile.json=.orphan-child-results/${resultId}-vitest.json`],{env:{...environment,ORPHAN_REQUEST:JSON.stringify({phase:'recover',...f,...extra,resultId})},timeout:150_000,maxBuffer:8_000_000});
  const result=JSON.parse(readFileSync(`.orphan-child-results/${resultId}-result.json`,'utf8'));
  console.info('ORPHAN_COORDINATOR',JSON.stringify({resultId,result,stdout:out.stdout,stderr:out.stderr}));
  return result;
}
export async function restoreAgain(f:Packet) {
  const resultId=randomUUID();
  const out=await exec(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldRestoreChild.test.ts',...serial,
    `--outputFile.json=.cold-child-results/${resultId}-vitest.json`],{env:{...environment,COLD_REQUEST:JSON.stringify({...f,phase:'restore',resultId})},timeout:150_000,maxBuffer:8_000_000});
  const result=JSON.parse(readFileSync(`.cold-child-results/${resultId}.json`,'utf8'));
  console.info('ORPHAN_RETRY',JSON.stringify({resultId,result,stdout:out.stdout,stderr:out.stderr}));
  return result;
}
export async function orphan(f:Packet,fault='allocated'):Promise<Worker> {
  const resultId=randomUUID(); let output='';
  const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldOrphanChild.test.ts',...serial,
    `--outputFile.json=.orphan-child-results/${resultId}-vitest.json`],{env:{...environment,ORPHAN_REQUEST:JSON.stringify({...f,phase:'orphan',fault,resultId})},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',bytes => { output+=bytes.toString(); }); child.stderr.on('data',bytes => { output+=bytes.toString(); });
  const watch=Reflect.get(store,'watchColdWorker');
  const observation=typeof watch==='function' ? await watch(child) : null;
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => { child.once('error',reject); child.once('close',(code,signal) => resolve({code,signal})); });
  const deadline=Date.now()+120_000, file=`.orphan-child-results/${resultId}-ready.json`;
  while (!existsSync(file)) {
    if (child.exitCode!==null || child.signalCode!==null || Date.now()>deadline) { child.kill('SIGKILL'); await exit; throw new Error(`Orphan barrier failed: ${output}`); }
    await new Promise(done => setTimeout(done,50));
  }
  const ready=JSON.parse(readFileSync(file,'utf8'));
  const worker={child,ready,packet:f,exit,observation,log:()=>output}; workers.push(worker);
  expect(ready.pid).toBe(child.pid); expect(state(f).status).toBe('IN_FLIGHT');
  console.info('ORPHAN_ALLOCATED',JSON.stringify(ready));
  return worker;
}
export async function killWorker(w:Worker,certify=true) {
  expect(w.child.kill('SIGKILL')).toBe(true);
  const termination=await w.exit;
  expect(termination).toEqual({code:null,signal:'SIGKILL'});
  console.info('ORPHAN_FORCED_EXIT',JSON.stringify({pid:w.ready.pid,termination,stdout:w.log()}));
  const certifyExit=Reflect.get(store,'certifyColdWorkerExit');
  if (certify && typeof certifyExit==='function') {
    if (!w.observation) throw new Error('Missing trusted launcher observation');
    await certifyExit(w.packet.anchor,w.observation);
  }
}
export async function fixtureDocker(...args:string[]) {
  return (await exec('docker',['--host','unix:///var/run/docker.sock',...args],{env:{PATH:process.env.PATH,HOME:'/scratch',DOCKER_CONFIG:'/scratch',LANG:'C',NODE_ENV:'test'},timeout:30_000,maxBuffer:4_000_000})).stdout.trim();
}
export async function present(w:Worker) {
  return await fixtureDocker('ps','-aq','--no-trunc','--filter',`id=${w.ready.evidence.containerId}`)===w.ready.evidence.containerId;
}
export async function teardownOrphans() {
  for (const w of workers.splice(0).reverse()) {
    if (w.child.exitCode===null && w.child.signalCode===null) { w.child.kill('SIGKILL'); await w.exit; }
    // This is explicit end-of-test disposal, NOT the recovery decision. The
    // trusted launcher recorded these exact freshly-created handles itself.
    const id=w.ready.evidence.containerId;
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Unsafe fixture cleanup ID');
    if (await present(w)) {
      const [owned]=JSON.parse(await fixtureDocker('inspect',id));
      expect(owned.Id).toBe(id); expect(owned.Config.Labels['io.class-store.synthetic-pg-owner']).toBe(w.ready.databaseId);
      expect(owned.Image).toBe(w.ready.evidence.imageId); expect(owned.HostConfig.NetworkMode).toBe('none');
      expect(owned.HostConfig.Binds).toBeNull(); expect(owned.HostConfig.ReadonlyRootfs).toBe(true);
      await fixtureDocker('rm','--force',id);
    }
    expect(await present(w)).toBe(false);
    console.info('ORPHAN_FIXTURE_CLEANUP',JSON.stringify({id,runId:w.ready.databaseId,containerRemoved:true,scope:'explicit synthetic test teardown, not recovery authorization'}));
  }
}
