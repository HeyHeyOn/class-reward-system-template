// @vitest-environment node
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { retainColdDatabase } from '@/server/db/testing/coldRestore';
import { materializeLocalCandidate } from './localCandidateMaterialization';
import { stageLocalFullGeneration } from './localFullGenerationStage';
import { stageLegacyFinalGeneration } from './finalGeneration';
import { inspectLocalPointerPreparationEnvelopes } from './localPointerCheckedPreparation';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, INITIAL, STALE, TENANT, OTHER } from '../../../test-support/task19DeleteFixture';
vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const exec = promisify(execFile);
afterEach(cleanupDeleteFixture);
async function cold(request: Record<string, unknown>) {
  const resultId = randomUUID();
  const output = await exec(process.execPath, ['node_modules/vitest/vitest.mjs','run','test-support/coldRestoreChild.test.ts',
    '--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=.cold-child-results/${resultId}-vitest.json`],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
    COLD_REQUEST: JSON.stringify({ ...request, resultId }) }, timeout: 150_000, maxBuffer: 8_000_000 });
  console.info('TASK19_DELETE_COLD', JSON.stringify({ resultId, ...output }));
  const report = JSON.parse(readFileSync(`.cold-child-results/${resultId}-vitest.json`, 'utf8'));
  expect(report.numPassedTests).toBe(1); expect(report.numFailedTests).toBe(0);
  return JSON.parse(readFileSync(`.cold-child-results/${resultId}.json`, 'utf8'));
}
const stageRefusal = 'Local full-generation stage refused.';
suite('Task19 committed SQL delete packet', () => {
  it('characterizes committed deletion after initial candidate capture through exact candidate and independent cold restore', async () => {
    const f = await deleteFixture();
    const initial = await f.capture(INITIAL);
    expect(initial.sheets.tabs.Products.rows.map(row => row.cells[0])).toEqual(['P1','PX']);
    const initialStaged = await f.stage(initial);
    const initialEvidence = await f.state();
    const deletion = await f.commitDelete();
    expect(deletion.checkpoint).toEqual([{tenant:TENANT,revision:'2'},{tenant:OTHER,revision:'1'}]);
    expect(deletion.sequenceState).toEqual([{last_value:'1',is_called:true}]);
    expect((await f.local.owner.query("SELECT tenant,cells FROM task19_delete_rows WHERE tab='Products' AND ordinal>0 ORDER BY tenant,ordinal")).rows)
      .toEqual([{tenant:TENANT,cells:['P1','Pencil','20','5','TRUE','','school','1']},
        {tenant:OTHER,cells:['PX','Other tenant sentinel','9','0','TRUE','','school','2']}]);
    const candidate = await f.capture(), final = await f.stage(candidate);
    expect(final.staged).toMatchObject({authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
    expect(candidate.sheets.sourceRevision).toBe('2');
    expect(initialStaged.binding.generationId).not.toBe(final.binding.generationId);
    const delta = (await f.source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries WHERE generation_id=$1', [final.binding.generationId])).rows;
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({target_table:'products',target_id:'PX',change_kind:'REMOVED',entry_value:{identity:'["PX"]',kind:'REMOVED',after:null,afterDigest:null}});
    expect(delta[0].entry_value.before.target).toEqual(f.old.records.products.find(row => row.productId === 'PX'));
    expect(delta[0].entry_value.beforeDigest).toBe(sha256(canonicalJson(delta[0].entry_value.before.target)));
    expect(delta[0].entry_value.before.sources[0].sourceValue.source).toMatchObject({kind:'SHEET',tab:'Products',rowNumber:3,artifactDigest:f.original.sheets.digest});
    const materialized = await materializeLocalCandidate(final.binding,f.run());
    const expectedProducts = [{tenant_id:TENANT,product_id:'P1',name:'Pencil',price:'20',stock:'5',is_active:true,image_url:null,category:'school',sort_order:1,deleted_at:null}];
    expect((await f.destination.owner.query('SELECT tenant_id,product_id,name,price::text,stock::text,is_active,image_url,category,sort_order,deleted_at FROM products')).rows).toEqual(expectedProducts);
    expect((await f.source.owner.query('SELECT product_id FROM products ORDER BY product_id')).rows).toEqual([{product_id:'P1'},{product_id:'PX'}]);
    const beforeRetry = await f.state();
    expect(await materializeLocalCandidate(final.binding,f.run())).toEqual(materialized);
    expect(await f.state()).toEqual(beforeRetry);
    await f.destination.owner.query("SELECT setval('transactions_event_sequence_seq',900,true),setval('task_assignments_event_sequence_seq',700,false)");
    const exactProducts = (await f.destination.owner.query('SELECT to_jsonb(p) AS row FROM products p ORDER BY product_id')).rows.map(row => row.row);
    const anchor = await retainColdDatabase(f.destination,f.ownerId,final.binding,{retainUntil:Date.now()-1,expiresAt:Date.now()+600_000});
    const captured = await f.state();
    const closed = await Promise.all([f.local.close(),f.source.close(),f.destination.close()]);
    expect(closed.every(result => result.containerRemoved)).toBe(true);
    const restored = await cold({phase:'restore',anchor,binding:final.binding});
    expect(restored.ok,restored.error).toBe(true); expect(restored.pid).not.toBe(process.pid);
    expect(restored.restored.readback.tables.products).toEqual(exactProducts);
    expect(restored.restored.readback.sequences.transactions_event_sequence_seq).toEqual({last_value:'900',is_called:true});
    expect(restored.restored.readback.tables.migration_jobs[0]).toMatchObject({status:'IMPORTING',state_version:2,final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null});
    expect(restored.restored.result.authority).toBe('NONAUTHORITY');
    expect(restored.restored.cleanup.containerRemoved).toBe(true);
    const retry = await cold({phase:'restore',anchor,binding:final.binding});
    expect(retry.ok).toBe(false); expect(retry.dispatched).toBe(false);
    deletionEvidence('positive-cold', {initial,initialStaged,initialEvidence,deletion,candidate,final,delta,materialized,captured,anchor,closed,restored,retry});
  }, 240_000);

  it('refuses a deletion whose capture predates the original without publishing evidence or changing rows', async () => {
    const f = await deleteFixture(); await f.commitDelete();
    const candidate = await f.capture(STALE), before = await f.state();
    const outcome = await f.stage(candidate).then(result => ({accepted:true,result}), error => ({accepted:false,error:String(error.message)}));
    const after = await f.state();
    deletionEvidence('stale-capture-admission', {original:f.original,candidate,before,after,outcome});
    expect(outcome).toEqual({accepted:false,error:stageRefusal});
    expect(after).toEqual(before);
    // Existing direct preparation is intentionally not widened into this local
    // gate. Produce real stored envelopes there, then exercise cold-style reads.
    const input = f.input(candidate);
    const prepared = await stageLegacyFinalGeneration(input,{runTransaction:f.source.runTenantTransaction});
    const envelopes = (await f.source.owner.query("SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows;
    const binding = {tenantId:input.tenantId,migrationJobId:input.migrationJobId,expectedStateVersion:input.expectedStateVersion,
      originalSourceId:input.originalSourceId,originalSnapshotId:input.originalSnapshotId,exclusionGenerationReference:input.exclusionGenerationReference};
    expect(() => inspectLocalPointerPreparationEnvelopes(binding,prepared,envelopes)).toThrow('Local pointer-checked preparation refused.');
    const retained = await f.state();
    await expect(f.stage(candidate)).rejects.toThrow(stageRefusal);
    expect(await f.state()).toEqual(retained);
    deletionEvidence('stale-retained-readback', {binding,prepared,envelopes,retained});
  }, 120_000);

  it('retains rollback and foreign rows and refuses foreign forged tampered deletion and stale checkpoint retries', async () => {
    const f = await deleteFixture(), beforeRollback = await f.state();
    const rolled = await f.commitDelete(false);
    expect(await f.state()).toEqual(beforeRollback);
    expect(rolled.sequenceState).toEqual([{last_value:'1',is_called:true}]);
    await f.commitDelete();
    const candidate = await f.capture(), final = await f.stage(candidate);
    const before = await f.state();
    const foreign = await f.capture(undefined,'foreign-synthetic-workbook');
    await expect(f.stage(foreign)).rejects.toThrow(stageRefusal);
    const forged = structuredClone(candidate);
    (forged.sheets.tabs.Products.rows[0].cells as string[])[0] = 'forged-deletion-identity';
    await expect(f.stage(forged)).rejects.toThrow(stageRefusal);
    await expect(stageLocalFullGeneration({...f.input(candidate),expectedStateVersion:'99'},f.source.runTenantTransaction)).rejects.toThrow(stageRefusal);
    expect(await f.state()).toEqual(before);
    const materialized = await materializeLocalCandidate(final.binding,f.run());
    const valid = await f.state();
    await expect(materializeLocalCandidate({...final.binding,tenantId:OTHER},f.run())).rejects.toThrow('Local candidate domain materialization refused.');
    expect(await f.state()).toEqual(valid);
    await f.source.owner.query('ALTER TABLE migration_full_delta_entries DISABLE TRIGGER USER');
    try { await f.source.owner.query("UPDATE migration_full_delta_entries SET entry_value=jsonb_set(entry_value,'{beforeDigest}',to_jsonb($1::text)) WHERE target_id='PX'",[sha256('tampered delete')]); }
    finally { await f.source.owner.query('ALTER TABLE migration_full_delta_entries ENABLE TRIGGER USER'); }
    const damaged = await f.state();
    await expect(materializeLocalCandidate(final.binding,f.run())).rejects.toThrow('Local candidate domain materialization refused.');
    expect(await f.state()).toEqual(damaged);
    deletionEvidence('negative-rows', {beforeRollback,rolled,before,materialized,valid,damaged,after:await f.state()});
  }, 180_000);

  it.each([TENANT,OTHER])('never consumes a committed tombstone as authority to delete inherited destination rows for %s', async tenant => {
    const f = await deleteFixture(); await f.commitDelete();
    const final = await f.stage(await f.capture());
    if (tenant === OTHER) await f.destination.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'other-delete-tenant','Other')",[OTHER]);
    await f.destination.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active) VALUES($1,'PX','Inherited sentinel',9,0,true)",[tenant]);
    const before = await f.state();
    await expect(materializeLocalCandidate(final.binding,f.run())).rejects.toThrow('Local candidate domain materialization refused.');
    expect(await f.state()).toEqual(before);
    deletionEvidence('inherited-destination-refusal',{tenant,before,after:await f.state()});
  },120_000);

  it('never treats a lost destination commit acknowledgement as rollback or replays deletion over existing rows', async () => {
    const f = await deleteFixture(); await f.commitDelete();
    const final = await f.stage(await f.capture()), before = await f.state();
    let callbackCompleted = false;
    const run = f.run();
    let insertedBeforeRollback = false;
    await expect(materializeLocalCandidate(final.binding,(tenant,callback) => run(tenant,async pair => {
      await callback(pair);
      insertedBeforeRollback = (await pair.destination.execute(sql`SELECT count(*)::int AS n FROM products`)).rows[0].n === 1;
      throw new Error('synthetic precommit interruption after actual candidate INSERT');
    }))).rejects.toThrow('Local candidate domain materialization refused.');
    expect(insertedBeforeRollback).toBe(true);
    expect(await f.state()).toEqual(before);
    await expect(materializeLocalCandidate(final.binding,async (tenant,callback) => {
      await run(tenant,async pair => { const result = await callback(pair); callbackCompleted = true; return result; });
      throw new Error('synthetic lost destination COMMIT acknowledgement');
    })).rejects.toThrow('Local candidate domain materialization refused.');
    expect(callbackCompleted).toBe(true);
    const committed = await f.state();
    expect(committed.source).toEqual(before.source); expect(committed.local).toEqual(before.local);
    expect((await f.destination.owner.query('SELECT product_id FROM products')).rows).toEqual([{product_id:'P1'}]);
    expect((await f.destination.owner.query('SELECT count(*)::int AS n FROM migration_local_materializations')).rows).toEqual([{n:1}]);
    expect((await materializeLocalCandidate(final.binding,f.run())).authority).toBe('NONAUTHORITY');
    expect(await f.state()).toEqual(committed);
    const anchor = await retainColdDatabase(f.destination,f.ownerId,final.binding,{retainUntil:Date.now()-1,expiresAt:Date.now()+600_000});
    // Same-count domain tampering is not repaired by retry.
    await f.destination.owner.query("UPDATE products SET name='resurrected wrong bytes' WHERE product_id='P1'");
    const damaged = await f.state();
    await expect(materializeLocalCandidate(final.binding,f.run())).rejects.toThrow('Local candidate domain materialization refused.');
    expect(await f.state()).toEqual(damaged);
    expect((await f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
    await f.destination.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active) VALUES($1,'PX','Illicit resurrection',9,0,true)",[TENANT]);
    const resurrected = await f.state();
    await expect(materializeLocalCandidate(final.binding,f.run())).rejects.toThrow('Local candidate domain materialization refused.');
    expect(await f.state()).toEqual(resurrected);
    deletionEvidence('uncertain-commit', {before,committed,damaged,resurrected,after:await f.state(),insertedBeforeRollback,callbackCompleted,transportFault:'injected postcommit application acknowledgement loss, not wire disconnect'});
    await Promise.all([f.local.close(),f.source.close(),f.destination.close()]);
    const uncertain = await cold({phase:'restore',anchor,binding:final.binding,fault:'ack'});
    expect(uncertain.ok).toBe(false); expect(uncertain.dispatched).toBe(true);
    const journal = JSON.parse(readFileSync(`.cold-restore-control/${anchor.id}/state.json`,'utf8'));
    expect(journal.status).toBe('QUARANTINED'); expect(journal.lastAttempt.rollbackVerified).toBe(false);
    expect(journal.lastAttempt.error).toBe('simulated lost COMMIT acknowledgement');
    const retry = await cold({phase:'restore',anchor,binding:final.binding});
    expect(retry.ok).toBe(false); expect(retry.dispatched).toBe(false);
    deletionEvidence('uncertain-cold',{anchor,uncertain,journal,retry});
  }, 180_000);
});
