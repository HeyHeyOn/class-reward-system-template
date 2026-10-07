import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { certifyColdWorkerExit, type ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import { watchColdWorker } from '@/server/db/testing/coldProcessWitness';
import { fixtureDocker } from './coldOrphanFixture';
const exec=promisify(execFile);
export const directory='.sealed-crash-results';
const environment=():NodeJS.ProcessEnv => ({PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1'});
const argv=(id:string,successor=false) => ['node_modules/vitest/vitest.mjs','run',successor ? 'test-support/sealedSuccessorChild.test.ts' : 'test-support/sealedCrashChild.test.ts','--maxWorkers=1',
  '--no-file-parallelism','--pool=threads','--reporter=default','--reporter=json',`--outputFile.json=${directory}/${id}-vitest.json`];
export function save(id:string,suffix:string,value:unknown) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const path=`${directory}/${id}-${suffix}.json`;
  writeFileSync(path+'.part',JSON.stringify(value),{flag:'wx',mode:0o600}); renameSync(path+'.part',path);
}
export function coldFiles(anchor:ColdAnchor) {
  const root=`.cold-restore-control/${anchor.id}`;
  const files:Record<string,string>={};
  const visit=(dir:string) => {
    for (const entry of readdirSync(root+dir,{withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const path=dir+'/'+entry.name;
      if (entry.isDirectory()) {files[path]='DIRECTORY'; visit(path);}
      else files[path]=readFileSync(root+path).toString('base64');
    }
  };
  visit(''); return files;
}
export async function crashDispositionChild(request:Record<string,unknown>) {
  const id=randomUUID(); save(id,'request',request);
  let exit:number|string=0,stdout='',stderr='';
  try {({stdout,stderr}=await exec(process.execPath,argv(id,request.suite==='successor'),{env:{...environment(),SEALED_CRASH_REQUEST:`${directory}/${id}-request.json`,SEALED_CRASH_RESULT:id},timeout:600_000,maxBuffer:12_000_000}));}
  catch (error) {const e=error as {code:number|string;stdout:string;stderr:string}; exit=e.code; stdout=e.stdout; stderr=e.stderr;}
  save(id,'execution',{exit,stdout,stderr});
  const result=JSON.parse(readFileSync(`${directory}/${id}-result.json`,'utf8'));
  expect(result.ok,JSON.stringify(result.error)).toBe(true); expect(exit).toBe(0);
  const report=JSON.parse(readFileSync(`${directory}/${id}-vitest.json`,'utf8'));
  expect(report.numPassedTests).toBe(1); expect(report.numFailedTests).toBe(0);
  return result;
}
type End={code:number|null;signal:NodeJS.Signals|null};
type Worker={child:ChildProcess;id:string;exit:Promise<End>;close:Promise<End>;log:()=>string};
const workers:Worker[]=[];
export async function crashWorker(request:Record<string,unknown>) {
  const id=randomUUID(); save(id,'request',request); let output='';
  const child=spawn(process.execPath,argv(id,request.suite==='successor'),{env:{...environment(),SEALED_CRASH_REQUEST:`${directory}/${id}-request.json`,SEALED_CRASH_RESULT:id},stdio:['ignore','pipe','pipe']});
  const event=(name:'exit'|'close') => new Promise<End>((resolve,reject) => {child.once('error',reject); child.once(name,(code,signal) => resolve({code,signal}));});
  const w:Worker={child,id,exit:event('exit'),close:event('close'),log:()=>output}; workers.push(w);
  child.stdout.on('data',b => {output+=b.toString();}); child.stderr.on('data',b => {output+=b.toString();});
  const observation=await watchColdWorker(child),deadline=Date.now()+180_000,path=`${directory}/${id}-barrier.json`;
  while (!existsSync(path)) {
    if (child.exitCode!==null || child.signalCode!==null || Date.now()>deadline) throw new Error(`Sealed crash barrier failed: ${output}`);
    await new Promise(done => setTimeout(done,50));
  }
  const barrier=JSON.parse(readFileSync(path,'utf8'));
  expect(barrier.pid).toBe(child.pid);
  return {...w,barrier,observation};
}
export async function killCrashWorker(w:Awaited<ReturnType<typeof crashWorker>>,anchor:ColdAnchor,certify=true) {
  expect(w.child.kill('SIGKILL')).toBe(true);
  const exit=await w.exit,close=await w.close;
  save(w.id,'termination',{pid:w.child.pid,exit,close,output:w.log()});
  expect(exit).toEqual({code:null,signal:'SIGKILL'}); expect(close).toEqual(exit);
  if (certify) await certifyColdWorkerExit(anchor,w.observation);
}
export async function cleanupCrashWorkers() {
  for (const w of workers.splice(0)) {
    if (w.child.exitCode===null && w.child.signalCode===null) w.child.kill('SIGKILL');
    await w.close;
    const path=`${directory}/${w.id}-allocation.json`;
    if (!existsSync(path)) continue;
    const {runId,evidence}=JSON.parse(readFileSync(path,'utf8')),id=evidence.containerId;
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    const before=await fixtureDocker('ps','-aq','--no-trunc','--filter',`id=${id}`);
    if (before) {
      const [owned]=JSON.parse(await fixtureDocker('inspect',id));
      expect(owned.Id).toBe(id); expect(owned.Config.Labels['io.class-store.synthetic-pg-owner']).toBe(runId);
      expect(owned.Image).toBe(evidence.imageId); expect(owned.HostConfig.NetworkMode).toBe('none');
      expect(owned.HostConfig.Binds).toBeNull(); expect(owned.HostConfig.ReadonlyRootfs).toBe(true);
      await fixtureDocker('rm','--force',id);
    }
    const after=await fixtureDocker('ps','-aq','--no-trunc','--filter',`id=${id}`);
    save(w.id,'cleanup',{id,runId,before,after,scope:'explicit fresh test-owned teardown; NOT recovery disposal'});
    expect(after).toBe('');
  }
}
