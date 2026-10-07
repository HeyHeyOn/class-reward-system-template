// @vitest-environment node
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import * as cold from '@/server/db/testing/coldRestore';
import * as materialized from '@/server/db/testing/materializedRestore';
import * as archive from '@/server/db/testing/ownedPgArchive';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
vi.mock('server-only', () => ({}));
vi.mock('node:fs/promises',async importOriginal => ({...await importOriginal<typeof import('node:fs/promises')>()}));
const request=process.env.ORPHAN_REQUEST ? JSON.parse(process.env.ORPHAN_REQUEST) : null;
function save(suffix: string,value: unknown) {
  mkdirSync('.orphan-child-results',{recursive:true,mode:0o700});
  if (!/^[0-9a-f-]{36}$/.test(request.resultId)) throw new Error('Invalid fixture result ID');
  // The parent polls existence while this process is alive. Publish only a
  // complete JSON record; even synchronous writes expose an empty/partial file.
  const path=`.orphan-child-results/${request.resultId}-${suffix}.json`;
  writeFileSync(`${path}.part`,JSON.stringify(value),{flag:'wx',mode:0o600});
  renameSync(`${path}.part`,path);
}
it.skipIf(!request)('trusted orphan coordinator child',async () => {
  let result: unknown;
  try {
    if (request.now) vi.spyOn(Date,'now').mockReturnValue(request.now);
    if (request.phase==='recover') {
      // Namespace lookup lets the pre-implementation RED reach a real killed PG
      // fixture instead of failing module resolution before the experiment.
      const recover=Reflect.get(cold,'recoverColdDatabase');
      if (typeof recover!=='function') throw new Error('Orphan recovery not implemented');
      if (request.fault==='journal-publication') {
        const rename=fs.rename;
        vi.spyOn(fs,'rename').mockImplementation(async (from,to) => {
          if (String(to).endsWith('/state.json')) throw new Error('Injected recovery state publish failure');
          return rename(from,to);
        });
      }
      result={ok:true,recovery:await recover(request.anchor,request.binding),pid:process.pid};
    } else {
      let database: DisposablePostgres;
      const allocate=materialized.allocateRestoreTarget;
      vi.spyOn(materialized,'allocateRestoreTarget').mockImplementationOnce(async (...args) => {
        database=args[0]; return allocate(...args);
      });
      const hold=async (sql?: unknown) => {
        save('ready',{pid:process.pid,databaseId:database.runId,evidence:database.evidence,sql});
        await new Promise<void>(() => { /* Trusted launcher will SIGKILL this process. */ });
      };
      const restore=materialized.restoreRetainedMaterializedDatabase;
      vi.spyOn(materialized,'restoreRetainedMaterializedDatabase').mockImplementationOnce(async (...args) => {
        if (request.fault==='allocated') await hold();
        return restore(...args);
      });
      const execute=archive.executeOwnedRestore;
      vi.spyOn(archive,'executeOwnedRestore').mockImplementationOnce(async (db,script) => {
        if (request.fault==='partial') {
          const pending=execute(db,script+'\nSELECT pg_sleep(120);');
          // Observe actual SQL IN FLIGHT, not a timer guessed to mean SQL ran.
          const deadline=Date.now()+30_000;
          for (;;) {
            const rows=(await db.owner.query("SELECT pid,state,wait_event,query FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND state='active' AND query LIKE 'SELECT pg_sleep(120)%'")).rows;
            if (rows.length===1) { await hold({active:rows}); break; }
            if (Date.now()>deadline) throw new Error('Partial SQL barrier was not reached');
            await new Promise(done => setTimeout(done,50));
          }
          await pending;
        } else if (request.fault==='residue') {
          await db.owner.query("CREATE FUNCTION public.orphan_partial() RETURNS integer LANGUAGE sql AS 'SELECT 19'");
          await hold({residue:(await db.owner.query("SELECT proname FROM pg_proc WHERE proname='orphan_partial'")).rows});
        } else {
          await execute(db,script);
          await hold(await materialized.readRestoredMaterializedDatabase(db));
        }
      });
      result={ok:true,restored:await cold.restoreColdDatabase(request.anchor,request.binding),pid:process.pid};
    }
  } catch (error) { result={ok:false,error:error instanceof Error ? error.message : String(error),pid:process.pid}; }
  finally { vi.restoreAllMocks(); }
  save('result',result);
  expect(result).toHaveProperty('ok');
},180_000);
