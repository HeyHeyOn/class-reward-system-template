// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { allocateRestoreTarget, backupMaterializedDatabase, restoreMaterializedDatabase } from '@/server/db/testing/materializedRestore';
import { importLegacyNormalizationManifest } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets, makeRedis, finalizeRedisSnapshot } from './__fixtures__/normalization';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { stageLocalFullGeneration } from './localFullGenerationStage';
import { materializeLocalCandidate, type LocalCandidateBinding } from './localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
const TENANT = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const JOB = '20000000-0000-4000-8000-000000000019';
const FULL = ['migration_full_generations','migration_full_sources','migration_full_targets','migration_full_mappings',
  'migration_full_contributors','migration_full_reconciliation','migration_full_delta_entries','migration_full_claim_recaptures'];
const databases: DisposablePostgres[] = [];
afterEach(async () => { for (const db of databases.splice(0).reverse()) console.info('RESTORE_CLEANUP',JSON.stringify(await db.close())); });
async function database() {
  const db = await createDisposablePostgres(); databases.push(db);
  console.info('RESTORE_PG',JSON.stringify(db.evidence));
  return db;
}
async function state(db: DisposablePostgres) {
  const tables = (await db.owner.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  return Object.fromEntries(await Promise.all(tables.map(async ({tablename}) => [tablename,
    (await db.owner.query(`SELECT to_jsonb(t) AS value FROM public."${tablename}" t`)).rows.map(r => canonicalJson(r.value)).sort()])));
}
async function acquisition(mixed: boolean) {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([tab,data]) => [tab, [[...data.headers],...data.rows.map(row => [...row.cells])]]));
  if (mixed) {
    workbook.Products[1][1] = 'Changed pencil'; workbook.Products.push(['P2','Notebook','15','3','TRUE','','school','2']);
    workbook.Promotions = [workbook.Promotions[0]]; workbook.PromotionProducts = [workbook.PromotionProducts[0]];
  }
  const sheets = await captureSheetsSnapshot({spreadsheetId:seed.spreadsheetId,capturedAt:seed.capturedAt,
    reader:{listSheetNames:async () => Object.keys(workbook),getRows:async name => structuredClone(workbook[name]),getRevision:async () => mixed ? 'candidate' : 'original'}});
  const redis = makeRedis({v1Tombstones:[{tupleDigest:sha256('deleted-post'),ownerDigest:sha256('old-owner'),sourceProvenance:'upstash:padlet:evidence-claim:v1'}]});
  const op = redis.operationBindings[0];
  return {sheets,redis:finalizeRedisSnapshot({...redis,sourceRevision:mixed ? 'candidate-redis' : 'original-redis',
    operationBindings:mixed ? [op,{...op,operationId:'new-operation',binding:{...op.binding,evidence:{...op.binding.evidence,evidencePostId:'new-post'}}}] : [op]})};
}
async function fixture(mixed = true) {
  const staged = await database(), source = await database(), destination = await database();
  const ownerId = randomUUID(), restoreOwnerId = randomUUID();
  for (const db of [staged,source]) {
    await db.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'restore-test','Synthetic')",[TENANT]);
    await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
    for (const table of FULL) await db.owner.query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
    await db.owner.query('GRANT SELECT ON migration_local_restore_databases,migration_local_restorations TO app_runtime');
  }
  const original = await acquisition(false), candidate = await acquisition(mixed);
  const old = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...original});
  const next = createLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,...candidate});
  expect(old.status).toBe('READY_FOR_IMPORT'); expect(next.status).toBe('READY_FOR_IMPORT');
  await importLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,manifest:old,runTransaction:staged.runTenantTransaction});
  for (const status of ['RECONCILING','READY']) await staged.owner.query('UPDATE migration_jobs SET status=$1,state_version=state_version+1',[status]);
  const version = (await staged.owner.query('SELECT state_version::text AS v FROM migration_jobs')).rows[0].v;
  const generation = await stageLocalFullGeneration({tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,
    originalSourceId:`sheet:${original.sheets.digest}`,originalSnapshotId:`import:${old.manifestDigest}`,
    exclusionGenerationReference:sha256('UNPROVEN local label'),original,candidate},staged.runTenantTransaction);
  for (const [db,role] of [[staged,'SOURCE'],[source,'DESTINATION']] as const) {
    await db.owner.query('INSERT INTO migration_local_disposable_database VALUES(true,$1,$2,$3,$4,$5)',[db.runId,ownerId,role,TENANT,JOB]);
    await db.owner.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
    await db.owner.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  }
  const lease = (db: DisposablePostgres) => ({kind:'SYNTHETIC_DISPOSABLE' as const,databaseId:db.runId,ownerId,
    queryOwner:async (text: string,values?: unknown[]) => db.owner.query(text,values),runTransaction:db.runTenantTransaction});
  const binding: LocalCandidateBinding = {tenantId:TENANT,migrationJobId:JOB,generationId:generation.generationId,
    expectedStateVersion:version,sourceFingerprint:next.sourceFingerprint,manifestDigest:next.manifestDigest};
  await materializeLocalCandidate(binding,createOwnedLocalMaterializationRunner(TENANT,JOB,lease(staged),lease(source)));
  await staged.close();
  return {source,destination,ownerId,restoreOwnerId,binding,mixed};
}
const restoreSuite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
restoreSuite('local disposable independent restore', () => {
  it.each([false,true])('restores actual SQL after backup source is closed mixed=%s',async mixed => {
    const f = await fixture(mixed), before = await state(f.source);
    const backup = await backupMaterializedDatabase(f.source,f.ownerId,f.binding);
    const sourceAfter = await state(f.source);
    expect(sourceAfter).toEqual(before);
    const target = await allocateRestoreTarget(f.destination,f.restoreOwnerId,f.binding);
    mkdirSync('.restore-artifacts',{recursive:true});
    const file = `.restore-artifacts/${f.source.runId}.sql`;
    writeFileSync(file,backup.bytes,{flag:'wx',mode:0o600});
    await f.source.close();
    await restoreMaterializedDatabase({...backup,bytes:readFileSync(file)},target);
    expect((await f.destination.owner.query('SELECT product_id,name,price::text,stock::text FROM products ORDER BY product_id')).rows)
      .toEqual(mixed ? [{product_id:'P1',name:'Changed pencil',price:'20',stock:'5'},{product_id:'P2',name:'Notebook',price:'15',stock:'3'}]
        : [{product_id:'P1',name:'Pencil',price:'20',stock:'5'}]);
    const after = await state(f.destination);
    for (const [table,rows] of Object.entries(before)) {
      if (['migration_local_disposable_database','migration_local_materializations','migration_local_restore_databases','migration_local_restorations'].includes(table)) continue;
      expect(after[table],table).toEqual(rows);
    }
    expect(after.migration_local_disposable_database).toEqual([]);
    expect(after.migration_local_materializations).toEqual([]);
    const claims = (await f.destination.owner.query(`SELECT c.post_id,o.operation_id,o.payload_hash,o.status,r.claim_kind
      FROM padlet_evidence_claims c JOIN operations o ON o.tenant_id=c.claimed_by_tenant_id AND o.operation_id=c.claimed_by_operation_id
      JOIN padlet_claim_digest_registry r USING(tuple_digest) ORDER BY c.post_id`)).rows;
    expect(claims).toHaveLength(mixed ? 2 : 1); expect(claims.every(c => c.status==='PENDING' && c.claim_kind==='CLAIM')).toBe(true);
    expect((await f.destination.owner.query("SELECT count(*)::int AS n FROM padlet_claim_digest_tombstones t JOIN padlet_claim_digest_registry r USING(tuple_digest) WHERE r.claim_kind='TOMBSTONE'")).rows).toEqual([{n:1}]);
    expect((await f.destination.owner.query('SELECT status,state_version::text,final_fingerprint FROM migration_jobs')).rows).toEqual([{status:'IMPORTING',state_version:'2',final_fingerprint:null}]);
    const identity = (await f.destination.owner.query('SELECT * FROM migration_local_restore_databases')).rows;
    expect(identity).toMatchObject([{database_id:f.destination.runId,owner_id:f.restoreOwnerId,state:'RESTORED_NONAUTHORITY'}]);
    const receipt = (await f.destination.owner.query('SELECT * FROM migration_local_restorations')).rows;
    expect(receipt).toMatchObject([{source_database_id:f.source.runId,destination_database_id:f.destination.runId,
      source_owner_id:f.ownerId,destination_owner_id:f.restoreOwnerId,authority:'NONAUTHORITY',activation_allowed:false}]);
    console.info('RESTORE_SQL_READBACK',JSON.stringify({mixed,backupFile:file,backupSha256:sha256(backup.bytes.toString('utf8')),
      sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,sourceOwnerId:f.ownerId,destinationOwnerId:f.restoreOwnerId,
      sourceBeforeSha256:sha256(canonicalJson(before)),sourceAfterSha256:sha256(canonicalJson(sourceAfter)),sourceClosedBeforeRestore:true,
      sourceRows:before,restoredRows:after,claims,identity,receipt}));
  },120_000);
  it('rejects a nonempty destination without adopting it',async () => {
    const f = await fixture(), backup = await backupMaterializedDatabase(f.source,f.ownerId,f.binding);
    await f.destination.owner.query("INSERT INTO users(google_subject,canonical_email) VALUES('unrelated','synthetic@example.invalid')");
    const before = await state(f.destination);
    await expect((async () => restoreMaterializedDatabase(backup,await allocateRestoreTarget(f.destination,f.restoreOwnerId,f.binding)))()).rejects.toThrow();
    expect(await state(f.destination)).toEqual(before);
  },120_000);
  it.each(['product','receipt','orphan-registry','missing-claim','unrelated','foreign','owner','binding','phase','marker'])
    ('rejects source substitution or omission %s',async fault => {
      const f = await fixture();
      if (fault==='product') await f.source.owner.query("UPDATE products SET name='same-count substitution'");
      if (fault==='receipt') { await f.source.owner.query('ALTER TABLE migration_local_materializations DISABLE TRIGGER USER'); await f.source.owner.query('DELETE FROM migration_local_materializations'); }
      if (fault==='orphan-registry') await f.source.owner.query("INSERT INTO padlet_claim_digest_registry(tuple_digest,claim_kind) VALUES($1,'CLAIM')",[sha256('orphan')]);
      if (fault==='missing-claim') { await f.source.owner.query('ALTER TABLE padlet_evidence_claims DISABLE TRIGGER USER'); await f.source.owner.query("DELETE FROM padlet_evidence_claims WHERE post_id='new-post'"); }
      if (fault==='unrelated') await f.source.owner.query("INSERT INTO users(google_subject,canonical_email) VALUES('unrelated','other@example.invalid')");
      if (fault==='foreign') await f.source.owner.query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'foreign','Other')",[OTHER]);
      if (fault==='phase') await f.source.owner.query("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1");
      if (fault==='marker') { await f.source.owner.query('ALTER TABLE migration_local_disposable_database DISABLE TRIGGER USER'); await f.source.owner.query("UPDATE migration_local_disposable_database SET role='SOURCE'"); }
      const before = await state(f.source);
      await expect(backupMaterializedDatabase(f.source,fault==='owner' ? randomUUID() : f.ownerId,
        fault==='binding' ? {...f.binding,manifestDigest:sha256('wrong')} : f.binding)).rejects.toThrow();
      expect(await state(f.source)).toEqual(before);
    },120_000);
  it.each(['bytes','truncate','seal','tenant','owner','identity'])('rejects restore boundary substitution %s',async fault => {
    const f = await fixture(), backup = await backupMaterializedDatabase(f.source,f.ownerId,f.binding);
    const target = await allocateRestoreTarget(f.destination,fault==='owner' ? f.ownerId : f.restoreOwnerId,
      fault==='tenant' ? {...f.binding,tenantId:OTHER} : f.binding);
    if (fault==='identity') {
      await f.destination.owner.query('ALTER TABLE local_restore_control.lease DISABLE TRIGGER USER');
      await f.destination.owner.query('UPDATE local_restore_control.lease SET database_id=$1',[f.source.runId]);
    }
    const before = await state(f.destination);
    const altered = {...backup,bytes:fault==='bytes' ? Buffer.concat([backup.bytes,Buffer.from('\nSELECT 1;')]) :
      fault==='truncate' ? backup.bytes.subarray(0,20) : backup.bytes,seal:fault==='seal' ? Object.freeze({}) : backup.seal};
    await expect(restoreMaterializedDatabase(altered,target)).rejects.toThrow();
    expect(await state(f.destination)).toEqual(before);
  },120_000);
  it.each(['late-error','missing-row','same-count-value','missing-registry','missing-receipt','missing-guard','missing-rls'])
    ('rolls back SQL data DDL and receipt after %s and allows only a clean failed attempt',async fault => {
      const f = await fixture(), backup = await backupMaterializedDatabase(f.source,f.ownerId,f.binding);
      const target = await allocateRestoreTarget(f.destination,f.restoreOwnerId,f.binding);
      const before = await state(f.destination);
      const control = (await f.destination.owner.query('SELECT * FROM local_restore_control.lease')).rows;
      const execute = target.execute;
      let dispatched = false;
      const injected = vi.spyOn(target,'execute').mockImplementationOnce(async script => {
        expect(script).toContain('INSERT INTO public.products');
        const original = script;
        if (fault==='late-error') script += '\nSELECT 1/0;';
        if (fault==='missing-row') script = script.replace(/^INSERT INTO public\.products.*'P2'.*;$/m,'');
        if (fault==='same-count-value') script = script.replace("'Changed pencil'","'Same count bad value'");
        if (fault==='missing-registry') script = script.replace(/^INSERT INTO public\.padlet_claim_digest_registry.*;$/m,'');
        if (fault==='missing-receipt') script = script.replace(/^INSERT INTO public\.migration_local_restorations.*;$/m,'');
        if (fault==='missing-guard') script = script.replace(/^CREATE TRIGGER transactions_immutable .*;$/m,'');
        if (fault==='missing-rls') script = script.replace(/^ALTER TABLE public\.products ENABLE ROW LEVEL SECURITY;$/m,'');
        expect(script).not.toBe(original);
        dispatched = true;
        await execute(script);
      });
      await expect(restoreMaterializedDatabase(backup,target)).rejects.toThrow();
      expect(injected).toHaveBeenCalledTimes(1); expect(dispatched).toBe(true); injected.mockRestore();
      const rolledBackPublic = await state(f.destination);
      expect(rolledBackPublic).toEqual(before);
      expect((await f.destination.owner.query('SELECT * FROM local_restore_control.lease')).rows).toEqual(control);
      await expect(restoreMaterializedDatabase(backup,target)).resolves.toMatchObject({authority:'NONAUTHORITY',activationAllowed:false});
      const restored = await state(f.destination);
      await expect(restoreMaterializedDatabase(backup,target)).rejects.toThrow();
      expect(await state(f.destination)).toEqual(restored);
      console.info('RESTORE_ROLLBACK_READBACK',JSON.stringify({fault,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
        before,rolledBackPublic,control,cleanRetrySucceeded:true,exactRetryRefused:true}));
    },120_000);
  it('captures admitted archive bytes before awaiting infrastructure checks',async () => {
    const f = await fixture(), backup = await backupMaterializedDatabase(f.source,f.ownerId,f.binding);
    const target = await allocateRestoreTarget(f.destination,f.restoreOwnerId,f.binding);
    const pending = restoreMaterializedDatabase(backup,target);
    backup.bytes.fill(0);
    await expect(pending).resolves.toMatchObject({authority:'NONAUTHORITY',activationAllowed:false});
    expect((await f.destination.owner.query('SELECT count(*)::int AS n FROM products')).rows).toEqual([{n:2}]);
  },120_000);
  it.each(['source','destination'])('rejects an unreviewed nonpublic schema on %s',async side => {
    const f = await fixture(), db = side==='source' ? f.source : f.destination;
    await db.owner.query('CREATE SCHEMA unrelated; CREATE TABLE unrelated.rows(value text); INSERT INTO unrelated.rows VALUES(\'synthetic unrelated data\')');
    const before = await state(db);
    const attempt = side==='source' ? backupMaterializedDatabase(db,f.ownerId,f.binding) : allocateRestoreTarget(db,f.restoreOwnerId,f.binding);
    await expect(attempt.then(() => 'unexpected acceptance')).rejects.toThrow();
    expect(await state(db)).toEqual(before);
    expect((await db.owner.query('SELECT value FROM unrelated.rows')).rows).toEqual([{value:'synthetic unrelated data'}]);
  },120_000);
  it('rejects physically substituted pools despite copied marker and container evidence',async () => {
    const f = await fixture();
    await expect(backupMaterializedDatabase({...f.source,owner:f.destination.owner},f.ownerId,f.binding)).rejects.toThrow();
    await expect(allocateRestoreTarget({...f.destination,owner:f.source.owner},f.restoreOwnerId,f.binding)).rejects.toThrow();
  },120_000);
  it.each(['source','destination'])('rejects private rows by owner count before reading private fields on %s',async side => {
    const f = await fixture(), db = side==='source' ? f.source : f.destination;
    await db.owner.query("INSERT INTO users(google_subject,canonical_email) VALUES('private-synthetic','private@example.invalid')");
    const client = await db.owner.connect();
    const queries = vi.spyOn(client,'query');
    client.release();
    try {
      const attempt = side==='source' ? backupMaterializedDatabase(db,f.ownerId,f.binding) : allocateRestoreTarget(db,f.restoreOwnerId,f.binding);
      await expect(attempt.then(() => 'unexpected acceptance')).rejects.toThrow();
      const statements = queries.mock.calls.map(args => args[0]).filter((text): text is string => typeof text==='string');
      expect(statements.some(text => text.includes('"users"'))).toBe(true);
      expect(statements.some(text => text.includes('"users"') && text.includes('to_jsonb'))).toBe(false);
    } finally { queries.mockRestore(); }
  },120_000);
  it('enforces restored immutable FK RLS registry and refuses damaged exact retries',async () => {
    const f = await fixture(), backup = await backupMaterializedDatabase(f.source,f.ownerId,f.binding);
    const target = await allocateRestoreTarget(f.destination,f.restoreOwnerId,f.binding);
    await restoreMaterializedDatabase(backup,target);
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`UPDATE transactions SET operator_snapshot='tamper'`)))
      .rejects.toMatchObject({cause:{code:'55000',message:expect.stringMatching(/immutable/i)}});
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`DELETE FROM padlet_evidence_claims`)))
      .rejects.toMatchObject({cause:{code:'P0001',message:expect.stringMatching(/immutable/i)}});
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`UPDATE operations SET payload_hash=${sha256('changed')}`)))
      .rejects.toMatchObject({cause:{code:'P0001',message:expect.stringMatching(/immutable/i)}});
    await expect(f.destination.owner.query('UPDATE migration_local_restorations SET activation_allowed=true')).rejects.toThrow(/immutable/i);
    await expect(f.destination.owner.query('TRUNCATE migration_local_restore_databases CASCADE')).rejects.toThrow(/immutable/i);
    await expect(f.destination.owner.query('UPDATE local_restore_control.lease SET database_id=$1',[randomUUID()])).rejects.toThrow(/immutable/i);
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`INSERT INTO padlet_claim_digest_registry(tuple_digest,claim_kind)
      SELECT tuple_digest,claim_kind FROM padlet_claim_digest_registry LIMIT 1`))).rejects.toMatchObject({cause:{code:'23505'}});
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`UPDATE accounts SET student_id='missing'`)))
      .rejects.toMatchObject({cause:{code:'23503'}});
    expect((await f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`SELECT * FROM products`))).rows).toEqual([]);
    expect((await f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`SELECT * FROM migration_local_restorations`))).rows).toEqual([]);
    await expect(f.destination.runTenantTransaction(OTHER,tx => tx.execute(sql`INSERT INTO products(tenant_id,product_id,name,price,stock,sort_order)
      VALUES(${TENANT},'cross-tenant','denied',1,1,1)`))).rejects.toMatchObject({cause:{code:'42501',message:expect.stringMatching(/row-level security/i)}});
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`SELECT * FROM local_restore_control.lease`)))
      .rejects.toMatchObject({cause:{code:'42501'}});
    await expect(f.destination.runTenantTransaction(TENANT,tx => tx.execute(sql`INSERT INTO migration_local_restorations SELECT * FROM migration_local_restorations`)))
      .rejects.toMatchObject({cause:{code:'42501'}});
    const role = (await f.destination.runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows;
    expect(role).toEqual([{rolsuper:false,rolbypassrls:false}]);
    await f.destination.owner.query("UPDATE products SET name='post-restore alteration'");
    await f.destination.owner.query('ALTER TABLE migration_local_restorations DISABLE TRIGGER USER');
    await f.destination.owner.query('DELETE FROM migration_local_restorations');
    const damaged = await state(f.destination);
    await expect(restoreMaterializedDatabase(backup,target)).rejects.toThrow();
    await expect(allocateRestoreTarget(f.destination,randomUUID(),f.binding)).rejects.toThrow();
    expect(await state(f.destination)).toEqual(damaged);
  },120_000);
});
