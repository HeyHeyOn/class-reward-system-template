import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import { control, fixtureDocker, type Packet } from './coldOrphanFixture';
import { certifyColdWorkerExit } from '@/server/db/testing/coldRestoreStore';
import { coldProcessIdentity, killedColdWorker, watchColdWorker } from '@/server/db/testing/coldProcessWitness';

export const evidenceRoot='.created-removal-evidence';
export const json=(path:string) => JSON.parse(readFileSync(path,'utf8'));
export function save(name:string,value:unknown) {
  mkdirSync(evidenceRoot,{recursive:true,mode:0o700});
  writeFileSync(`${evidenceRoot}/${name}.json`,JSON.stringify(value),{mode:0o600,flag:'wx'});
}
export async function exact(id:string) {
  expect(id).toMatch(/^[a-f0-9]{64}$/);
  const args=['ps','-aq','--no-trunc','--filter',`id=${id}`];
  const stdout=await fixtureDocker(...args);
  expect(['',id]).toContain(stdout);
  const inspect=stdout ? JSON.parse(await fixtureDocker('inspect',id))[0] : null;
  return {args,stdout,inspect};
}
export function sourceSnapshot(f:Packet) {
  const dir=control(f), files:Record<string,unknown>={};
  const capture=(name:string,path:string) => {
    if (!existsSync(path)) { files[name]=null; return; }
    const stat=lstatSync(path);
    if (stat.isDirectory()) {
      files[name]={kind:'directory',ino:stat.ino,mode:stat.mode,entries:readdirSync(path).sort()};
    } else {
      const bytes=readFileSync(path);
      files[name]={kind:'file',ino:stat.ino,mode:stat.mode,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
    }
  };
  for (const name of readdirSync(dir).filter(n => !n.startsWith('blocked-')).sort()) {
    capture(name,`${dir}/${name}`);
    if (name==='recovery-lock') for (const entry of readdirSync(`${dir}/${name}`).sort()) capture(`${name}/${entry}`,`${dir}/${name}/${entry}`);
  }
  capture('transport',`.cold-restore-transport/${f.anchor.id}.sql`);
  return files;
}
const children:Running[]=[];
const allocations:{f:Packet;resultId:string}[]=[];
type Termination={code:number|null;signal:NodeJS.Signals|null};
type Running={child:ChildProcess;exit:Promise<Termination>;close:Promise<Termination>;resultId:string;log:()=>string};
async function launch(file:string,variable:string,request:Record<string,unknown>) {
  const resultId=randomUUID(); let output='';
  const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run',file,'--maxWorkers=1','--no-file-parallelism',
    '--pool=threads','--reporter=default','--reporter=json',`--outputFile.json=${evidenceRoot}/${resultId}-vitest.json`],
  {env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',
    [variable]:JSON.stringify({...request,resultId})},stdio:['ignore','pipe','pipe']});
  const event=(name:'exit'|'close') => new Promise<Termination>((resolve,reject) => {
    child.once('error',reject); child.once(name,(code,signal) => resolve({code,signal}));
  });
  const running={child,exit:event('exit'),close:event('close'),resultId,log:()=>output};
  children.push(running);
  child.stdout.on('data',b => { output+=b.toString(); }); child.stderr.on('data',b => { output+=b.toString(); });
  const observation=await watchColdWorker(child), identity=await coldProcessIdentity(child.pid);
  return {...running,observation,identity};
}
async function wait(r:Running,path:string) {
  const deadline=Date.now()+120_000;
  while (!existsSync(path)) {
    if (r.child.exitCode!==null || r.child.signalCode!==null || Date.now()>deadline) {
      save(`${r.resultId}-barrier-failure`,{path,output:r.log(),code:r.child.exitCode,signal:r.child.signalCode});
      throw new Error(`CREATED process barrier failed: ${path}: ${r.log()}`);
    }
    await new Promise(done => setTimeout(done,50));
  }
  return json(path);
}
export async function createdWorker(f:Packet) {
  mkdirSync(evidenceRoot,{recursive:true,mode:0o700});
  const w=await launch('test-support/coldAllocationChild.test.ts','ALLOCATION_REQUEST',{...f,boundary:'created-durable'});
  allocations.push({f,resultId:w.resultId});
  const barrier=await wait(w,`.allocation-child-results/${w.resultId}-ready.json`);
  expect(barrier.identity).toEqual(w.identity); expect(barrier.boundary).toBe('created-durable');
  const inventory=json(`${control(f)}/inventory.json`);
  expect(inventory.phase).toBe('CREATED'); expect(inventory.containerId).toBe(barrier.containerId);
  expect(inventory.systemIdentifier).toBeUndefined(); expect(inventory.control).toBeUndefined();
  save(`${w.resultId}-created`,{barrier,inventory,native:await exact(barrier.containerId),source:sourceSnapshot(f),sql:'NOT_APPLICABLE_NEVER_STARTED'});
  return {...w,barrier,id:barrier.containerId as string};
}
export async function kill(r:Awaited<ReturnType<typeof launch>>,role:'worker'|'coordinator',f:Packet) {
  expect(r.child.kill('SIGKILL')).toBe(true);
  const exit=await r.exit, close=await r.close, witness=await killedColdWorker(r.observation);
  const result={role,identity:r.identity,witness,exit,close,output:r.log()};
  save(`${r.resultId}-exit`,result);
  expect(exit).toEqual({code:null,signal:'SIGKILL'}); expect(close).toEqual(exit); expect(witness.worker).toEqual(r.identity);
  if (role==='worker') await certifyColdWorkerExit(f.anchor,r.observation);
  return result;
}
export async function removalCoordinator(f:Packet,boundary:string,options:Record<string,unknown>={}) {
  const c=await launch('test-support/coldCreatedRemovalChild.test.ts','CREATED_REMOVAL_REQUEST',{...f,boundary,...options});
  const barrier=await wait(c,`${evidenceRoot}/${c.resultId}-barrier.json`);
  expect(barrier.identity).toEqual(c.identity); expect(barrier.boundary).toBe(boundary);
  return {...c,barrier};
}
export async function resume(c:Awaited<ReturnType<typeof removalCoordinator>>) {
  writeFileSync(`${evidenceRoot}/${c.resultId}-continue`,'continue',{mode:0o600,flag:'wx'});
  await c.close;
  save(`${c.resultId}-terminal`,{exit:await c.exit,close:await c.close,output:c.log()});
  expect(await c.close,c.log()).toEqual({code:0,signal:null});
  return json(`${evidenceRoot}/${c.resultId}-result.json`);
}
export function nativeTrace(resultId:string) {
  return readFileSync(`${evidenceRoot}/${resultId}-native.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
export async function cleanupCreated() {
  for (const c of children.splice(0)) {
    if (c.child.exitCode===null && c.child.signalCode===null) c.child.kill('SIGKILL');
    await c.close;
  }
  for (const a of allocations.splice(0)) {
    const path=`.allocation-child-results/${a.resultId}-allocation.json`;
    if (!existsSync(path)) continue;
    const pin=json(path), before=await exact(pin.containerId);
    if (before.inspect) {
      expect(before.inspect.Id).toBe(pin.containerId); expect(before.inspect.Image).toBe(pin.imageId);
      expect(before.inspect.Config.Labels).toMatchObject({'io.class-store.synthetic-pg-owner':pin.runId,'io.class-store.cold-packet':a.f.anchor.id});
      expect(before.inspect.State.Status).toBe('created'); expect(before.inspect.State.Running).toBe(false);
      // Fresh launcher-owned NEVER_STARTED target only. Never force, start,
      // release stale gates, or touch the preexisting containers.
      const stdout=await fixtureDocker('rm',pin.containerId);
      save(`${a.resultId}-teardown-rm`,{args:['rm',pin.containerId],stdout,before,authority:'fresh synthetic launcher teardown only'});
      expect(stdout).toBe(pin.containerId);
    }
    const after=await exact(pin.containerId);
    save(`${a.resultId}-teardown`,{id:pin.containerId,after,source:sourceSnapshot(a.f)});
    expect(after.stdout).toBe('');
  }
}
