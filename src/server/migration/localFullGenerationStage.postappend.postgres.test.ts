// @vitest-environment node
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { deleteFixture, deleteState, cleanupDeleteFixture, TENANT, JOB } from '../../../test-support/task19DeleteFixture';
import { stageLocalFullGeneration } from './localFullGenerationStage';
import { stageLocalFullDeltaCheckedPreparation } from './localFullDeltaCheckedPreparation';

import type { TenantImportTransactionRunner } from './importer';
vi.mock('server-only', () => ({}));
afterEach(cleanupDeleteFixture);
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
type Fixture = Awaited<ReturnType<typeof fixture>>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture() {
  const f = await deleteFixture();
  // Literal independent change contract: P1 changes name/price, PX disappears.
  await f.commitDelete();
  await f.local.owner.query(`UPDATE task19_delete_rows SET cells=jsonb_set(jsonb_set(cells,
    '{1}','"Postappend pencil"'::jsonb),'{2}','"31"'::jsonb)
    WHERE tenant=$1 AND tab='Products' AND cells->>0='P1'`,[TENANT]);
  return {...f, input:f.input(await f.capture())};
}
async function state(f: Fixture) {
  const tables = (await f.source.owner.query(`SELECT tablename FROM pg_tables
    WHERE schemaname='public' ORDER BY tablename`)).rows as {tablename: string}[];
  const image: Record<string, string[]> = {};
  for (const {tablename} of tables) {
    if (!/^[a-z_]+$/.test(tablename)) throw new Error('Unexpected fixture table');
    image[tablename] = (await f.source.owner.query(`SELECT to_jsonb(t)::text AS value
      FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows.map(row => row.value);
  }
  return image;
}
function persist(name: string, value: unknown) {
  mkdirSync('.task19-postappend-results', {recursive:true, mode:0o700});
  const path = `.task19-postappend-results/${name}-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(value), {flag:'wx',mode:0o600});
  console.info('TASK19_POSTAPPEND_WITNESS', JSON.stringify({name,path,sha256:digest(value)}));
}
async function install(f: Fixture, point: 'graph' | 'report', deferred: boolean, fault: 'authority' | 'source' | 'noop') {
  const table = point === 'graph' ? 'migration_full_generations' : 'migration_full_reconciliation';
  const when = point === 'report' ? "WHEN (NEW.category='products')" : '';
  const effect = fault === 'authority' ? `UPDATE public.migration_jobs SET final_fingerprint=repeat('b',64)
    WHERE tenant_id=NEW.tenant_id AND job_id=NEW.migration_job_id;`
    : fault === 'source' ? `INSERT INTO public.migration_full_sources
      (tenant_id,migration_job_id,generation_id,source_ordinal,source_value)
      SELECT NEW.tenant_id,NEW.migration_job_id,NEW.generation_id,
        (SELECT max(source_ordinal)+1 FROM public.migration_full_sources WHERE tenant_id=NEW.tenant_id
          AND migration_job_id=NEW.migration_job_id AND generation_id=NEW.generation_id), source_value
      FROM public.migration_full_sources WHERE tenant_id=NEW.tenant_id
        AND migration_job_id=NEW.migration_job_id AND generation_id=NEW.generation_id
      ORDER BY source_ordinal LIMIT 1;` : '';
  // Sequence is only a nontransactional trigger-reach witness, never an oracle
  // for product acceptance. No immutable trigger, RLS or FK is disabled.
  await f.source.owner.query(`CREATE SEQUENCE task19_postappend_seen;
    CREATE FUNCTION task19_postappend_fault() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path=pg_catalog,public AS $$ BEGIN
      PERFORM nextval('public.task19_postappend_seen'); ${effect} RETURN NEW; END $$;
    CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER task19_postappend_fault AFTER INSERT ON ${table}
      ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW ${when}
      EXECUTE FUNCTION task19_postappend_fault()`);
  return {
    table,
    definition: (await f.source.owner.query(`SELECT pg_get_triggerdef(oid) AS value,tgdeferrable,tginitdeferred
      FROM pg_trigger WHERE tgname='task19_postappend_fault'`)).rows,
    drop: () => f.source.owner.query(`DROP TRIGGER task19_postappend_fault ON ${table}`),
  };
}
function observedRun(f: Fixture) {
  const transactions: unknown[] = [];
  const run: TenantImportTransactionRunner = (tenant, callback) => f.source.runTenantTransaction(tenant, async tx => {
    transactions.push((await tx.execute(sql`SELECT pg_backend_pid() AS pid,txid_current()::text AS xid`)).rows);
    return callback(tx);
  });
  return {run, transactions};
}
async function positive(f: Fixture) {
  const operational = (image: Awaited<ReturnType<typeof state>>) => Object.fromEntries(Object.entries(image)
    .filter(([table]) => !table.startsWith('migration_full_') && table !== 'audit_events'));
  const before = await state(f);
  const result = await stageLocalFullGeneration(f.input, f.source.runTenantTransaction);
  expect(result).toMatchObject({scope:'LOCAL_FULL_MUTABLE_SNAPSHOT', authority:'NONAUTHORITY',
    phase:'LOCAL_CANDIDATE',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN',persistedReadback:'MATCH'});
  // Explicit SQL/literal oracle, not production projector/delta/reconciliation helpers.
  const delta = (await f.source.owner.query(`SELECT target_id,change_kind,
    entry_value#>>'{before,target,name}' AS before_name, entry_value#>>'{after,target,name}' AS after_name,
    entry_value#>>'{after,target,price}' AS after_price,
    entry_value->'after' AS after_image FROM migration_full_delta_entries ORDER BY target_id`)).rows;
  expect(delta.map(({target_id,change_kind,before_name,after_name,after_price}) =>
    ({target_id,change_kind,before_name,after_name,after_price}))).toEqual([
    {target_id:'P1',change_kind:'MUTATED',before_name:'Pencil',after_name:'Postappend pencil',after_price:'31'},
    {target_id:'PX',change_kind:'REMOVED',before_name:'Delete me',after_name:null,after_price:null},
  ]);
  expect(delta[1].after_image).toBeNull();
  expect((await f.source.owner.query(`SELECT target_id,canonical_value->>'name' AS name,
    canonical_value->>'price' AS price FROM migration_full_targets WHERE target_table='products' ORDER BY target_id`)).rows)
    .toEqual([{target_id:'P1',name:'Postappend pencil',price:'31'}]);
  const published = await state(f);
  expect(operational(published)).toEqual(operational(before));
  expect(published.audit_events.filter(row => before.audit_events.includes(row))).toEqual(before.audit_events);
  const replay = await stageLocalFullGeneration(f.input, f.source.runTenantTransaction);
  expect(replay).toEqual(result); expect(await state(f)).toEqual(published);
  await expect(stageLocalFullDeltaCheckedPreparation(f.input, f.source.runTenantTransaction))
    .rejects.toThrow('Local full-delta-checked preparation refused.');
  expect(await state(f)).toEqual(published);
  return {result,delta,published,retryEqual:true,addedOnlyRefused:true};
}

suite('Task19 postappend publication boundary', () => {
  it('accepts a harmless deferred report trigger, exact modified/deleted SQL and deterministic retry', async () => {
    const f = await fixture(); const before = await state(f);
    const trigger = await install(f,'report',true,'noop');
    const control = await positive(f);
    expect((await f.source.owner.query('SELECT last_value::text,is_called FROM task19_postappend_seen')).rows)
      .toEqual([{last_value:'1',is_called:true}]);
    persist('control',{before,after:await state(f),trigger:trigger.definition,...control});
  },120_000);

  it.each([
    ['graph','immediate','authority'],
    ['report','immediate','authority'],
    ['report','deferred','authority'],
    ['report','immediate','source'],
    ['report','deferred','source'],
  ] as const)('rolls back %s %s %s drift before publishing a final candidate', async (point,timing,fault) => {
    const f = await fixture(); const before = await state(f);
    const destinationBefore = await deleteState(f.destination);
    const trigger = await install(f,point,timing==='deferred',fault);
    const observed = observedRun(f);
    let result: unknown, error: unknown;
    try { result = await stageLocalFullGeneration(f.input,observed.run); }
    catch (caught) { error = caught; }
    const after = await state(f);
    const reached = (await f.source.owner.query('SELECT last_value::text,is_called FROM task19_postappend_seen')).rows;
    // Persist native committed BEFORE/AFTER before any assertion, including RED.
    persist(`${point}-${timing}-${fault}`,{before,after,beforeDigest:digest(before),afterDigest:digest(after),
      outcome: error instanceof Error ? error.message : 'RETURNED_CANDIDATE', result,
      trigger:trigger.definition,reached,transactions:observed.transactions,
      destinationUnchanged:JSON.stringify(destinationBefore)===JSON.stringify(await deleteState(f.destination))});
    expect(reached).toEqual([{last_value:'1',is_called:true}]);
    expect(observed.transactions).toHaveLength(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Local full-generation stage refused.');
    expect(result).toBeUndefined(); expect(after).toEqual(before);
    expect(await deleteState(f.destination)).toEqual(destinationBefore);
    await trigger.drop();
    persist(`${point}-${timing}-${fault}-retry`,await positive(f));
    expect((await f.source.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2',[TENANT,JOB])).rows)
      .toEqual([{status:'READY',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null}]);
  },120_000);
});
