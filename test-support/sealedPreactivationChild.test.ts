// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateRestoreTarget, restoreRetainedMaterializedDatabase } from '@/server/db/testing/materializedRestore';
import { acquireColdArchive, bindColdTarget, coldAllocationRegistration, readColdLease, settleColdArchive } from '@/server/db/testing/coldRestoreStore';
import { installProductChainTerminal, initializeTerminalCoordinator, replaySealedProductSegment, verifyProductChainTerminal } from '@/server/exports/syntheticProductTerminal';
import { canonicalJson } from '@/server/migration/validators';
import { borrowChainDatabase } from './productChainHarness';
import { comparable, digest, terminalChild, terminalState } from './productTerminalHarness';
import { directory, preactivationChild, preactivationWitness } from './sealedPreactivationHarness';
vi.mock('server-only',() => ({}));
// Missing implementation is a normal assertion after entering a real owned-PG
// fixture in RED, not an import/collection/ambient-database error.
const modules=import.meta.glob('../src/server/migration/localSealedPreactivation.ts');
const enabled=process.env.RUN_REAL_POSTGRES==='1' && process.env.SEALED_PREACTIVATION_REQUEST;
(enabled ? it : it.skip)('sealed preactivation cold application phase',async () => {
  const request=JSON.parse(readFileSync(process.env.SEALED_PREACTIVATION_REQUEST!,'utf8'));
  let result:Record<string,unknown>={ok:false,pid:process.pid,phase:request.phase};
  try {
    const coordinator=await borrowChainDatabase(request.coordinator);
    try {
      // Type derives from the implementation only in GREEN; glob lets RED prove
      // the API gap explicitly. Input fixtures remain test-only process JSON.
      expect(modules['../src/server/migration/localSealedPreactivation.ts'],'executable sealed Task19 preparation entry point').toBeTypeOf('function');
      const { stageLocalSealedPreactivation:prepare }=await modules['../src/server/migration/localSealedPreactivation.ts']() as {
        stageLocalSealedPreactivation:(...args:unknown[]) => Promise<{kind:string;preparation:Record<string,unknown>}>;
      };
      expect(prepare).toBeTypeOf('function');
      if (request.phase==='prepare') {
        const target=await borrowChainDatabase(request.descriptor);
        try {
          const before={destination:await preactivationWitness(target.db),coordinator:await preactivationWitness(coordinator.db)};
          const prepared=await prepare(target.db,request.ownerId,request.base,request.pin,coordinator.db,request.coordinatorPin);
          const after={destination:await preactivationWitness(target.db),coordinator:await preactivationWitness(coordinator.db)};
          expect(after.coordinator).toEqual(before.coordinator);
          result={...result,ok:true,prepared,before,after};
        } finally {await target.release();}
      } else {
        const f=request.capture,lease=await acquireColdArchive(f.anchor,f.base.binding),base=readColdLease(lease).seal;
        const {ownerId,registration}=coldAllocationRegistration(lease),db=await createDisposablePostgres(registration);
        console.info('PREACTIVATION_DESTINATION_PG',JSON.stringify(db.evidence));
        try {
          const target=await allocateRestoreTarget(db,ownerId,base.binding);
          await bindColdTarget(lease,db); await restoreRetainedMaterializedDatabase(lease,target);
          await settleColdArchive(lease,'SUCCEEDED',{pid:process.pid,targetId:db.runId,containerId:db.evidence.containerId,rollbackVerified:false});
          const descriptor={runId:db.runId,evidence:db.evidence},common={descriptor,ownerId,base,pin:f.pin,coordinator:request.coordinator,coordinatorPin:request.coordinatorPin};
          const negatives:unknown[]=[];
          const gate=() => prepare(db,ownerId,base,f.pin,coordinator.db,request.coordinatorPin);
          const reject=async (name:string,attempt=gate,extra=coordinator.db) => {
            const before={destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator.db),extra:await preactivationWitness(extra)};
            await expect(attempt(),name).rejects.toThrow('Local sealed preactivation preparation refused.');
            const after={destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator.db),extra:await preactivationWitness(extra)};
            expect(after,name).toEqual(before); negatives.push({name,before,after});
          };
          await reject('terminal not installed');
          await installProductChainTerminal(db,ownerId,base,f.pin,coordinator.db,request.coordinatorPin);
          await reject('entire segment suffix absent');
          for (let i=0;i<f.segments.length;i++) {
            const segment=f.segments[i];
            await replaySealedProductSegment(db,ownerId,base,f.pin,readFileSync(segment.artifact.path),segment.artifact.sha256);
            if (i<f.segments.length-1) await reject(`valid prefix ${i+1} missing sealed suffix`);
          }
          const complete=await terminalState(db);
          expect(comparable(complete.public.tables)).toEqual(comparable(f.sourceFinal.public.tables));
          expect(complete.public.sequences).toEqual(f.sourceFinal.public.sequences);
          expect(complete.public.guards).toEqual(f.sourceFinal.public.guards);
          // Test-only owner corruption is committed before the measured boundary;
          // restoration is explicit and never counted as gate rollback evidence.
          const alterRecord=async (database:typeof db,table:string,value:unknown) => {
            const payload=canonicalJson(value);
            await database.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
            try {await database.owner.query(`UPDATE ${table} SET payload=$1,digest=$2`,[payload,digest(payload)]);}
            finally {await database.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);}
          };
          if (request.negative) {
            for (const [name,pin] of [['stale coordinator owner',{...request.coordinatorPin,ownerId:randomUUID()}],
              ['foreign coordinator database',{...request.coordinatorPin,databaseId:randomUUID()}],
              ['stale coordinator system',{...request.coordinatorPin,systemIdentifier:'1'}]] as const)
              await reject(name,() => prepare(db,ownerId,base,f.pin,coordinator.db,pin));
            await reject('wrong destination owner',() => prepare(db,randomUUID(),base,f.pin,coordinator.db,request.coordinatorPin));
            await reject('wrong parent',() => prepare(db,ownerId,{...base,digest:'0'.repeat(64)},f.pin,coordinator.db,request.coordinatorPin));
            await reject('wrong chain',() => prepare(db,ownerId,base,{...f.pin,chainId:randomUUID()},coordinator.db,request.coordinatorPin));
            const wrong={...base,binding:{...base.binding,tenantId:'20000000-0000-4000-8000-000000000002'}};
            await reject('wrong tenant with recomputed parent',() => prepare(db,ownerId,wrong,{...f.pin,parentIdentity:digest(canonicalJson(wrong))},coordinator.db,request.coordinatorPin));
            await reject('coordinator equals destination',() => prepare(db,ownerId,base,f.pin,db,request.coordinatorPin));
            const absent=await createDisposablePostgres(); console.info('PREACTIVATION_ABSENT_PG',JSON.stringify(absent.evidence));
            try {
              const absentPin=await initializeTerminalCoordinator(absent,randomUUID());
              await reject('authenticated foreign coordinator without seal',() => prepare(db,ownerId,base,f.pin,absent,absentPin),absent);
              await reject('foreign handle with original pin',() => prepare(db,ownerId,base,f.pin,absent,request.coordinatorPin),absent);
            } finally {console.info('PREACTIVATION_ABSENT_CLEANUP',JSON.stringify(await absent.close()));}
            for (const [database,table,name] of [[coordinator.db,'local_product_terminal.seal','coordinator seal absent'],
              [db,'local_restore_control.product_chain_terminal','installed seal absent']] as const) {
              await database.owner.query(`ALTER TABLE ${table} RENAME TO saved_terminal`);
              try {await reject(name);} finally {await database.owner.query(`ALTER TABLE ${table.split('.')[0]}.saved_terminal RENAME TO ${table.split('.')[1]}`);}
            }
            for (const [database,table,name] of [[coordinator.db,'local_product_terminal.seal','coordinator seal conflicting'],
              [db,'local_restore_control.product_chain_terminal','installed seal conflicting']] as const) {
              const original=JSON.parse((await database.owner.query(`SELECT payload FROM ${table}`)).rows[0].payload);
              const changed=structuredClone(original); changed.seal.intent.counts=[2,2]; changed.seal.segments=changed.seal.segments.slice(0,2);
              await alterRecord(database,table,changed);
              try {await reject(name);} finally {await alterRecord(database,table,original);}
            }
            const rows=(await db.owner.query('SELECT product_id,name FROM public.products ORDER BY product_id LIMIT 1')).rows[0];
            await db.owner.query('UPDATE public.products SET name=$1 WHERE product_id=$2',[`${rows.name} missing postwrite`,rows.product_id]);
            try {await reject('post-write product SQL differs');} finally {await db.owner.query('UPDATE public.products SET name=$1 WHERE product_id=$2',[rows.name,rows.product_id]);}
            const tenant=(await db.owner.query('SELECT display_name FROM public.tenants')).rows[0].display_name;
            await db.owner.query("UPDATE public.tenants SET display_name='wrong public row'");
            try {await reject('non-product public SQL differs');} finally {await db.owner.query('UPDATE public.tenants SET display_name=$1',[tenant]);}
            const sequence=(await db.owner.query('SELECT last_value::text,is_called FROM public.transactions_event_sequence_seq')).rows[0];
            await db.owner.query("SELECT nextval('public.transactions_event_sequence_seq')");
            try {await reject('public sequence differs');} finally {await db.owner.query("SELECT setval('public.transactions_event_sequence_seq',$1::bigint,$2)",[sequence.last_value,sequence.is_called]);}
            await db.owner.query('ALTER TABLE public.products DISABLE ROW LEVEL SECURITY');
            try {await reject('public guard differs');} finally {await db.owner.query('ALTER TABLE public.products ENABLE ROW LEVEL SECURITY');}
            // Legacy single-segment checkpoint must not be treated as sealed.
            await db.owner.query('CREATE TABLE local_restore_control.product_delta_checkpoint(singleton boolean)');
            try {await reject('single-segment compatibility cannot bypass sealed gate');}
            finally {await db.owner.query('DROP TABLE local_restore_control.product_delta_checkpoint');}
            const checkpoint='local_restore_control.product_chain_checkpoint';
            const originalJournal=(await db.owner.query(`SELECT * FROM ${checkpoint} ORDER BY segment`)).rows;
            const originalInstalled=JSON.parse((await db.owner.query('SELECT payload FROM local_restore_control.product_chain_terminal')).rows[0].payload);
            const originalRetained=JSON.parse((await coordinator.db.owner.query('SELECT payload FROM local_product_terminal.seal')).rows[0].payload);
            const changed=structuredClone(originalJournal),newInstalled=structuredClone(originalInstalled),newRetained=structuredClone(originalRetained);
            for (let i=1;i<changed.length;i++) {
              const envelope=JSON.parse(changed[i].payload);
              if (i===1) {const prior=JSON.parse(envelope.transaction.events[0].before); prior.stock++; envelope.transaction.events[0].before=JSON.stringify(prior);}
              else envelope.previousDigest=changed[i-1].artifact_digest;
              changed[i].payload=JSON.stringify(envelope); changed[i].artifact_digest=digest(changed[i].payload); changed[i].request_digest=changed[i].artifact_digest;
              newInstalled.seal.segments[i].sha256=changed[i].artifact_digest; newRetained.seal.segments[i].sha256=changed[i].artifact_digest;
            }
            const writeJournal=async (rows:typeof originalJournal) => {
              await db.owner.query(`ALTER TABLE ${checkpoint} DISABLE TRIGGER USER`);
              try {for (const r of rows) await db.owner.query(`UPDATE ${checkpoint} SET payload=$1,artifact_digest=$2,request_digest=$3 WHERE segment=$4`,
                [r.payload,r.artifact_digest,r.request_digest,r.segment]);}
              finally {await db.owner.query(`ALTER TABLE ${checkpoint} ENABLE TRIGGER USER`);}
            };
            await writeJournal(changed); await alterRecord(db,'local_restore_control.product_chain_terminal',newInstalled);
            await alterRecord(coordinator.db,'local_product_terminal.seal',newRetained);
            try {
              // ORIGINAL pinning rejects a coherent forged seal even before the
              // transition gate. Pure reconciliation tests independently retain
              // the impossible-before-image check; never weaken ORIGINAL here.
              await expect(verifyProductChainTerminal(db,ownerId,base,f.pin)).rejects.toThrow('Synthetic ORIGINAL catalog prerequisite refused.');
              await reject('coherent terminal digests but impossible intermediate postwrite before-image');
            } finally {
              await writeJournal(originalJournal); await alterRecord(db,'local_restore_control.product_chain_terminal',originalInstalled);
              await alterRecord(coordinator.db,'local_product_terminal.seal',originalRetained);
            }
          }
          const before=await terminalState(db);
          const prepared=await preactivationChild({phase:'prepare',...common});
          expect(prepared.pid).not.toBe(process.pid); expect(prepared.prepared.kind).toBe('PREPARED');
          expect(prepared.prepared.preparation).toMatchObject({scope:'LOCAL_SEALED_PREACTIVATION_PREPARATION_ONLY',authority:'NONAUTHORITY',
            activationAllowed:false,complete:false,coverage:'CONTROLLED_SYNTHETIC_PRODUCT_WRITER_ONLY',outsideWriterCoverage:'NOT_PROVEN',
            terminal:{segment:3,checkpoint:6},productEvents:6});
          const stored=(await db.owner.query('SELECT payload FROM local_restore_control.sealed_preactivation')).rows;
          expect(stored).toHaveLength(1); expect(JSON.parse(stored[0].payload)).toEqual(prepared.prepared.preparation);
          const after=await terminalState(db); expect(after.public).toEqual(before.public);
          for (const [table,rows] of Object.entries(before.private.rows)) expect(after.private.rows[table]).toEqual(rows);
          const retry=await preactivationChild({phase:'prepare',...common});
          expect(retry.pid).not.toBe(prepared.pid); expect(retry.prepared).toEqual({...prepared.prepared,kind:'ALREADY_PREPARED'});
          expect(retry.after).toEqual(retry.before); expect(await terminalState(db)).toEqual(after);
          await expect(db.runtime.query('SELECT * FROM local_restore_control.sealed_preactivation')).rejects.toThrow(/permission denied/);
          await expect(db.owner.query('UPDATE local_restore_control.sealed_preactivation SET payload=payload')).rejects.toThrow(/immutable/);
          await expect(db.owner.query('TRUNCATE local_restore_control.sealed_preactivation')).rejects.toThrow(/immutable/);
          if (request.negative) {
            const original=JSON.parse(stored[0].payload),changed={...original,productEvents:5};
            await alterRecord(db,'local_restore_control.sealed_preactivation',changed);
            try {await reject('conflicting preparation retry');} finally {await alterRecord(db,'local_restore_control.sealed_preactivation',original);}
            const row=(await db.owner.query('SELECT product_id,name FROM public.products LIMIT 1')).rows[0];
            await db.owner.query("UPDATE public.products SET name='post-preparation drift' WHERE product_id=$1",[row.product_id]);
            try {await reject('existing preparation never masks postwrite drift');} finally {await db.owner.query('UPDATE public.products SET name=$1 WHERE product_id=$2',[row.name,row.product_id]);}
          }
          const final=await terminalState(db); expect(final).toEqual(after);
          expect(JSON.parse(final.public.tables.tenants).every((t:{lifecycle:string}) => t.lifecycle==='IMPORTING')).toBe(true);
          expect(JSON.parse(final.public.tables.migration_jobs).every((j:{status:string}) => j.status==='IMPORTING')).toBe(true);
          result={...result,ok:true,sourceClosed:f.sourceClosed,databaseId:db.runId,prepared,retry,negatives,sourceComparison:{publicSql:true,sequences:true,guards:true},final};
        } finally {result.cleanup=await db.close(); console.info('PREACTIVATION_DESTINATION_CLEANUP',JSON.stringify(result.cleanup));}
      }
    } finally {await coordinator.release();}
  } catch (error) {result.error=error instanceof Error ? {message:error.message,stack:error.stack} : String(error); throw error;}
  finally {writeFileSync(`${directory}/${request.resultId}-preactivation.json`,JSON.stringify(result),{flag:'wx',mode:0o600});}
},900_000);
