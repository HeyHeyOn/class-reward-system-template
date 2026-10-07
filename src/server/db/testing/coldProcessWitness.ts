import 'server-only';
import { ChildProcess } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';

export type ColdProcessIdentity=Readonly<{pid:number; startTicks:string; bootId:string; pidNamespace:string}>;
export type ColdWorkerObservation=Readonly<object>;
type Exit={code:number|null; signal:NodeJS.Signals|null};
const observations=new WeakMap<ColdWorkerObservation,{worker:ColdProcessIdentity; exit:Promise<Exit>}>();
function refused():never { throw new Error('Cold process witness refused.'); }
function optIn() { if (process.env.RUN_REAL_POSTGRES!=='1' || process.platform!=='linux') refused(); }
export async function coldProcessIdentity(pid=process.pid):Promise<ColdProcessIdentity> {
  optIn();
  if (!Number.isSafeInteger(pid) || pid<=1) refused();
  const stat=await readFile(`/proc/${pid}/stat`,'utf8');
  const fields=stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
  const startTicks=fields[19];
  const bootId=(await readFile('/proc/sys/kernel/random/boot_id','utf8')).trim();
  const pidNamespace=await readlink(`/proc/${pid}/ns/pid`);
  if (!/^[1-9][0-9]*$/.test(startTicks) || !/^[a-f0-9-]{36}$/.test(bootId) || !/^pid:\[[0-9]+\]$/.test(pidNamespace)) refused();
  return Object.freeze({pid,startTicks,bootId,pidNamespace});
}
/** The trusted launcher must call this on its actual freshly spawned child,
 * before the attempt starts. Serialized PID/exit claims cannot mint a witness. */
export async function watchColdWorker(child:ChildProcess):Promise<ColdWorkerObservation> {
  optIn();
  if (!(child instanceof ChildProcess) || !child.pid || child.exitCode!==null || child.signalCode!==null) refused();
  const exit=new Promise<Exit>(resolve => { child.once('exit',(code,signal) => resolve({code,signal})); });
  const worker=await coldProcessIdentity(child.pid), self=await coldProcessIdentity();
  if (worker.pid===self.pid || worker.bootId!==self.bootId || worker.pidNamespace!==self.pidNamespace) refused();
  const observation=Object.freeze({}); observations.set(observation,{worker,exit}); return observation;
}
/** No wall clock or PID nonexistence alone is termination authorization. */
export async function killedColdWorker(observation:ColdWorkerObservation) {
  const value=observations.get(observation); if (!value) refused();
  const exit=await value.exit;
  if (exit.code!==null || exit.signal!=='SIGKILL' || await coldWorkerBlocker(value.worker)) refused();
  return {worker:value.worker,code:exit.code,signal:exit.signal};
}
export async function coldWorkerBlocker(worker:ColdProcessIdentity):Promise<string|null> {
  try {
    if (!worker || !Number.isSafeInteger(worker.pid) || worker.pid<=1 || !/^[1-9][0-9]*$/.test(worker.startTicks)) return 'PROCESS_IDENTITY_UNREADABLE';
    const self=await coldProcessIdentity();
    if (self.bootId!==worker.bootId || self.pidNamespace!==worker.pidNamespace) return 'PROCESS_SCOPE_MISMATCH';
    try { process.kill(worker.pid,0); return 'WORKER_STILL_LIVE'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ESRCH') return 'PROCESS_IDENTITY_UNREADABLE'; }
    try { await readFile(`/proc/${worker.pid}/stat`); return 'WORKER_STILL_LIVE'; }
    catch (error) { return (error as NodeJS.ErrnoException).code==='ENOENT' ? null : 'PROCESS_IDENTITY_UNREADABLE'; }
  } catch { return 'PROCESS_IDENTITY_UNREADABLE'; }
}
