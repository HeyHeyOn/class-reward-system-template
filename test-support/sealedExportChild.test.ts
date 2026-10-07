// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { coldFixture, cleanupColdFixture } from './coldRestoreFixture';
import { borrowChainDatabase, chainChild } from './productChainHarness';
import { comparable, digest, terminalState } from './productTerminalHarness';
import { preactivationWitness } from './sealedPreactivationHarness';
import { directory, sealedExportChild } from './sealedExportHarness';
import { retainColdDatabase } from '@/server/db/testing/coldRestore';
import { acquireColdArchive } from '@/server/db/testing/coldRestoreStore';
import { registerProductChainIntent, retainProductChainTerminal } from '@/server/exports/syntheticProductTerminal';
import { canonicalJson } from '@/server/migration/validators';
import type * as ExportApi from '@/server/exports/syntheticSealedExport';
vi.mock('server-only',() => ({}));
afterEach(cleanupColdFixture);
const modules=import.meta.glob('../src/server/exports/syntheticSealedExport.ts');
const enabled=process.env.RUN_REAL_POSTGRES==='1' && process.env.SEALED_EXPORT_REQUEST;
const artifactPath=(sha256:string) => `.sealed-product-export/${sha256}.json`;
(enabled ? it : it.skip)('sealed export cold application phase',async () => {
  const request=JSON.parse(readFileSync(process.env.SEALED_EXPORT_REQUEST!,'utf8'));
  let result:Record<string,unknown>={ok:false,pid:process.pid,phase:request.phase};
  try {
    const api=await modules['../src/server/exports/syntheticSealedExport.ts']() as typeof ExportApi;
    const control=await borrowChainDatabase(request.coordinator),coordinator=control.db,cp=request.coordinatorPin;
    try {
      if (request.phase==='capture') {
        const f=await coldFixture(true);
        await f.source.owner.query("SELECT setval('transactions_event_sequence_seq',901,true),setval('task_assignments_event_sequence_seq',701,false)");
        const anchor=await retainColdDatabase(f.source,f.ownerId,f.binding,{retainUntil:Date.now()+60_000,expiresAt:Date.now()+3_600_000});
        const base=JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/expectation.json`,'utf8')).seal;
        const pin={chainId:randomUUID(),parentIdentity:digest(canonicalJson(base))};
        await registerProductChainIntent(f.source,base,pin,[2,2,2]);
        const negatives:unknown[]=[];
        const reject=async (name:string) => {
          const before={source:await preactivationWitness(f.source),coordinator:await preactivationWitness(coordinator)};
          await expect(api.exportSealedProductRecovery(f.source,anchor,base,pin,coordinator,cp),name).rejects.toThrow('Sealed synthetic export refused.');
          const after={source:await preactivationWitness(f.source),coordinator:await preactivationWitness(coordinator)};
          expect(after).toEqual(before); negatives.push({name,before,after});
        };
        await reject('intent without committed sealed suffix cannot export');
        let cursor={segment:1,from:0,previousDigest:digest(canonicalJson(pin))};
        const writes=[
          [{op:'create',id:'export-new',name:'First \'\n합성',price:31,stock:4},{op:'update',id:'P1',name:'First',price:17,stock:23}],
          [{op:'update',id:'export-new',name:'Second',price:9007199254740991,stock:9},{op:'delete',id:'P2'}],
          [{op:'delete',id:'export-new'},{op:'create',id:'export-final',name:'Third',price:73,stock:11}],
        ];
        for (const batch of writes) {
          const s=await chainChild({phase:'write',descriptor:{runId:f.source.runId,evidence:f.source.evidence},base,pin,cursor,writes:batch});
          cursor={segment:cursor.segment+1,from:cursor.from+batch.length,previousDigest:s.artifact.sha256};
        }
        await reject('complete outbox without separately retained terminal cannot export');
        await retainProductChainTerminal(coordinator,cp,f.source,base,pin);
        if (request.negative) {
          const saved=(await f.source.owner.query('SELECT display_name FROM public.tenants')).rows[0].display_name;
          await f.source.owner.query("UPDATE public.tenants SET display_name='source drift'");
          try {await reject('source public divergence');} finally {await f.source.owner.query('UPDATE public.tenants SET display_name=$1',[saved]);}
          await f.source.owner.query('CREATE TABLE public.synthetic_secret_probe(value text); INSERT INTO public.synthetic_secret_probe VALUES(\'DO_NOT_EXPORT_SYNTHETIC_SECRET\')');
          try {await reject('unexpected populated table excluded before field read');}
          finally {await f.source.owner.query('DROP TABLE public.synthetic_secret_probe');}
          // Recompute EVERY affected digest and both SQL terminals. This reaches
          // semantic transition reconciliation rather than just hash admission.
          const journal=(await f.source.owner.query('SELECT * FROM local_product_chain.outbox ORDER BY segment')).rows;
          const sourceSeal=JSON.parse((await f.source.owner.query('SELECT payload FROM local_product_chain.terminal')).rows[0].payload);
          const retained=JSON.parse((await coordinator.owner.query('SELECT payload FROM local_product_terminal.seal')).rows[0].payload);
          const changed=structuredClone(journal),badSeal=structuredClone(sourceSeal),badRetained=structuredClone(retained);
          for (let i=1;i<changed.length;i++) {
            const envelope=JSON.parse(changed[i].payload);
            if (i===1) {const before=JSON.parse(envelope.transaction.events[0].before); before.stock++; envelope.transaction.events[0].before=JSON.stringify(before);}
            else envelope.previousDigest=changed[i-1].artifact_digest;
            changed[i].payload=JSON.stringify(envelope); changed[i].artifact_digest=digest(changed[i].payload);
            badSeal.segments[i].sha256=changed[i].artifact_digest; badRetained.seal.segments[i].sha256=changed[i].artifact_digest;
          }
          const writeJournal=async (rows:typeof journal) => {
            await f.source.owner.query('ALTER TABLE local_product_chain.outbox DISABLE TRIGGER USER');
            try {for (const r of rows) await f.source.owner.query('UPDATE local_product_chain.outbox SET payload=$1,artifact_digest=$2 WHERE segment=$3',[r.payload,r.artifact_digest,r.segment]);}
            finally {await f.source.owner.query('ALTER TABLE local_product_chain.outbox ENABLE TRIGGER USER');}
          };
          const writeSeal=async (database:typeof coordinator,table:string,value:unknown) => {
            const payload=canonicalJson(value); await database.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
            try {await database.owner.query(`UPDATE ${table} SET payload=$1,digest=$2`,[payload,digest(payload)]);}
            finally {await database.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);}
          };
          await writeJournal(changed); await writeSeal(f.source,'local_product_chain.terminal',badSeal); await writeSeal(coordinator,'local_product_terminal.seal',badRetained);
          try {await reject('coherently rehashed impossible intermediate product transition');}
          finally {await writeJournal(journal); await writeSeal(f.source,'local_product_chain.terminal',sourceSeal); await writeSeal(coordinator,'local_product_terminal.seal',retained);}
        }
        const before={source:await preactivationWitness(f.source),coordinator:await preactivationWitness(coordinator)};
        const ref=await api.exportSealedProductRecovery(f.source,anchor,base,pin,coordinator,cp);
        expect(await api.exportSealedProductRecovery(f.source,anchor,base,pin,coordinator,cp)).toEqual(ref);
        const after={source:await preactivationWitness(f.source),coordinator:await preactivationWitness(coordinator)};
        expect(after).toEqual(before);
        const bytes=readFileSync(artifactPath(ref.sha256)),envelope=JSON.parse(bytes.toString());
        expect(digest(bytes)).toBe(ref.sha256); expect(lstatSync(artifactPath(ref.sha256)).mode & 0o777).toBe(0o400);
        expect(envelope).toMatchObject({profile:'SYNTHETIC_SEALED_EXPORT_V1',authority:'NONAUTHORITY',activationAllowed:false,
          complete:false,coverage:'CONTROLLED_SYNTHETIC_PRODUCT_WRITER_ONLY',outsideWriterCoverage:'NOT_PROVEN'});
        expect(envelope.seal.intent.counts).toEqual([2,2,2]); expect(envelope.journal).toHaveLength(3);
        expect(digest(Buffer.from(envelope.archive,'base64'))).toBe(base.digest);
        expect(envelope.postwrite).toEqual((await terminalState(f.source)).public);
        const raw=bytes.toString()+Buffer.from(envelope.archive,'base64').toString();
        for (const forbidden of [String(f.source.evidence.containerId),String(coordinator.evidence.containerId),
          'DO_NOT_EXPORT_SYNTHETIC_SECRET','DATABASE_URL=','REDIS_URL=','Bearer ','BEGIN PRIVATE KEY','postgresql://']) expect(raw).not.toContain(forbidden);
        for (const table of ['tenant_sessions','tenant_admin_credentials','tenant_google_credentials','oauth_pending_states'])
          if (envelope.postwrite.tables[table]!==undefined) expect(envelope.postwrite.tables[table]).toBe('[]');
        const sourceFinal=(await terminalState(f.source)).public,sourceClosed=await f.source.close();
        // Delete only this fixture's transport; original trusted coordinator files
        // remain untouched. The destination must execute bytes FROM the envelope.
        unlinkSync(`.cold-restore-transport/${anchor.id}.sql`);
        result={...result,ok:true,anchor,base,pin,ref,before,after,sourceFinal,sourceClosed,negatives};
      } else if (request.phase==='prepare') {
        const target=await borrowChainDatabase(request.descriptor);
        try {
          const before={destination:await preactivationWitness(target.db),coordinator:await preactivationWitness(coordinator)};
          const prepared=await api.prepareSealedProductExport(target.db,request.ownerId,request.ref,request.base,request.pin,coordinator,cp);
          const after={destination:await preactivationWitness(target.db),coordinator:await preactivationWitness(coordinator)};
          expect(after.coordinator).toEqual(before.coordinator);
          result={...result,ok:true,prepared,before,after};
        } finally {await target.release();}
      } else {
        const f=request.captured;
        expect(f.sourceClosed.containerRemoved).toBe(true);
        expect(existsSync(`.cold-restore-transport/${f.anchor.id}.sql`)).toBe(false);
        const statePath=`.cold-restore-control/${f.anchor.id}/state.json`,stateBefore=readFileSync(statePath,'utf8');
        const original=readFileSync(artifactPath(f.ref.sha256)),wire=JSON.parse(original.toString());
        const negatives:unknown[]=[];
        // No target exists for an invalid first restore, and the original single
        // lease journal must remain byte-identical (not reset/re-enrolled).
        const badFirst={...wire,journal:wire.journal.slice(0,-1)},badBytes=Buffer.from(canonicalJson(badFirst)),badRef={sha256:digest(badBytes)};
        writeFileSync(artifactPath(badRef.sha256),badBytes,{flag:'wx',mode:0o400});
        const beforeFirst=await preactivationWitness(coordinator);
        await expect(api.restoreSealedProductExport(badRef,f.anchor,f.base,f.pin,coordinator,cp)).rejects.toThrow('Sealed synthetic export refused.');
        expect(readFileSync(statePath,'utf8')).toBe(stateBefore); expect(await preactivationWitness(coordinator)).toEqual(beforeFirst);
        negatives.push({name:'missing suffix before allocation',before:beforeFirst,after:beforeFirst,coldJournalSha256:digest(stateBefore),destination:'NOT_ALLOCATED'});
        const restored=await api.restoreSealedProductExport(f.ref,f.anchor,f.base,f.pin,coordinator,cp),db=restored.database;
        console.info('SEALED_EXPORT_DESTINATION_PG',JSON.stringify(db.evidence));
        try {
          expect(restored.stage).toBe('RESTORED_AWAITING_SEALED_PREPARATION');
          const common={descriptor:{runId:db.runId,evidence:db.evidence},ownerId:restored.ownerId,ref:f.ref,base:f.base,pin:f.pin,
            coordinator:request.coordinator,coordinatorPin:cp};
          const full=await terminalState(db);
          expect(comparable(full.public.tables)).toEqual(comparable(f.sourceFinal.tables));
          expect(full.public.guards).toEqual(f.sourceFinal.guards); expect(full.public.sequences).toEqual(f.sourceFinal.sequences);
          expect(full.public.tables.migration_local_disposable_database).toBe('[]');
          expect(full.public.tables.migration_local_materializations).toBe('[]');
          expect(JSON.parse(full.public.tables.tenants)[0].lifecycle).toBe('IMPORTING');
          const prepare=() => api.prepareSealedProductExport(db,restored.ownerId,f.ref,f.base,f.pin,coordinator,cp);
          const reject=async (name:string,fn:() => Promise<unknown>=prepare) => {
            const before={destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator),cold:readFileSync(statePath,'utf8')};
            await expect(fn(),name).rejects.toThrow();
            const after={destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator),cold:readFileSync(statePath,'utf8')};
            expect(after,name).toEqual(before); negatives.push({name,before,after});
          };
          if (request.negative) {
            for (const name of ['missing suffix','tampered suffix','wrong tenant','wrong parent','wrong coordinator','stale seal','public witness','sequence witness','guard witness','secret field']) {
              const changed=structuredClone(wire);
              if (name==='missing suffix') changed.journal.pop();
              if (name==='tampered suffix') changed.journal.at(-1).payload+=' ';
              if (name==='wrong tenant') changed.base.binding.tenantId=randomUUID();
              if (name==='wrong parent') changed.chain.parentIdentity='0'.repeat(64);
              if (name==='wrong coordinator') changed.coordinator.ownerId=randomUUID();
              if (name==='stale seal') {changed.seal.intent.counts.pop(); changed.seal.segments.pop(); changed.journal.pop();}
              if (name==='public witness') changed.postwrite.tables.tenants='[]';
              if (name==='sequence witness') changed.postwrite.sequences.transactions_event_sequence_seq='[]';
              if (name==='guard witness') changed.postwrite.guards='[]';
              if (name==='secret field') changed.credentials={password:'DO_NOT_EXPORT_SYNTHETIC_SECRET'};
              const bytes=Buffer.from(canonicalJson(changed)),ref={sha256:digest(bytes)},path=artifactPath(ref.sha256);
              if (!existsSync(path)) writeFileSync(path,bytes,{flag:'wx',mode:0o400});
              await reject(name,() => api.prepareSealedProductExport(db,restored.ownerId,ref,f.base,f.pin,coordinator,cp));
            }
            await reject('wrong independent parent',() => api.prepareSealedProductExport(db,restored.ownerId,f.ref,{...f.base,digest:'0'.repeat(64)},f.pin,coordinator,cp));
            await reject('wrong independent coordinator',() => api.prepareSealedProductExport(db,restored.ownerId,f.ref,f.base,f.pin,coordinator,{...cp,ownerId:randomUUID()}));
            await reject('wrong destination owner',() => api.prepareSealedProductExport(db,randomUUID(),f.ref,f.base,f.pin,coordinator,cp));
            await reject('single original cold lease cannot be consumed twice',() => api.restoreSealedProductExport(f.ref,f.anchor,f.base,f.pin,coordinator,cp));
            await reject('original archive acquisition still terminal',() => acquireColdArchive(f.anchor,f.base.binding));
            const path=artifactPath(f.ref.sha256),saved=`${path}.owned-test-saved`;
            renameSync(path,saved);
            try {
              await reject('missing envelope');
              symlinkSync(saved.split('/').at(-1)!,path); try {await reject('symlink envelope');} finally {unlinkSync(path);}
              linkSync(saved,path); try {await reject('hardlinked envelope');} finally {unlinkSync(path);}
              writeFileSync(path,Buffer.concat([original,Buffer.from(' ')]),{flag:'wx',mode:0o400});
              try {await reject('tampered bytes under independently pinned filename');} finally {unlinkSync(path);}
            } finally {renameSync(saved,path);}
            chmodSync(path,0o600); try {await reject('mutable envelope mode');} finally {chmodSync(path,0o400);}
            const product=(await db.owner.query('SELECT product_id,name FROM public.products LIMIT 1')).rows[0];
            await db.owner.query("UPDATE public.products SET name='postwrite drift' WHERE product_id=$1",[product.product_id]);
            try {await reject('postwrite product SQL drift');} finally {await db.owner.query('UPDATE public.products SET name=$1 WHERE product_id=$2',[product.name,product.product_id]);}
            const tenant=(await db.owner.query('SELECT display_name FROM public.tenants')).rows[0].display_name;
            await db.owner.query("UPDATE public.tenants SET display_name='divergent public SQL'");
            try {await reject('nonproduct public SQL drift');} finally {await db.owner.query('UPDATE public.tenants SET display_name=$1',[tenant]);}
            const seq=(await db.owner.query('SELECT last_value::text,is_called FROM public.transactions_event_sequence_seq')).rows[0];
            await db.owner.query("SELECT nextval('public.transactions_event_sequence_seq')");
            try {await reject('destination sequence drift');} finally {await db.owner.query("SELECT setval('public.transactions_event_sequence_seq',$1::bigint,$2)",[seq.last_value,seq.is_called]);}
            await db.owner.query('ALTER TABLE public.products DISABLE ROW LEVEL SECURITY');
            try {await reject('destination guard drift');} finally {await db.owner.query('ALTER TABLE public.products ENABLE ROW LEVEL SECURITY');}
          }
          const prepared=await sealedExportChild({phase:'prepare',...common});
          expect(prepared.prepared.kind).toBe('PREPARED');
          expect(prepared.prepared.preparation).toMatchObject({activationAllowed:false,complete:false,productEvents:6,terminal:{segment:3,checkpoint:6}});
          const retry=await sealedExportChild({phase:'prepare',...common});
          expect(retry.prepared).toEqual({...prepared.prepared,kind:'ALREADY_PREPARED'});
          expect(retry.before).toEqual(retry.after);
          const final=await terminalState(db); expect(final.public).toEqual(full.public);
          result={...result,ok:true,restoration:restored.restoration,ownerId:restored.ownerId,databaseId:db.runId,prepared,retry,negatives,
            sourceClosed:f.sourceClosed,archiveTransportAbsent:true,sourceComparison:{publicSql:true,sequences:true,guards:true},final};
        } finally {result.cleanup=await db.close(); console.info('SEALED_EXPORT_DESTINATION_CLEANUP',JSON.stringify(result.cleanup));}
      }
    } finally {await control.release();}
  } catch (error) {result.error=error instanceof Error ? {message:error.message,stack:error.stack} : String(error); throw error;}
  finally {writeFileSync(`${directory}/${request.resultId}.json`,JSON.stringify(result),{flag:'wx',mode:0o600});}
},900_000);
