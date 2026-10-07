// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { requireSyntheticPrivateGuards } from './syntheticPrivateGuards';
import { requireSyntheticCatalogFence } from './syntheticOriginalCatalog';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const errorRecord=(error:unknown) => {const e=error as {code?:string;message?:string}; return {code:e.code,message:e.message};};
const lease='local_product_terminal.lease' as const;
const mutation='ALTER FUNCTION local_product_terminal.immutable() COST 101';
async function exactWitness(db:Awaited<ReturnType<typeof createDisposablePostgres>>) {
  const state=await preactivationWitness(db),catalog:Record<string,unknown>={};
  for (const [name,sql] of Object.entries({
    namespaces:"SELECT to_jsonb(n) AS v FROM pg_namespace n WHERE nspname LIKE 'local_%' ORDER BY oid",
    relations:"SELECT to_jsonb(c) AS v FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname LIKE 'local_%' ORDER BY c.oid",
    functions:"SELECT to_jsonb(p) AS v FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE nspname LIKE 'local_%' ORDER BY p.oid",
    roles:'SELECT oid,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolconnlimit,rolvaliduntil,rolbypassrls,rolconfig FROM pg_roles ORDER BY oid',
    memberships:'SELECT to_jsonb(m) AS v FROM pg_auth_members m ORDER BY oid',
  })) catalog[name]=(await db.owner.query(sql)).rows;
  const system=(await db.owner.query('SELECT (pg_control_system()).system_identifier::text AS id')).rows[0].id;
  const originals=Object.fromEntries(readdirSync('.synthetic-original-catalog').filter(n => n.startsWith(system+'-')).sort().map(n =>
    [n,Object.fromEntries(readdirSync(`.synthetic-original-catalog/${n}`).sort().map(f => [f,readFileSync(`.synthetic-original-catalog/${n}/${f}`,'utf8')]))]));
  return {state,catalog,originals};
}
suite('Task21 synthetic successor native transaction fence',() => {
  it('refuses a concurrent catalog contender before it can trap the admitted transaction in an upgrade wait',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('SUCCESSOR_FENCE_PG',JSON.stringify({runId:db.runId,evidence:db.evidence}));
    try {
      const pin=await initializeTerminalCoordinator(db,randomUUID()),before=await exactWitness(db);
      const a=await db.owner.connect(),b=await db.owner.connect();
      let contenderError:unknown,mutationError:unknown,mutationRows:number|null=null;
      let contenders:unknown,ownerLocks:unknown;
      try {
        await a.query("BEGIN; SET LOCAL lock_timeout='400ms'; SET LOCAL statement_timeout='3000ms'");
        await requireSyntheticPrivateGuards(a,lease);
        const apid=(await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await b.query("BEGIN; SET LOCAL lock_timeout='400ms'; SET LOCAL statement_timeout='3000ms'");
        const bpid=(await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        try {await requireSyntheticPrivateGuards(b,lease);} catch (e) {contenderError=errorRecord(e);}
        contenders=(await a.query(`SELECT pid,state,xact_start IS NOT NULL AS transaction_live FROM pg_stat_activity
          WHERE pid=ANY($1) ORDER BY pid`,[[apid,bpid]])).rows;
        ownerLocks=(await a.query(`SELECT pid,relation::regclass::text AS relation,mode,granted FROM pg_locks
          WHERE pid=ANY($1) AND relation IN ('pg_catalog.pg_namespace'::regclass,'pg_catalog.pg_proc'::regclass,
          'local_product_terminal.lease'::regclass) ORDER BY pid,relation::regclass::text,mode`,[[apid,bpid]])).rows;
        // A real same-transaction catalog upgrade, not a synthetic exception.
        // The existing SHARE/SHARE admission lets B retain catalog locks while
        // A owns the public/private transaction; A can no longer perform DDL.
        // Rollback-only fixture corruption never edits a role or its grants.
        try {mutationRows=(await a.query(mutation)).rowCount;} catch (e) {mutationError=errorRecord(e);}
      } finally {await b.query('ROLLBACK'); await a.query('ROLLBACK'); b.release(); a.release();}
      const after=await exactWitness(db);
      save(id,'concurrent-catalog-admission',{pin,before,after,contenderAccepted:contenderError===undefined,
        contenderError,mutationError,mutationRows,contenders,ownerLocks,successorAccepted:false,grantEnrolled:false});
      expect(after).toEqual(before);
      expect(contenderError,'a live catalog transaction must exclude another contender').toMatchObject({code:'55P03'});
      expect(mutationError,'the denied contender must not retain locks that block the owner').toBeUndefined();
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it.each(['COMMIT','ROLLBACK'] as const)('retains exclusive catalog admission until %s and admits a fresh exact retry afterwards',async end => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('SUCCESSOR_FENCE_PG',JSON.stringify({runId:db.runId,evidence:db.evidence}));
    try {
      const owner=randomUUID(),pin=await initializeTerminalCoordinator(db,owner),before=await exactWitness(db);
      const a=await db.owner.connect(),b=await db.owner.connect();
      let refused:unknown,original:unknown,retry:unknown,locks:unknown;
      try {
        await a.query('BEGIN'); await requireSyntheticPrivateGuards(a,lease);
        original=(await a.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        await requireSyntheticPrivateGuards(a,lease); // Reentrant, not a new grant.
        locks=(await a.query(`SELECT relation::regclass::text AS relation,mode,granted FROM pg_locks
          WHERE pid=pg_backend_pid() AND relation IN ('pg_catalog.pg_namespace'::regclass,'pg_catalog.pg_proc'::regclass,
          'pg_catalog.pg_authid'::regclass,'local_product_terminal.lease'::regclass) ORDER BY relation::regclass::text,mode`)).rows;
        await b.query("BEGIN; SET LOCAL lock_timeout='400ms'");
        try {await requireSyntheticCatalogFence(b);} catch (e) {refused=errorRecord(e);}
        await b.query('ROLLBACK');
        await a.query(end);
        await b.query('BEGIN'); await requireSyntheticPrivateGuards(b,lease);
        retry=(await b.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        await b.query('COMMIT');
      } finally {await b.query('ROLLBACK'); await a.query('ROLLBACK'); b.release(); a.release();}
      const after=await exactWitness(db),pinRetry=await initializeTerminalCoordinator(db,owner);
      save(id,'catalog-lifetime',{end,pin,pinRetry,before,after,refused,original,retry,locks,grantEnrolled:false,successorAccepted:false});
      expect(refused).toMatchObject({code:'55P03'}); expect(retry).not.toEqual(original);
      expect(locks).toContainEqual({relation:'pg_namespace',mode:'ShareRowExclusiveLock',granted:true});
      for (const relation of ['pg_proc','pg_authid','local_product_terminal.lease']) expect(locks).toContainEqual({relation,mode:'ShareLock',granted:true});
      expect(pinRetry).toEqual(pin); expect(after).toEqual(before); expect(await exactWitness(db)).toEqual(before);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it('releases the native fence after exact owned backend death with aborted DML and no publication',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('SUCCESSOR_FENCE_PG',JSON.stringify({runId:db.runId,evidence:db.evidence}));
    try {
      await db.owner.query('CREATE TABLE public.successor_fence_probe(value text)');
      const owner=randomUUID(),pin=await initializeTerminalCoordinator(db,owner),before=await exactWitness(db);
      const a=await db.owner.connect(),errors:unknown[]=[];
      const onError=(e:Error) => {errors.push(errorRecord(e));}; a.on('error',onError);
      const ended=new Promise<void>(done => {a.once('end',done);});
      let backend:{pid:number;xid:string}|undefined,uncommitted:unknown,terminated:unknown,live:unknown;
      try {
        await a.query('BEGIN'); await requireSyntheticPrivateGuards(a,lease);
        backend=(await a.query('SELECT pg_backend_pid() AS pid,pg_current_xact_id()::text AS xid')).rows[0];
        await a.query("INSERT INTO public.successor_fence_probe VALUES('uncommitted'); CREATE TABLE local_product_terminal.unpublished_fence_probe(value text)");
        uncommitted=(await a.query('SELECT * FROM public.successor_fence_probe')).rows;
        live=(await db.owner.query('SELECT pid,state FROM pg_stat_activity WHERE pid=$1',[backend!.pid])).rows;
        expect(await exactWitness(db)).toEqual(before);
        // Only the exact backend just acquired by THIS fresh test is terminated.
        // This is native transaction death, not an application/host-loss claim.
        terminated=(await db.owner.query('SELECT pg_terminate_backend($1) AS terminated',[backend!.pid])).rows;
        const deadline=Date.now()+30_000;
        while ((await db.owner.query('SELECT pid FROM pg_stat_activity WHERE pid=$1',[backend!.pid])).rows.length) {
          if (Date.now()>deadline) throw new Error('Owned native fence backend still present');
          await new Promise(done => setTimeout(done,25));
        }
      } finally {a.release(true); await ended; a.removeListener('error',onError);}
      const status=(await db.owner.query('SELECT pg_xact_status($1::xid8) AS status',[backend!.xid])).rows;
      const after=await exactWitness(db),retry=await initializeTerminalCoordinator(db,owner);
      save(id,'catalog-backend-death',{pin,before,after,backend,live,uncommitted,terminated,status,errors,retry,grantEnrolled:false,successorAccepted:false});
      expect(uncommitted).toEqual([{value:'uncommitted'}]); expect(live).toEqual([{pid:backend!.pid,state:'idle in transaction'}]);
      expect(terminated).toEqual([{terminated:true}]); expect(status).toEqual([{status:'aborted'}]);
      expect(after).toEqual(before); expect(retry).toEqual(pin); expect(await exactWitness(db)).toEqual(before);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it('refuses a wrong session role without publishing or changing account permissions',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('SUCCESSOR_FENCE_PG',JSON.stringify({runId:db.runId,evidence:db.evidence}));
    try {
      await initializeTerminalCoordinator(db,randomUUID()); const before=await exactWitness(db),q=await db.runtime.connect();
      let denied:unknown;
      try {await q.query('BEGIN'); try {await requireSyntheticCatalogFence(q);} catch (e) {denied=errorRecord(e);}}
      finally {await q.query('ROLLBACK'); q.release();}
      const after=await exactWitness(db); save(id,'catalog-wrong-role',{before,after,denied,grantEnrolled:false});
      expect(denied).toMatchObject({code:'42501'}); expect(after).toEqual(before);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it('revalidates ORIGINAL after same-transaction post-admission mutation rather than caching admission',async () => {
    const db=await createDisposablePostgres(),id=randomUUID();
    console.info('SUCCESSOR_FENCE_PG',JSON.stringify({runId:db.runId,evidence:db.evidence}));
    try {
      const owner=randomUUID(),pin=await initializeTerminalCoordinator(db,owner),before=await exactWitness(db),q=await db.owner.connect();
      let denied:unknown,changed:unknown;
      try {
        await q.query('BEGIN'); await requireSyntheticPrivateGuards(q,lease); await q.query(mutation);
        changed=(await q.query("SELECT procost FROM pg_proc WHERE oid='local_product_terminal.immutable()'::regprocedure")).rows;
        try {await requireSyntheticPrivateGuards(q,lease);} catch (e) {denied=errorRecord(e);}
      } finally {await q.query('ROLLBACK'); q.release();}
      const after=await exactWitness(db),retry=await initializeTerminalCoordinator(db,owner);
      save(id,'catalog-post-admission-mutation',{pin,before,after,changed,denied,retry,grantEnrolled:false,successorAccepted:false});
      expect(changed).toEqual([{procost:101}]); expect(denied).toMatchObject({message:'Synthetic ORIGINAL catalog prerequisite refused.'});
      expect(after).toEqual(before); expect(retry).toEqual(pin); expect(await exactWitness(db)).toEqual(before);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
});
