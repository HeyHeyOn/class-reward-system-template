// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import * as api from '@/server/exports/syntheticSealedExport';
import { installProductChainTerminal, replaySealedProductSegment, verifyProductChainTerminal } from '@/server/exports/syntheticProductTerminal';
import { replaySyntheticProductSegment } from '@/server/exports/syntheticProductChain';
import { acquireColdArchive, type ColdAnchor } from '@/server/db/testing/coldRestoreStore';
import { coldProcessIdentity } from '@/server/db/testing/coldProcessWitness';
import { readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import { borrowChainDatabase } from './productChainHarness';
import { preactivationWitness } from './sealedPreactivationHarness';
import { coldFiles, save } from './sealedCrashHarness';
vi.mock('server-only',() => ({}));
const request=process.env.SEALED_CRASH_REQUEST ? JSON.parse(readFileSync(process.env.SEALED_CRASH_REQUEST,'utf8')) : null;
const id=process.env.SEALED_CRASH_RESULT!;
it.skipIf(!request)('sealed successor cannot inherit original execution authority',async () => {
  let result:Record<string,unknown>={},release:(()=>Promise<void>)|undefined;
  try {
    const target=await borrowChainDatabase(request.destination),coordinator=await borrowChainDatabase(request.coordinator);
    release=async () => {await target.release(); await coordinator.release();};
    const db=target.db,{ref,anchor,base,pin}=request.captured,cp=request.coordinatorPin;
    const envelope=JSON.parse(readFileSync(`.sealed-product-export/${ref.sha256}.json`,'utf8'));
    const segment=envelope.journal[request.complete ? 2 : 1];
    const replay=(owner=request.owner) => replaySealedProductSegment(db,owner,base,pin,Buffer.from(segment.payload),segment.sha256);
    const prepare=(owner=request.owner) => api.prepareSealedProductExport(db,owner,ref,base,pin,coordinator.db,cp);
    if (request.phase==='positive-contract') {
      const before=await preactivationWitness(db);
      let returned:unknown=null,error:unknown=null;
      try {returned=await replay();} catch (e) {error=e instanceof Error ? {message:e.message,stack:e.stack} : String(e);}
      const after=await preactivationWitness(db);
      // An executable unfulfilled positive contract, not a denial relabeled PASS.
      // The parent asserts acceptance and retains this actual exception on RED.
      save(id,'result',{ok:true,pid:process.pid,identity:await coldProcessIdentity(),accepted:error===null,
        before,after,returned,error,exportSha256:ref.sha256,terminal:(await db.owner.query(
          'SELECT * FROM local_restore_control.product_chain_terminal')).rows});
      return;
    }
    if (request.phase==='successor-transaction') {
      const connect=db.owner.connect.bind(db.owner);
      vi.spyOn(db.owner,'connect').mockImplementation(((...parameters:unknown[]) => {
        if (parameters.length) return Reflect.apply(connect,db.owner,parameters);
        return connect().then(q => {
          const query=q.query.bind(q);
          q.query=(async (...params:unknown[]) => {
            const value=await Reflect.apply(query,q,params);
            if (params[0]==='SELECT * FROM local_restore_control.product_chain_terminal LIMIT 2') {
              save(id,'barrier',{pid:process.pid,identity:await coldProcessIdentity(),destination:request.destination,
                owner:request.owner,backend:(await query('SELECT pg_backend_pid() AS pid')).rows[0],
                public:await readMaterializedRecoveryState(q),checkpoint:(await query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows});
              await new Promise<void>(() => { /* Kill at successor transaction admission, before any DML. */ });
            }
            return value;
          }) as typeof q.query;
          return q;
        });
      }) as typeof db.owner.connect);
      await replay(); throw new Error('Successor transaction did not hold');
    }
    const snapshot=async () => ({destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator.db),cold:coldFiles(anchor)});
    const rejected:unknown[]=[];
    const reject=async (label:string,run:()=>Promise<unknown>) => {
      const before=await snapshot(); let message='',returned:unknown=null;
      try {returned=await run();} catch (error) {message=error instanceof Error ? error.message : String(error);}
      const after=await snapshot();
      save(randomUUID(),'successor-reject',{label,before,after,message,returned,accepted:message===''});
      expect(message,`${label}: no execution authority may be inherited`).not.toBe('');
      expect(after,label).toEqual(before); rejected.push({label,before,after,message,accepted:false});
    };
    // Behavioral RED: previously a distinct process could actually append segment2.
    await reject('cold sealed replay cannot inherit original lease',() => replay());
    await reject('unsealed replay entry cannot bypass export binding',() => replaySyntheticProductSegment(db,request.owner,base,pin,Buffer.from(segment.payload),segment.sha256));
    await reject('terminal reinstall cannot mint successor authority',() => installProductChainTerminal(db,request.owner,base,pin,coordinator.db,cp));
    await reject('terminal proof cannot accept unsettled original',() => verifyProductChainTerminal(db,request.owner,base,pin));
    await reject('dead original cannot prepare even complete SQL',() => prepare());
    await reject('no new original lease',() => acquireColdArchive(anchor,base.binding));
    await reject('no full restore restart',() => api.restoreSealedProductExport(ref,anchor,base,pin,coordinator.db,cp));
    if (request.negative) {
      await reject('owner mismatch replay',() => replay(randomUUID()));
      await reject('owner mismatch preparation',() => prepare(randomUUID()));
      await reject('tampered segment',() => replaySealedProductSegment(db,request.owner,base,pin,Buffer.from(segment.payload+' '),segment.sha256));
      await reject('coordinator pin mismatch',() => api.prepareSealedProductExport(db,request.owner,ref,base,pin,coordinator.db,{...cp,ownerId:randomUUID()}));
      await reject('copied lease cannot enroll successor',() => installProductChainTerminal(db,request.owner,base,pin,coordinator.db,cp,{lease:{id:anchor.id},exportSha256:ref.sha256}));
      for (const [label,sql,restore] of [
        ['partial SQL',"UPDATE public.products SET name='partial successor SQL' WHERE product_id='P1'",'row'],
        ['sequence mutation',"SELECT setval('transactions_event_sequence_seq',888,true)",'sequence'],
        ['public guard mutation','ALTER TABLE public.products DISABLE ROW LEVEL SECURITY','guard'],
        ['private guard mutation','ALTER TABLE local_restore_control.product_chain_checkpoint DISABLE TRIGGER USER','private'],
      ]) {
        const state=await readMaterializedRecoveryState(db.owner);
        await db.owner.query(sql);
        try {await reject(label,() => replay()); await reject(label+' preparation',() => prepare());}
        finally {
          if (restore==='row') await db.owner.query('UPDATE public.products SET name=$1 WHERE product_id=$2',[JSON.parse(state.tables.products).find((p:{product_id:string}) => p.product_id==='P1').name,'P1']);
          if (restore==='sequence') {const s=JSON.parse(state.sequences.transactions_event_sequence_seq)[0]; await db.owner.query("SELECT setval('transactions_event_sequence_seq',$1,$2)",[s.last_value,s.is_called]);}
          if (restore==='guard') await db.owner.query('ALTER TABLE public.products ENABLE ROW LEVEL SECURITY');
          if (restore==='private') await db.owner.query('ALTER TABLE local_restore_control.product_chain_checkpoint ENABLE TRIGGER USER');
        }
      }
      // Metadata cannot be used as a capability, even with exact pinned SQL.
      for (const [file,key,value] of [['inventory.json','ownerId',randomUUID()],['worker-exit.json','signal','SIGTERM']]) {
        const path=`.cold-restore-control/${anchor.id}/${file}`,saved=readFileSync(path);
        writeFileSync(path,JSON.stringify({...JSON.parse(saved.toString()),[key]:value}));
        try {await reject('tampered original '+file,() => replay());} finally {writeFileSync(path,saved);}
      }
      const path=`.cold-restore-control/${anchor.id}`,away=path+'.owned-test-unavailable';
      renameSync(path,away);
      try {
        const before={destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator.db)};
        await expect(replay()).rejects.toThrow(); await expect(prepare()).rejects.toThrow();
        const after={destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator.db)};
        expect(after).toEqual(before); rejected.push({label:'original coordinator loss',before,after,accepted:false});
      } finally {renameSync(away,path);}
      await db.owner.query('ALTER TABLE local_restore_control.sealed_export_execution RENAME TO owned_test_execution');
      try {await reject('missing private execution pin',() => replay()); await reject('missing private pin preparation',() => prepare());}
      finally {await db.owner.query('ALTER TABLE local_restore_control.owned_test_execution RENAME TO sealed_export_execution');}
      await coordinator.db.owner.query('ALTER SCHEMA local_product_terminal RENAME TO owned_test_terminal');
      try {await reject('retained SQL coordinator loss',() => prepare()); await reject('coordinator loss does not create replay authority',() => replay());}
      finally {await coordinator.db.owner.query('ALTER SCHEMA owned_test_terminal RENAME TO local_product_terminal');}
    }
    const quarantine=(a:ColdAnchor=anchor) => api.quarantineSealedProductExport(ref,a,base,pin,coordinator.db,cp);
    const before=await snapshot(),disposition=await quarantine(),after=await snapshot();
    expect(disposition).toMatchObject({accepted:false,complete:false,disposition:{status:'QUARANTINED',blocker:'SEALED_REPLAY_RESTART_UNSUPPORTED'}});
    expect(after.destination).toEqual(before.destination); expect(after.coordinator).toEqual(before.coordinator);
    await reject('quarantine cannot replay suffix',() => replay());
    await reject('quarantine cannot prepare complete or partial target',() => prepare());
    const retry=await quarantine(); expect(retry).toEqual(disposition); expect(await snapshot()).toEqual(after);
    result={ok:true,pid:process.pid,identity:await coldProcessIdentity(),rejected,before,after,disposition,retry,
      accepted:false,missingCapability:'No pre-enrolled durable successor execution grant; original in-process lease cannot be reconstructed from SQL or metadata'};
  } catch (error) {result={ok:false,pid:process.pid,error:error instanceof Error ? {message:error.message,stack:error.stack} : String(error)};}
  finally {vi.restoreAllMocks(); await release?.();}
  save(id,'result',result); expect(result.ok,JSON.stringify(result.error)).toBe(true);
},900_000);
