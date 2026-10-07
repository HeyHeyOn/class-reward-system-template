// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coldCapture, control, coordinator, fixtureDocker, restoreAgain, state, type Packet } from '../../../test-support/coldOrphanFixture';
import { certifyColdWorkerExit } from '@/server/db/testing/coldRestoreStore';
import { coldProcessIdentity, killedColdWorker, watchColdWorker } from '@/server/db/testing/coldProcessWitness';
import { readColdOrphan } from '@/server/db/testing/ownedPgArchive';
vi.mock('server-only',() => ({}));
const children:{child:ChildProcess;exit:Promise<unknown>;resultId:string;f:Packet}[]=[];
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const json=(path:string) => JSON.parse(readFileSync(path,'utf8'));
async function present(id:string) { return await fixtureDocker('ps','-aq','--no-trunc','--filter',`id=${id}`)===id; }
async function physical(id:string) {
  const [v]=JSON.parse(await fixtureDocker('inspect',id));
  return {Id:v.Id,Name:v.Name,Image:v.Image,State:v.State,RestartCount:v.RestartCount,Labels:v.Config.Labels,
    User:v.Config.User,HostConfig:v.HostConfig,Mounts:v.Mounts};
}
async function nativeAllocationSql(id:string) {
  return fixtureDocker('exec','--user','postgres',id,'psql','-X','-w','-qAt','-h','/var/run/postgresql','-U','postgres','-d','postgres',
    '--set','ON_ERROR_STOP=1','-c',"BEGIN READ ONLY; SELECT jsonb_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()),'control',to_regclass('local_restore_control.lease'),'tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public')); COMMIT;");
}
afterEach(async () => {
  for (const w of children.splice(0)) {
    if (w.child.exitCode===null && w.child.signalCode===null) w.child.kill('SIGKILL');
    await w.exit;
    const path=`.allocation-child-results/${w.resultId}-allocation.json`;
    if (!existsSync(path)) continue;
    const a=json(path), id=a.containerId;
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    if (await present(id)) {
      const p=await physical(id);
      expect(p.Id).toBe(id); expect(p.Image).toBe(a.imageId); expect(p.Name).toBe(`/crs-app-pg-${a.runId}`);
      expect(p.Labels).toMatchObject({'io.class-store.synthetic-pg-owner':a.runId,'io.class-store.cold-packet':w.f.anchor.id});
      expect(p.HostConfig.NetworkMode).toBe('none'); expect(p.HostConfig.Binds).toBeNull();
      await fixtureDocker('rm','--force',id);
    }
    expect(await present(id)).toBe(false);
    console.info('ALLOCATION_FIXTURE_CLEANUP',JSON.stringify({id,absent:true,authority:'explicit newly owned synthetic fixture teardown, not recovery'}));
  }
},90_000);
async function paused(f:Packet,boundary:string) {
  const resultId=randomUUID(); let output='';
  const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldAllocationChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--pool=threads','--reporter=default','--reporter=json',
    `--outputFile.json=.allocation-child-results/${resultId}-vitest.json`],{env:{PATH:process.env.PATH,HOME:process.env.HOME,
      LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',ALLOCATION_REQUEST:JSON.stringify({...f,boundary,resultId})},stdio:['ignore','pipe','pipe']});
  const exit=new Promise((resolve,reject) => { child.once('error',reject); child.once('close',(code,signal) => resolve({code,signal})); });
  children.push({child,exit,resultId,f});
  child.stdout.on('data',b => { output+=b.toString(); }); child.stderr.on('data',b => { output+=b.toString(); });
  const observation=await watchColdWorker(child), identity=await coldProcessIdentity(child.pid);
  const path=`.allocation-child-results/${resultId}-ready.json`, deadline=Date.now()+120_000;
  while (!existsSync(path)) {
    if (child.exitCode!==null || child.signalCode!==null || Date.now()>deadline) throw new Error(`Allocation barrier failed: ${output}`);
    await new Promise(done => setTimeout(done,50));
  }
  const barrier=json(path); expect(barrier.identity).toEqual(identity); expect(barrier.boundary).toBe(boundary);
  return {child,exit,observation,identity,barrier,resultId};
}
async function kill(w:Awaited<ReturnType<typeof paused>>,f:Packet,certify=true) {
  expect(w.child.kill('SIGKILL')).toBe(true); expect(await w.exit).toEqual({code:null,signal:'SIGKILL'});
  const proof=await killedColdWorker(w.observation);
  writeFileSync(`.allocation-child-results/${w.resultId}-exit.json`,JSON.stringify(proof),{mode:0o600,flag:'wx'});
  if (certify) await certifyColdWorkerExit(f.anchor,w.observation);
  console.info('ALLOCATION_FORCED_EXIT',JSON.stringify({boundary:w.barrier.boundary,...proof}));
}
const uncertain=['before-intent-pin','after-intent-rename','intent-durable','before-create','create-ack','before-created-pin',
  'after-starting-rename','starting-durable','start-ack','database-ready','before-control','after-control','before-control-pin'];
const safe=['after-created-rename','created-durable','before-start-intent','before-starting-pin','after-control-rename','allocated-durable'];
suite('cold allocation pin recovery',() => {
  it.each([...uncertain,...safe])('reads back actual worker SIGKILL at %s',async boundary => {
    const f=await coldCapture(), w=await paused(f,boundary), dir=control(f);
    const id=w.barrier.containerId as string|undefined;
    const inventory=existsSync(`${dir}/inventory.json`) ? json(`${dir}/inventory.json`) : null;
    const files=Object.fromEntries(readdirSync(dir).filter(n => n.endsWith('.json')).map(n => [n,readFileSync(`${dir}/${n}`,'utf8')]));
    await kill(w,f);
    const proof=readFileSync(`${dir}/worker-exit.json`), transport=readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`);
    const before=id ? await physical(id) : null;
    const scopedIds=await fixtureDocker('ps','-aq','--no-trunc','--filter',`label=io.class-store.synthetic-pg-owner=${w.barrier.runId}`,
      '--filter',`label=io.class-store.cold-packet=${f.anchor.id}`);
    expect(scopedIds).toBe(id ?? '');
    let sql:unknown=null;
    if (id && ['after-control','before-control-pin','after-control-rename','allocated-durable'].includes(boundary)) {
      sql=await readColdOrphan({...inventory,containerId:id});
    } else if (id && ['database-ready','before-control'].includes(boundary)) {
      sql=await nativeAllocationSql(id);
    }
    const r=await coordinator(f); expect(r.ok,r.error).toBe(true);
    // Preserve readback even when this behavioral assertion is RED.
    mkdirSync('.allocation-evidence',{recursive:true,mode:0o700});
    const evidence={boundary,anchor:f.anchor,identity:w.identity,files,inventory,proof:JSON.parse(proof.toString()),before,scopedIds,sql,result:r.recovery};
    writeFileSync(`.allocation-evidence/${w.resultId}.json`,JSON.stringify(evidence),{mode:0o600,flag:'wx'});
    let afterSql:unknown=null;
    if (safe.includes(boundary)) {
      expect(r.recovery.status).toBe('DISPOSED_EMPTY'); expect(r.recovery.cleanup.id).toBe(id);
      expect(await present(id!)).toBe(false); expect(state(f).status).toBe('READY');
      expect(existsSync(`${dir}/lock`)).toBe(false);
      const retry=await restoreAgain(f); expect(retry.ok,retry.error).toBe(true);
      expect(retry.restored.containerId).not.toBe(id); expect(retry.guardsVerified).toBe(true);
      expect(retry.restored.cleanup.containerRemoved).toBe(true);
    } else {
      const expected=inventory?.phase==='STARTING' ? 'CONTROL_PIN_INCOMPLETE' : inventory ? 'ALLOCATION_ID_UNPROVEN' : 'INVENTORY_MISMATCH';
      expect(r.recovery).toMatchObject({status:'QUARANTINED',blocker:expected});
      expect(existsSync(`${dir}/lock`)).toBe(true);
      expect((await restoreAgain(f)).ok).toBe(false);
      expect((await coordinator(f,{now:Date.now()+9_000_000_000})).recovery).toEqual(r.recovery);
      if (id) {
        expect(await present(id)).toBe(true);
        const after=await physical(id); expect(after.Id).toBe(before?.Id); expect(after.Labels).toEqual(before?.Labels);
        if (sql) {
          afterSql=['after-control','before-control-pin'].includes(boundary)
            ? await readColdOrphan({...inventory,containerId:id}) : await nativeAllocationSql(id);
          expect(afterSql).toEqual(sql);
        }
      }
      if (inventory) expect(json(`${dir}/inventory.json`)).toEqual(inventory);
      const disposition=json(`${dir}/recovery.json`); expect(disposition.result).toEqual(r.recovery);
    }
    expect(readFileSync(`${dir}/worker-exit.json`)).toEqual(proof);
    expect(readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toEqual(transport);
    const final={...evidence,afterSql,finalState:state(f),present:id ? await present(id) : null,
      finalInventory:existsSync(`${dir}/inventory.json`) ? json(`${dir}/inventory.json`) : null,
      lock:existsSync(`${dir}/lock`),recoveryGate:existsSync(`${dir}/recovery-lock`),
      transportSha256:createHash('sha256').update(transport).digest('hex'),
      finalPhysical:id && await present(id) ? await physical(id) : null};
    writeFileSync(`.allocation-evidence/${w.resultId}-final.json`,JSON.stringify(final),{mode:0o600,flag:'wx'});
    console.info('ALLOCATION_BOUNDARY_READBACK',JSON.stringify(final));
  },300_000);
  it('does not turn live or uncertified CREATED allocation into cleanup authority',async () => {
    const f=await coldCapture(), w=await paused(f,'created-durable'), before=readFileSync(`${control(f)}/state.json`);
    expect((await coordinator(f,{now:Date.now()+9_000_000_000})).recovery).toMatchObject({status:'BLOCKED',blocker:'WORKER_STILL_LIVE'});
    await kill(w,f,false);
    expect((await coordinator(f,{now:Date.now()+9_000_000_000})).recovery).toMatchObject({status:'BLOCKED',blocker:'EXIT_UNPROVEN'});
    expect(readFileSync(`${control(f)}/state.json`)).toEqual(before); expect(await present(w.barrier.containerId)).toBe(true);
    await certifyColdWorkerExit(f.anchor,w.observation);
    expect((await coordinator(f)).recovery.status).toBe('DISPOSED_EMPTY');
  },300_000);
  it.each(['containerId','packetId','imageId','missing-id'])('preserves CREATED on damaged exact pin %s',async field => {
    const f=await coldCapture(), w=await paused(f,'created-durable'); await kill(w,f);
    const path=`${control(f)}/inventory.json`, inventory=json(path), damaged={...inventory};
    if (field==='missing-id') delete damaged.containerId;
    else damaged[field]=field==='containerId' ? '0'.repeat(64) : field==='imageId' ? 'sha256:'+'0'.repeat(64) : randomUUID();
    writeFileSync(path,JSON.stringify(damaged));
    const r=await coordinator(f);
    expect(r.recovery.status).toBe('QUARANTINED');
    expect(['INVENTORY_MISMATCH','OWNERSHIP_MISMATCH']).toContain(r.recovery.blocker);
    expect(await present(w.barrier.containerId)).toBe(true); expect((await restoreAgain(f)).ok).toBe(false);
    console.info('ALLOCATION_DAMAGED_PIN',JSON.stringify({field,inventory,damaged,result:r.recovery,physical:await physical(w.barrier.containerId)}));
  },300_000);
  it.each(['running','stopped'])('rejects CREATED if native Docker proves it was %s',async mode => {
    const f=await coldCapture(), w=await paused(f,'created-durable'); await kill(w,f);
    const id=w.barrier.containerId;
    // Explicit new synthetic fixture corruption, not product recovery/start.
    await fixtureDocker('start',id);
    if (mode==='stopped') await fixtureDocker('stop','--time','2',id);
    const before=await physical(id), r=await coordinator(f);
    expect(r.recovery).toMatchObject({status:'QUARANTINED',blocker:'ALLOCATION_START_UNPROVEN'});
    expect(await present(id)).toBe(true); expect((await restoreAgain(f)).ok).toBe(false);
    expect((await physical(id)).Id).toBe(before.Id);
    console.info('ALLOCATION_START_NEGATIVE',JSON.stringify({mode,before,result:r.recovery}));
  },300_000);
});
