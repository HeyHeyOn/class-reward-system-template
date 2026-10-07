// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { materializeLocalCandidate } from './localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { captureLocalMutableRetention, verifyLocalMutableRetention } from './localMutableRetention';
import type { LegacyNormalizationManifest } from './manifest';
import { canonicalJson, sha256 } from './validators';
import { cleanupMutableFixture, forbidMutableWrites, mutableFixture, mutableState, TENANT, OTHER, JOB,
  type MutableChildRequest } from '../../../test-support/task19MutableFixture';
vi.mock('server-only', () => ({}));
afterEach(cleanupMutableFixture);
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const REFUSED = 'Local candidate domain materialization refused.';
// Independent mandatory inventory, not derived from production's coverage catalog.
const NORMALIZED = ['students','accounts','products','settings','tasks','task_allowed_students',
  'promotions','promotion_products','transactions','transaction_items','adjustments','task_assignments',
  'task_completions','legacy_operation_bindings','padlet_evidence_claims','padlet_claim_digest_tombstones'];
const CATEGORIES = [...NORMALIZED,'SOURCE_RECORDS','MAPPINGS','CONTRIBUTORS','DELTA_ENTRIES'];
type Fixture = Awaited<ReturnType<typeof mutableFixture>>;

async function cold(request: MutableChildRequest) {
  const prefix = `.task19-mutable-results/${randomUUID()}`;
  mkdirSync('.task19-mutable-results', { recursive: true, mode: 0o700 });
  writeFileSync(`${prefix}-request.json`, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs','run','test-support/task19MutableChild.test.ts',
    '--pool=threads','--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
    TASK19_MUTABLE_REQUEST: `${prefix}-request.json` }, stdio: ['ignore','pipe','pipe'], timeout: 150_000, killSignal: 'SIGTERM' });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const termination = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({code,signal}));
  });
  writeFileSync(`${prefix}-process.json`, JSON.stringify({pid:child.pid,...termination,stdout,stderr}), {flag:'wx',mode:0o600});
  expect(termination, stderr + stdout).toEqual({code:0,signal:null});
  expect(JSON.parse(readFileSync(`${prefix}-vitest.json`, 'utf8')))
    .toMatchObject({numPassedTests:1,numFailedTests:0,numFailedTestSuites:0,success:true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`, 'utf8'));
  expect(result.pid).toBe(child.pid); expect(result.pid).not.toBe(process.pid); expect(result.poolsClosed).toBe(true);
  console.info('TASK19_FINAL_DELTA_COLD', JSON.stringify({prefix,...termination,...result}));
  return result;
}

// Products have one direct Sheet contributor; do not call deltaEntries/projector.
function image(manifest: LegacyNormalizationManifest, id: string) {
  const target = manifest.records.products.find(row => row.productId === id);
  if (!target) return null;
  const sources = manifest.sourceRecords.flatMap((sourceValue, sourceOrdinal) => sourceValue.targetTable === 'products'
    && sourceValue.targetId === id ? [{sourceOrdinal,sourceValue}] : []);
  const mappings = manifest.mappings.flatMap((mappingValue, mappingOrdinal) => mappingValue.targetTable === 'products'
    && mappingValue.targetId === id ? [{mappingOrdinal,mappingValue}] : []);
  expect(sources).toHaveLength(1); expect(mappings).toHaveLength(1);
  expect(sources[0].sourceValue.source).toMatchObject({kind:'SHEET',tab:'Products',artifactDigest:manifest.sourceArtifacts.sheets.digest});
  return {target,sources,mappings,contributors:[{sourceOrdinal:sources[0].sourceOrdinal,mappingOrdinal:mappings[0].mappingOrdinal}]};
}
const rowsDigest = (rows: unknown[]) => sha256(canonicalJson(rows.map(row => canonicalJson(row)).sort()));
async function state(f: Fixture) { return [await mutableState(f.source), await mutableState(f.destination)]; }
async function refuseUnchanged(f: Fixture) {
  const before = await state(f);
  await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow(REFUSED);
  expect(await state(f)).toEqual(before);
}
async function corruptSource(f: Fixture, table: string, statement: string, values: unknown[] = []) {
  // Owned synthetic fault injection only, always restore the immutable guard.
  await f.source.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try { expect((await f.source.owner.query(statement,values)).rowCount).toBe(1); }
  finally { await f.source.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`); }
}

