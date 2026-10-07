// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coldCapture, control, coordinator, fixtureDocker, killWorker, orphan, present, restoreAgain, state, teardownOrphans } from '../../../test-support/coldOrphanFixture';
import { certifyColdWorkerExit } from '@/server/db/testing/coldRestoreStore';
vi.mock('server-only', () => ({}));
afterEach(teardownOrphans,90_000);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
suite('cold orphan owned recovery',() => {
  it('persists explicit blockers for malformed exit fields without touching the target',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const path=`${control(f)}/worker-exit.json`, bytes=readFileSync(path), before=readFileSync(`${control(f)}/state.json`);
    for (const field of ['worker','anchor']) {
      const proof=JSON.parse(bytes.toString()); delete proof[field]; writeFileSync(path,JSON.stringify(proof));
      const r=await coordinator(f);
      expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'EXIT_UNPROVEN'});
      expect(await present(w)).toBe(true); expect(readFileSync(`${control(f)}/state.json`)).toEqual(before);
    }
    expect(readdirSync(control(f)).filter(name => name.startsWith('blocked-'))).toHaveLength(2);
    writeFileSync(path,bytes); expect((await coordinator(f)).recovery.status).toBe('DISPOSED_EMPTY');
  },240_000);
  it('blocks a disposition published before a failed journal write and preserves the committed orphan',async () => {
    const f=await coldCapture(), w=await orphan(f,'committed'); await killWorker(w);
    const failed=await coordinator(f,{fault:'journal-publication'});
    expect(failed.ok).toBe(false); expect(failed.error).toBe('Injected recovery state publish failure');
    expect(JSON.parse(readFileSync(`${control(f)}/recovery.json`,'utf8')).result.status).toBe('QUARANTINED');
    expect(state(f).status).toBe('IN_FLIGHT'); expect(await present(w)).toBe(true);
    const retry=await coordinator(f);
    expect(retry.ok,retry.error).toBe(true); expect(retry.recovery).toMatchObject({status:'BLOCKED',blocker:'RECOVERY_PUBLICATION_INCOMPLETE'});
    expect(state(f).status).toBe('IN_FLIGHT'); expect(await present(w)).toBe(true); expect((await restoreAgain(f)).ok).toBe(false);
    expect(readdirSync(control(f)).filter(name => name.startsWith('blocked-'))).toHaveLength(1);
  },240_000);
  it('preserves a target if the durable worker lock is missing',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    renameSync(`${control(f)}/lock`,`${control(f)}/test-preserved-lock`);
    const r=await coordinator(f);
    expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'LEASE_LOCK_UNPROVEN'});
    expect(state(f).status).toBe('IN_FLIGHT'); expect(await present(w)).toBe(true);
    expect((await restoreAgain(f)).ok).toBe(false);
  },240_000);
  it('rejects a copied exit claim and a mismatched observed attempt without consuming the lease',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const path=`${control(f)}/worker-exit.json`, bytes=readFileSync(path), proof=JSON.parse(bytes.toString());
    await expect(certifyColdWorkerExit(f.anchor,proof)).rejects.toThrow(/witness refused/);
    writeFileSync(path,JSON.stringify({...proof,attemptId:randomUUID()}));
    const r=await coordinator(f);
    expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'EXIT_UNPROVEN'}); expect(await present(w)).toBe(true);
    writeFileSync(path,bytes);
    expect((await coordinator(f)).recovery.status).toBe('DISPOSED_EMPTY'); expect(await present(w)).toBe(false);
  },240_000);
  it.each(['owner_id','database_id'])('quarantines mismatched native SQL %s despite a matching container label',async column => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const tampered=randomUUID();
    const sql=`ALTER TABLE local_restore_control.lease DISABLE TRIGGER USER;
      UPDATE local_restore_control.lease SET ${column}='${tampered}';
      ALTER TABLE local_restore_control.lease ENABLE TRIGGER USER;
      SELECT row_to_json(t) FROM local_restore_control.lease t;`;
    const observed=await fixtureDocker('exec','--user','postgres',w.ready.evidence.containerId,'psql','-X','-w','-qAt','-h','/var/run/postgresql','-U','postgres','-d','postgres','--set','ON_ERROR_STOP=1','-c',sql);
    expect(JSON.parse(observed)[column]).toBe(tampered); console.info('ORPHAN_SQL_IDENTITY_NEGATIVE',observed);
    const r=await coordinator(f);
    expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'QUARANTINED',blocker:'CONTROL_MISMATCH'});
    expect(await present(w)).toBe(true); expect((await restoreAgain(f)).ok).toBe(false);
  },240_000);
  it.each(['ownerId','runId','systemIdentifier','missing'])('preserves a target on damaged inventory %s',async field => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const path=`${control(f)}/inventory.json`, inventory=JSON.parse(readFileSync(path,'utf8'));
    if (field==='missing') renameSync(path,`${control(f)}/test-preserved-inventory.json`);
    else writeFileSync(path,JSON.stringify({...inventory,[field]:field==='systemIdentifier' ? '0' : randomUUID()}));
    const r=await coordinator(f);
    expect(r.ok,r.error).toBe(true); expect(r.recovery.status).toBe('QUARANTINED');
    expect(['INVENTORY_MISMATCH','OWNERSHIP_MISMATCH','CONTROL_MISMATCH']).toContain(r.recovery.blocker);
    expect(await present(w)).toBe(true); expect((await restoreAgain(f)).ok).toBe(false);
  },240_000);
  it('never steals a live worker lock even after arbitrarily old timestamps',async () => {
    const f=await coldCapture(), w=await orphan(f), before=readFileSync(`${control(f)}/state.json`);
    const r=await coordinator(f,{now:Date.now()+9_000_000});
    expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'WORKER_STILL_LIVE'});
    expect(readFileSync(`${control(f)}/state.json`)).toEqual(before); expect(await present(w)).toBe(true);
    expect((await restoreAgain(f)).ok).toBe(false);
  },240_000);
  it('preserves a killed worker target without a trusted exit observation',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w,false);
    const r=await coordinator(f,{now:Date.now()+9_000_000});
    expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'BLOCKED',blocker:'EXIT_UNPROVEN'});
    expect(state(f).status).toBe('IN_FLIGHT'); expect(await present(w)).toBe(true);
  },240_000);
  it('rejects wrong owner pin UUID and binding without touching the owned orphan',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const before=readFileSync(`${control(f)}/state.json`);
    for (const extra of [
      {anchor:{...f.anchor,ownerId:randomUUID()}}, {anchor:{...f.anchor,expectationSha256:'0'.repeat(64)}},
      {anchor:{...f.anchor,id:'../'+f.anchor.id}}, {anchor:{...f.anchor,id:randomUUID()}},
      {binding:{...f.binding,manifestDigest:'0'.repeat(64)}},
    ]) { const r=await coordinator(f,extra); expect(r.ok).toBe(false); expect(r.error).toMatch(/Cold restore refused/); }
    expect(readFileSync(`${control(f)}/state.json`)).toEqual(before); expect(await present(w)).toBe(true);
    const recovered=await coordinator(f); expect(recovered.ok,recovered.error).toBe(true);
    expect(recovered.recovery.status).toBe('DISPOSED_EMPTY');
  },240_000);
  it('identifies only its pinned inventory and refuses another packet database',async () => {
    const a=await coldCapture(), wa=await orphan(a); await killWorker(wa);
    const b=await coldCapture(), wb=await orphan(b); await killWorker(wb);
    const path=`${control(a)}/inventory.json`, other=`${control(b)}/inventory.json`;
    // On pre-feature RED there is no inventory; the coordinator must still
    // reach its missing behavior after two actual orphan allocations/kills.
    if (existsSync(path) && existsSync(other)) writeFileSync(path,readFileSync(other));
    const r=await coordinator(a);
    expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'QUARANTINED',blocker:'INVENTORY_MISMATCH'});
    expect(await present(wa)).toBe(true); expect(await present(wb)).toBe(true);
    expect((await restoreAgain(a)).ok).toBe(false); expect(state(b).status).toBe('IN_FLIGHT');
  },300_000);
  it.each(['partial','residue','committed'])('preserves %s SQL uncertainty and rejects every retry',async fault => {
    const f=await coldCapture(), w=await orphan(f,fault); await killWorker(w);
    const r=await coordinator(f);
    expect(r.ok,r.error).toBe(true); expect(r.pid).not.toBe(w.ready.pid);
    expect(r.recovery.status).toBe('QUARANTINED');
    expect(r.recovery.blocker).toBe(fault==='partial' ? 'SQL_STILL_ACTIVE' : 'SQL_OUTCOME_UNCERTAIN');
    expect(await present(w)).toBe(true); expect(state(f).status).toBe('QUARANTINED');
    expect((await restoreAgain(f)).ok).toBe(false);
    const again=await coordinator(f); expect(again.recovery).toEqual(r.recovery); expect(await present(w)).toBe(true);
    if (fault==='committed') {
      expect(r.recovery.readback.identity[0]).toMatchObject({database_id:w.ready.databaseId,state:'RESTORED_NONAUTHORITY'});
      expect(r.recovery.readback.identity[0].owner_id).not.toBe(f.anchor.ownerId);
      expect(r.recovery.readback.receipts[0]).toMatchObject({authority:'NONAUTHORITY',activation_allowed:false,destination_database_id:w.ready.databaseId});
      expect(r.recovery.readback.registry).toHaveLength(3);
      expect(r.recovery.readback.claims).toHaveLength(2);
      expect(r.recovery.readback.operations).toHaveLength(2);
    }
  },240_000);
  it('preserves an exact owned target when destination SQL readback is unavailable',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    await fixtureDocker('stop','--time','2',w.ready.evidence.containerId);
    const r=await coordinator(f);
    expect(r.ok,r.error).toBe(true); expect(r.recovery).toMatchObject({status:'QUARANTINED',blocker:'DESTINATION_UNREADABLE'});
    expect(await present(w)).toBe(true); expect((await restoreAgain(f)).ok).toBe(false);
  },240_000);
  it('disposes only a proven pre-dispatch empty target then restores to a new identity once',async () => {
    const f=await coldCapture(), w=await orphan(f); await killWorker(w);
    const results=await Promise.all([coordinator(f),coordinator(f)]);
    for (const r of results) expect(r.ok,r.error).toBe(true);
    const completed=results.filter(r => r.recovery.status==='DISPOSED_EMPTY');
    expect(completed.length).toBeGreaterThan(0);
    for (const r of results) expect(['DISPOSED_EMPTY','BLOCKED']).toContain(r.recovery.status);
    // A contender may reach EEXIST before owner publication or during removal.
    // Without a readable live owner that gate is UNPROVEN, never releaseable.
    for (const r of results.filter(r => r.recovery.status==='BLOCKED')) {
      expect(['RECOVERY_BUSY','RECOVERY_GATE_UNPROVEN']).toContain(r.recovery.blocker);
    }
    expect(completed[0].recovery.cleanup).toMatchObject({containerRemoved:true,id:w.ready.evidence.containerId});
    expect(completed[0].recovery.readback).toMatchObject({publicObjects:[],identity:[],receipts:[],registry:[]});
    expect(await present(w)).toBe(false); expect(state(f).status).toBe('READY');
    const again=await coordinator(f); expect(again.recovery).toEqual(completed[0].recovery);
    const retry=await restoreAgain(f); expect(retry.ok,retry.error).toBe(true);
    expect(retry.restored.databaseId).not.toBe(w.ready.databaseId); expect(retry.guardsVerified).toBe(true);
    expect(retry.restored.readback.relationships.claims).toHaveLength(2);
    expect(retry.restored.readback.relationships.tombstones).toEqual([{n:1}]);
    expect(retry.restored.cleanup.containerRemoved).toBe(true); expect(state(f).status).toBe('SUCCEEDED');
    expect((await restoreAgain(f)).ok).toBe(false);
  },300_000);
});
