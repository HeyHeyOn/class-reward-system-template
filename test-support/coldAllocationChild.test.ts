// @vitest-environment node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import * as disposable from '@/server/db/testing/disposablePostgres';
import * as materialized from '@/server/db/testing/materializedRestore';
import { restoreColdDatabase } from '@/server/db/testing/coldRestore';
import { coldProcessIdentity } from '@/server/db/testing/coldProcessWitness';
vi.mock('server-only',() => ({}));
vi.mock('node:fs/promises',async original => ({...await original<typeof import('node:fs/promises')>()}));
const hooks=vi.hoisted(() => ({before:(async () => {}) as (args:string[]) => Promise<void>,
  after:(async () => {}) as (args:string[],stdout:string) => Promise<void>}));
vi.mock('node:child_process',async original => {
  const actual=await original<typeof import('node:child_process')>();
  const {promisify}=await import('node:util'), execute=promisify(actual.execFile);
  const wrapped=(...args:Parameters<typeof actual.execFile>) => actual.execFile(...args);
  Object.defineProperty(wrapped,promisify.custom,{value:async (file:string,args:string[],options:object) => {
    if (file==='docker') await hooks.before(args);
    const result=await execute(file,args,options);
    if (file==='docker') await hooks.after(args,String(result.stdout));
    return result;
  }});
  return {...actual,execFile:wrapped};
});
const request=process.env.ALLOCATION_REQUEST ? JSON.parse(process.env.ALLOCATION_REQUEST) : null;
it.skipIf(!request)('owned allocation process barriers',async () => {
  mkdirSync('.allocation-child-results',{recursive:true,mode:0o700});
  const prefix=`.allocation-child-results/${request.resultId}`, identity=await coldProcessIdentity();
  let containerId:string|undefined, runId:string|undefined, imageId:string|undefined, exactPublished=false;
  const save=(suffix:string,value:unknown) => {
    const path=`${prefix}-${suffix}.json`;
    writeFileSync(`${path}.part`,JSON.stringify(value),{mode:0o600,flag:'wx'}); renameSync(`${path}.part`,path);
  };
  const hold=async (boundary:string) => {
    if (request.boundary!==boundary) return;
    save('ready',{boundary,identity,containerId,runId,imageId});
    await new Promise<void>(() => {});
  };
  hooks.before=async args => {
    if (args[2]==='create') await hold('before-create');
    if (args[2]==='start') {
      // Pre-feature RED still reaches a real never-started Docker allocation.
      // The baseline lacks the exact publication callback, not the allocation.
      if (!exactPublished) await hold('created-durable');
      await hold('starting-durable');
    }
  };
  hooks.after=async (args,stdout) => {
    if (args[2]==='create') {
      containerId=stdout.trim();
      const label=args.find(a => a.startsWith('io.class-store.synthetic-pg-owner=')); runId=label?.split('=')[1];
      imageId=args.find(a => /^sha256:[a-f0-9]{64}$/.test(a));
      // Launcher-owned teardown evidence is not a recovery authority/pin.
      save('allocation',{containerId,runId,imageId,packetId:request.anchor.id,identity});
      await hold('create-ack');
    }
    if (args[2]==='start') await hold('start-ack');
  };
  const rename=fs.rename;
  vi.spyOn(fs,'rename').mockImplementation(async (from,to) => {
    if (!String(to).endsWith('/inventory.json')) return rename(from,to);
    const next=JSON.parse(readFileSync(from,'utf8'));
    const boundary=({PLANNED:'intent',CREATED:'created',STARTING:'starting',ALLOCATED:'control'} as Record<string,string>)[next.phase];
    if (boundary) await hold(`before-${boundary}-pin`);
    await rename(from,to);
    if (boundary) await hold(`after-${boundary}-rename`);
  });
  const create=disposable.createDisposablePostgres;
  vi.spyOn(disposable,'createDisposablePostgres').mockImplementation(async registration => {
    const r=registration!;
    const before=r.beforeCreate;
    const enhanced=r as typeof r & {afterCreate?:(v:{containerId:string}) => Promise<void>;beforeStart?:() => Promise<void>};
    const after=enhanced.afterCreate, start=enhanced.beforeStart;
    const db=await create({...r,beforeCreate:async v => { runId=v.runId; imageId=v.imageId; await before(v); await hold('intent-durable'); },
      ...(after ? {afterCreate:async (v:{containerId:string}) => { await after(v); exactPublished=true; await hold('created-durable'); }} : {}),
      ...(start ? {beforeStart:async () => { await hold('before-start-intent'); await start(); }} : {})});
    await hold('database-ready'); return db;
  });
  const allocate=materialized.allocateRestoreTarget;
  vi.spyOn(materialized,'allocateRestoreTarget').mockImplementation(async (...args) => {
    await hold('before-control'); const result=await allocate(...args); await hold('after-control'); return result;
  });
  const restore=materialized.restoreRetainedMaterializedDatabase;
  vi.spyOn(materialized,'restoreRetainedMaterializedDatabase').mockImplementation(async (...args) => {
    await hold('allocated-durable'); return restore(...args);
  });
  try { save('unexpected',{result:await restoreColdDatabase(request.anchor,request.binding)}); expect.fail('Allocation barrier not reached'); }
  finally { vi.restoreAllMocks(); }
},180_000);
