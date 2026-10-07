// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coldCapture, control, coordinator, killWorker, orphan, present, restoreAgain, state, teardownOrphans, type Packet } from '../../../test-support/coldOrphanFixture';
import { coldProcessIdentity, killedColdWorker, watchColdWorker } from '@/server/db/testing/coldProcessWitness';
import { readColdOrphan } from '@/server/db/testing/ownedPgArchive';
import { disposeColdArchive } from '@/server/db/testing/coldRestoreStore';
vi.mock('server-only',() => ({}));
const children:{child:ChildProcess;exit:Promise<unknown>}[]=[];
afterEach(async () => {
  for (const {child,exit} of children.splice(0)) {
    if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    await exit;
  }
  await teardownOrphans();
},90_000);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
async function paused(f:Packet,boundary:string) {
  const resultId=randomUUID(); let output='';
  const child=spawn(process.execPath,['node_modules/vitest/vitest.mjs','run','test-support/coldRecoveryGateChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--pool=threads','--reporter=default','--reporter=json',
    `--outputFile.json=.gate-child-results/${resultId}-vitest.json`],{env:{PATH:process.env.PATH,HOME:process.env.HOME,
    LANG:'C.UTF-8',NODE_ENV:'test',CI:'1',RUN_REAL_POSTGRES:'1',GATE_REQUEST:JSON.stringify({...f,boundary,resultId})},stdio:['ignore','pipe','pipe']});
  const exit=new Promise((resolve,reject) => { child.once('error',reject); child.once('close',(code,signal) => resolve({code,signal})); });
  children.push({child,exit});
  child.stdout.on('data',b => { output+=b.toString(); }); child.stderr.on('data',b => { output+=b.toString(); });
  const observation=await watchColdWorker(child), identity=await coldProcessIdentity(child.pid);
  const path=`.gate-child-results/${resultId}.json`, deadline=Date.now()+120_000;
  while (!existsSync(path)) {
    if (child.exitCode!==null || child.signalCode!==null || Date.now()>deadline) throw new Error(`Coordinator barrier failed: ${output}`);
    await new Promise(done => setTimeout(done,50));
  }
  const barrier=JSON.parse(readFileSync(path,'utf8'));
  expect(barrier.unexpectedCompletion,JSON.stringify(barrier)).not.toBe(true);
  expect(barrier.boundary).toBe(boundary); expect(barrier.identity).toEqual(identity);
  return {child,exit,observation,identity,barrier,resultId};
}
async function killCoordinator(p:Awaited<ReturnType<typeof paused>>) {
  expect(p.child.kill('SIGKILL')).toBe(true); expect(await p.exit).toEqual({code:null,signal:'SIGKILL'});
  const observed=await killedColdWorker(p.observation);
  expect(observed.worker).toEqual(p.identity);
  // This distinct process-local witness is audit evidence ONLY. It is never
  // passed to certifyColdWorkerExit and confers no stale-gate release authority.
  writeFileSync(`.gate-child-results/${p.resultId}-exit.json`,JSON.stringify({role:'recovery-coordinator',coordinator:observed.worker,
    code:observed.code,signal:observed.signal}),{mode:0o600,flag:'wx'});
  console.info('COORDINATOR_FORCED_EXIT',JSON.stringify({barrier:p.barrier,coordinator:observed.worker,code:observed.code,signal:observed.signal}));
}
const boundaries=['gate-acquired','gate-owned','sql-checked','before-remove','remove-ack','after-remove',
  'before-disposition','after-disposition','before-journal','after-journal','before-gate-release'];
