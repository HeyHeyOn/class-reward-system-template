// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { coldFixture, cleanupColdFixture, coldState } from './coldRestoreFixture';
import { retainColdDatabase } from '@/server/db/testing/coldRestore';
import { acquireColdArchive, readColdLease, bindColdTarget, coldAllocationRegistration, settleColdArchive } from '@/server/db/testing/coldRestoreStore';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateRestoreTarget, restoreRetainedMaterializedDatabase, readRestoredMaterializedDatabase, readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import { captureSyntheticProductWrites, replaySyntheticProductDelta } from '@/server/exports/syntheticProductDelta';
vi.mock('server-only',() => ({}));
afterEach(cleanupColdFixture);
const requestPath=process.env.PRODUCT_DELTA_REQUEST_FILE;
if (requestPath && !/^\.product-delta-results\/[0-9a-f-]{36}-request\.json$/.test(requestPath)) throw new Error('Invalid request path');
const request=requestPath ? JSON.parse(readFileSync(requestPath,'utf8')) : null;
const hash=(bytes:Buffer) => createHash('sha256').update(bytes).digest('hex');
const OMIT=['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'];
const comparable=(tables:Record<string,unknown>) => Object.fromEntries(Object.entries(tables).filter(([t]) => !OMIT.includes(t)));
it.skipIf(!request)('trusted Task21 product delta child',async () => {
  let result:Record<string,unknown>={ok:false,pid:process.pid};
  try {
    if (request.phase==='capture') {
      const f=await coldFixture(true);
      const anchor=await retainColdDatabase(f.source,f.ownerId,f.binding,{retainUntil:Date.now()+60_000,expiresAt:Date.now()+3_600_000});
      // Trusted coordinator channel, never authority reconstructed from delta.
      const base=JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`,'utf8')).seal;
      const writes=[{op:'create' as const,id:'delta-new',name:'합성 \' 줄\n상품',price:9007199254740991,stock:4},
        {op:'update' as const,id:'P1',name:'Changed after backup',price:17,stock:23},
        {op:'delete' as const,id:'P2'}];
      const initial=await readMaterializedRecoveryState(f.source.owner);
      await expect(captureSyntheticProductWrites(f.source,base,[writes[0],{op:'delete',id:'missing'}])).rejects.toThrow();
      expect(await readMaterializedRecoveryState(f.source.owner)).toEqual(initial);
      expect((await f.source.owner.query("SELECT to_regnamespace('local_product_delta') AS n")).rows[0].n).toBeNull();
      const delta=await captureSyntheticProductWrites(f.source,base,writes);
      expect(hash(delta.bytes)).toBe(delta.sha256);
      const actual=await readRestoredMaterializedDatabase(f.source);
      const products=actual.tables.products;
      expect(products.map((p:{product_id:string}) => p.product_id).sort()).toEqual(['P1','delta-new']);
      expect(products.find((p:{product_id:string}) => p.product_id==='P1')).toMatchObject({name:'Changed after backup',price:17,stock:23});
      expect(products.find((p:{product_id:string}) => p.product_id==='delta-new')).toMatchObject({price:9007199254740991});
      const sourceUnchanged=await coldState(f.source);
      // A committed source transaction must retain its exact export even if the
      // caller lost the first response. This is not process-local memoization.
      const sourceReceipt=(await f.source.owner.query('SELECT * FROM local_product_delta.outbox')).rows;
      expect(sourceReceipt).toHaveLength(1);
      expect(sourceReceipt[0].artifact_digest).toBe(delta.sha256);
      expect(sourceReceipt[0].payload).toBe(delta.bytes.toString('utf8'));
      expect(await captureSyntheticProductWrites(f.source,structuredClone(base),structuredClone(writes))).toEqual(delta);
      await expect(captureSyntheticProductWrites(f.source,base,[{op:'delete',id:'P1'}])).rejects.toThrow();
      expect(await coldState(f.source)).toEqual(sourceUnchanged);
      await expect(f.source.runtime.query('SELECT * FROM local_product_delta.outbox')).rejects.toThrow(/permission denied/);
      const exact=await readMaterializedRecoveryState(f.source.owner);
      const path=`.product-delta-results/${request.resultId}.delta.json`;
      mkdirSync('.product-delta-results',{recursive:true,mode:0o700});
      writeFileSync(path,delta.bytes,{flag:'wx',mode:0o600});
      const closed=await f.source.close();
      result={ok:true,pid:process.pid,anchor,binding:f.binding,base,path,pin:delta.sha256,actual,exact,sourceReceipt,sourceClosed:closed};
    } else {
      const f=request.capture;
      const lease=await acquireColdArchive(f.anchor,f.binding);
      const {ownerId,registration}=coldAllocationRegistration(lease);
      const db=await createDisposablePostgres(registration);
      console.info('DELTA_PG',JSON.stringify(db.evidence));
      try {
        const base=readColdLease(lease).seal;
        const target=await allocateRestoreTarget(db,ownerId,base.binding);
        await bindColdTarget(lease,db);
        await restoreRetainedMaterializedDatabase(lease,target);
        await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false});
        const bytes=readFileSync(f.path);
        const before=await readRestoredMaterializedDatabase(db);
        expect(comparable(before.tables)).toEqual(comparable(Object.fromEntries(Object.entries(base.tables).map(([t,s]) => [t,JSON.parse(s)]))));
        const control=async () => (await db.owner.query("SELECT pg_describe_object(classid,objid,objsubid) AS v FROM pg_depend WHERE refclassid='pg_namespace'::regclass AND refobjid='local_restore_control'::regnamespace ORDER BY v")).rows;
        const controls=await control();
        const negativeResults:string[]=[];
        if (request.phase==='negative') {
          const wire=JSON.parse(bytes.toString('utf8'));
          const reject=async (name:string,body:Buffer,pin:string,expectedBase=base,owner=ownerId,code?:string) => {
            const attempt=replaySyntheticProductDelta(db,owner,expectedBase,body,pin);
            if (code) await expect(attempt,name).rejects.toMatchObject({code});
            else await expect(attempt,name).rejects.toThrow();
            expect(await readRestoredMaterializedDatabase(db),name).toEqual(before);
            expect(await control(),name).toEqual(controls);
            negativeResults.push(name);
          };
          await reject('tampered bytes',Buffer.concat([bytes,Buffer.from(' ')]),f.pin);
          await reject('wrong digest',bytes,'0'.repeat(64));
          await reject('wrong owner',bytes,f.pin,{...base},'20000000-0000-4000-8000-000000000099');
          await reject('wrong base',bytes,f.pin,{...base,digest:'0'.repeat(64)});
          // Re-pin deliberately malformed fixture bytes to exercise semantic
          // validation beyond transport authentication, not a forged authority.
          for (const name of ['reorder','gap','cross-tenant','unsupported','late-preimage','bad-final','missing-event','extra-field']) {
            const changed=structuredClone(wire);
            if (name==='reorder') changed.events.reverse();
            if (name==='gap') changed.events[1].sequence=5;
            if (name==='cross-tenant') changed.events[1].after=JSON.stringify({...JSON.parse(changed.events[1].after),tenant_id:'20000000-0000-4000-8000-000000000002'});
            if (name==='unsupported') changed.events[1].entity='accounts';
            if (name==='late-preimage') changed.events[2].before=changed.events[0].after;
            if (name==='bad-final') changed.finalProducts='[]';
            if (name==='missing-event') changed.events.pop();
            if (name==='extra-field') changed.events[1].sql='SELECT 1';
            const body=Buffer.from(JSON.stringify(changed));
            await reject(name,body,hash(body));
          }
          // Native FK refusal after a preceding INSERT must roll everything back.
          const fk=structuredClone(wire);
          const existing=JSON.parse(base.tables.products).find((p:{product_id:string}) => p.product_id==='P1');
          fk.events[1]={sequence:2,entity:'products',op:'delete',id:'P1',before:JSON.stringify(existing),after:null};
          const body=Buffer.from(JSON.stringify(fk));
          await reject('native FK rollback',body,hash(body),base,ownerId,'23503');
        }
        const applied=await replaySyntheticProductDelta(db,ownerId,base,bytes,f.pin);
        expect(applied).toMatchObject({kind:'APPLIED',checkpoint:3});
        const after=await readRestoredMaterializedDatabase(db);
        const exact=await readMaterializedRecoveryState(db.owner);
        expect(comparable(exact.tables)).toEqual(comparable(f.exact.tables));
        expect(exact.guards).toEqual(f.exact.guards);
        expect(exact.sequences).toEqual(f.exact.sequences);
        expect(comparable(after.tables)).toEqual(comparable(f.actual.tables));
        expect(after.sequences).toEqual(f.actual.sequences);
        expect(after.guards).toEqual(f.actual.guards);
        expect((await db.owner.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rows).toHaveLength(1);
        const retry=await replaySyntheticProductDelta(db,ownerId,base,Buffer.from(bytes),f.pin);
        expect(retry).toMatchObject({kind:'ALREADY_APPLIED',checkpoint:3});
        expect(await readRestoredMaterializedDatabase(db)).toEqual(after);
        const checkpoint=(await db.owner.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rows;
        const altered=Buffer.from(bytes.toString('utf8').replace('Changed after backup','replaced same checkpoint'));
        await expect(replaySyntheticProductDelta(db,ownerId,base,altered,hash(altered))).rejects.toThrow();
        expect(await readRestoredMaterializedDatabase(db)).toEqual(after);
        expect((await db.owner.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rows).toEqual(checkpoint);
        expect((await db.runTenantTransaction('20000000-0000-4000-8000-000000000002',tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
        await expect(db.runtime.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rejects.toThrow(/permission denied/);
        let provenanceRefusal:null|{before:string;after:string}=null;
        if (request.phase==='negative') {
          // Copied source-only provenance is an unsupported post-restore write,
          // not one of the legitimate source/destination identity differences.
          await db.owner.query(`INSERT INTO migration_local_disposable_database
            SELECT * FROM jsonb_populate_record(NULL::migration_local_disposable_database,$1::jsonb)`,[JSON.stringify(base.marker)]);
          const contaminated=await readMaterializedRecoveryState(db.owner),privateBefore=await control();
          await expect(replaySyntheticProductDelta(db,ownerId,base,bytes,f.pin)).rejects.toThrow();
          expect(await readMaterializedRecoveryState(db.owner)).toEqual(contaminated);
          expect(await control()).toEqual(privateBefore);
          expect((await db.owner.query('SELECT * FROM local_restore_control.product_delta_checkpoint')).rows).toEqual(checkpoint);
          provenanceRefusal={before:hash(Buffer.from(JSON.stringify(contaminated))),
            after:hash(Buffer.from(JSON.stringify(await readMaterializedRecoveryState(db.owner))))};
        }
        result={ok:true,pid:process.pid,sourcePid:f.pid,databaseId:db.runId,sourceId:base.sourceId,applied,retry,negativeResults,checkpoint,after,exact,provenanceRefusal};
      } finally { result.cleanup=await db.close(); console.info('DELTA_CLEANUP',JSON.stringify(result.cleanup)); }
    }
  } catch (error) { result={...result,ok:false,error:error instanceof Error ? error.stack : String(error)}; }
  mkdirSync('.product-delta-results',{recursive:true,mode:0o700});
  writeFileSync(`.product-delta-results/${request.resultId}.json`,JSON.stringify(result),{flag:'wx',mode:0o600});
  expect(result.ok,result.error as string).toBe(true);
},180_000);
