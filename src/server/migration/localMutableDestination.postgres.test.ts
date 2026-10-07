// @vitest-environment node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { materializeLocalCandidate } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import type { LegacyNormalizationManifest } from './manifest';
import { cleanupMutableFixture, forbidMutableWrites, mutableFixture, mutableState, TENANT, OTHER, JOB,
  type MutableChildRequest } from '../../../test-support/task19MutableFixture';
vi.mock('server-only', () => ({}));
afterEach(cleanupMutableFixture);
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;

async function cold(request: MutableChildRequest) {
  const id = randomUUID(), prefix = `.task19-mutable-results/${id}`;
  mkdirSync('.task19-mutable-results', { recursive: true, mode: 0o700 });
  writeFileSync(`${prefix}-request.json`, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs','run','test-support/task19MutableChild.test.ts',
    '--pool=threads','--maxWorkers=1','--no-file-parallelism','--reporter=default','--reporter=json',`--outputFile.json=${prefix}-vitest.json`],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', NODE_ENV: 'test', CI: '1', RUN_REAL_POSTGRES: '1',
    TASK19_MUTABLE_REQUEST: `${prefix}-request.json` }, stdio: ['ignore','pipe','pipe'], timeout: 150_000, killSignal: 'SIGTERM' });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const termination = await new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));
  });
  writeFileSync(`${prefix}-process.json`, JSON.stringify({ pid: child.pid, ...termination, stdout, stderr }), { flag: 'wx', mode: 0o600 });
  expect(termination, stderr + stdout).toEqual({code: 0, signal: null});
  const report = JSON.parse(readFileSync(`${prefix}-vitest.json`, 'utf8'));
  expect(report).toMatchObject({numPassedTests: 1, numFailedTests: 0, numFailedTestSuites: 0, success: true});
  const result = JSON.parse(readFileSync(`${prefix}-result.json`, 'utf8'));
  expect(result.pid).toBe(child.pid); expect(result.pid).not.toBe(process.pid); expect(result.poolsClosed).toBe(true);
  console.info('TASK19_MUTABLE_COLD', JSON.stringify({ prefix, ...termination, ...result }));
  return result;
}