suite('cold recovery coordinator gate',() => {
  it.each(boundaries)('preserves fail-closed state after actual coordinator SIGKILL at %s',async boundary => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const proof=readFileSync(`${control(f)}/worker-exit.json`), original=JSON.parse(proof.toString());
    const inventory=JSON.parse(readFileSync(`${control(f)}/inventory.json`,'utf8'));
    const beforeSql=await readColdOrphan(inventory), p=await paused(f,boundary);
    if (boundary==='before-remove') {
      expect(p.barrier.inspections).toBe(3);
      expect(p.barrier.lastCommand).toEqual(['--host','unix:///var/run/docker.sock','inspect',w.ready.evidence.containerId]);
    }
    if (boundary==='remove-ack') expect(p.barrier.lastCommand).toEqual(['--host','unix:///var/run/docker.sock','rm','--force',w.ready.evidence.containerId]);
    expect(p.identity.pid).not.toBe(w.ready.pid); expect(p.identity).not.toEqual(original.worker);
    expect(existsSync(`${control(f)}/recovery-lock`)).toBe(true);
    const journal=readFileSync(`${control(f)}/state.json`), workerLock=existsSync(`${control(f)}/lock`);
    await killCoordinator(p);
    const removed=['remove-ack','after-remove','before-disposition','after-disposition','before-journal','after-journal','before-gate-release'].includes(boundary);
    expect(await present(w)).toBe(!removed);
    const afterSql=removed ? null : await readColdOrphan(inventory);
    if (afterSql) expect(afterSql).toEqual(beforeSql);
    console.info('COORDINATOR_SQL_PRESERVATION',JSON.stringify({boundary,containerId:w.ready.evidence.containerId,beforeSql,afterSql,
      removed,worker:original.worker,coordinator:p.identity,state:state(f),workerLock}));
    // Prove the READY/publication tail cannot start a new restore while the gate
    // survives; a successful restoration here is the behavioral RED, not a mock.
    expect((await restoreAgain(f)).ok).toBe(false);
    const transport=readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`);
    await expect(disposeColdArchive(f.anchor)).rejects.toThrow('Cold restore refused.');
    expect(readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toEqual(transport);
    for (const now of [Date.now(),Date.now()+9_000_000_000]) {
      const retry=await coordinator(f,{now});
      expect(retry.ok,retry.error).toBe(true);
      expect(retry.recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
      expect(readFileSync(`${control(f)}/state.json`)).toEqual(journal);
      expect(existsSync(`${control(f)}/lock`)).toBe(workerLock);
      expect(existsSync(`${control(f)}/recovery-lock`)).toBe(true);
      expect(await present(w)).toBe(!removed);
    }
    const blockers=readdirSync(control(f)).filter(n => n.startsWith('blocked-')).map(n => JSON.parse(readFileSync(`${control(f)}/${n}`,'utf8')));
    expect(blockers).toHaveLength(2);
    for (const b of blockers) expect(b.result).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
    expect(readFileSync(`${control(f)}/worker-exit.json`)).toEqual(proof);
    if (!removed) {
      const finalSql=await readColdOrphan(inventory); expect(finalSql).toEqual(beforeSql);
      console.info('COORDINATOR_FINAL_SQL',JSON.stringify({boundary,containerId:w.ready.evidence.containerId,finalSql}));
    }
    if (boundary==='sql-checked') {
      expect(JSON.parse(readFileSync(`${control(f)}/recovery-lock/owner.json`,'utf8'))).toMatchObject({version:1,anchor:f.anchor,coordinator:p.identity});
      expect(p.barrier.sql).toEqual(beforeSql);
    }
  },300_000);
  it('allows normal recovery after a coordinator dies before gate acquisition',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const p=await paused(f,'before-gate'); expect(existsSync(`${control(f)}/recovery-lock`)).toBe(false);
    await killCoordinator(p); expect(await present(w)).toBe(true);
    const r=await coordinator(f); expect(r.recovery.status).toBe('DISPOSED_EMPTY'); expect(await present(w)).toBe(false);
    expect((await coordinator(f)).recovery).toEqual(r.recovery);
    const retry=await restoreAgain(f); expect(retry.ok,retry.error).toBe(true); expect(retry.restored.databaseId).not.toBe(w.ready.databaseId);
  },300_000);
  it('keeps a live unpublished coordinator gate unproven without allowing recovery',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const dir=control(f), journal=readFileSync(`${dir}/state.json`), proof=readFileSync(`${dir}/worker-exit.json`);
    const transport=readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`);
    const inventory=JSON.parse(readFileSync(`${dir}/inventory.json`,'utf8')), beforeSql=await readColdOrphan(inventory);
    const p=await paused(f,'gate-acquired');
    expect(await coldProcessIdentity(p.child.pid)).toEqual(p.identity);
    expect(existsSync(`${dir}/recovery-lock`)).toBe(true);
    expect(existsSync(`${dir}/recovery-lock/owner.json`)).toBe(false);
    const r=await coordinator(f);
    expect(r.ok,r.error).toBe(true);
    expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
    expect((await restoreAgain(f)).ok).toBe(false); expect(await present(w)).toBe(true);
    expect(readFileSync(`${dir}/state.json`)).toEqual(journal);
    expect(readFileSync(`${dir}/worker-exit.json`)).toEqual(proof);
    expect(readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toEqual(transport);
    const afterSql=await readColdOrphan(inventory); expect(afterSql).toEqual(beforeSql);
    writeFileSync(`.gate-child-results/${p.resultId}-unpublished.json`,JSON.stringify({coordinator:p.identity,
      containerId:w.ready.evidence.containerId,blocker:r.recovery.blocker,beforeSql,afterSql}),{mode:0o600,flag:'wx'});
    await killCoordinator(p);
    expect((await coordinator(f)).recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
    expect((await restoreAgain(f)).ok).toBe(false); expect(await present(w)).toBe(true);
    expect(readFileSync(`${dir}/state.json`)).toEqual(journal);
    expect(readFileSync(`${dir}/worker-exit.json`)).toEqual(proof);
    expect(readFileSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toEqual(transport);
    expect(await readColdOrphan(inventory)).toEqual(beforeSql);
  },300_000);
  it('keeps live coordinator contention separate from original worker exit authority',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const p=await paused(f,'sql-checked'), before=readFileSync(`${control(f)}/state.json`);
    const r=await coordinator(f,{now:Date.now()+9_000_000_000});
    expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_BUSY'});
    expect(await present(w)).toBe(true); expect(readFileSync(`${control(f)}/state.json`)).toEqual(before);
    expect((await restoreAgain(f)).ok).toBe(false); await killCoordinator(p);
    expect((await coordinator(f)).recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
  },300_000);
  it('preserves committed SQL across interrupted quarantine journal publication',async () => {
    const f=await coldCapture(), w=await orphan(f,'committed'); await killWorker(w);
    const inventory=JSON.parse(readFileSync(`${control(f)}/inventory.json`,'utf8')), before=await readColdOrphan(inventory);
    const p=await paused(f,'after-disposition'); await killCoordinator(p);
    expect(state(f).status).toBe('IN_FLIGHT');
    expect(JSON.parse(readFileSync(`${control(f)}/recovery.json`,'utf8')).result).toMatchObject({status:'QUARANTINED',blocker:'SQL_OUTCOME_UNCERTAIN'});
    expect((await coordinator(f)).recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
    expect((await restoreAgain(f)).ok).toBe(false); expect(await present(w)).toBe(true);
    const after=await readColdOrphan(inventory); expect(after).toEqual(before);
    expect(after.identity[0].state).toBe('RESTORED_NONAUTHORITY'); expect(after.receipts[0].activation_allowed).toBe(false);
    expect(after.registry).toHaveLength(3); expect(after.claims).toHaveLength(2); expect(after.operations).toHaveLength(2);
    console.info('COORDINATOR_COMMITTED_PRESERVATION',JSON.stringify({containerId:w.ready.evidence.containerId,before,after}));
  },300_000);
  it('never treats damaged copied or changed-scope gate identity as release authority',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const p=await paused(f,'sql-checked'), path=`${control(f)}/recovery-lock/owner.json`;
    const bytes=readFileSync(path), owner=JSON.parse(bytes.toString()), journal=readFileSync(`${control(f)}/state.json`);
    const exit=JSON.parse(readFileSync(`${control(f)}/worker-exit.json`,'utf8'));
    const inventory=JSON.parse(readFileSync(`${control(f)}/inventory.json`,'utf8')), before=await readColdOrphan(inventory);
    const variants=[{},exit,{...owner,anchor:{...owner.anchor,id:randomUUID()}},
      {...owner,coordinator:exit.worker},{...owner,coordinator:{...p.identity,startTicks:'1'}},
      {...owner,coordinator:{...p.identity,bootId:randomUUID()}},{...owner,coordinator:{...p.identity,pidNamespace:'pid:[0]'}}];
    for (const value of variants) {
      writeFileSync(path,JSON.stringify(value));
      const r=await coordinator(f,{now:Date.now()+9_000_000_000});
      expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
      expect(readFileSync(path,'utf8')).toBe(JSON.stringify(value));
      expect(readFileSync(`${control(f)}/state.json`)).toEqual(journal); expect(await present(w)).toBe(true);
    }
    writeFileSync(path,bytes);
    expect((await coordinator(f)).recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_BUSY'});
    await killCoordinator(p);
    expect((await coordinator(f)).recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
    expect(await readColdOrphan(inventory)).toEqual(before); expect((await restoreAgain(f)).ok).toBe(false);
    console.info('COORDINATOR_DAMAGED_GATE_SQL',JSON.stringify({containerId:w.ready.evidence.containerId,before,after:await readColdOrphan(inventory)}));
  },300_000);
});
