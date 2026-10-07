// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import * as api from '@/server/exports/syntheticSealedExport';
import * as terminal from '@/server/exports/syntheticProductTerminal';
import { acquireColdArchive, type ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import { coldProcessIdentity } from '@/server/db/testing/coldProcessWitness';
import { readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import { borrowChainDatabase } from './productChainHarness';
import { preactivationWitness } from './sealedPreactivationHarness';
import { coldFiles, save } from './sealedCrashHarness';
vi.mock('server-only',() => ({}));
const request=process.env.SEALED_CRASH_REQUEST ? JSON.parse(readFileSync(process.env.SEALED_CRASH_REQUEST,'utf8')) : null;
const id=process.env.SEALED_CRASH_RESULT!;
it.skipIf(!request)('sealed partial restore cold application child',async () => {
  let result:Record<string,unknown>={},release:(() => Promise<void>)|undefined;
  try {
    const coordinator=await borrowChainDatabase(request.coordinator); release=coordinator.release;
    const {ref,anchor,base,pin}=request.captured,cp=request.coordinatorPin;
    if (request.phase==='crash') {
      const replay=terminal.replaySealedProductSegment;
      let calls=0;
      vi.spyOn(terminal,'replaySealedProductSegment').mockImplementation(async (...args) => {
        const [db,owner]=args; calls++;
        if (calls===1) save(id,'allocation',{runId:db.runId,evidence:db.evidence,owner});
        const hold=async (transaction?:unknown) => {
          save(id,'barrier',{pid:process.pid,identity:await coldProcessIdentity(),boundary:request.boundary,
            destination:{runId:db.runId,evidence:db.evidence},owner,transaction});
          await new Promise<void>(() => { /* Trusted launcher kills this actual application. */ });
        };
        if (calls===2 && request.boundary==='during-transaction') {
          const connect=db.owner.connect.bind(db.owner);
          vi.spyOn(db.owner,'connect').mockImplementation(((...parameters:unknown[]) => {
            // Pool.query uses connect(callback); preserve it. Instrument only
            // the application's explicit transaction-client Promise acquisition.
            if (parameters.length) return Reflect.apply(connect,db.owner,parameters);
            return connect().then(q => {
              const query=q.query.bind(q);
              q.query=(async (...params:unknown[]) => {
                if (params[0]==='COMMIT') {
                  const backend=(await query('SELECT pg_backend_pid() AS pid')).rows[0];
                  await hold({backend,checkpoint:(await query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows,
                    public:await readMaterializedRecoveryState(q)});
                }
                return Reflect.apply(query,q,params);
              }) as typeof q.query;
              return q;
            });
          }) as typeof db.owner.connect);
        }
        const replayed=await replay(...args);
        if (calls===(request.segment ?? 1) && request.boundary==='after-commit') await hold({committed:replayed,
          checkpoint:(await db.owner.query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows,
          public:await readMaterializedRecoveryState(db.owner)});
        return replayed;
      });
      await api.restoreSealedProductExport(ref,anchor,base,pin,coordinator.db,cp);
      throw new Error('Crash boundary did not hold');
    }
    const target=await borrowChainDatabase(request.destination);
    const releaseCoordinator=release; release=async () => {await target.release(); await releaseCoordinator();};
    const db=target.db;
    const snapshot=async () => ({destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator.db)});
    const rejected:unknown[]=[];
    const reject=async (label:string,run:()=>Promise<unknown>) => {
      const before=await snapshot(),coldBefore=coldFiles(anchor);
      await expect(run(),label).rejects.toThrow();
      const after=await snapshot(),coldAfter=coldFiles(anchor);
      expect(after,label).toEqual(before); expect(coldAfter,label+' cold authority').toEqual(coldBefore);
      rejected.push({label,before,after,coldBefore,coldAfter});
    };
    const prepare=(owner=request.owner) => api.prepareSealedProductExport(db,owner,ref,base,pin,coordinator.db,cp);
    const quarantine=(a:ColdAnchor=anchor,r=ref,b=base,p=pin,c=cp) => {
      const fn=Reflect.get(api,'quarantineSealedProductExport');
      if (typeof fn!=='function') throw new Error('Executable sealed partial crash disposition missing');
      return fn(r,a,b,p,coordinator.db,c) as Promise<Record<string,unknown>>;
    };
    const block=async (label:string,expectedBlocker:string) => {
      const before=await snapshot(),coldBefore=coldFiles(anchor),disposition=await quarantine();
      const after=await snapshot(),coldAfter=coldFiles(anchor);
      expect(disposition).toMatchObject({accepted:false,activationAllowed:false,complete:false,disposition:{status:'BLOCKED',blocker:expectedBlocker}});
      expect(after).toEqual(before);
      for (const [name,value] of Object.entries(coldBefore)) expect(coldAfter[name],name).toBe(value);
      const added=Object.keys(coldAfter).filter(name => !(name in coldBefore));
      expect(added).toHaveLength(1); expect(added[0]).toMatch(/^\/blocked-.*\.json$/);
      const witness={label,before,after,coldBefore,coldAfter,disposition}; rejected.push(witness);
      return witness;
    };
    if (request.phase==='blocked') {
      save(id,'result',{ok:true,pid:process.pid,...await block(request.expectedBlocker,request.expectedBlocker)});
      return;
    }
    // These read-only calls remain executable even though the old application
    // never returned segment one to its bridge, nor settled its original lease.
    await reject('no preparation for committed prefix',() => prepare());
    await reject('no second original lease',() => acquireColdArchive(anchor,base.binding));
    await reject('no full restore retry from IN_FLIGHT or QUARANTINED',() => api.restoreSealedProductExport(ref,anchor,base,pin,coordinator.db,cp));
    if (request.negative) {
      await reject('wrong destination owner',() => prepare(randomUUID()));
      await reject('wrong original owner',() => quarantine({...anchor,ownerId:randomUUID()}));
      await reject('wrong binding',() => quarantine(anchor,ref,{...base,binding:{...base.binding,tenantId:randomUUID()}}));
      await reject('wrong chain',() => quarantine(anchor,ref,base,{...pin,chainId:randomUUID()}));
      await reject('wrong independently pinned terminal coordinator',() => quarantine(anchor,ref,base,pin,{...cp,ownerId:randomUUID()}));
      await reject('tampered export pin',() => quarantine(anchor,{...ref,sha256:'a'.repeat(64)}));
      for (const [file,key,value,blocker] of [
        ['worker-exit.json','signal','SIGTERM','EXIT_UNPROVEN'],
        ['inventory.json','ownerId',randomUUID(),'INVENTORY_MISMATCH'],
        ['inventory.json','phase','ALLOCATED','SEALED_DISPATCH_UNPROVEN'],
      ]) {
        const path=`.cold-restore-control/${anchor.id}/${file}`,original=readFileSync(path);
        writeFileSync(path,JSON.stringify({...JSON.parse(original.toString()),[key]:value}));
        try {await block(`tampered ${file} ${key}`,blocker);} finally {writeFileSync(path,original);}
      }
      for (const [label,sql] of [
        ['partial SQL row',"UPDATE products SET name='unwitnessed partial SQL' WHERE product_id='P1'"],
        ['partial SQL sequence',"SELECT setval('transactions_event_sequence_seq',777,true)"],
        ['public guard disabled','ALTER TABLE public.products DISABLE ROW LEVEL SECURITY'],
      ]) {
        const before=await readMaterializedRecoveryState(db.owner);
        // Use a real committed corruption. A failed preparation may not repair it.
        if (label==='public guard disabled') {
          await db.owner.query(sql);
          await reject(label,() => prepare());
          await db.owner.query('ALTER TABLE public.products ENABLE ROW LEVEL SECURITY');
        } else if (label==='partial SQL row') {
          await db.owner.query(sql);
          await reject(label,() => prepare());
          const original=JSON.parse(before.tables.products).find((p:{product_id:string}) => p.product_id==='P1');
          await db.owner.query('UPDATE products SET name=$1 WHERE product_id=$2',[original.name,original.product_id]);
        } else {
          await db.owner.query(sql); await reject(label,() => prepare());
          const seq=JSON.parse(before.sequences.transactions_event_sequence_seq)[0];
          await db.owner.query("SELECT setval('transactions_event_sequence_seq',$1,$2)",[seq.last_value,seq.is_called]);
        }
        expect(await readMaterializedRecoveryState(db.owner)).toEqual(before);
      }
    }
    const state=() => JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/state.json`,'utf8'));
    const before=await snapshot(),stateBefore=state();
    const disposition=await quarantine();
    expect(disposition).toMatchObject({accepted:false,activationAllowed:false,complete:false,
      disposition:{status:'QUARANTINED',blocker:'SEALED_REPLAY_RESTART_UNSUPPORTED'}});
    const stateAfter=state(),after=await snapshot();
    expect(stateAfter.status).toBe('QUARANTINED'); expect(after).toEqual(before);
    expect(stateAfter).not.toHaveProperty('result');
    expect((await db.owner.query("SELECT to_regclass('local_restore_control.sealed_preactivation') AS name")).rows[0].name).toBeNull();
    const coldAfter=coldFiles(anchor);
    const retry=await quarantine();
    expect(retry).toEqual(disposition); expect(coldFiles(anchor)).toEqual(coldAfter);
    expect(await snapshot()).toEqual(after);
    await reject('quarantine never READY on original admission',() => acquireColdArchive(anchor,base.binding));
    await reject('quarantine never prepares partial prefix',() => prepare());
    result={ok:true,pid:process.pid,identity:await coldProcessIdentity(),before,after,stateBefore,stateAfter,disposition,retry,rejected,coldAfter};
  } catch (error) {result={ok:false,pid:process.pid,error:error instanceof Error ? {message:error.message,stack:error.stack} : String(error)};}
  finally {vi.restoreAllMocks(); await release?.();}
  save(id,'result',result); expect(result.ok,JSON.stringify(result.error)).toBe(true);
},900_000);
