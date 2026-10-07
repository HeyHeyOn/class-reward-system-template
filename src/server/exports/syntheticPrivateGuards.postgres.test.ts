// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import * as terminal from './syntheticProductTerminal';
import { restoreSealedProductExport, prepareSealedProductExport } from './syntheticSealedExport';
import { requireSyntheticPrivateGuards } from './syntheticPrivateGuards';
import { sealedExportChild } from '../../../test-support/sealedExportHarness';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { coldFiles, save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
afterEach(() => vi.restoreAllMocks());
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
/** Tests use independently valid original execution/settlement, not a borrowed
 * cold lease whose earlier refusal would hide the private-guard prerequisite. */
suite('Task21 successor immutable prerequisite',() => {
  it('retains the native function-catalog fence; never enrolls a successor',async () => {
    const coordinator=await createDisposablePostgres(),id=randomUUID();
    console.info('PRIVATE_GUARD_CATALOG_PG',JSON.stringify(coordinator.evidence));
    try {
      const pin=await terminal.initializeTerminalCoordinator(coordinator,randomUUID());
      const q=await coordinator.owner.connect();

      const rows=async () => (await coordinator.owner.query('SELECT to_jsonb(t)::text AS wire,xmin::text,ctid::text FROM local_product_terminal.lease t')).rows;
      try {
        const before=await preactivationWitness(coordinator),beforeRows=await rows();
        await q.query('BEGIN');
        await requireSyntheticPrivateGuards(q,'local_product_terminal.lease');
        const backend=(await q.query('SELECT pg_backend_pid() AS pid')).rows[0];
        const nativeLocks=(await coordinator.owner.query("SELECT mode,granted FROM pg_locks WHERE pid=$1 AND relation='local_product_terminal.lease'::regclass ORDER BY mode",[backend.pid])).rows;
        expect(nativeLocks).toContainEqual({mode:'ShareLock',granted:true});
        // Frozen historical RED remains unchanged. The source regression now
        // requires the native catalog fence, not just the relation lock.
        // The fixture pool has two slots. Release the DDL client before the
        // independent witness reader needs its slot; never add a third client.
        const ddl=await coordinator.owner.connect();
        try {
          await ddl.query('BEGIN'); await ddl.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='2000ms'");
          await expect(ddl.query('CREATE OR REPLACE FUNCTION local_product_terminal.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$')).rejects.toMatchObject({code:'55P03'});
        } finally {try {await ddl.query('ROLLBACK');} finally {ddl.release();}}
        const activity=(await coordinator.owner.query('SELECT pid,state FROM pg_stat_activity WHERE pid=$1',[backend.pid])).rows;
        expect(activity).toEqual([{pid:backend.pid,state:'idle in transaction'}]);
        const changed=await preactivationWitness(coordinator); expect(changed).toEqual(before);
        await requireSyntheticPrivateGuards(q,'local_product_terminal.lease');
        await expect(q.query('UPDATE local_product_terminal.lease SET payload=payload')).rejects.toMatchObject({code:'P0001'});
        await q.query('ROLLBACK'); expect(await rows()).toEqual(beforeRows);
        const restored=await preactivationWitness(coordinator); expect(restored).toEqual(before);
        save(id,'native-catalog-fence',{pin,before,changed,restored,beforeRows,afterRollbackRows:await rows(),
          backend,nativeLocks,activity,nativeUpdateRows:0,ddlCommittedWhileOriginalTransactionLive:false,grantEnrolled:false,successorAccepted:false});
      } finally {try {await q.query('ROLLBACK');} finally {q.release();}}
    } finally {const closed=await coordinator.close(); save(id,'catalog-cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it.each(['original replay','settled terminal and preparation'])('%s',async phase => {
    const coordinator=await createDisposablePostgres(),id=randomUUID();
    console.info('PRIVATE_GUARD_COORDINATOR',JSON.stringify({runId:coordinator.runId,evidence:coordinator.evidence}));
    try {
      const cp=await terminal.initializeTerminalCoordinator(coordinator,randomUUID());
      const captured=await sealedExportChild({phase:'capture',coordinator:{runId:coordinator.runId,evidence:coordinator.evidence},coordinatorPin:cp});
      expect(captured.sourceClosed.containerRemoved).toBe(true);
      const {ref,anchor,base,pin}=captured,wire=JSON.parse(readFileSync(`.sealed-product-export/${ref.sha256}.json`,'utf8'));
      let ordinal=0;
      const replay=terminal.replaySealedProductSegment;
      const negatives:unknown[]=[];
      const witness=async (db:DisposablePostgres) => ({destination:await preactivationWitness(db),coordinator:await preactivationWitness(coordinator),cold:coldFiles(anchor)});
      const reject=async (db:DisposablePostgres,label:string,run:()=>Promise<unknown>) => {
        const before=await witness(db); let returned:unknown,error:string|undefined;
        try {returned=await run();} catch (e) {error=e instanceof Error ? e.message : String(e);}
        const after=await witness(db),record={label,before,after,accepted:error===undefined,returned,error};
        negatives.push(record); save(id,`guard-reject-${ordinal++}`,record);
        expect(error,label).toBeDefined(); expect(after,label).toEqual(before);
      };
      const triggerMutations=async (db:DisposablePostgres,table:string,check:(label:string)=>Promise<void>) => {
        for (const trigger of ['immutable','no_truncate']) {
          // Destructive OID-changing drift is covered with transaction rollback
          // in syntheticCatalogFence; recreating it cannot re-enroll ORIGINAL.
          for (const mode of ['disabled','replica']) {
            if (mode==='disabled') await db.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
            if (mode==='replica') await db.owner.query(`ALTER TABLE ${table} ENABLE REPLICA TRIGGER ${trigger}`);
            try {await check(`${table} ${trigger} ${mode}`);}
            finally {await db.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);}
          }
        }
      };
      const functionMutations=async (db:DisposablePostgres,schema:string,check:(label:string)=>Promise<void>) => {
        const saved=(await db.owner.query('SELECT pg_get_functiondef($1::regprocedure) AS ddl',[`${schema}.immutable()`])).rows[0].ddl;
        for (const sql of [
          `CREATE OR REPLACE FUNCTION ${schema}.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$`,
          `ALTER FUNCTION ${schema}.immutable() SECURITY DEFINER`,
          `ALTER FUNCTION ${schema}.immutable() SET search_path=public`,
        ]) {
          await db.owner.query(sql);
          try {await check(sql);} finally {await db.owner.query(saved);}
        }
      };
      if (phase==='original replay') {
        let calls=0;
        vi.spyOn(terminal,'replaySealedProductSegment').mockImplementation(async (...args) => {
          calls++; const [db,owner]=args;
          if (calls===2) {
            const prior=wire.journal[0];
            const retry=() => replay(db,owner,base,pin,Buffer.from(prior.payload),prior.sha256);
            const before=await witness(db);
            expect(await retry()).toMatchObject({kind:'ALREADY_APPLIED',segment:1,checkpoint:2});
            expect(await witness(db)).toEqual(before);
            const check=(label:string) => reject(db,label,retry);
            for (const table of ['local_restore_control.product_chain_checkpoint','local_restore_control.product_chain_terminal',
              'local_restore_control.sealed_export_execution','local_restore_control.lease']) await triggerMutations(db,table,check);
            await functionMutations(db,'local_restore_control',check);
            // Independently authorized original suffix remains possible after
            // test corruption is restored; this is NOT successor authorization.
            expect((await db.owner.query('SELECT segment FROM local_restore_control.product_chain_checkpoint ORDER BY segment')).rows).toEqual([{segment:1}]);
            save(id,'prefix-prerequisite',{before,after:await witness(db),owner,destination:{runId:db.runId,evidence:db.evidence},acceptedSuccessor:false});
          }
          return replay(...args);
        });
      }
      const restored=await restoreSealedProductExport(ref,anchor,base,pin,coordinator,cp),db=restored.database;
      console.info('PRIVATE_GUARD_DESTINATION',JSON.stringify({runId:db.runId,evidence:db.evidence}));
      try {
        const verify=() => terminal.verifyProductChainTerminal(db,restored.ownerId,base,pin);
        const prepare=() => prepareSealedProductExport(db,restored.ownerId,ref,base,pin,coordinator,cp);
        await verify();
        if (phase==='settled terminal and preparation') {
          const check=async (label:string) => {await reject(db,label+' terminal',verify); await reject(db,label+' preparation',prepare);};
          for (const table of ['local_restore_control.product_chain_checkpoint','local_restore_control.product_chain_terminal',
            'local_restore_control.sealed_export_execution','local_restore_control.lease']) await triggerMutations(db,table,check);
          await functionMutations(db,'local_restore_control',check);
          const coordinatorCheck=(label:string) => reject(db,label+' preparation',prepare);
          for (const table of ['local_product_terminal.lease','local_product_terminal.seal']) await triggerMutations(coordinator,table,coordinatorCheck);
          await functionMutations(coordinator,'local_product_terminal',coordinatorCheck);
          expect((await db.owner.query("SELECT to_regclass('local_restore_control.sealed_preactivation') AS receipt")).rows).toEqual([{receipt:null}]);
        }
        const prepared=await prepare(); expect(prepared.kind).toBe('PREPARED');
        const before=await witness(db),retry=await prepare();
        expect(retry).toEqual({...prepared,kind:'ALREADY_PREPARED'}); expect(await witness(db)).toEqual(before);
        if (phase==='settled terminal and preparation') await triggerMutations(db,'local_restore_control.sealed_preactivation',label => reject(db,label+' retry',prepare));
        save(id,'guard-evidence',{phase,captured,originalPid:process.pid,destination:{runId:db.runId,evidence:db.evidence},owner:restored.ownerId,
          before,after:await witness(db),prepared,retry,negatives,acceptedSuccessor:false,scope:'PRIVATE_IMMUTABILITY_PREREQUISITE_ONLY'});
      } finally {const closed=await db.close(); save(id,'target-cleanup',closed); expect(closed.containerRemoved).toBe(true);}
    } finally {const closed=await coordinator.close(); save(id,'coordinator-cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },1_200_000);
});
