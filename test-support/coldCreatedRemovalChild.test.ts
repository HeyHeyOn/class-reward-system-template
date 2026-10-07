// @vitest-environment node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as cp from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { recoverColdDatabase } from '@/server/db/testing/coldOrphanRecovery';
import { coldProcessIdentity } from '@/server/db/testing/coldProcessWitness';
import * as archive from '@/server/db/testing/ownedPgArchive';
vi.mock('server-only',() => ({}));
vi.mock('node:fs/promises',async original => ({...await original<typeof import('node:fs/promises')>()}));
vi.mock('node:child_process',async original => ({...await original<typeof import('node:child_process')>()}));
const request=process.env.CREATED_REMOVAL_REQUEST ? JSON.parse(process.env.CREATED_REMOVAL_REQUEST) : null;
it.skipIf(!request)('real CREATED native removal barriers',async () => {
  const root='.created-removal-evidence', prefix=`${root}/${request.resultId}`;
  mkdirSync(root,{recursive:true,mode:0o700});
  writeFileSync(`${prefix}-native.jsonl`,'',{mode:0o600,flag:'wx'});
  const identity=await coldProcessIdentity(), dir=`.cold-restore-control/${request.anchor.id}`;
  const inventory=JSON.parse(readFileSync(`${dir}/inventory.json`,'utf8')), id=inventory.containerId;
  expect(inventory.phase).toBe('CREATED'); expect(id).toMatch(/^[a-f0-9]{64}$/);
  const save=(suffix:string,value:unknown) => {
    const path=`${prefix}-${suffix}.json`;
    writeFileSync(`${path}.part`,JSON.stringify(value),{mode:0o600,flag:'wx'}); renameSync(`${path}.part`,path);
  };
  const trace=(value:unknown) => appendFileSync(`${prefix}-native.jsonl`,JSON.stringify(value)+'\n');
  // Synchronous spawn cannot be wrapped in an async mock. Pause exactly before
  // its native invocation without fabricating a ChildProcess or command result.
  // A release file is test IPC only; it never authorizes a recovery operation.
  const hold=(boundary:string,extra:Record<string,unknown>={}) => {
    if (request.boundary!==boundary) return;
    save('barrier',{boundary,identity,id,...extra});
    const sleep=new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(`${prefix}-continue`)) Atomics.wait(sleep,0,0,50);
  };
  const spawn=cp.spawn; let sequence=0, removalClosed=false;
  vi.spyOn(cp,'spawn').mockImplementation((...args:Parameters<typeof cp.spawn>) => {
    if (args[0]!=='docker' || !Array.isArray(args[1])) return spawn(...args);
    const requested=[...args[1]] as string[];
    const removal=requested[2]==='rm', absence=requested[2]==='ps' && requested.includes(`id=${id}`);
    if (removal) {
      expect(requested).toEqual(['--host','unix:///var/run/docker.sock','rm',id]);
      hold('created-before-rm',{nextCommand:requested});
    }
    if (absence) {
      expect(removalClosed).toBe(true);
      hold('created-rm-ack',{nextCommand:requested});
      if (request.unreadableAbsence) {
        // Real failing Docker invocation at a deliberately unavailable local
        // socket. Its nonzero stderr/exit is retained, never turned into [].
        args[1]=['--host','unix:///scratch/created-readback-unavailable.sock',...requested.slice(2)];
      }
    }
    const serial=++sequence, actual=[...args[1]];
    trace({event:'spawn',serial,requested,actual});
    const child=spawn(...args); let stdout='', stderr='';
    child.stdout?.on('data',b => { stdout+=b.toString(); }); child.stderr?.on('data',b => { stderr+=b.toString(); });
    child.once('exit',(code,signal) => trace({event:'exit',serial,code,signal}));
    child.once('close',(code,signal) => {
      trace({event:'close',serial,requested,actual,code,signal,stdout,stderr});
      if (removal && code===0 && signal===null) removalClosed=true;
    });
    return child;
  });
  const dispose=archive.disposeUnstartedColdAllocation;
  vi.spyOn(archive,'disposeUnstartedColdAllocation').mockImplementation(async (...args) => {
    const result=await dispose(...args);
    hold('created-readback',{result}); return result;
  });
  const rename=fs.rename;
  vi.spyOn(fs,'rename').mockImplementation(async (from,to) => {
    await rename(from,to);
    if (String(to).endsWith('/recovery.json')) hold('created-published',{publication:'rename-visible-before-directory-sync',
      disposition:JSON.parse(readFileSync(String(to),'utf8'))});
  });
  try {
    const recovery=await recoverColdDatabase(request.anchor,request.binding);
    save('result',{ok:true,recovery,identity});
  } catch (error) {
    save('result',{ok:false,error:error instanceof Error ? error.message : String(error),identity});
  } finally { vi.restoreAllMocks(); }
},180_000);