suite('Task19 final mutable delta positive', () => {
  it.each(['final-only','mutated-only','removed-only'] as const)(
    'cold imports exact %s Products with all categories and write-free retry', async variant => {
      const f = await mutableFixture(variant);
      const expected = (variant === 'final-only' ? [['P1','MUTATED'],['PX','REMOVED']]
        : variant === 'mutated-only' ? [['P1','MUTATED']] : [['PX','REMOVED']]).map(([id,kind]) => {
        const before = image(f.old,id), after = image(f.next,id);
        return {tenant_id:TENANT,migration_job_id:JOB,generation_id:f.binding.generationId,
          target_table:'products',target_id:id,change_kind:kind,entry_value:{table:'products',identity:canonicalJson([id]),kind,
            beforeDigest:before && sha256(canonicalJson(before.target)),afterDigest:after && sha256(canonicalJson(after.target)),before,after}};
      });
      const delta = (await f.source.owner.query('SELECT * FROM migration_full_delta_entries ORDER BY target_id')).rows;
      expect(delta).toEqual(expected);
      expect(delta.some(row => row.change_kind === 'ADDED')).toBe(false);
      const reports = (await f.source.owner.query('SELECT * FROM migration_full_reconciliation ORDER BY category')).rows;
      expect(reports.map(row => row.category)).toEqual([...CATEGORIES].sort());
      for (const report of reports) {
        expect(report).toMatchObject({tenant_id:TENANT,migration_job_id:JOB,generation_id:f.binding.generationId,status:'MATCH'});
        expect(report.expected_count).toBe(report.observed_count);
        expect(report.expected_digest).toBe(report.observed_digest);
        if (NORMALIZED.includes(report.category)) {
          expect(report.expected_count).toBe((f.next.records[report.category] ?? []).length);
          const targets = (await f.source.owner.query('SELECT canonical_value FROM migration_full_targets WHERE target_table=$1',[report.category])).rows;
          expect(targets.map(row => canonicalJson(row.canonical_value)).sort())
            .toEqual((f.next.records[report.category] ?? []).map(row => canonicalJson(row)).sort());
        }
      }
      const deltaReport = reports.find(row => row.category === 'DELTA_ENTRIES');
      expect(deltaReport).toMatchObject({expected_count:expected.length,observed_count:expected.length,
        expected_digest:rowsDigest(expected.map(({target_table,target_id,change_kind,entry_value}) => ({target_table,target_id,change_kind,entry_value})))});
      await forbidMutableWrites(f.source);
      const sourceBefore = await mutableState(f.source);
      const first = await cold(f.request);
      expect(first.outcome).toBe('MATERIALIZED');
      expect(first.receipt).toMatchObject({binding:f.binding,authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
      const product = {tenant_id:TENANT,product_id:'P1',name:variant === 'removed-only' ? 'Pencil' : 'Mutable pencil',
        price:variant === 'removed-only' ? '20' : '27',stock:variant === 'removed-only' ? '5' : '8',
        is_active:true,image_url:null,category:'school',sort_order:1,deleted_at:null};
      expect((await f.destination.owner.query('SELECT tenant_id,product_id,name,price::text,stock::text,is_active,image_url,category,sort_order,deleted_at FROM products')).rows)
        .toEqual([product]);
      expect((await f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
      const persisted = (await f.destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({tenant_id:TENANT,job_id:JOB,generation_id:f.binding.generationId,
        source_database_id:f.source.runId,destination_database_id:f.destination.runId,owner_id:f.ownerId,
        source_fingerprint:f.binding.sourceFingerprint,manifest_digest:f.binding.manifestDigest,domain_readback:first.receipt.readback});
      expect((await f.destination.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
        .toEqual([{status:'IMPORTING',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
      const destinationBefore = await mutableState(f.destination);
      await forbidMutableWrites(f.destination);
      const retry = await cold(f.request);
      expect(retry.pid).not.toBe(first.pid); expect(retry.outcome).toBe('MATERIALIZED'); expect(retry.receipt).toEqual(first.receipt);
      expect(await mutableState(f.source)).toEqual(sourceBefore);
      expect(await mutableState(f.destination)).toEqual(destinationBefore);
      console.info('TASK19_FINAL_DELTA_WITNESS',JSON.stringify({variant,binding:f.binding,delta,reports,product,
        sourceBefore:sha256(canonicalJson(sourceBefore)),sourceAfter:sha256(canonicalJson(await mutableState(f.source))),
        destinationBefore:sha256(canonicalJson(destinationBefore)),destinationAfter:sha256(canonicalJson(await mutableState(f.destination)))}));
    }, 180_000);
});

suite('Task19 final mutable delta negative', () => {
  it('cold retention refuses omitted empty tombstone report in the sibling verification path', async () => {
    const f = await mutableFixture(); // Retention deliberately remains mixed-only.
    const evidence = await f.source.runTenantTransaction(TENANT,tx => captureLocalMutableRetention(f.binding,tx));
    const bytes = canonicalJson({...evidence,reconciliation:evidence.reconciliation.filter(row => row.category !== 'padlet_claim_digest_tombstones')});
    const before = await state(f);
    expect(() => verifyLocalMutableRetention(bytes,f.binding)).toThrow('Local mutable retention evidence refused.');
    expect(await state(f)).toEqual(before);
  }, 120_000);

  it('refuses missing empty tombstone category rather than silently importing an unaccounted final delta', async () => {
    const f = await mutableFixture('final-only');
    expect(f.next.records.padlet_claim_digest_tombstones ?? []).toEqual([]);
    await f.source.owner.query('ALTER TABLE migration_full_reconciliation DISABLE TRIGGER USER');
    try { await f.source.owner.query("DELETE FROM migration_full_reconciliation WHERE category='padlet_claim_digest_tombstones'"); }
    finally { await f.source.owner.query('ALTER TABLE migration_full_reconciliation ENABLE TRIGGER USER'); }
    await refuseUnchanged(f);
  }, 120_000);

  it.each(CATEGORIES)('refuses missing mandatory %s accounting before import and on receipt retry', async category => {
    const f = await mutableFixture('final-only');
    const saved = (await f.source.owner.query('SELECT * FROM migration_full_reconciliation WHERE category=$1',[category])).rows[0];
    expect(saved).toBeDefined();
    await corruptSource(f,'migration_full_reconciliation','DELETE FROM migration_full_reconciliation WHERE category=$1',[category]);
    await refuseUnchanged(f);
    await f.source.owner.query('INSERT INTO migration_full_reconciliation SELECT * FROM jsonb_populate_record(NULL::migration_full_reconciliation,$1::jsonb)',[JSON.stringify(saved)]);
    await materializeLocalCandidate(f.binding,f.run());
    await corruptSource(f,'migration_full_reconciliation','DELETE FROM migration_full_reconciliation WHERE category=$1',[category]);
    await refuseUnchanged(f);
  }, 120_000);

  it.each(['missing-mutation','missing-removal','mutation-as-removal','duplicate-removal-alias','same-count-product-substitution','false-product-report'] as const)(
    'refuses %s even with a previously valid destination receipt', async kind => {
      const f = await mutableFixture('final-only');
      await materializeLocalCandidate(f.binding,f.run());
      if (kind === 'missing-mutation' || kind === 'missing-removal') await corruptSource(f,'migration_full_delta_entries',
        'DELETE FROM migration_full_delta_entries WHERE target_id=$1',[kind === 'missing-mutation' ? 'P1' : 'PX']);
      else if (kind === 'mutation-as-removal') await corruptSource(f,'migration_full_delta_entries',
        `UPDATE migration_full_delta_entries SET change_kind='REMOVED',entry_value=entry_value || '{"kind":"REMOVED","after":null,"afterDigest":null}'::jsonb WHERE target_id='P1'`);
      else if (kind === 'duplicate-removal-alias') await f.source.owner.query(`INSERT INTO migration_full_delta_entries
        SELECT tenant_id,migration_job_id,generation_id,target_table,'PX-alias',change_kind,entry_value FROM migration_full_delta_entries WHERE target_id='PX'`);
      else if (kind === 'same-count-product-substitution') await corruptSource(f,'migration_full_targets',
        `UPDATE migration_full_targets SET canonical_value=jsonb_set(canonical_value,'{name}','"same-count wrong product"') WHERE target_table='products' AND target_id='P1'`);
      else await corruptSource(f,'migration_full_reconciliation',
        `UPDATE migration_full_reconciliation SET expected_count=0,observed_count=0 WHERE category='products'`);
      await refuseUnchanged(f);
      // Actual fresh app/process refusal, not a fixture setup error or healing.
      const before = await state(f);
      expect((await cold(f.request)).outcome).toBe('REFUSED');
      expect(await state(f)).toEqual(before);
    }, 180_000);

  it('refuses a second identical removal at the SQL unique boundary without deleting source products', async () => {
    const f = await mutableFixture('final-only'), before = await state(f);
    await expect(f.source.owner.query(`INSERT INTO migration_full_delta_entries SELECT * FROM migration_full_delta_entries WHERE target_id='PX'`))
      .rejects.toMatchObject({code:'23505'});
    expect(await state(f)).toEqual(before);
    await materializeLocalCandidate(f.binding,f.run());
    expect(await mutableState(f.source)).toEqual(before[0]);
    expect((await f.source.owner.query("SELECT product_id FROM products WHERE product_id='PX'")).rows).toEqual([{product_id:'PX'}]);
  }, 120_000);

  it.each([TENANT,OTHER])('never removes an inherited PX row belonging to tenant %s', async tenant => {
    const f = await mutableFixture('final-only');
    // Same business ID as the removal tombstone, but NOT created by this import.
    await f.destination.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'PX','Inherited sentinel',9,0)",[tenant]);
    await forbidMutableWrites(f.destination);
    await refuseUnchanged(f);
    expect((await f.destination.owner.query("SELECT tenant_id,product_id,name FROM products")).rows)
      .toEqual([{tenant_id:tenant,product_id:'PX',name:'Inherited sentinel'}]);
  }, 120_000);

  it('refuses tenant job generation version fingerprint and manifest substitutions with no writes', async () => {
    const f = await mutableFixture('final-only');
    for (const retry of [false,true]) {
      if (retry) await materializeLocalCandidate(f.binding,f.run());
      const before = await state(f);
      for (const [key,value] of Object.entries({tenantId:OTHER,migrationJobId:'different-job',generationId:'different-generation',
        expectedStateVersion:'99',sourceFingerprint:sha256('different-source'),manifestDigest:sha256('different-manifest')})) {
        await expect(materializeLocalCandidate({...f.binding,[key]:value},f.run()),key).rejects.toThrow(REFUSED);
        expect(await state(f)).toEqual(before);
      }
    }
  }, 120_000);

  it('refuses substitution of a different owned physical source even with identical logical captures', async () => {
    const f = await mutableFixture('final-only'), other = await mutableFixture('final-only');
    expect(other.binding).toEqual(f.binding);
    const lease = (db: Fixture['source'], ownerId: string, databaseId = db.runId) => ({kind:'SYNTHETIC_DISPOSABLE' as const,
      ownerId,databaseId,runTransaction:db.runTenantTransaction,queryOwner:(text: string,values?: unknown[]) => db.owner.query(text,values)});
    // Keep the trusted original pin/owner while swapping only the actual source
    // connection. The on-DB SOURCE marker must expose the substitution.
    for (const retry of [false,true]) {
      if (retry) await materializeLocalCandidate(f.binding,f.run());
      const before = await state(f), otherBefore = await state(other);
      const substituted = createOwnedLocalMaterializationRunner(TENANT,JOB,lease(other.source,f.ownerId,f.source.runId),lease(f.destination,f.ownerId));
      await expect(materializeLocalCandidate(f.binding,substituted)).rejects.toThrow(REFUSED);
      expect(await state(f)).toEqual(before); expect(await state(other)).toEqual(otherBefore);
    }
  }, 120_000);

  it('fails closed on suppressed product INSERT readback, then retries from the unchanged empty destination', async () => {
    const f = await mutableFixture('final-only');
    await f.destination.owner.query('CREATE SEQUENCE task19_attempt');
    await f.destination.owner.query(`CREATE FUNCTION task19_suppress_product() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN PERFORM nextval('task19_attempt'); RETURN NULL; END $$`);
    await f.destination.owner.query('CREATE TRIGGER task19_suppress_product BEFORE INSERT ON products FOR EACH ROW EXECUTE FUNCTION task19_suppress_product()');
    await refuseUnchanged(f);
    expect((await f.destination.owner.query('SELECT last_value::text,is_called FROM task19_attempt')).rows).toEqual([{last_value:'1',is_called:true}]);
    await f.destination.owner.query('DROP TRIGGER task19_suppress_product ON products');
    expect((await materializeLocalCandidate(f.binding,f.run())).activationAllowed).toBe(false);
  }, 120_000);

  it('rolls back a real cancelled SQL write after product insertion; fresh process retry never accepts partial state', async () => {
    const f = await mutableFixture('final-only');
    await f.destination.owner.query('CREATE SEQUENCE task19_write_pid');
    await f.destination.owner.query(`CREATE FUNCTION task19_pause_product() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
      BEGIN PERFORM setval('task19_write_pid',pg_backend_pid()); PERFORM pg_sleep(20); RETURN NEW; END $$`);
    await f.destination.owner.query('CREATE TRIGGER task19_pause_product AFTER INSERT ON products FOR EACH ROW EXECUTE FUNCTION task19_pause_product()');
    const before = await state(f);
    // Observe a nontransactional sequence written AFTER the real product INSERT.
    // It survives rollback, preventing a pre-write refusal from passing this test.
    const attempt = materializeLocalCandidate(f.binding,f.run()).then(() => 'UNEXPECTED_SUCCESS', error => (error as Error).message);
    let pid: number | undefined;
    try {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const row = (await f.destination.owner.query('SELECT last_value::int AS pid,is_called FROM task19_write_pid')).rows[0];
        if (row.is_called) { pid = row.pid; break; }
        await delay(25);
      }
      expect(pid).toBeDefined();
      const active = (await f.destination.owner.query(`SELECT pid,usename,datname,state FROM pg_stat_activity WHERE pid=$1`,[pid])).rows;
      expect(active).toEqual([{pid,usename:'app_runtime',datname:'postgres',state:'active'}]);
      expect((await f.destination.owner.query('SELECT pg_cancel_backend($1) AS cancelled',[pid])).rows).toEqual([{cancelled:true}]);
    } finally {
      expect(await attempt).toBe(REFUSED);
    }
    expect(await state(f)).toEqual(before);
    expect((await f.destination.owner.query('SELECT * FROM migration_local_materializations')).rows).toEqual([]);
    await f.destination.owner.query('DROP TRIGGER task19_pause_product ON products');
    const retried = await cold(f.request);
    expect(retried.outcome).toBe('MATERIALIZED'); expect(retried.receipt.activationAllowed).toBe(false);
    expect((await f.destination.owner.query('SELECT product_id,name FROM products')).rows).toEqual([{product_id:'P1',name:'Mutable pencil'}]);
    expect(await mutableState(f.source)).toEqual(before[0]);
    console.info('TASK19_FINAL_DELTA_CANCELLED',JSON.stringify({pid,cancelled:true,rolledBack:true,binding:f.binding,retryPid:retried.pid}));
  }, 180_000);
});
