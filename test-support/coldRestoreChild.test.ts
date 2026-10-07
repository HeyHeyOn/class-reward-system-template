// @vitest-environment node
import { mkdirSync, writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterEach, expect, it, vi } from 'vitest';
import { coldFixture, coldState, cleanupColdFixture } from './coldRestoreFixture';
import { retainColdDatabase, restoreColdDatabase, disposeColdArchive } from '@/server/db/testing/coldRestore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import { acquireColdArchive } from '@/server/db/testing/coldRestoreStore';
import { restoreRetainedMaterializedDatabase } from '@/server/db/testing/materializedRestore';
vi.mock('server-only', () => ({}));
afterEach(cleanupColdFixture);
const request = process.env.COLD_REQUEST ? JSON.parse(process.env.COLD_REQUEST) : null;
it.skipIf(!request)('trusted cold coordinator child',async () => {
  let result: unknown;
  let dispatched = false;
  let guardsVerified = false;
  try {
    if (request.now) vi.spyOn(Date,'now').mockReturnValue(request.now);
    if (request.phase==='capture') {
      const f = await coldFixture(request.mixed);
      // Non-default sequence state, including is_called=false, must survive SQL.
      await f.source.owner.query("SELECT setval('transactions_event_sequence_seq',900,true), setval('task_assignments_event_sequence_seq',700,false)");
      const before=await coldState(f.source);
      const anchor = await retainColdDatabase(f.source,f.ownerId,f.binding,request.policy);
      expect(await coldState(f.source)).toEqual(before);
      const closed = await f.source.close();
      result = {ok:true,anchor,binding:f.binding,sourceClosed:closed,sourceDatabaseId:f.source.runId,pid:process.pid};
    } else if (request.phase==='abandon') {
      await acquireColdArchive(request.anchor,request.binding); result={ok:true,pid:process.pid};
    } else if (request.phase==='forged-capability') {
      await restoreRetainedMaterializedDatabase({id:request.anchor.id},{execute:async () => { dispatched=true; }});
      result={ok:true,pid:process.pid,dispatched};
    } else if (request.phase==='dispose') {
      await disposeColdArchive(request.anchor); result={ok:true,pid:process.pid};
    } else {
      const execute = archive.executeOwnedRestore;
      vi.spyOn(archive,'executeOwnedRestore').mockImplementationOnce(async (db,script) => {
        if (['rollback','residue'].includes(request.fault)) script+='\nSELECT 1/0;';
        if (request.fault==='sequence') {
          expect(script).toContain("900, true");
          script=script.replace('900, true','901, true');
        }
        dispatched = true;
        try { await execute(db,script); }
        catch (error) {
          if (request.fault==='residue') await db.owner.query("CREATE FUNCTION public.incomplete_rollback() RETURNS integer LANGUAGE sql AS 'SELECT 1'");
          throw error;
        }
        if (request.fault==='postcommit-erased') {
          await db.owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
          return; // psql succeeded; only the subsequent receipt readback fails.
        }
        if (request.fault==='ack') throw new Error('simulated lost COMMIT acknowledgement');
        const tenant=request.binding.tenantId, other='20000000-0000-4000-8000-000000000002';
        await expect(db.runTenantTransaction(tenant,tx => tx.execute(sql`UPDATE transactions SET operator_snapshot='tamper'`)))
          .rejects.toMatchObject({cause:{code:'55000'}});
        await expect(db.runTenantTransaction(tenant,tx => tx.execute(sql`DELETE FROM padlet_evidence_claims`)))
          .rejects.toMatchObject({cause:{code:'P0001'}});
        await expect(db.runTenantTransaction(tenant,tx => tx.execute(sql`UPDATE accounts SET student_id='missing'`)))
          .rejects.toMatchObject({cause:{code:'23503'}});
        await expect(db.runTenantTransaction(tenant,tx => tx.execute(sql`INSERT INTO padlet_claim_digest_registry(tuple_digest,claim_kind)
          SELECT tuple_digest,claim_kind FROM padlet_claim_digest_registry LIMIT 1`))).rejects.toMatchObject({cause:{code:'23505'}});
        expect((await db.runTenantTransaction(other,tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
        expect((await db.runTenantTransaction(other,tx => tx.execute(sql`SELECT * FROM migration_local_restorations`))).rows).toEqual([]);
        await expect(db.owner.query('UPDATE migration_local_restorations SET activation_allowed=true')).rejects.toThrow(/immutable/i);
        await expect(db.owner.query('TRUNCATE migration_local_restore_databases CASCADE')).rejects.toThrow(/immutable/i);
        guardsVerified=true;
      });
      const restored = await restoreColdDatabase(request.anchor,request.binding);
      result={ok:true,restored,pid:process.pid,dispatched,guardsVerified};
    }
  } catch (error) { result={ok:false,error:error instanceof Error ? error.message : String(error),pid:process.pid,dispatched}; }
  finally { vi.restoreAllMocks(); }
  mkdirSync('.cold-child-results',{recursive:true,mode:0o700});
  if (!/^[0-9a-f-]{36}$/.test(request.resultId)) throw new Error('Invalid result ID');
  writeFileSync(`.cold-child-results/${request.resultId}.json`,JSON.stringify(result),{flag:'wx',mode:0o600});
  expect(result).toHaveProperty('ok');
},120_000);
