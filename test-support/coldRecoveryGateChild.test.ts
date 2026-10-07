// @vitest-environment node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as cp from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { recoverColdDatabase } from '@/server/db/testing/coldOrphanRecovery';
import { coldProcessIdentity } from '@/server/db/testing/coldProcessWitness';
import * as archive from '@/server/db/testing/ownedPgArchive';
vi.mock('server-only',() => ({}));
vi.mock('node:fs/promises',async original => ({...await original<typeof import('node:fs/promises')>()}));
vi.mock('node:child_process',async original => ({...await original<typeof import('node:child_process')>()}));
const request=process.env.GATE_REQUEST ? JSON.parse(process.env.GATE_REQUEST) : null;
it.skipIf(!request)('owned recovery gate process barrier',async () => {
  const dir=`.cold-restore-control/${request.anchor.id}`, gate=`${dir}/recovery-lock`;
  const identity=await coldProcessIdentity();
  const save=(value:unknown) => {
    mkdirSync('.gate-child-results',{recursive:true,mode:0o700});
    const path=`.gate-child-results/${request.resultId}.json`;
    writeFileSync(`${path}.part`,JSON.stringify(value),{mode:0o600,flag:'wx'}); renameSync(`${path}.part`,path);
  };
  const hold=async (boundary:string,extra:Record<string,unknown>={}) => {
    if (request.boundary!==boundary) return;
    save({boundary,identity,state:JSON.parse(readFileSync(`${dir}/state.json`,'utf8')),...extra});
    await new Promise<void>(() => { /* Only our trusted parent will SIGKILL us. */ });
  };
  const mkdir=fs.mkdir, rename=fs.rename, rmdir=fs.rmdir, mkdtemp=fs.mkdtemp, rm=fs.rm;
  let lastCommand:string[]=[], inspections=0;
  const spawn=cp.spawn;
  vi.spyOn(cp,'spawn').mockImplementation((...args:Parameters<typeof cp.spawn>) => {
    if (args[0]==='docker' && Array.isArray(args[1])) {
      lastCommand=args[1] as string[];
      if (lastCommand[2]==='inspect') inspections++;
    }
    return spawn(...args);
  });
  vi.spyOn(fs,'mkdir').mockImplementation(async (...args:Parameters<typeof fs.mkdir>) => {
    if (String(args[0])===gate || String(args[0]).endsWith(`/${gate}`)) await hold('before-gate');
    const result=await mkdir(...args);
    if (String(args[0]).endsWith('/recovery-lock')) await hold('gate-acquired');
    return result;
  });
  vi.spyOn(fs,'rename').mockImplementation(async (from,to) => {
    const target=String(to);
    if (target.endsWith('/recovery.json')) await hold('before-disposition');
    if (target.endsWith('/state.json')) await hold('before-journal');
    await rename(from,to);
    if (target.endsWith('/owner.json')) await hold('gate-owned');
    if (target.endsWith('/recovery.json')) await hold('after-disposition');
    if (target.endsWith('/state.json')) await hold('after-journal');
  });
  vi.spyOn(fs,'rmdir').mockImplementation(async (...args) => {
    if (String(args[0]).endsWith('/recovery-lock')) await hold('before-gate-release');
    return rmdir(...args);
  });
  vi.spyOn(fs,'mkdtemp').mockImplementation(async (...args:Parameters<typeof fs.mkdtemp>) => {
    // Exact next native command is rm after both SQL inspections and the final
    // physical inspect. Do not fake Docker/SQL results or dispatch a substitute.
    if (inspections===3 && lastCommand[2]==='inspect') await hold('before-remove',{lastCommand,inspections});
    return mkdtemp(...args);
  });
  vi.spyOn(fs,'rm').mockImplementation(async (...args) => {
    await rm(...args);
    if (lastCommand[2]==='rm') await hold('remove-ack',{lastCommand});
  });
  const read=archive.readColdOrphan, dispose=archive.disposeEmptyColdOrphan;
  vi.spyOn(archive,'readColdOrphan').mockImplementation(async (...args) => {
    const sql=await read(...args); await hold('sql-checked',{sql}); return sql;
  });
  vi.spyOn(archive,'disposeEmptyColdOrphan').mockImplementation(async (...args) => {
    const cleanup=await dispose(...args); await hold('after-remove',{cleanup}); return cleanup;
  });
  try {
    const recovery=await recoverColdDatabase(request.anchor,request.binding);
    save({unexpectedCompletion:true,recovery,identity});
    expect.fail('Requested coordinator barrier was not reached');
  } finally { vi.restoreAllMocks(); }
},180_000);
