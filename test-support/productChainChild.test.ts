// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { coldFixture, cleanupColdFixture } from './coldRestoreFixture';
import { chainChild, borrowChainDatabase } from './productChainHarness';
import { retainColdDatabase } from '@/server/db/testing/coldRestore';
import { acquireColdArchive, readColdLease, bindColdTarget, coldAllocationRegistration, settleColdArchive } from '@/server/db/testing/coldRestoreStore';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateRestoreTarget, restoreRetainedMaterializedDatabase, readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import { captureSyntheticProductSegment, replaySyntheticProductSegment, verifySyntheticProductChainCheckpoint } from '@/server/exports/syntheticProductChain';
import { canonicalJson } from '@/server/migration/validators';
vi.mock('server-only',() => ({}));
afterEach(cleanupColdFixture);
const requestPath=process.env.PRODUCT_CHAIN_REQUEST_FILE;
if (requestPath && !/^\.product-chain-results\/[0-9a-f-]{36}-request\.json$/.test(requestPath)) throw new Error('Invalid request path');
const request=requestPath ? JSON.parse(readFileSync(requestPath,'utf8')) : null;
const hash=(bytes:Buffer|string) => createHash('sha256').update(bytes).digest('hex');
const OMIT=['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'];
const comparable=(tables:Record<string,string>) => Object.fromEntries(Object.entries(tables).filter(([t]) => !OMIT.includes(t)));
async function privateState(db:DisposablePostgres) {
  const tables=(await db.owner.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('local_product_chain','local_restore_control') ORDER BY schemaname,tablename")).rows;
  const rows:Record<string,unknown>={};
  for (const t of tables) rows[`${t.schemaname}.${t.tablename}`]=(await db.owner.query(`SELECT to_jsonb(t)::text AS wire FROM "${t.schemaname}"."${t.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  const objects=(await db.owner.query("SELECT n.nspname,pg_describe_object(d.classid,d.objid,d.objsubid) AS v FROM pg_depend d JOIN pg_namespace n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid WHERE n.nspname IN ('local_product_chain','local_restore_control') ORDER BY n.nspname,v")).rows;
  return {rows,objects};
}
const state=async (db:DisposablePostgres) => ({public:await readMaterializedRecoveryState(db.owner),private:await privateState(db)});
it.skipIf(!request)('trusted Task21 product chain child',async () => {
  let result:Record<string,unknown>={ok:false,pid:process.pid};
  try {
    if (request.phase==='capture') {
      const f=await coldFixture(true);
      await f.source.owner.query("SELECT setval('transactions_event_sequence_seq',901,true),setval('task_assignments_event_sequence_seq',701,false)");
      const anchor=await retainColdDatabase(f.source,f.ownerId,f.binding,{retainUntil:Date.now()+60_000,expiresAt:Date.now()+3_600_000});
      const base=JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`,'utf8')).seal;
      const pin={chainId:randomUUID(),parentIdentity:hash(canonicalJson(base))};
      let cursor={segment:1,from:0,previousDigest:hash(canonicalJson(pin))};
      const writes=[
        [{op:'create',id:'chain-new',name:'First \'\n합성',price:31,stock:4},{op:'update',id:'P1',name:'First',price:17,stock:23}],
        [{op:'update',id:'chain-new',name:'Second',price:9007199254740991,stock:9},{op:'delete',id:'P2'}],
        [{op:'delete',id:'chain-new'},{op:'create',id:'chain-final',name:'Third',price:73,stock:11}],
      ];
      const descriptor={runId:f.source.runId,evidence:f.source.evidence},segments=[];
      for (const batch of writes) {
        const captured=await chainChild({phase:'write',descriptor,base,pin,cursor,writes:batch});
        const exact=await readMaterializedRecoveryState(f.source.owner);
        const retry=await chainChild({phase:'write-retry',descriptor,base,pin,cursor,writes:batch,expected:captured});
        expect(retry.pid).not.toBe(captured.pid); expect(retry.artifact).toEqual(captured.artifact);
        expect(await readMaterializedRecoveryState(f.source.owner)).toEqual(exact);
        segments.push({...captured,exact,retryPid:retry.pid});
        cursor={segment:cursor.segment+1,from:cursor.from+batch.length,previousDigest:captured.artifact.sha256};
      }
      const outbox=(await f.source.owner.query('SELECT * FROM local_product_chain.outbox ORDER BY segment')).rows;
      expect(outbox).toHaveLength(3);
      expect(outbox.map(r => r.artifact_digest)).toEqual(segments.map(s => s.artifact.sha256));
      await expect(f.source.runtime.query('SELECT * FROM local_product_chain.outbox')).rejects.toThrow(/permission denied/);
      await expect(f.source.owner.query('UPDATE local_product_chain.outbox SET request_digest=request_digest')).rejects.toThrow(/immutable/);
      const sourceClosed=await f.source.close();
      result={ok:true,pid:process.pid,anchor,binding:f.binding,base,pin,segments,outbox,sourceClosed};
    } else if (request.phase==='write' || request.phase==='write-retry') {
      const {db,release}=await borrowChainDatabase(request.descriptor);
      try {
        const before=await state(db);
        if (request.phase==='write') {
          // Successful first DML followed by a missing delete must roll back,
          // including after an earlier committed segment/outbox already exists.
          const bad=[request.writes[0],{op:'delete' as const,id:'absent-chain-row'}];
          await expect(captureSyntheticProductSegment(db,request.base,request.pin,request.cursor,bad)).rejects.toThrow();
          expect(await state(db)).toEqual(before);
          await expect(captureSyntheticProductSegment(db,request.base,{...request.pin,chainId:randomUUID()},
            {...request.cursor,previousDigest:'0'.repeat(64)},request.writes)).rejects.toThrow();
          expect(await state(db)).toEqual(before);
        }
        const delta=await captureSyntheticProductSegment(db,request.base,request.pin,request.cursor,request.writes);
        if (request.expected) {
          expect(delta.sha256).toBe(request.expected.artifact.sha256);
          expect(delta.bytes).toEqual(readFileSync(request.expected.artifact.path));
          expect(await state(db)).toEqual(before);
        }
        const path=request.expected?.artifact.path ?? `.product-chain-results/${request.resultId}.segment.json`;
        if (!request.expected) writeFileSync(path,delta.bytes,{flag:'wx',mode:0o600});
        result={ok:true,pid:process.pid,artifact:{path,sha256:delta.sha256},cursor:request.cursor,sourceState:await state(db)};
      } finally {await release();}
    } else if (request.phase==='restore') {
      const f=request.capture,lease=await acquireColdArchive(f.anchor,f.binding);
      const {ownerId,registration}=coldAllocationRegistration(lease);
      const db=await createDisposablePostgres(registration);
      console.info('CHAIN_PG',JSON.stringify(db.evidence));
      try {
        const base=readColdLease(lease).seal;
        expect(base).toEqual(f.base);
        const target=await allocateRestoreTarget(db,ownerId,base.binding);
        await bindColdTarget(lease,db); await restoreRetainedMaterializedDatabase(lease,target);
        await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false});
        const descriptor={runId:db.runId,evidence:db.evidence},checkpoints=[];
        for (let index=0;index<f.segments.length;index++) {
          const applied=await chainChild({phase:'replay',descriptor,ownerId,base,pin:f.pin,segments:f.segments,index,negative:request.negative});
          const exact=await readMaterializedRecoveryState(db.owner);
          expect(comparable(exact.tables)).toEqual(comparable(f.segments[index].exact.tables));
          expect(exact.sequences).toEqual(f.segments[index].exact.sequences);
          expect(exact.guards).toEqual(f.segments[index].exact.guards);
          const retry=await chainChild({phase:'retry',descriptor,ownerId,base,pin:f.pin,segments:f.segments,index});
          expect(retry.pid).not.toBe(applied.pid);
          expect(retry.applied).toEqual({...applied.applied,kind:'ALREADY_APPLIED'});
          expect(await readMaterializedRecoveryState(db.owner)).toEqual(exact);
          checkpoints.push({applied,retry,exact});
        }
        await expect(db.runtime.query('SELECT * FROM local_restore_control.product_chain_checkpoint')).rejects.toThrow(/permission denied/);
        await expect(db.owner.query('TRUNCATE local_restore_control.product_chain_checkpoint')).rejects.toThrow(/immutable/);
        expect((await db.runTenantTransaction('20000000-0000-4000-8000-000000000002',tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
        result={ok:true,pid:process.pid,checkpoints,sourceId:base.sourceId,databaseId:db.runId};
      } finally {result.cleanup=await db.close(); console.info('CHAIN_CLEANUP',JSON.stringify(result.cleanup));}
    } else {
      const {db,release}=await borrowChainDatabase(request.descriptor);
      try {
        const s=request.segments[request.index],bytes=readFileSync(s.artifact.path),wire=JSON.parse(bytes.toString('utf8'));
        const before=await state(db),negatives:unknown[]=[];
        const endpoint=(segment:typeof s) => ({segment:segment.cursor.segment,checkpoint:segment.cursor.from+2,sha256:segment.artifact.sha256});
        const reject=async (name:string,body:Buffer,pin=hash(body),chain=request.pin,base=request.base,owner=request.ownerId,code?:string) => {
          const attempt=replaySyntheticProductSegment(db,owner,base,chain,body,pin);
          if (code) await expect(attempt,name).rejects.toMatchObject({code});
          else await expect(attempt,name).rejects.toThrow();
          const after=await state(db); expect(after,name).toEqual(before);
          negatives.push({name,before:hash(canonicalJson(before)),after:hash(canonicalJson(after))});
        };
        if (request.negative) {
          await expect(verifySyntheticProductChainCheckpoint(db,request.ownerId,request.base,request.pin,endpoint(request.segments[2])))
            .rejects.toThrow();
          expect(await state(db)).toEqual(before);
          negatives.push({name:'missing terminal checkpoint',before:hash(canonicalJson(before)),after:hash(canonicalJson(await state(db)))});
          await reject('tampered transport',Buffer.concat([bytes,Buffer.from(' ')]),s.artifact.sha256);
          await reject('untrusted chain replacement',bytes,s.artifact.sha256,{...request.pin,chainId:randomUUID()});
          await reject('wrong parent pin',bytes,s.artifact.sha256,{...request.pin,parentIdentity:'0'.repeat(64)});
          await reject('parent base substituted',bytes,s.artifact.sha256,request.pin,{...request.base,digest:'0'.repeat(64)});
          await reject('wrong destination owner',bytes,s.artifact.sha256,request.pin,request.base,randomUUID());
          if (request.index+1<request.segments.length) {
            const next=request.segments[request.index+1].artifact;
            await reject('missing/reordered segment',readFileSync(next.path),next.sha256);
          }
          if (request.index>1) {
            const old=request.segments[0].artifact;
            await reject('historical duplicate segment',readFileSync(old.path),old.sha256);
          }
          // Trusted adversarial fixture repins reach semantic guards, not a
          // claim that untrusted transport can forge coordinator authority.
          for (const name of ['previous-digest','checkpoint-gap','segment-gap','duplicate-event','reordered-events','missing-event','cross-tenant','wrong-chain','wrong-parent','unsupported','late-preimage','bad-final','extra-field']) {
            const changed=structuredClone(wire);
            if (name==='previous-digest') changed.previousDigest='0'.repeat(64);
            if (name==='checkpoint-gap') changed.from++;
            if (name==='segment-gap') changed.segment++;
            if (name==='duplicate-event') changed.transaction.events[1]=structuredClone(changed.transaction.events[0]);
            if (name==='reordered-events') changed.transaction.events.reverse();
            if (name==='missing-event') changed.transaction.events.pop();
            if (name==='cross-tenant') changed.transaction.tenantId='20000000-0000-4000-8000-000000000002';
            if (name==='wrong-chain') changed.chainId=randomUUID();
            if (name==='wrong-parent') changed.parentIdentity='0'.repeat(64);
            if (name==='unsupported') changed.transaction.events[1].entity='accounts';
            if (name==='late-preimage') {
              const current=JSON.parse(before.public.tables.products).find((p:{product_id:string}) => p.product_id==='P1');
              const wrong={...current,name:'wrong but structurally valid preimage'};
              changed.transaction.events[1]={sequence:2,entity:'products',op:'update',id:'P1',before:JSON.stringify(wrong),
                after:JSON.stringify({...wrong,name:'wrong successor',version:wrong.version+1})};
            }
            if (name==='bad-final') changed.transaction.finalProducts='[]';
            if (name==='extra-field') changed.authority='ACTIVE';
            await reject(name,Buffer.from(JSON.stringify(changed)));
          }
          const fk=structuredClone(wire),current=JSON.parse(before.public.tables.products).find((p:{product_id:string}) => p.product_id==='P1');
          fk.transaction.events[1]={sequence:2,entity:'products',op:'delete',id:'P1',before:JSON.stringify(current),after:null};
          await reject('native FK after first DML',Buffer.from(JSON.stringify(fk)),undefined,request.pin,request.base,request.ownerId,'23503');
        }
        const applied=await replaySyntheticProductSegment(db,request.ownerId,request.base,request.pin,bytes,s.artifact.sha256);
        expect(applied).toEqual({kind:request.phase==='retry' ? 'ALREADY_APPLIED' : 'APPLIED',segment:request.index+1,checkpoint:(request.index+1)*2});
        const checkpoint=(await db.owner.query('SELECT * FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows;
        expect(checkpoint).toHaveLength(request.index+1);
        if (request.phase==='retry') expect(await state(db)).toEqual(before);
        const committed=await state(db);
        const checkpointVerification=await verifySyntheticProductChainCheckpoint(db,request.ownerId,request.base,request.pin,endpoint(s));
        expect(checkpointVerification).toEqual({kind:'VERIFIED',...endpoint(s)});
        expect(await state(db)).toEqual(committed);
        for (const wrong of [{...endpoint(s),sha256:'0'.repeat(64)},{...endpoint(s),checkpoint:endpoint(s).checkpoint+1},
          ...(request.index>0 ? [endpoint(request.segments[request.index-1])] : [])]) {
          await expect(verifySyntheticProductChainCheckpoint(db,request.ownerId,request.base,request.pin,wrong)).rejects.toThrow();
          expect(await state(db)).toEqual(committed);
        }
        const conflict=structuredClone(wire); conflict.transaction.finalProducts='[]';
        const conflictBytes=Buffer.from(JSON.stringify(conflict));
        await expect(replaySyntheticProductSegment(db,request.ownerId,request.base,request.pin,conflictBytes,hash(conflictBytes))).rejects.toThrow();
        expect(await state(db)).toEqual(committed);
        result={ok:true,pid:process.pid,applied,checkpoint,checkpointVerification,negatives,exact:committed.public};
      } finally {await release();}
    }
  } catch (error) {result={...result,ok:false,error:error instanceof Error ? error.stack : String(error)};}
  mkdirSync('.product-chain-results',{recursive:true,mode:0o700});
  writeFileSync(`.product-chain-results/${request.resultId}.json`,JSON.stringify(result),{flag:'wx',mode:0o600});
  expect(result.ok,result.error as string).toBe(true);
},330_000);
