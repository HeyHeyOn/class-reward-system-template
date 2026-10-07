// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coldCapture, control, coordinator, restoreAgain, state } from '../../../test-support/coldOrphanFixture';
import { cleanupCreated, createdWorker, exact, json, kill, nativeTrace, removalCoordinator, resume, save, sourceSnapshot } from '../../../test-support/coldCreatedRemovalFixture';
import { certifyColdWorkerExit, disposeColdArchive } from '@/server/db/testing/coldRestoreStore';
import { killedColdWorker } from '@/server/db/testing/coldProcessWitness';
vi.mock('server-only',() => ({}));
afterEach(cleanupCreated,90_000);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const boundaries=['created-before-rm','created-rm-ack','created-readback','created-published'];
function assertNative(trace:ReturnType<typeof nativeTrace>,id:string,removed:boolean,readback:boolean) {
  const launched=trace.filter(v => v.event==='spawn'), closed=trace.filter(v => v.event==='close');
  expect(launched.every(v => !['start','exec'].includes(v.requested[2]))).toBe(true);
  expect(launched.every(v => !v.requested.includes('--force'))).toBe(true);
  const inspections=closed.filter(v => v.requested[2]==='inspect');
  expect(inspections).toHaveLength(2);
  for (const inspection of inspections) {
    expect(inspection.code).toBe(0); expect(inspection.signal).toBeNull();
    const [physical]=JSON.parse(inspection.stdout);
    expect(physical.Id).toBe(id); expect(physical.State).toMatchObject({Status:'created',Running:false,Pid:0,StartedAt:'0001-01-01T00:00:00Z'});
  }
  const rms=closed.filter(v => v.requested[2]==='rm');
  expect(rms).toHaveLength(removed ? 1 : 0);
  if (removed) {
    expect(rms[0]).toMatchObject({code:0,signal:null,stdout:`${id}\n`,stderr:''});
    expect(rms[0].actual).toEqual(['--host','unix:///var/run/docker.sock','rm',id]);
  }
  const absent=closed.filter(v => v.requested.includes(`id=${id}`));
  expect(absent).toHaveLength(readback ? 1 : 0);
  if (readback) expect(absent[0]).toMatchObject({code:0,signal:null,stdout:'',stderr:''});
}
suite('CREATED exact removal coordinator crash',() => {
  it.each(boundaries)('keeps original authority fail closed after witnessed SIGKILL at %s',async boundary => {
    const f=await coldCapture(), w=await createdWorker(f); await kill(w,'worker',f);
    const original=sourceSnapshot(f), workerProof=readFileSync(`${control(f)}/worker-exit.json`);
    const c=await removalCoordinator(f,boundary);
    expect(c.identity).not.toEqual(w.identity); expect(c.identity.pid).not.toBe(w.identity.pid);
    const atBarrier=sourceSnapshot(f), nativeBeforeKill=await exact(w.id);
    expect(state(f).status).toBe('IN_FLIGHT'); expect(existsSync(`${control(f)}/lock`)).toBe(true);
    expect(existsSync(`${control(f)}/recovery-lock`)).toBe(true);
    expect(json(`${control(f)}/recovery-lock/owner.json`).coordinator).toEqual(c.identity);
    const exit=await kill(c,'coordinator',f), removed=boundary!=='created-before-rm';
    const afterKill=await exact(w.id), trace=nativeTrace(c.resultId);
    save(`${c.resultId}-crash`,{boundary,anchor:f.anchor,worker:w.identity,coordinator:c.identity,original,atBarrier,afterKill,
      nativeBeforeKill,trace,exit,sql:'NOT_APPLICABLE_NEVER_STARTED',destinationControl:'NOT_CREATED'});
    assertNative(trace,w.id,removed,['created-readback','created-published'].includes(boundary));
    expect(afterKill.stdout).toBe(removed ? '' : w.id);
    expect(sourceSnapshot(f)).toEqual(atBarrier);
    expect(existsSync(`${control(f)}/recovery.json`)).toBe(boundary==='created-published');
    if (boundary==='created-published') {
      expect(json(`${control(f)}/recovery.json`).result).toMatchObject({status:'DISPOSED_EMPTY',readback:{kind:'NEVER_STARTED'},cleanup:{id:w.id,containerRemoved:true}});
    }
    // A real coordinator witness is distinct from the original worker witness.
    // Neither its serialized report nor its process-local observation can be
    // promoted into worker-exit authority or used to release a stale gate.
    await expect(killedColdWorker(JSON.parse(JSON.stringify(exit.witness)))).rejects.toThrow('Cold process witness refused.');
    await expect(certifyColdWorkerExit(f.anchor,c.observation)).rejects.toThrow('Cold restore refused.');
    for (const now of [Date.now(),Date.now()+9_000_000_000]) {
      const recovery=await coordinator(f,{now});
      expect(recovery.ok,recovery.error).toBe(true);
      expect(recovery.recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
      expect((await restoreAgain(f)).ok).toBe(false);
      await expect(disposeColdArchive(f.anchor)).rejects.toThrow('Cold restore refused.');
      expect(sourceSnapshot(f)).toEqual(atBarrier);
      expect((await exact(w.id)).stdout).toBe(removed ? '' : w.id);
    }
    expect(readFileSync(`${control(f)}/worker-exit.json`)).toEqual(workerProof);
    save(`${c.resultId}-final`,{boundary,source:sourceSnapshot(f),native:await exact(w.id),state:state(f),
      gateReleased:false,restoreAllowed:false,coordinatorEvidencePromoted:false,sql:'NOT_APPLICABLE_NEVER_STARTED'});
  },300_000);
  it.each(['missing','copied-worker-exit','copied-owner','replaced-gate'])('refuses unauthorized disposition and gate release on %s owner after native rm',async mode => {
    const f=await coldCapture(), w=await createdWorker(f); await kill(w,'worker',f);
    const c=await removalCoordinator(f,'created-rm-ack'), dir=control(f), owner=`${dir}/recovery-lock/owner.json`;
    if (mode==='missing') unlinkSync(owner);
    else if (mode==='copied-worker-exit') writeFileSync(owner,readFileSync(`${dir}/worker-exit.json`));
    else if (mode==='copied-owner') {
      writeFileSync(`${owner}.copy`,readFileSync(owner),{mode:0o600,flag:'wx'}); renameSync(`${owner}.copy`,owner);
    } else {
      const bytes=readFileSync(owner);
      renameSync(`${dir}/recovery-lock`,`${dir}/test-preserved-gate`);
      mkdirSync(`${dir}/recovery-lock`,{mode:0o700}); writeFileSync(owner,bytes,{mode:0o600,flag:'wx'});
    }
    const damaged=sourceSnapshot(f), result=await resume(c), after=sourceSnapshot(f), native=await exact(w.id), trace=nativeTrace(c.resultId);
    // Save the observed unsafe result BEFORE the behavioral RED can fail.
    save(`${c.resultId}-unauthorized`,{mode,result,damaged,after,native,trace,state:state(f)});
    expect(state(f).status).toBe('IN_FLIGHT');
    expect(existsSync(`${dir}/recovery-lock`)).toBe(true);
    expect(existsSync(`${dir}/recovery.json`)).toBe(false);
    expect(after).toEqual(damaged); expect(native.stdout).toBe('');
    assertNative(trace,w.id,true,true);
    expect((await coordinator(f)).recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_GATE_UNPROVEN'});
    expect((await restoreAgain(f)).ok).toBe(false);
    await expect(disposeColdArchive(f.anchor)).rejects.toThrow('Cold restore refused.');
    expect(sourceSnapshot(f)).toEqual(damaged);
  },300_000);
  it('keeps real failed absence readback uncertain instead of synthesizing cleanup or READY',async () => {
    const f=await coldCapture(), w=await createdWorker(f); await kill(w,'worker',f);
    const original=sourceSnapshot(f), c=await removalCoordinator(f,'created-rm-ack',{unreadableAbsence:true});
    const result=await resume(c), trace=nativeTrace(c.resultId), native=await exact(w.id);
    save(`${c.resultId}-uncertain`,{result,trace,native,original,after:sourceSnapshot(f),state:state(f)});
    expect(result).toMatchObject({ok:true,recovery:{status:'QUARANTINED',blocker:'DESTINATION_UNREADABLE'}});
    expect(result.recovery.cleanup).toBeUndefined(); expect(result.recovery.readback).toBeUndefined();
    const failed=trace.filter(v => v.event==='close' && v.requested.includes(`id=${w.id}`));
    expect(failed).toHaveLength(1); expect(failed[0].code).not.toBe(0); expect(failed[0].stderr).not.toBe('');
    expect(failed[0].actual[1]).toBe('unix:///scratch/created-readback-unavailable.sock');
    expect(native.stdout).toBe(''); expect(state(f).status).toBe('QUARANTINED');
    expect(existsSync(`${control(f)}/lock`)).toBe(true);
    expect((await coordinator(f,{now:Date.now()+9_000_000_000})).recovery).toEqual(result.recovery);
    expect((await restoreAgain(f)).ok).toBe(false);
    const after=sourceSnapshot(f);
    for (const key of ['inventory.json','worker-exit.json','lock','transport']) expect(after[key]).toEqual(original[key]);
  },300_000);
  it('finishes only uninterrupted exact native removal with owned gate and confirmed absence',async () => {
    const f=await coldCapture(), w=await createdWorker(f); await kill(w,'worker',f);
    const c=await removalCoordinator(f,'created-rm-ack'), result=await resume(c), trace=nativeTrace(c.resultId);
    save(`${c.resultId}-positive`,{result,trace,native:await exact(w.id),source:sourceSnapshot(f)});
    assertNative(trace,w.id,true,true);
    expect(result).toMatchObject({ok:true,recovery:{status:'DISPOSED_EMPTY',cleanup:{containerRemoved:true,id:w.id},readback:{kind:'NEVER_STARTED'}}});
    expect(state(f).status).toBe('READY');
    expect(existsSync(`${control(f)}/recovery-lock`)).toBe(false); expect(existsSync(`${control(f)}/lock`)).toBe(false);
    expect((await exact(w.id)).stdout).toBe('');
    const fresh=await restoreAgain(f);
    save(`${c.resultId}-fresh`,fresh);
    expect(fresh.ok,fresh.error).toBe(true); expect(fresh.restored.containerId).not.toBe(w.id);
    expect(fresh.restored.cleanup.containerRemoved).toBe(true); expect(fresh.guardsVerified).toBe(true);
  },300_000);
});
