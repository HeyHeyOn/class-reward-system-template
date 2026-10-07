// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { initializeTerminalCoordinator } from './syntheticProductTerminal';
import { requireSyntheticPrivateGuards } from './syntheticPrivateGuards';
import { preactivationWitness } from '../../../test-support/sealedPreactivationHarness';
import { save } from '../../../test-support/sealedCrashHarness';
vi.mock('server-only',() => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
const lease='local_product_terminal.lease' as const;
const errorRecord=(e:unknown) => {const x=e as {code?:string;message?:string}; return {code:x.code,message:x.message};};
async function originals(system:string) {
  return Object.fromEntries(readdirSync('.synthetic-original-catalog').filter(n => n.startsWith(system+'-')).sort().map(n =>
    [n,Object.fromEntries(readdirSync(`.synthetic-original-catalog/${n}`).sort().map(f => [f,readFileSync(`.synthetic-original-catalog/${n}/${f}`,'utf8')]))]));
}
suite('Task21 effective native catalog resolution fence',() => {
  it('rechecks effective resolution after same-transaction admission instead of caching a clean path',async () => {
    const db=await createDisposablePostgres(),id=randomUUID(),owner=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,owner),before=await preactivationWitness(db),q=await db.owner.connect();
      let denied:unknown;
      try {
        await q.query('BEGIN'); await requireSyntheticPrivateGuards(q,lease);
        await q.query('CREATE TEMP TABLE pg_proc AS SELECT * FROM pg_catalog.pg_proc');
        try {await requireSyntheticPrivateGuards(q,lease);} catch (e) {denied=errorRecord(e);}
      } finally {await q.query('ROLLBACK'); q.release(true);}
      const after=await preactivationWitness(db),retry=await initializeTerminalCoordinator(db,owner);
      save(id,'late-resolution-change',{pin,before,after,denied,retry});
      expect(after).toEqual(before); expect(retry).toEqual(pin);
      expect(denied).toMatchObject({message:'Synthetic ORIGINAL catalog prerequisite refused.'});
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it('does not reject a clean owner because an independent session has a private temporary catalog',async () => {
    const db=await createDisposablePostgres(),id=randomUUID(),owner=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,owner),before=await preactivationWitness(db);
      const a=await db.owner.connect(),b=await db.owner.connect(); let aPath:unknown,bPath:unknown;
      try {
        await b.query('CREATE TEMP TABLE pg_proc AS SELECT * FROM pg_catalog.pg_proc');
        bPath=(await b.query('SELECT pg_catalog.current_schemas(true)::text[] AS schemas')).rows[0].schemas;
        await a.query('BEGIN'); await requireSyntheticPrivateGuards(a,lease);
        aPath=(await a.query('SELECT pg_catalog.current_schemas(true)::text[] AS schemas')).rows[0].schemas;
        await a.query('COMMIT');
      } finally {await a.query('ROLLBACK'); a.release(true); b.release(true);}
      const after=await preactivationWitness(db),retry=await initializeTerminalCoordinator(db,owner);
      save(id,'other-session-temporary-catalog',{pin,before,after,aPath,bPath,retry});
      expect(aPath).toEqual(['pg_catalog','public']); expect(bPath).not.toEqual(aPath);
      expect(after).toEqual(before); expect(retry).toEqual(pin);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it.each(['pg_proc','pg_trigger'] as const)('refuses an implicit temporary %s copy hiding real native immutability loss',async shadow => {
    const db=await createDisposablePostgres(),id=randomUUID(),owner=randomUUID();
    console.info('RESOLUTION_FENCE_PG',JSON.stringify({runId:db.runId,evidence:db.evidence}));
    try {
      const pin=await initializeTerminalCoordinator(db,owner),before=await preactivationWitness(db),original=await originals(pin.systemIdentifier);
      const q=await db.owner.connect(); let denied:unknown,admitted=false,unauthorizedUpdate:unknown=null,mode:unknown,native:unknown,locks:unknown;
      try {
        await q.query('BEGIN');
        // Default search_path is unchanged. PostgreSQL implicitly resolves
        // relations through pg_temp BEFORE pg_catalog, unlike function lookup.
        await q.query(`CREATE TEMP TABLE ${shadow} AS SELECT * FROM pg_catalog.${shadow}`);
        if (shadow==='pg_proc') await q.query(`CREATE OR REPLACE FUNCTION local_product_terminal.immutable()
          RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN OLD; END$$`);
        else await q.query(`ALTER TABLE ${lease} DISABLE TRIGGER USER`);
        mode=(await q.query(`SELECT pg_catalog.current_setting('search_path') AS path,
          pg_catalog.current_schemas(true)::text[] AS schemas,pg_catalog.pg_backend_pid() AS pid`)).rows;
        native=shadow==='pg_proc'
          ? (await q.query("SELECT prosrc FROM pg_catalog.pg_proc WHERE oid='local_product_terminal.immutable()'::regprocedure")).rows
          : (await q.query(`SELECT tgname,tgenabled FROM pg_catalog.pg_trigger WHERE tgrelid=$1::regclass ORDER BY tgname`,[lease])).rows;
        try {await requireSyntheticPrivateGuards(q,lease); admitted=true;} catch (e) {denied=errorRecord(e);}
        locks=(await q.query(`SELECT relation::regclass::text AS relation,mode FROM pg_catalog.pg_locks
          WHERE pid=pg_catalog.pg_backend_pid() AND mode IN ('ShareLock','ShareRowExclusiveLock')
          AND relation IN ('pg_catalog.pg_proc'::regclass,'pg_catalog.pg_namespace'::regclass) ORDER BY relation,mode`)).rows;
        // RED-only witness: a passed guard really permits the native forbidden
        // UPDATE. Roll back everything; never publish this forged admission.
        if (admitted) unauthorizedUpdate=(await q.query(`UPDATE ${lease} SET payload=payload RETURNING xmin::text,ctid::text`)).rows;
      } finally {await q.query('ROLLBACK'); q.release(true);}
      const after=await preactivationWitness(db),retry=await initializeTerminalCoordinator(db,owner);
      save(id,'implicit-catalog-shadow',{shadow,pin,before,after,original,originalAfter:await originals(pin.systemIdentifier),
        mode,native,admitted,denied,unauthorizedUpdate,locks,retry,grantEnrolled:false,successorAccepted:false});
      expect(after).toEqual(before); expect(await originals(pin.systemIdentifier)).toEqual(original); expect(retry).toEqual(pin);
      expect(admitted,'a temporary catalog copy must not authenticate a changed native guard').toBe(false);
      expect(denied).toMatchObject({message:'Synthetic ORIGINAL catalog prerequisite refused.'});
      expect(unauthorizedUpdate).toBeNull(); expect(locks).toEqual([]);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
  it('keeps original identity across same-transaction reentry, clean sessions and exact retries',async () => {
    const db=await createDisposablePostgres(),id=randomUUID(),owner=randomUUID();
    try {
      const pin=await initializeTerminalCoordinator(db,owner),before=await preactivationWitness(db),original=await originals(pin.systemIdentifier),sessions=[];
      for (const end of ['COMMIT','ROLLBACK']) {
        const q=await db.owner.connect();
        try {
          await q.query('BEGIN'); await requireSyntheticPrivateGuards(q,lease); await requireSyntheticPrivateGuards(q,lease);
          sessions.push((await q.query('SELECT pg_catalog.pg_backend_pid() AS pid,pg_catalog.current_schemas(true)::text[] AS schemas')).rows[0]);
          await q.query(end);
        } finally {await q.query('ROLLBACK'); q.release(true);}
        expect(await initializeTerminalCoordinator(db,owner)).toEqual(pin);
      }
      const after=await preactivationWitness(db);
      save(id,'resolution-positive',{pin,before,after,sessions,original,originalAfter:await originals(pin.systemIdentifier)});
      expect(sessions[0].pid).not.toBe(sessions[1].pid);
      for (const session of sessions) expect(session.schemas).toEqual(['pg_catalog','public']);
      expect(after).toEqual(before); expect(await originals(pin.systemIdentifier)).toEqual(original);
    } finally {const closed=await db.close(); save(id,'cleanup',closed); expect(closed.containerRemoved).toBe(true);}
  },120_000);
});