// An independent products-only oracle: no full-generation delta/projector helper.
function productImage(manifest: LegacyNormalizationManifest, id: string) {
  const target = manifest.records.products.find(row => row.productId === id);
  if (!target) return null;
  const sources = manifest.sourceRecords.flatMap((sourceValue, sourceOrdinal) => sourceValue.targetTable === 'products'
    && sourceValue.targetId === id ? [{sourceOrdinal, sourceValue}] : []);
  const mappings = manifest.mappings.flatMap((mappingValue, mappingOrdinal) => mappingValue.targetTable === 'products'
    && mappingValue.targetId === id ? [{mappingOrdinal, mappingValue}] : []);
  expect(sources).toHaveLength(1); expect(mappings).toHaveLength(1);
  const pointer = sources[0].sourceValue.source;
  expect(pointer.kind).toBe('SHEET');
  if (pointer.kind !== 'SHEET') throw new Error('Expected synthetic product Sheet pointer');
  expect(pointer.tab).toBe('Products'); expect(pointer.artifactDigest).toBe(manifest.sourceArtifacts.sheets.digest);
  expect(mappings[0].mappingValue.sourceDigest).toBe(pointer.rowHash);
  return { target, sources, mappings, contributors: [{mappingOrdinal: mappings[0].mappingOrdinal, sourceOrdinal: sources[0].sourceOrdinal}] };
}
const refusal = 'Local candidate domain materialization refused.';
suite('Task19 mixed mutable destination', () => {
  it('cold imports exact MUTATED REMOVED ADDED products with durable provenance and write-free cold retry', async () => {
    const f = await mutableFixture();
    const delta = (await f.source.owner.query('SELECT tenant_id,migration_job_id,generation_id,target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_id')).rows;
    expect(delta).toHaveLength(3);
    for (const [id, kind] of [['P1','MUTATED'],['PNEW','ADDED'],['PX','REMOVED']]) {
      const before = productImage(f.old, id), after = productImage(f.next, id);
      expect(delta.find(row => row.target_id === id)).toEqual({ tenant_id: TENANT, migration_job_id: JOB,
        generation_id: f.binding.generationId, target_table: 'products', target_id: id, change_kind: kind,
        entry_value: { table: 'products', identity: canonicalJson([id]), kind,
          beforeDigest: before ? sha256(canonicalJson(before.target)) : null,
          afterDigest: after ? sha256(canonicalJson(after.target)) : null, before, after } });
    }
    expect((await f.source.owner.query('SELECT product_id,name,price::text,stock::text FROM products ORDER BY product_id')).rows)
      .toEqual([{product_id:'P1',name:'Pencil',price:'20',stock:'5'},{product_id:'PX',name:'Removed unreferenced',price:'9',stock:'0'}]);
    expect((await f.source.runTenantTransaction(OTHER, tx => tx.execute(sql`SELECT * FROM migration_full_delta_entries`))).rows).toEqual([]);
    await expect(f.source.owner.query("UPDATE migration_full_delta_entries SET target_id=target_id WHERE target_id='PX'"))
      .rejects.toMatchObject({code:'55000'});
    await forbidMutableWrites(f.source);
    const sourceBefore = await mutableState(f.source);
    const first = await cold(f.request);
    expect(first.outcome).toBe('MATERIALIZED');
    expect(first.receipt).toMatchObject({binding:f.binding,authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
    const products = (await f.destination.owner.query('SELECT tenant_id,product_id,name,price::text,stock::text,is_active,category,sort_order,deleted_at FROM products ORDER BY product_id')).rows;
    expect(products).toEqual([
      {tenant_id:TENANT,product_id:'P1',name:'Mutable pencil',price:'27',stock:'8',is_active:true,category:'school',sort_order:1,deleted_at:null},
      {tenant_id:TENANT,product_id:'PNEW',name:'Added notebook',price:'15',stock:'3',is_active:true,category:'school',sort_order:2,deleted_at:null},
    ]);
    const receipts = (await f.destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({tenant_id:TENANT,job_id:JOB,generation_id:f.binding.generationId,
      source_database_id:f.source.runId,destination_database_id:f.destination.runId,owner_id:f.ownerId,
      expected_state_version:f.binding.expectedStateVersion,source_fingerprint:f.binding.sourceFingerprint,
      manifest_digest:f.binding.manifestDigest,domain_readback:first.receipt.readback,authority:'NONAUTHORITY',activation_allowed:false});
    expect((await f.destination.owner.query('SELECT status,state_version::text,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
      .toEqual([{status:'IMPORTING',state_version:'2',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
    expect((await f.destination.owner.query('SELECT lifecycle FROM tenants WHERE id=$1',[TENANT])).rows).toEqual([{lifecycle:'IMPORTING'}]);
    const destinationBefore = await mutableState(f.destination);
    await forbidMutableWrites(f.destination);
    const retry = await cold(f.request);
    expect(retry.pid).not.toBe(first.pid); expect(retry.outcome).toBe('MATERIALIZED'); expect(retry.receipt).toEqual(first.receipt);
    expect(await mutableState(f.destination)).toEqual(destinationBefore);
    expect(await mutableState(f.source)).toEqual(sourceBefore);
    console.info('TASK19_MUTABLE_SQL_WITNESS', JSON.stringify({binding:f.binding,sourceId:f.source.runId,destinationId:f.destination.runId,
      sourceBeforeSha256:sha256(canonicalJson(sourceBefore)),sourceAfterSha256:sha256(canonicalJson(await mutableState(f.source))),
      destinationBeforeRetrySha256:sha256(canonicalJson(destinationBefore)),destinationAfterRetrySha256:sha256(canonicalJson(await mutableState(f.destination))),
      delta,products,receipts,firstPid:first.pid,retryPid:retry.pid}));
  }, 240_000);

  it('refuses every tenant job generation version fingerprint and manifest substitution before import and after publication', async () => {
    const f = await mutableFixture();
    for (const retry of [false,true]) {
      if (retry) await materializeLocalCandidate(f.binding,f.run());
      const before = await mutableState(f.destination), source = await mutableState(f.source);
      for (const [key,value] of Object.entries({tenantId:OTHER,migrationJobId:'other-job',generationId:'other-generation',
        expectedStateVersion:'99',sourceFingerprint:sha256('other-source'),manifestDigest:sha256('other-manifest')})) {
        await expect(materializeLocalCandidate({...f.binding,[key]:value},f.run()), key).rejects.toThrow(refusal);
        expect(await mutableState(f.destination)).toEqual(before); expect(await mutableState(f.source)).toEqual(source);
      }
    }
  }, 120_000);

  it.each(['missing-tombstone','before-target','after-target','before-source','before-mapping','before-contributor','missing-report','header-version'] as const)(
    'refuses %s persisted evidence before initial publication without writes', async kind => {
      const f = await mutableFixture();
      // Leave an empty destination: then materialize a valid candidate before
      // corruption only in separate retry tests below. This test isolates intake.
      const table = kind === 'missing-report' ? 'migration_full_reconciliation' : kind === 'header-version'
        ? 'migration_full_generations' : 'migration_full_delta_entries';
      await f.source.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      if (kind === 'missing-report') await f.source.owner.query("DELETE FROM migration_full_reconciliation WHERE category='DELTA_ENTRIES'");
      else if (kind === 'header-version') await f.source.owner.query('UPDATE migration_full_generations SET expected_state_version=expected_state_version+1');
      else if (kind === 'missing-tombstone') await f.source.owner.query("DELETE FROM migration_full_delta_entries WHERE target_id='PX'");
      else {
        const path = { 'before-target':'{before,target,name}', 'after-target':'{after,target,name}',
          'before-source':'{before,sources,0,sourceValue,source,rowHash}',
          'before-mapping':'{before,mappings,0,mappingValue,sourceDigest}',
          'before-contributor':'{before,contributors,0,sourceOrdinal}' }[kind];
        await f.source.owner.query(`UPDATE migration_full_delta_entries SET entry_value=jsonb_set(entry_value,$1::text[],$2::jsonb) WHERE target_id=$3`,
          [path, kind === 'before-contributor' ? '9999' : JSON.stringify('same-count-substitution'), kind === 'after-target' ? 'P1' : 'PX']);
      }
      await f.source.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      const before = await mutableState(f.destination), source = await mutableState(f.source);
      await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow(refusal);
      expect(await mutableState(f.destination)).toEqual(before); expect(await mutableState(f.source)).toEqual(source);
    }, 120_000);

  it.each(['missing-tombstone','substituted-tombstone','missing-receipt','wrong-receipt-version','missing-product','substituted-product','resurrected-product'] as const)(
    'cold retry refuses %s without healing or republishing', async kind => {
      const f = await mutableFixture();
      await materializeLocalCandidate(f.binding,f.run());
      const sourceFault = kind === 'missing-tombstone' || kind === 'substituted-tombstone';
      const db = sourceFault ? f.source : f.destination;
      const table = sourceFault ? 'migration_full_delta_entries' : kind.includes('receipt') ? 'migration_local_materializations' : 'products';
      await db.owner.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      if (kind === 'missing-tombstone') await db.owner.query("DELETE FROM migration_full_delta_entries WHERE target_id='PX'");
      else if (kind === 'substituted-tombstone') await db.owner.query("UPDATE migration_full_delta_entries SET entry_value=jsonb_set(entry_value,'{before,target,name}','\"substitute\"') WHERE target_id='PX'");
      else if (kind === 'missing-receipt') await db.owner.query('DELETE FROM migration_local_materializations');
      else if (kind === 'wrong-receipt-version') await db.owner.query('UPDATE migration_local_materializations SET expected_state_version=expected_state_version+1');
      else if (kind === 'missing-product') await db.owner.query("DELETE FROM products WHERE product_id='PNEW'");
      else if (kind === 'substituted-product') await db.owner.query("UPDATE products SET name='same-count-substitution' WHERE product_id='PNEW'");
      else await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'PX','Removed unreferenced',9,0)",[TENANT]);
      await db.owner.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      const before = await mutableState(f.destination), source = await mutableState(f.source);
      const result = await cold(f.request);
      expect(result.outcome).toBe('REFUSED');
      expect(await mutableState(f.destination)).toEqual(before); expect(await mutableState(f.source)).toEqual(source);
    }, 180_000);

  it('rolls back a suppressed destination receipt after real mixed product INSERTs then imports on a clean retry', async () => {
    const f = await mutableFixture();
    await f.destination.owner.query('CREATE FUNCTION task19_suppress() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
    await f.destination.owner.query('CREATE TRIGGER task19_suppress BEFORE INSERT ON migration_local_materializations FOR EACH ROW EXECUTE FUNCTION task19_suppress()');
    const before = await mutableState(f.destination), source = await mutableState(f.source);
    await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow(refusal);
    expect(await mutableState(f.destination)).toEqual(before); expect(await mutableState(f.source)).toEqual(source);
    await f.destination.owner.query('DROP TRIGGER task19_suppress ON migration_local_materializations');
    await expect(materializeLocalCandidate(f.binding,f.run())).resolves.toMatchObject({activationAllowed:false});
  }, 120_000);
});
