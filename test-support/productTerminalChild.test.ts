// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { coldFixture, cleanupColdFixture } from './coldRestoreFixture';
import { chainChild, borrowChainDatabase } from './productChainHarness';
import { terminalChild, terminalState, digest, comparable } from './productTerminalHarness';
import { retainColdDatabase } from '@/server/db/testing/coldRestore';
import { acquireColdArchive, readColdLease, bindColdTarget, coldAllocationRegistration, settleColdArchive } from '@/server/db/testing/coldRestoreStore';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateRestoreTarget, restoreRetainedMaterializedDatabase, readMaterializedRecoveryState } from '@/server/db/testing/materializedRestore';
import { captureSyntheticProductSegment, verifySyntheticProductChainCheckpoint } from '@/server/exports/syntheticProductChain';
import { initializeTerminalCoordinator, registerProductChainIntent, retainProductChainTerminal, installProductChainTerminal,
  verifyProductChainTerminal, replaySealedProductSegment } from '@/server/exports/syntheticProductTerminal';
import { canonicalJson } from '@/server/migration/validators';
vi.mock('server-only',() => ({}));
afterEach(cleanupColdFixture);
const requestPath=process.env.PRODUCT_TERMINAL_REQUEST_FILE;
if (requestPath && !/^\.product-terminal-results\/[0-9a-f-]{36}-request\.json$/.test(requestPath)) throw new Error('Invalid terminal request path');
const request=requestPath ? JSON.parse(readFileSync(requestPath,'utf8')) : null;
const describeDB=(db:DisposablePostgres) => ({runId:db.runId,evidence:db.evidence});
it.skipIf(!request)('trusted Task21 terminal child',async () => {
  let result:Record<string,unknown>={ok:false,pid:process.pid};
  try {
    if (request.phase==='initialize') {
      const c=await borrowChainDatabase(request.coordinator);
      try {result={...result,ok:true,pin:await initializeTerminalCoordinator(c.db,request.coordinatorOwner)};}
      finally {await c.release();}
    } else if (request.phase==='capture') {
      const f=await coldFixture(true);
      await f.source.owner.query("SELECT setval('transactions_event_sequence_seq',901,true),setval('task_assignments_event_sequence_seq',701,false)");
      const anchor=await retainColdDatabase(f.source,f.ownerId,f.binding,{retainUntil:Date.now()+60_000,expiresAt:Date.now()+3_600_000});
      const base=JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`,'utf8')).seal;
      const pin={chainId:randomUUID(),parentIdentity:digest(canonicalJson(base))},counts=[2,2,2];
      const descriptor=describeDB(f.source),intent=await terminalChild({phase:'intent',descriptor,base,pin,counts});
      const retry=await terminalChild({phase:'intent',descriptor,base,pin,counts});
      expect(intent.pid).not.toBe(retry.pid); expect(intent.intent).toEqual(retry.intent);
      const initial=await terminalState(f.source);
      for (const invalid of [[],[0],[101],Array(33).fill(1),[2,1,3]]) {
        await expect(registerProductChainIntent(f.source,base,pin,invalid)).rejects.toThrow();
        expect(await terminalState(f.source)).toEqual(initial);
      }
      let cursor={segment:1,from:0,previousDigest:digest(canonicalJson(pin))};
      const writes=[
        [{op:'create',id:'terminal-new',name:'First \'\n합성',price:31,stock:4},{op:'update',id:'P1',name:'First',price:17,stock:23}],
        [{op:'update',id:'terminal-new',name:'Second',price:9007199254740991,stock:9},{op:'delete',id:'P2'}],
        [{op:'delete',id:'terminal-new'},{op:'create',id:'terminal-final',name:'Third',price:73,stock:11}],
      ],segments=[];
      const c=await borrowChainDatabase(request.coordinator);
      try {
        const noSeal=await terminalState(c.db);
        for (const batch of writes) {
          // Declared source intent cannot be sealed while a valid suffix is still missing.
          const before=await terminalState(f.source);
          await expect(retainProductChainTerminal(c.db,request.coordinatorPin,f.source,base,pin)).rejects.toThrow();
          expect(await terminalState(f.source)).toEqual(before); expect(await terminalState(c.db)).toEqual(noSeal);
          const captured=await chainChild({phase:'write',descriptor,base,pin,cursor,writes:batch});
          const exact=await readMaterializedRecoveryState(f.source.owner);
          const retried=await chainChild({phase:'write-retry',descriptor,base,pin,cursor,writes:batch,expected:captured});
          expect(captured.pid).not.toBe(retried.pid); expect(captured.artifact).toEqual(retried.artifact);
          expect(await readMaterializedRecoveryState(f.source.owner)).toEqual(exact);
          segments.push({...captured,exact,retryPid:retried.pid});
          cursor={segment:cursor.segment+1,from:cursor.from+batch.length,previousDigest:captured.artifact.sha256};
        }
        const before=await terminalState(f.source);
        await expect(captureSyntheticProductSegment(f.source,base,pin,cursor,writes[0] as never)).rejects.toThrow();
        await expect(registerProductChainIntent(f.source,base,pin,[2,2])).rejects.toThrow();
        expect(await terminalState(f.source)).toEqual(before);
        const retain=await terminalChild({phase:'retain',descriptor,base,pin,coordinator:request.coordinator,coordinatorPin:request.coordinatorPin});
        const retained=await terminalState(c.db),sealed=await terminalState(f.source);
        const sourceSeal=JSON.parse((await f.source.owner.query('SELECT payload FROM local_product_chain.terminal')).rows[0].payload);
        const coordinatorSeal=JSON.parse((await c.db.owner.query('SELECT payload FROM local_product_terminal.seal')).rows[0].payload);
        expect(sourceSeal).toEqual(retain.seal); expect(coordinatorSeal).toEqual({coordinator:request.coordinatorPin,seal:sourceSeal});
        expect(sourceSeal.intent).toEqual(intent.intent);
        expect(sourceSeal.segments).toEqual(segments.map((s,index) => ({segment:index+1,checkpoint:(index+1)*2,sha256:s.artifact.sha256})));
        const retainRetry=await terminalChild({phase:'retain',descriptor,base,pin,coordinator:request.coordinator,coordinatorPin:request.coordinatorPin});
        expect(retainRetry.pid).not.toBe(retain.pid); expect(retainRetry.seal).toEqual(retain.seal);
        expect(await terminalState(c.db)).toEqual(retained); expect(await terminalState(f.source)).toEqual(sealed);
        for (const table of ['intent','terminal']) {
          await expect(f.source.runtime.query(`SELECT * FROM local_product_chain.${table}`)).rejects.toThrow(/permission denied/);
          await expect(f.source.owner.query(`TRUNCATE local_product_chain.${table}`)).rejects.toThrow(/immutable/);
        }
        await expect(c.db.runtime.query('SELECT * FROM local_product_terminal.seal')).rejects.toThrow(/permission denied/);
        await expect(c.db.owner.query('UPDATE local_product_terminal.seal SET payload=payload')).rejects.toThrow(/immutable/);
        await expect(c.db.owner.query('INSERT INTO local_product_terminal.seal SELECT * FROM local_product_terminal.seal')).rejects.toThrow(/duplicate key/);
        expect(await terminalState(c.db)).toEqual(retained);
        const sourceClosed=await f.source.close();
        // No retained seal/endpoint is returned as destination authority. Only
        // independently owned coordinator SQL can supply it after this process exits.
        result={...result,ok:true,anchor,base,pin,segments,sourceClosed,intent,retain,retainRetry,sourceFinal:sealed,coordinatorState:retained};
      } finally {await c.release();}
    } else if (request.phase==='intent' || request.phase==='retain') {
      const source=await borrowChainDatabase(request.descriptor);
      try {
        if (request.phase==='intent') result={...result,ok:true,intent:await registerProductChainIntent(source.db,request.base,request.pin,request.counts)};
        else {
          const c=await borrowChainDatabase(request.coordinator);
          try {result={...result,ok:true,seal:await retainProductChainTerminal(c.db,request.coordinatorPin,source.db,request.base,request.pin)};}
          finally {await c.release();}
        }
      } finally {await source.release();}
    } else if (request.phase==='restore') {
      const f=request.capture,lease=await acquireColdArchive(f.anchor,f.base.binding),base=readColdLease(lease).seal;
      const {ownerId,registration}=coldAllocationRegistration(lease),db=await createDisposablePostgres(registration);
      console.info('TERMINAL_DESTINATION_PG',JSON.stringify(db.evidence));
      try {
        const target=await allocateRestoreTarget(db,ownerId,base.binding);
        await bindColdTarget(lease,db); await restoreRetainedMaterializedDatabase(lease,target);
        await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false});
        const descriptor=describeDB(db),common={descriptor,ownerId,base,pin:f.pin,coordinator:request.coordinator,coordinatorPin:request.coordinatorPin};
        const empty=await terminalState(db),first=f.segments[0].artifact;
        await expect(verifyProductChainTerminal(db,ownerId,base,f.pin)).rejects.toThrow();
        await expect(replaySealedProductSegment(db,ownerId,base,f.pin,readFileSync(first.path),first.sha256)).rejects.toThrow();
        expect(await terminalState(db)).toEqual(empty);
        const install=await terminalChild({phase:'install',...common,negative:request.negative});
        const installed=await terminalState(db);
        expect(installed.public).toEqual(empty.public);
        const installedSql=JSON.parse((await db.owner.query('SELECT payload FROM local_restore_control.product_chain_terminal')).rows[0].payload);
        expect(installedSql).toEqual(install.installed);
        expect(installedSql.seal.segments).toEqual(f.segments.map((s:{artifact:{sha256:string}},index:number) =>
          ({segment:index+1,checkpoint:(index+1)*2,sha256:s.artifact.sha256})));
        const installRetry=await terminalChild({phase:'install',...common});
        expect(await terminalState(db)).toEqual(installed);
        const checkpoints=[];
        for (let index=0;index<f.segments.length;index++) {
          const applied=await terminalChild({phase:'replay',...common,segments:f.segments,index,negative:request.negative});
          const exact=await terminalState(db);
          expect(comparable(exact.public.tables)).toEqual(comparable(f.segments[index].exact.tables));
          expect(exact.public.sequences).toEqual(f.segments[index].exact.sequences); expect(exact.public.guards).toEqual(f.segments[index].exact.guards);
          const retry=await terminalChild({phase:'retry',...common,segments:f.segments,index});
          expect(retry.applied).toEqual({...applied.applied,kind:'ALREADY_APPLIED'}); expect(await terminalState(db)).toEqual(exact);
          checkpoints.push({...applied,retry,exact});
        }
        const complete=await terminalState(db),verified=await verifyProductChainTerminal(db,ownerId,base,f.pin);
        const coldVerify=await terminalChild({phase:'verify',...common,segments:f.segments});
        expect(coldVerify.verified).toEqual(verified); expect(await terminalState(db)).toEqual(complete);
        await expect(db.runtime.query('SELECT * FROM local_restore_control.product_chain_terminal')).rejects.toThrow(/permission denied/);
        await expect(db.owner.query('UPDATE local_restore_control.product_chain_terminal SET payload=payload')).rejects.toThrow(/immutable/);
        expect(await terminalState(db)).toEqual(complete);
        result={...result,ok:true,sourceId:base.sourceId,databaseId:db.runId,install,installRetry,checkpoints,verified,coldVerify,final:complete};
      } finally {result.cleanup=await db.close(); console.info('TERMINAL_DESTINATION_CLEANUP',JSON.stringify(result.cleanup));}
    } else {
      const target=await borrowChainDatabase(request.descriptor),db=target.db,negatives:unknown[]=[];
      try {
        const reject=async (name:string,attempt:() => Promise<unknown>) => {
          const before=await terminalState(db); await expect(attempt(),name).rejects.toThrow();
          const after=await terminalState(db); expect(after,name).toEqual(before);
          negatives.push({name,before:digest(canonicalJson(before)),after:digest(canonicalJson(after))});
        };
        if (request.phase==='install') {
          const c=await borrowChainDatabase(request.coordinator);
          try {
            if (request.negative) {
              const absent=await createDisposablePostgres();
              console.info('TERMINAL_MISSING_COORDINATOR_PG',JSON.stringify(absent.evidence));
              try {
                const absentPin=await initializeTerminalCoordinator(absent,randomUUID());
                await reject('independently authenticated coordinator has no durable seal',() => installProductChainTerminal(db,request.ownerId,request.base,request.pin,absent,absentPin));
                await reject('substituted handle with original coordinator pin',() => installProductChainTerminal(db,request.ownerId,request.base,request.pin,absent,request.coordinatorPin));
              } finally {console.info('TERMINAL_MISSING_COORDINATOR_CLEANUP',JSON.stringify(await absent.close()));}
              for (const [name,pin] of [['forged coordinator owner',{...request.coordinatorPin,ownerId:randomUUID()}],
                ['wrong coordinator database',{...request.coordinatorPin,databaseId:randomUUID()}],
                ['wrong coordinator system',{...request.coordinatorPin,systemIdentifier:'1'}]] as const) {
                await reject(name,() => installProductChainTerminal(db,request.ownerId,request.base,request.pin,c.db,pin));
              }
              await reject('forged transport seal is not a coordinator pin',() => installProductChainTerminal(db,request.ownerId,request.base,request.pin,c.db,
                {endpoint:{segment:1,checkpoint:2,sha256:'0'.repeat(64)}} as never));
              await reject('wrong chain',() => installProductChainTerminal(db,request.ownerId,request.base,{...request.pin,chainId:randomUUID()},c.db,request.coordinatorPin));
              await reject('wrong parent',() => installProductChainTerminal(db,request.ownerId,{...request.base,digest:'0'.repeat(64)},request.pin,c.db,request.coordinatorPin));
              const wrong={...request.base,binding:{...request.base.binding,tenantId:'20000000-0000-4000-8000-000000000002'}};
              await reject('wrong tenant and repinned parent',() => installProductChainTerminal(db,request.ownerId,wrong,
                {...request.pin,parentIdentity:digest(canonicalJson(wrong))},c.db,request.coordinatorPin));
            }
            const installed=await installProductChainTerminal(db,request.ownerId,request.base,request.pin,c.db,request.coordinatorPin);
            result={...result,ok:true,installed,negatives,sql:await terminalState(db)};
          } finally {await c.release();}
        } else if (request.phase==='verify') {
          const verified=await verifyProductChainTerminal(db,request.ownerId,request.base,request.pin);
          const last=request.segments.at(-1),wire=JSON.parse(readFileSync(last.artifact.path,'utf8'));
          wire.segment++; wire.from=wire.through; wire.through+=wire.transaction.through; wire.previousDigest=last.artifact.sha256;
          const extra=Buffer.from(JSON.stringify(wire));
          await reject('extra valid-structure successor after sealed terminal',() => replaySealedProductSegment(db,request.ownerId,request.base,request.pin,extra,digest(extra)));
          await reject('conflicting destination seal update',() => db.owner.query("UPDATE local_restore_control.product_chain_terminal SET payload='{}'"));
          result={...result,ok:true,verified,negatives};
        } else {
          const s=request.segments[request.index],bytes=readFileSync(s.artifact.path),wire=JSON.parse(bytes.toString('utf8'));
          if (request.phase==='replay') {
            await reject('valid incomplete prefix cannot complete',() => verifyProductChainTerminal(db,request.ownerId,request.base,request.pin));
            if (request.index) {
              const prev=request.segments[request.index-1];
              await reject('caller supplied prefix endpoint cannot bypass sealed gate',() => verifySyntheticProductChainCheckpoint(db,request.ownerId,request.base,request.pin,
                {segment:request.index,checkpoint:request.index*2,sha256:prev.artifact.sha256}));
            }
          }
          if (request.negative) {
            for (const name of ['forged seal field','tampered final','terminal gap']) {
              const changed=structuredClone(wire);
              if (name==='forged seal field') changed.terminal={segment:request.index+1,checkpoint:(request.index+1)*2,sha256:s.artifact.sha256};
              if (name==='tampered final') changed.transaction.finalProducts='[]';
              if (name==='terminal gap') {changed.segment++; changed.from++; changed.through++;}
              const bad=Buffer.from(JSON.stringify(changed));
              await reject(name,() => replaySealedProductSegment(db,request.ownerId,request.base,request.pin,bad,digest(bad)));
            }
          }
          const applied=await replaySealedProductSegment(db,request.ownerId,request.base,request.pin,bytes,s.artifact.sha256);
          expect(applied).toEqual({kind:request.phase==='retry' ? 'ALREADY_APPLIED' : 'APPLIED',segment:request.index+1,checkpoint:(request.index+1)*2});
          if (request.index<2) await reject('valid prefix still incomplete after apply/retry',() => verifyProductChainTerminal(db,request.ownerId,request.base,request.pin));
          const sql=await terminalState(db);
          result={...result,ok:true,applied,negatives,sql};
        }
      } finally {await target.release();}
    }
  } catch (error) {result={...result,ok:false,error:error instanceof Error ? error.stack : String(error)};}
  mkdirSync('.product-terminal-results',{recursive:true,mode:0o700});
  writeFileSync(`.product-terminal-results/${request.resultId}.json`,JSON.stringify(result),{flag:'wx',mode:0o600});
  expect(result.ok,result.error as string).toBe(true);
},450_000);
