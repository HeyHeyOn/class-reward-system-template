// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { requireSyntheticPrivateGuards } from './syntheticPrivateGuards';
import { createTerminalSchema, insertTerminalRecord } from './syntheticProductTerminalState';
import { enrollSyntheticOriginalCatalog, requireSyntheticCatalogFence } from './syntheticOriginalCatalog';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const replacement='CREATE OR REPLACE FUNCTION local_product_terminal.immutable() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$';
const errorRecord=(e:unknown) => {const x=e as {code?:string;message?:string}; return {code:x.code,message:x.message};};
async function exactWitness(db:Awaited<ReturnType<typeof createDisposablePostgres>>) {
  const state=await preactivationWitness(db),catalog:Record<string,unknown>={};
  for (const [name,sql] of Object.entries({
    schemas:"SELECT to_jsonb(n) AS v FROM pg_namespace n WHERE nspname LIKE 'local_%' ORDER BY oid",
    relations:"SELECT to_jsonb(c) AS v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname LIKE 'local_%' ORDER BY c.oid",
    columns:"SELECT to_jsonb(a) AS v FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname LIKE 'local_%' ORDER BY a.attrelid,a.attnum",
    constraints:"SELECT to_jsonb(c) AS v FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE nspname LIKE 'local_%' ORDER BY c.oid",
    functions:"SELECT to_jsonb(p) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE nspname LIKE 'local_%' ORDER BY p.oid",
    eventTriggers:'SELECT to_jsonb(e) AS v FROM pg_event_trigger e ORDER BY oid',
    languageFunctions:'SELECT to_jsonb(p) AS v FROM pg_proc p WHERE oid IN (SELECT lanplcallfoid FROM pg_language UNION SELECT laninline FROM pg_language UNION SELECT lanvalidator FROM pg_language) ORDER BY oid',
    triggers:"SELECT to_jsonb(t) AS v FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname LIKE 'local_%' ORDER BY t.oid",
  })) catalog[name]=(await db.owner.query(sql)).rows;
  const system=(await db.owner.query('SELECT (pg_control_system()).system_identifier::text AS id')).rows[0].id;
  const originals=Object.fromEntries(readdirSync('.synthetic-original-catalog').filter(n => n.startsWith(system+'-')).sort().map(n =>
    [n,Object.fromEntries(readdirSync(`.synthetic-original-catalog/${n}`).sort().map(f => [f,readFileSync(`.synthetic-original-catalog/${n}/${f}`,'utf8')]))]));
  return {state,catalog,originals,grantEnrolled:false,successorAccepted:false};
}
suite('Task21 ORIGINAL catalog fence',() => {
  it('refuses a FIFO ORIGINAL without waiting for a writer or changing admitted state',async () => {
    const db=await createDisposablePostgres(),id=randomUUID(),owner=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,owner),before=await exactWitness(db);
      const bucket=readdirSync('.synthetic-original-catalog').find(s => s.startsWith(pin.systemIdentifier+'-')
        && s.endsWith('-local_product_terminal.lease'))!;
      const path='.synthetic-original-catalog/'+bucket+'/'+readdirSync('.synthetic-original-catalog/'+bucket)[0];
      const held='.synthetic-original-catalog/.held-'+id+'.json',original=readFileSync(path);
      renameSync(path,held);
      let timer:ReturnType<typeof setTimeout>|undefined,writer:number|undefined;
      let result:{accepted:boolean;error?:ReturnType<typeof errorRecord>}|undefined,waitingForWriter=false;
      try {
        // Only this freshly generated fixture is faulted. O_NONBLOCK must allow
        // fstat's regular-file rejection before an invalid FIFO can block open.
        execFileSync('mkfifo',['-m','600',path]);
        const attempt=initializeTerminalCoordinator(db,owner).then(() => ({accepted:true}),
          error => ({accepted:false,error:errorRecord(error)}));
        const first=await Promise.race([attempt,new Promise<null>(done => {timer=setTimeout(() => done(null),5000);})]);
        waitingForWriter=first===null;
        // RED-only teardown: keep a writer open so a defective reader unwinds
        // its transaction. This is not a production fallback or a passing retry.
        if (waitingForWriter) writer=openSync(path,constants.O_RDWR|constants.O_NONBLOCK);
        result=await attempt;
      } finally {
        if (timer!==undefined) clearTimeout(timer);
        if (writer!==undefined) closeSync(writer);
        if (existsSync(path)) unlinkSync(path);
        renameSync(held,path);
      }
      const after=await exactWitness(db),retry=await initializeTerminalCoordinator(db,owner);
      save(id,'fifo-original',{pin,waitingForWriter,result,before,after,retry});
      expect(result).toMatchObject({accepted:false,error:{message:'Synthetic ORIGINAL catalog prerequisite refused.'}});
      expect(after).toEqual(before); expect(readFileSync(path)).toEqual(original); expect(retry).toEqual(pin);
      expect(await exactWitness(db)).toEqual(before);
      expect(waitingForWriter,'invalid ORIGINAL must be refused before waiting for a FIFO writer').toBe(false);
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
  it('refuses shadowed session search_path without executing a catalog lookalike or advancing a sequence',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    try {
      await initializeTerminalCoordinator(db,randomUUID());
      await db.owner.query(`CREATE SEQUENCE public.catalog_entry_probe;
        CREATE FUNCTION public.current_setting(text) RETURNS text LANGUAGE plpgsql AS $$BEGIN
          PERFORM pg_catalog.nextval('public.catalog_entry_probe'); RETURN pg_catalog.current_setting($1); END$$`);
      const before=(await db.owner.query('SELECT last_value::text,is_called FROM public.catalog_entry_probe')).rows;
      const q=await db.owner.connect(); let denied:unknown;
      try {
        await q.query('BEGIN; SET LOCAL search_path=public,pg_catalog');
        try {await requireSyntheticCatalogFence(q);} catch (e) {denied=errorRecord(e);}
      } finally {await q.query('ROLLBACK'); q.release();}
      const after=(await db.owner.query('SELECT last_value::text,is_called FROM public.catalog_entry_probe')).rows;
      save(id,'search-path-entry',{before,after,denied}); expect(denied).toBeDefined(); expect(after).toEqual(before);
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
  it('fails closed on a missing ORIGINAL directory without recreating authority evidence',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,randomUUID()),before=await exactWitness(db);
      const bucket=readdirSync('.synthetic-original-catalog').find(s => s.startsWith(pin.systemIdentifier+'-'))!;
      const path='.synthetic-original-catalog/'+bucket; renameSync(path,path+'.lost');
      const q=await db.owner.connect(); let denied:unknown,recreated=false;
      try {
        await q.query('BEGIN');
        try {await requireSyntheticPrivateGuards(q,'local_product_terminal.lease');} catch (e) {denied=errorRecord(e);}
        recreated=existsSync(path);
      } finally {await q.query('ROLLBACK'); q.release(); if (existsSync(path)) rmdirSync(path); renameSync(path+'.lost',path);}
      const after=await exactWitness(db); save(id,'missing-original-directory',{before,after,denied,recreated});
      expect(denied).toBeDefined(); expect(recreated).toBe(false); expect(after).toEqual(before);
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
  it.each(['COMMIT','ROLLBACK'] as const)('blocks native replacement/alter/drop until original %s',async end => {
    for (const ddl of [replacement,'ALTER FUNCTION local_product_terminal.immutable() SET search_path=public',
      'DROP FUNCTION local_product_terminal.immutable() CASCADE','ALTER TABLE local_product_terminal.lease DROP CONSTRAINT lease_singleton_check',
      'GRANT USAGE ON SCHEMA local_product_terminal TO app_runtime','GRANT EXECUTE ON FUNCTION local_product_terminal.immutable() TO app_runtime']) {
      const db=await createDisposablePostgres(),id=randomUUID();
      try {
        const pin=await initializeTerminalCoordinator(db,randomUUID()),before=await exactWitness(db);
        const a=await db.owner.connect(),b=await db.owner.connect(); let pending:Promise<unknown>|undefined,bReleased=false;
        try {
          await a.query('BEGIN'); await requireSyntheticPrivateGuards(a,'local_product_terminal.lease');
          const aid=(await a.query('SELECT pg_backend_pid() AS id')).rows[0].id;
          await b.query("BEGIN; SET LOCAL lock_timeout='8000ms'; SET LOCAL statement_timeout='10000ms'");
          const bid=(await b.query('SELECT pg_backend_pid() AS id')).rows[0].id;
          let finished=false;
          pending=b.query(ddl).then(r => {finished=true; return {rowCount:r.rowCount};},e => {finished=true; return {error:errorRecord(e)};});
          const deadline=Date.now()+5000; let blocked:Record<string,unknown>[]=[];
          while (Date.now()<deadline) {
            blocked=(await a.query('SELECT pid,pg_blocking_pids(pid) AS blockers,state,wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1',[bid])).rows;
            if ((blocked[0]?.blockers as number[]).includes(aid) || finished) break;
            await new Promise(done => setTimeout(done,20));
          }
          // Read through the lock-owning connection: a third observer may queue
          // behind DROP's pending AccessExclusiveLock and invalidate the barrier.
          const whileBlocked=(await a.query('SELECT to_jsonb(t)::text AS wire,xmin::text,ctid::text FROM local_product_terminal.lease t ORDER BY to_jsonb(t)::text')).rows;
          expect(finished).toBe(false); expect(blocked[0].blockers).toContain(aid);
          expect(whileBlocked).toEqual(JSON.parse(readFileSync(before.state.path,'utf8')).sql['local_product_terminal.lease']);
          await a.query(end); const result=await pending; await b.query('COMMIT'); b.release(); bReleased=true;
          const after=await exactWitness(db);
          save(id,'transaction-lifetime',{pin,ddl,end,aid,bid,blocked,before,whileBlocked,result,after});
          expect(result).not.toHaveProperty('error'); expect(after.catalog).not.toEqual(before.catalog);
          expect(after.originals).toEqual(before.originals);
        } finally {await a.query('ROLLBACK'); if (pending) await pending; if (!bReleased) {await b.query('ROLLBACK'); b.release();} a.release();}
      } finally {save(id,'cleanup',await db.close());}
    }
  },240_000);
  it('reconciles aborted enrollment append-only; refuses late/repeated enrollment, missing baseline and weak privilege',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,randomUUID()),before=await exactWitness(db);
      const q=await db.owner.connect();
      try {
        await q.query('BEGIN'); await createTerminalSchema(q,'local_product_terminal');
        await insertTerminalRecord(q,'local_product_terminal.seal',{pin}); await q.query('ROLLBACK');
        const aborted=await exactWitness(db);
        expect(aborted.state).toEqual(before.state); expect(aborted.catalog).toEqual(before.catalog);
        await q.query('BEGIN'); await insertTerminalRecord(q,'local_product_terminal.seal',{pin}); await q.query('COMMIT');
        const committed=await exactWitness(db);
        for (const [name,files] of Object.entries(aborted.originals)) for (const [file,bytes] of Object.entries(files)) expect(committed.originals[name][file]).toBe(bytes);
        await q.query('BEGIN'); await requireSyntheticPrivateGuards(q,'local_product_terminal.seal');
        await expect(enrollSyntheticOriginalCatalog(q,'local_product_terminal.seal',{pin})).rejects.toThrow(); await q.query('ROLLBACK');
        const lease=Object.keys(committed.originals).find(n => n.endsWith('-local_product_terminal.lease'))!;
        const path=`.synthetic-original-catalog/${lease}`,file=Object.keys(committed.originals[lease])[0];
        renameSync(`${path}/${file}`,`${path}/${file}.missing`);
        try {
          await q.query('BEGIN'); await expect(requireSyntheticPrivateGuards(q,'local_product_terminal.lease')).rejects.toThrow(); await q.query('ROLLBACK');
        } finally {renameSync(`${path}/${file}.missing`,`${path}/${file}`);}
        const runtime=await db.runtime.connect(); let denied:unknown;
        try {
          await runtime.query('BEGIN');
          try {await requireSyntheticCatalogFence(runtime);} catch (e) {denied=errorRecord(e);}
          expect(denied).toMatchObject({code:'42501'});
        } finally {await runtime.query('ROLLBACK'); runtime.release();}
        await expect(requireSyntheticCatalogFence(q)).rejects.toMatchObject({code:'25P01'});
        await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); await expect(requireSyntheticCatalogFence(q)).rejects.toThrow(); await q.query('ROLLBACK');
        const after=await exactWitness(db); expect(after).toEqual(committed);
        save(id,'enrollment-reconciliation',{pin,before,aborted,committed,after,denied});
        await q.query('DROP TABLE local_product_terminal.seal');
        const removed=await exactWitness(db);
        await q.query('BEGIN');
        await expect(insertTerminalRecord(q,'local_product_terminal.seal',{pin})).rejects.toThrow();
        await q.query('ROLLBACK'); const rejectedRecreation=await exactWitness(db);
        expect(rejectedRecreation).toEqual(removed);
        save(id,'no-reenrollment',{removed,rejectedRecreation});
      } finally {await q.query('ROLLBACK'); q.release();}
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
  it('refuses schema ACL, function ACL, constraints and column drift against creation ORIGINAL',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    try {
      await initializeTerminalCoordinator(db,randomUUID());
      const before=await exactWitness(db),results=[];
      for (const sql of [
        'GRANT USAGE ON SCHEMA local_product_terminal TO app_runtime',
        'GRANT EXECUTE ON FUNCTION local_product_terminal.immutable() TO app_runtime',
        'GRANT SELECT ON local_product_terminal.lease TO app_runtime',
        'ALTER SCHEMA local_product_terminal OWNER TO app_runtime',
        'ALTER TABLE local_product_terminal.lease OWNER TO app_runtime',
        'ALTER FUNCTION local_product_terminal.immutable() OWNER TO app_runtime',
        'ALTER TABLE local_product_terminal.lease DROP CONSTRAINT lease_singleton_check',
        'ALTER TABLE local_product_terminal.lease ALTER COLUMN payload DROP NOT NULL',
        'ALTER FUNCTION local_product_terminal.immutable() SET search_path=public',
        'ALTER FUNCTION local_product_terminal.immutable() SECURITY DEFINER',
        `CREATE FUNCTION public.catalog_event() RETURNS event_trigger LANGUAGE plpgsql AS $$BEGIN NULL; END$$;
          CREATE EVENT TRIGGER catalog_event ON ddl_command_start EXECUTE FUNCTION public.catalog_event()`,
        'ALTER FUNCTION pg_catalog.plpgsql_call_handler() COST 101',
        replacement,
        'ALTER TABLE local_product_terminal.lease DISABLE TRIGGER immutable',
        'DROP TRIGGER immutable ON local_product_terminal.lease; CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON local_product_terminal.lease FOR EACH ROW WHEN (false) EXECUTE FUNCTION local_product_terminal.immutable()',
        `ALTER TABLE local_product_terminal.lease DISABLE TRIGGER immutable;
          UPDATE local_product_terminal.lease SET payload='{}',digest='forged owner/chain identity';
          ALTER TABLE local_product_terminal.lease ENABLE TRIGGER immutable`,
      ]) {
        const q=await db.owner.connect(); let error:unknown;
        try {
          await q.query('BEGIN'); await q.query(sql);
          try {await requireSyntheticPrivateGuards(q,'local_product_terminal.lease');} catch (e) {error=errorRecord(e);}
        } finally {await q.query('ROLLBACK'); q.release();}
        const after=await exactWitness(db); expect(after).toEqual(before); results.push({sql,error,after});
      }
      save(id,'drift-red',{before,results});
      expect(results.filter(r => !r.error),'drift admitted').toEqual([]);
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
  it('native capability: catalog SHARE lock excludes function replacement without server changes',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('CATALOG_PG',JSON.stringify(db.evidence));
    try {
      await initializeTerminalCoordinator(db,randomUUID());
      const a=await db.owner.connect(),b=await db.owner.connect();
      let lockError:unknown,ddlError:unknown,locks:unknown,privilege:unknown;
      try {
        privilege=(await a.query("SELECT current_user,session_user,current_setting('allow_system_table_mods') AS allow_system_table_mods,rolsuper FROM pg_roles WHERE rolname=current_user")).rows;
        await a.query('BEGIN');
        try {await a.query('LOCK TABLE pg_catalog.pg_proc IN SHARE MODE');}
        catch (e) {lockError=errorRecord(e);}
        if (!lockError) {
          locks=(await a.query("SELECT mode,granted,relation::regclass::text AS relation FROM pg_locks WHERE pid=pg_backend_pid() AND relation='pg_catalog.pg_proc'::regclass")).rows;
          await b.query("BEGIN; SET LOCAL lock_timeout='300ms'; SET LOCAL statement_timeout='1500ms'");
          try {await b.query(replacement); await b.query('COMMIT');} catch (e) {ddlError=errorRecord(e);}
        }
        save(id,'native-capability',{privilege,locks,lockError,ddlError,serverConfigurationChanged:false,grantEnrolled:false});
        expect(lockError).toBeUndefined(); expect(ddlError).toMatchObject({code:'55P03'});
      } finally {await a.query('ROLLBACK'); await b.query('ROLLBACK'); a.release(); b.release();}
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
  it('admission retains native exclusion until the original transaction ends',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('CATALOG_PG',JSON.stringify(db.evidence));
    try {
      const pin=await initializeTerminalCoordinator(db,randomUUID());
      const before=await preactivationWitness(db);
      const definition=(await db.owner.query("SELECT pg_get_functiondef('local_product_terminal.immutable()'::regprocedure) AS ddl")).rows[0].ddl;
      const a=await db.owner.connect();
      try {
        await a.query('BEGIN'); await requireSyntheticPrivateGuards(a,'local_product_terminal.lease');
        const backend=(await a.query('SELECT pg_backend_pid() AS pid,txid_current()::text AS xid')).rows[0];
        const locks=(await db.owner.query("SELECT mode,granted,relation::regclass::text AS relation FROM pg_locks WHERE pid=$1 AND relation IN ('local_product_terminal.lease'::regclass,'pg_catalog.pg_proc'::regclass) ORDER BY relation::regclass::text,mode",[backend.pid])).rows;
        expect(locks).toContainEqual({mode:'ShareLock',granted:true,relation:'local_product_terminal.lease'});
        const b=await db.owner.connect(); let ddlError:unknown,ddlCommitted=false,updateRows:number|null=null,updateError:unknown;
        try {
          await b.query("BEGIN; SET LOCAL lock_timeout='300ms'; SET LOCAL statement_timeout='1500ms'");
          try {await b.query(replacement); await b.query('COMMIT'); ddlCommitted=true;} catch (e) {ddlError=errorRecord(e);}
        } finally {await b.query('ROLLBACK'); b.release();}
        const activity=(await db.owner.query('SELECT pid,state FROM pg_stat_activity WHERE pid=$1',[backend.pid])).rows;
        const afterDDL=await preactivationWitness(db);
        try {updateRows=(await a.query('UPDATE local_product_terminal.lease SET payload=payload')).rowCount;}
        catch (e) {updateError=errorRecord(e);}
        await a.query('ROLLBACK');
        const afterRollback=await preactivationWitness(db);
        if (ddlCommitted) await db.owner.query(definition);
        const restored=await preactivationWitness(db);
        save(id,'admission-race',{pin,backend,locks,activity,before,afterDDL,afterRollback,restored,ddlCommitted,ddlError,updateRows,updateError,
          grantEnrolled:false,successorAccepted:false});
        expect(restored).toEqual(before);
        expect(ddlCommitted,'function replacement committed before protected DML').toBe(false);
        expect(ddlError).toMatchObject({code:'55P03'});
        expect(updateError).toMatchObject({code:'P0001'}); expect(updateRows).toBeNull();
      } finally {await a.query('ROLLBACK'); a.release();}
    } finally {save(id,'cleanup',await db.close());}
  },120_000);
});
