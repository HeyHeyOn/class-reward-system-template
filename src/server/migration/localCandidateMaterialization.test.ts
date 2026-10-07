// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets, makeRedis, finalizeRedisSnapshot } from './__fixtures__/normalization';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { stageLocalFullGeneration } from './localFullGenerationStage';
import { materializeLocalCandidate, prepareLocalCandidateTransition, type LocalCandidateBinding } from './localCandidateMaterialization';
import { inspectLegacyFinalGeneration, type FinalGenerationPreparationInput } from './finalGeneration';
import { createOwnedLocalMaterializationRunner } from './localMaterializationRunner';
import { canonicalJson, sha256 } from './validators';

vi.mock('server-only', () => ({}));
const TENANT = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const JOB = '20000000-0000-4000-8000-000000000019';
const FULL = ['migration_full_generations','migration_full_sources','migration_full_targets','migration_full_mappings',
  'migration_full_contributors','migration_full_reconciliation','migration_full_delta_entries','migration_full_claim_recaptures'];
const DOMAIN = ['tenant_settings','students','accounts','products','promotions','promotion_products','tasks',
  'task_allowed_students','task_assignments','transactions','transaction_items','adjustments','task_completions',
  'operations','padlet_evidence_claims','padlet_claim_digest_tombstones','padlet_claim_digest_registry','inventory_ledger'];
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) console.info('DOMAIN_CLEANUP', await close()); });

async function database() {
  const pg = process.env.RUN_REAL_POSTGRES === '1' ? await createDisposablePostgres() : null;
  const lite = pg ? null : await createPgliteDatabaseHarness({ migrationSet: 'base' });
  closes.push(async () => pg ? pg.close() : lite!.close());
  if (pg) console.info('DOMAIN_PG', JSON.stringify(pg.evidence));
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> =>
    pg ? pg.owner.query(text, values) : lite!.database.query(text, values);
  const exec = async (text: string): Promise<void> => {
    if (pg) await pg.owner.query(text);
    else await lite!.database.exec(text);
  };
  if (lite) for (const file of readdirSync('src/server/db/migrations').filter(f => /^\d{4}_.*\.sql$/.test(f) && f.slice(0,4) > '0008').sort()) {
    await lite.database.exec(readFileSync(`src/server/db/migrations/${file}`, 'utf8'));
  }
  if (pg) await query("INSERT INTO tenants(id,slug,display_name) VALUES($1,'domain-one','Synthetic'),($2,'domain-two','Synthetic other')", [TENANT,OTHER]);
  for (const table of FULL) await query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  const run = (pg?.runTenantTransaction ?? lite!.runTenantTransaction) as TenantImportTransactionRunner;
  const state = async (tables = [...DOMAIN,...FULL,'audit_events','migration_jobs','migration_sources','migration_source_records','migration_snapshots','tenants']) =>
    Object.fromEntries(await Promise.all(tables.map(async table => [table,
      (await query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows.map(r => canonicalJson(r.row)).sort()])));
  return { query, exec, run, state, id: pg?.runId ?? randomUUID() };
}

async function acquisition(mixed: boolean) {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([tab,data]) => [tab, [[...data.headers],...data.rows.map(row => [...row.cells])]]));
  if (mixed) {
    workbook.Products[1][1] = 'Changed pencil';
    workbook.Products.push(['P2','Notebook','15','3','TRUE','','school','2']);
    workbook.Promotions = [workbook.Promotions[0]];
    workbook.PromotionProducts = [workbook.PromotionProducts[0]];
  }
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId, capturedAt: seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async name => structuredClone(workbook[name]), getRevision: async () => mixed ? 'candidate' : 'original' } });
  const redis = makeRedis({ v1Tombstones: [{ tupleDigest: sha256('deleted-post'), ownerDigest: sha256('old-owner'), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }] });
  const op = redis.operationBindings[0];
  return { sheets, redis: finalizeRedisSnapshot({ ...redis, sourceRevision: mixed ? 'candidate-redis' : 'original-redis',
    operationBindings: mixed ? [op, { ...op, operationId: 'new-operation', binding: { ...op.binding,
      evidence: { ...op.binding.evidence, evidencePostId: 'new-post' } } }] : [op] }) };
}

async function fixture(mixed = true) {
  const source = await database(), destination = await database();
  const ownerId = randomUUID();
  const original = await acquisition(false), candidate = await acquisition(mixed);
  const old = createLegacyNormalizationManifest({ tenantId:TENANT,migrationJobId:JOB,...original });
  const next = createLegacyNormalizationManifest({ tenantId:TENANT,migrationJobId:JOB,...candidate });
  expect(old.status).toBe('READY_FOR_IMPORT'); expect(next.status).toBe('READY_FOR_IMPORT');
  await source.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  await importLegacyNormalizationManifest({tenantId:TENANT,migrationJobId:JOB,manifest:old,runTransaction:source.run});
  for (const status of ['RECONCILING','READY']) await source.query('UPDATE migration_jobs SET status=$3,state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2',[TENANT,JOB,status]);
  const version = (await source.query('SELECT state_version::text AS v FROM migration_jobs')).rows[0].v as string;
  const staged = await stageLocalFullGeneration({tenantId:TENANT,migrationJobId:JOB,expectedStateVersion:version,
    originalSourceId:`sheet:${original.sheets.digest}`,originalSnapshotId:`import:${old.manifestDigest}`,
    exclusionGenerationReference:sha256('UNPROVEN local label'),original,candidate},source.run);
  await destination.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[TENANT,JOB]);
  // The real implementation requires a DB-local ownership marker. Before that
  // additive migration exists the RED fixture is still a valid domain database.
  const marker = (await source.query("SELECT to_regclass('migration_local_disposable_database') AS name")).rows[0].name;
  if (marker) for (const [db, role] of [[source,'SOURCE'],[destination,'DESTINATION']] as const) {
    await db.query('INSERT INTO migration_local_disposable_database(singleton,database_id,owner_id,role,tenant_id,job_id) VALUES(true,$1,$2,$3,$4,$5)',[db.id,ownerId,role,TENANT,JOB]);
    await db.query('REVOKE ALL ON migration_local_disposable_database FROM app_runtime');
    await db.query('GRANT SELECT ON migration_local_disposable_database TO app_runtime');
    await db.query('GRANT SELECT,INSERT ON migration_local_materializations TO app_runtime');
  }
  const run = createOwnedLocalMaterializationRunner(TENANT,JOB,
    {kind:'SYNTHETIC_DISPOSABLE',databaseId:source.id,ownerId,queryOwner:source.query,runTransaction:source.run},
    {kind:'SYNTHETIC_DISPOSABLE',databaseId:destination.id,ownerId,queryOwner:destination.query,runTransaction:destination.run});
  const binding: LocalCandidateBinding = {tenantId:TENANT,migrationJobId:JOB,generationId:staged.generationId,
    expectedStateVersion:version,sourceFingerprint:next.sourceFingerprint,manifestDigest:next.manifestDigest};
  return {source,destination,run,binding,old,next};
}

async function preparedFixture() {
  const f = await fixture();
  const reconciled = await materializeLocalCandidate(f.binding,f.run);
  expect(await materializeLocalCandidate(f.binding,f.run)).toEqual(reconciled);
  const reports = (await f.source.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
    FROM migration_full_reconciliation WHERE generation_id=$1 ORDER BY category`,[f.binding.generationId])).rows;
  expect(reports.length).toBeGreaterThan(16);
  expect(reports.every(r => r.status==='MATCH' && r.expected_count===r.observed_count && r.expected_digest===r.observed_digest)).toBe(true);
  const receipt = (await f.destination.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const ownerId = (await f.destination.query('SELECT owner_id FROM migration_local_disposable_database')).rows[0].owner_id as string;
  const intent = {binding:f.binding,ownerId,sourceDatabaseId:f.source.id,destinationDatabaseId:f.destination.id,
    expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),
    expectedMaterializationDigest:sha256(canonicalJson(receipt))};
  const state = async (db:typeof f.source) => {
    const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
    const result:Record<string,unknown> = {};
    for (const {tablename} of tables) {
      expect(tablename).toMatch(/^[a-z_]+$/);
      result[String(tablename)] = (await db.query(`SELECT to_jsonb(t) AS row,xmin::text FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
    }
    return result;
  };
  return {...f,intent,state};
}

describe('local prepared transition STOP boundary',() => {
  it('commits a reconciled exact candidate to RECONCILING with a bound PREPARED_STOP_REQUIRED receipt, never authority',async () => {
    const f = await preparedFixture();
    // Preserve the reviewed entry/exit/evidence/delete embargo verbatim. The
    // intermediate edge must work WITH these guards, not by weakening them.
    for (const [kind,digest] of [
      ['Entry','2474310608c3d9d03728ba09e43b9c1d2ddde6cfc157d1243b4d1d51d2132a0d'],
      ['Evidence','a6ab9bd656aaac19992114c1d70e0d74175d77e0100f859f0e79e41ed066a267'],
      ['Exit','fb2ee8ebffacd91ccc4a96c6c157fcb2246eca2283db92ffb1794d0fc3dc0c51'],
      ['Delete','89abed47eed3b3a706ee323824f9dfdfe1cd39967bcdf257e52e44709d13b8ea'],
    ]) {
      const text = readFileSync(`src/server/migration/localProtected${kind}Guard.prototype.postgres.test.ts`,'utf8');
      expect(sha256(text)).toBe(digest);
      const start = `CREATE FUNCTION public.guard_migration_job_protected_${kind.toLowerCase()}()`;
      expect(text.split(start)).toHaveLength(2);
      const from = text.indexOf(start),literal = text.slice(from,text.indexOf('`);',from));
      expect(literal).not.toContain('${'); expect(literal).not.toContain('\\');
      // The hash-pinned, unchanged function+trigger script uses the driver's
      // script API; PGlite.query is a single prepared statement, not DDL exec.
      for (const db of [f.source,f.destination]) await db.exec(literal);
    }
    const original = await f.state(f.source),before = await f.state(f.destination);
    const result = await prepareLocalCandidateTransition(f.intent,f.run);
    expect(result).toMatchObject({preparation:'PREPARED_STOP_REQUIRED',status:'RECONCILING',stateVersion:'3',
      authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN',binding:f.binding});
    const jobs = (await f.destination.query('SELECT status,state_version::text,source_fingerprint,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows;
    expect(jobs).toEqual([{status:'RECONCILING',state_version:'3',source_fingerprint:f.binding.sourceFingerprint,
      final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
    const audits = (await f.destination.query('SELECT event_id,event_type,job_id,actor_user_id,redacted_details FROM audit_events')).rows;
    expect(audits).toEqual([{event_id:result.auditEventId,event_type:'MIGRATION_LOCAL_PREPARED_STOP',job_id:JOB,
      actor_user_id:null,redacted_details:result.receipt}]);
    expect(result.receipt).toMatchObject({intent:f.intent,previousStatus:'IMPORTING',status:'RECONCILING',
      stateVersion:'3',authority:'NONAUTHORITY',activationAllowed:false,exclusion:'NOT_PROVEN'});
    const after = await f.state(f.destination);
    for (const table of Object.keys(before).filter(t => !['migration_jobs','audit_events'].includes(t))) expect(after[table],table).toEqual(before[table]);
    expect(await f.state(f.source)).toEqual(original);
    console.info('PREPARED_STOP_READBACK',JSON.stringify({intent:f.intent,result,jobs,sourceUnchanged:true,domainUnchanged:true}));
    await expect(prepareLocalCandidateTransition(f.intent,f.run)).rejects.toThrow('Local prepared transition refused.');
    await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
    await expect(f.destination.run(TENANT,tx => tx.execute(sql`UPDATE migration_jobs SET status='FINAL_IMPORT',state_version=state_version+1`))).rejects.toThrow();
    await expect(f.destination.run(TENANT,tx => tx.execute(sql`DELETE FROM audit_events`))).rejects.toThrow();
    expect(await f.state(f.destination)).toEqual(after);
  },120_000);

  it('refuses every mismatched source/candidate/lease/report/version identity without any writes',async () => {
    const f = await preparedFixture(),before = await f.state(f.destination),original = await f.state(f.source);
    const changes = [
      ...['ownerId','sourceDatabaseId','destinationDatabaseId'].map(key => ({...f.intent,[key]:randomUUID()})),
      ...['expectedReportDigest','expectedMaterializationDigest'].map(key => ({...f.intent,[key]:sha256('different')})),
      {...f.intent,expectedDestinationStateVersion:'3'},
      ...Object.keys(f.binding).map(key => ({...f.intent,binding:{...f.binding,[key]:key==='tenantId' ? OTHER
        : key==='expectedStateVersion' ? '5' : key==='sourceFingerprint' || key==='manifestDigest' ? sha256('wrong') : 'wrong'}})),
    ];
    for (const intent of changes) {
      await expect(prepareLocalCandidateTransition(intent,f.run)).rejects.toThrow('Local prepared transition refused.');
      expect(await f.state(f.destination)).toEqual(before); expect(await f.state(f.source)).toEqual(original);
    }
  },120_000);

  it.each(['absent-report','changed-report','repinned-changed-report','absent-materialization','changed-materialization',
    'stale-destination','stale-source','conflicting-destination','conflicting-source','changed-domain'] as const)(
    'refuses %s without repairing or publishing anything',async kind => {
      const f = await preparedFixture();
      if (kind.includes('report')) {
        await f.source.query('ALTER TABLE migration_full_reconciliation DISABLE TRIGGER USER');
        if (kind==='absent-report') await f.source.query("DELETE FROM migration_full_reconciliation WHERE category='padlet_claim_digest_tombstones'");
        else await f.source.query("UPDATE migration_full_reconciliation SET expected_digest=repeat('b',64),observed_digest=repeat('b',64) WHERE category='products'");
        await f.source.query('ALTER TABLE migration_full_reconciliation ENABLE TRIGGER USER');
        if (kind==='repinned-changed-report') f.intent.expectedReportDigest = sha256(canonicalJson((await f.source.query(`SELECT category,expected_count,observed_count,expected_digest,observed_digest,status
          FROM migration_full_reconciliation WHERE generation_id=$1 ORDER BY category`,[f.binding.generationId])).rows));
      } else if (kind.includes('materialization')) {
        await f.destination.query('ALTER TABLE migration_local_materializations DISABLE TRIGGER USER');
        await f.destination.query(kind==='absent-materialization' ? 'DELETE FROM migration_local_materializations'
          : "UPDATE migration_local_materializations SET domain_readback='{}'");
        await f.destination.query('ALTER TABLE migration_local_materializations ENABLE TRIGGER USER');
      } else if (kind==='stale-destination') await f.destination.query("UPDATE migration_jobs SET status='RECONCILING',state_version=state_version+1");
      else if (kind==='stale-source') await f.source.query("UPDATE migration_jobs SET status='FREEZING',state_version=state_version+1");
      else if (kind.startsWith('conflicting')) await (kind==='conflicting-source' ? f.source : f.destination)
        .query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'conflicting-job','VALIDATED')",[TENANT]);
      else await f.destination.query("UPDATE products SET name='not the reconciled candidate' WHERE product_id='P2'");
      const before = await f.state(f.destination),original = await f.state(f.source);
      await expect(prepareLocalCandidateTransition(f.intent,f.run)).rejects.toThrow('Local prepared transition refused.');
      expect(await f.state(f.destination)).toEqual(before); expect(await f.state(f.source)).toEqual(original);
    },120_000);

  it.each(['suppressed-receipt','changed-receipt','suppressed-state','post-state-failure','domain-side-effect'] as const)(
    'rolls back the entire PREPARED edge on %s; a clean retry then succeeds',async kind => {
      const f = await preparedFixture();
      const audit = ['suppressed-receipt','changed-receipt'].includes(kind),table = audit ? 'audit_events' : 'migration_jobs';
      const body = kind==='changed-receipt' ? "NEW.redacted_details='{}'::jsonb; RETURN NEW;"
        : kind==='post-state-failure' ? "RAISE EXCEPTION 'synthetic after update failure';"
        : kind==='domain-side-effect' ? "UPDATE products SET name='unexpected side effect' WHERE product_id='P2'; RETURN NEW;" : 'RETURN NULL;';
      await f.destination.query(`CREATE FUNCTION prepared_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} END $$`);
      await f.destination.query(`CREATE TRIGGER prepared_fault ${kind==='post-state-failure' ? 'AFTER' : 'BEFORE'} ${audit ? 'INSERT' : 'UPDATE'} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION prepared_fault()`);
      const before = await f.state(f.destination),original = await f.state(f.source);
      await expect(prepareLocalCandidateTransition(f.intent,f.run)).rejects.toThrow('Local prepared transition refused.');
      expect(await f.state(f.destination)).toEqual(before); expect(await f.state(f.source)).toEqual(original);
      await f.destination.query(`DROP TRIGGER prepared_fault ON ${table}`);
      await expect(prepareLocalCandidateTransition(f.intent,f.run)).resolves.toMatchObject({preparation:'PREPARED_STOP_REQUIRED',activationAllowed:false});
    },120_000);

  it('detaches exact intent before awaits and refuses executable/augmented input or skipped runners',async () => {
    const f = await preparedFixture(),calls = vi.fn();
    const accessor = {...f.intent}; Object.defineProperty(accessor,'ownerId',{get:calls});
    for (const intent of [new Proxy(f.intent,{get:calls}),accessor,{...f.intent,extra:true},
      {...f.intent,binding:new Proxy(f.binding,{get:calls})}]) {
      await expect(prepareLocalCandidateTransition(intent,calls as never)).rejects.toThrow('Local prepared transition refused.');
    }
    expect(calls).not.toHaveBeenCalled();
    await expect(prepareLocalCandidateTransition(f.intent,undefined as never)).rejects.toThrow();
    await expect(prepareLocalCandidateTransition(f.intent,async () => undefined as never)).rejects.toThrow();
    const detached = structuredClone(f.intent);
    const result = await prepareLocalCandidateTransition(f.intent,async (tenant,callback) => {
      f.intent.binding = {...f.binding,generationId:'changed after admission'};
      f.intent.ownerId = randomUUID();
      return f.run(tenant,callback);
    });
    expect(result.receipt.intent).toEqual(detached);
    expect(Object.isFrozen(result.receipt)).toBe(true);
  },120_000);
});

describe('local candidate domain materialization', () => {
  it.each([false,true])('publishes actual SQL candidate mixed=%s, not source P1 or staged graph; preserves the entire source',async mixed => {
    const f = await fixture(mixed);
    const before = await f.source.state();
    expect((await f.source.query('SELECT product_id,name FROM products ORDER BY product_id')).rows).toEqual([{product_id:'P1',name:'Pencil'}]);
    await materializeLocalCandidate(f.binding,f.run);
    expect((await f.destination.query('SELECT product_id,name,price::text,stock::text FROM products ORDER BY product_id')).rows)
      .toEqual(mixed ? [{product_id:'P1',name:'Changed pencil',price:'20',stock:'5'},{product_id:'P2',name:'Notebook',price:'15',stock:'3'}]
        : [{product_id:'P1',name:'Pencil',price:'20',stock:'5'}]);
    expect((await f.destination.query('SELECT promotion_id FROM promotions')).rows).toEqual(mixed ? [] : [{promotion_id:'PROMO1'}]);
    expect((await f.destination.query('SELECT promotion_product_id,promotion_id,product_id FROM promotion_products')).rows)
      .toEqual(mixed ? [] : [{promotion_product_id:'LINK1',promotion_id:'PROMO1',product_id:'P1'}]);
    expect((await f.destination.query(`SELECT c.post_id,c.claimed_by_operation_id,o.operation_kind,o.payload_hash,c.claimed_by_tenant_id
      FROM padlet_evidence_claims c JOIN operations o ON o.tenant_id=c.claimed_by_tenant_id AND o.operation_id=c.claimed_by_operation_id ORDER BY c.post_id`)).rows.sort((a,b) => String(a.post_id).localeCompare(String(b.post_id))))
      .toEqual(f.next.records.padlet_evidence_claims.map(row => ({post_id:row.postId,claimed_by_operation_id:row.operationId,
        operation_kind:'TASK_REWARD',payload_hash:String(row.operationPayloadHash).slice(7),claimed_by_tenant_id:TENANT})).sort((a,b) => String(a.post_id).localeCompare(String(b.post_id))));
    expect((await f.destination.query('SELECT tuple_digest,owner_digest,source_provenance FROM padlet_claim_digest_tombstones')).rows)
      .toEqual([{tuple_digest:sha256('deleted-post'),owner_digest:sha256('old-owner'),source_provenance:'upstash:padlet:evidence-claim:v1'}]);
    expect(await f.source.state()).toEqual(before);
    const result = await materializeLocalCandidate(f.binding,f.run);
    expect(result).toMatchObject({scope:'LOCAL_DISPOSABLE_DOMAIN',authority:'NONAUTHORITY',activationAllowed:false,complete:false});
    const after = await f.destination.state();
    expect(await materializeLocalCandidate(f.binding,f.run)).toEqual(result);
    expect(await f.destination.state()).toEqual(after);
    expect(await f.source.state()).toEqual(before);
    // Independent domain queries, not a staging projector compared to itself.
    expect((await f.destination.query('SELECT student_id,name,status FROM students')).rows).toEqual([{student_id:'S1',name:'Alice',status:'ACTIVE'}]);
    expect((await f.destination.query('SELECT student_id,balance::text,version::text FROM accounts')).rows).toEqual([{student_id:'S1',balance:'100',version:'1'}]);
    for (const table of ['transactions','transaction_items','adjustments','task_assignments','task_completions','tasks','task_allowed_students','tenant_settings']) {
      // Exclude only DB-generated audit defaults, not occurred/completed/cycle
      // values or task/assignment created_at which are actual imported history.
      const omit = ['transactions','transaction_items','adjustments','task_allowed_students','tenant_settings'].includes(table)
        ? " - 'created_at' - 'updated_at'" : '';
      const read = async (db: typeof f.source) => (await db.query(`SELECT to_jsonb(t)${omit} AS value FROM ${table} t`))
        .rows.map(row => canonicalJson(row.value)).sort();
      expect(await read(f.destination)).toEqual(await read(f.source));
    }
    expect((await f.destination.query('SELECT status,state_version::text,source_fingerprint,final_fingerprint FROM migration_jobs')).rows)
      .toEqual([{status:'IMPORTING',state_version:'2',source_fingerprint:f.next.sourceFingerprint,final_fingerprint:null}]);
    console.info('DOMAIN_SQL_READBACK',JSON.stringify({mixed,binding:f.binding,
      sourceDatabaseId:f.source.id,destinationDatabaseId:f.destination.id,
      sourceBeforeSha256:sha256(canonicalJson(before)),sourceAfterSha256:sha256(canonicalJson(await f.source.state())),
      independentSqlDomainRows:await f.destination.state(DOMAIN),receipt:result}));
  },120_000);

  it('rejects a nonempty destination without adopting or mutating its existing rows',async () => {
    const f = await fixture();
    await f.destination.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'P1','Pencil',20,5)",[TENANT]);
    const before = await f.destination.state();
    await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
    expect(await f.destination.state()).toEqual(before);
  },120_000);

  it.each(['unrelated-domain','second-job'] as const)('requires a genuinely empty destination beyond visible importer tables: %s',async kind => {
    const f = await fixture();
    if (kind === 'unrelated-domain') await f.destination.query("INSERT INTO users(google_subject,canonical_email) VALUES('synthetic-local-only','local-only@example.invalid')");
    else await f.destination.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'unrelated','VALIDATED')",[TENANT]);
    const before = await f.destination.state([...DOMAIN,...FULL,'migration_jobs','users']);
    await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
    expect(await f.destination.state([...DOMAIN,...FULL,'migration_jobs','users'])).toEqual(before);
  },120_000);

  it.each(['tenantId','migrationJobId','generationId','expectedStateVersion','sourceFingerprint','manifestDigest'] as const)(
    'rejects caller %s substitution before destination writes',async key => {
      const f = await fixture();
      const before = await f.destination.state();
      const changed = key === 'tenantId' ? OTHER : key === 'expectedStateVersion' ? '99'
        : key.endsWith('Digest') || key === 'sourceFingerprint' ? sha256('substitution') : 'wrong';
      await expect(materializeLocalCandidate({...f.binding,[key]:changed},f.run)).rejects.toThrow();
      expect(await f.destination.state()).toEqual(before);
    },120_000);

  it.each(['owner','same-database','role','job','missing-marker','foreign-rows','destination-phase','source-phase','source-fingerprint',
    'destination-fingerprint','destination-lifecycle','source-lifecycle'] as const)(
    'refuses owned pair boundary %s',async kind => {
      const f = await fixture();
      if (kind === 'foreign-rows') await f.destination.query("INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'foreign','Other',1,1)",[OTHER]);
      else if (kind === 'source-phase') await f.source.query("UPDATE migration_jobs SET status='FREEZING',state_version=state_version+1");
      else if (kind === 'destination-phase') await f.destination.query("UPDATE migration_jobs SET status='IMPORTING',state_version=state_version+1");
      else if (kind === 'source-fingerprint') await f.source.query('UPDATE migration_jobs SET source_fingerprint=$1',[sha256('wrong')]);
      else if (kind === 'destination-fingerprint') await f.destination.query('UPDATE migration_jobs SET source_fingerprint=$1',[sha256('wrong')]);
      else if (kind === 'destination-lifecycle') await f.destination.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1",[TENANT]);
      else if (kind === 'source-lifecycle') await f.source.query("UPDATE tenants SET lifecycle='READY' WHERE id=$1",[TENANT]);
      else {
        await f.destination.query('ALTER TABLE migration_local_disposable_database DISABLE TRIGGER USER');
        if (kind === 'missing-marker') await f.destination.query('DELETE FROM migration_local_disposable_database');
        else if (kind === 'same-database') await f.destination.query('UPDATE migration_local_disposable_database SET database_id=$1',[f.source.id]);
        else if (kind === 'owner') await f.destination.query('UPDATE migration_local_disposable_database SET owner_id=$1',[randomUUID()]);
        else if (kind === 'role') await f.destination.query("UPDATE migration_local_disposable_database SET role='SOURCE'");
        else {
          await f.destination.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,'other','VALIDATED')",[TENANT]);
          await f.destination.query("UPDATE migration_local_disposable_database SET job_id='other'");
        }
        await f.destination.query('ALTER TABLE migration_local_disposable_database ENABLE TRIGGER USER');
      }
      const before = await f.destination.state(), original = await f.source.state();
      await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
      expect(await f.destination.state()).toEqual(before); expect(await f.source.state()).toEqual(original);
    },120_000);

  it.each(['header','envelope','target','source','mapping','contributor','delta','recapture','report'] as const)(
    'requires all source evidence: %s corruption cannot be repaired by materialization',async kind => {
      const f = await fixture();
      const table = {header:'migration_full_generations',envelope:'audit_events',target:'migration_full_targets',
        source:'migration_full_sources',mapping:'migration_full_mappings',contributor:'migration_full_contributors',
        delta:'migration_full_delta_entries',recapture:'migration_full_claim_recaptures',report:'migration_full_reconciliation'}[kind];
      await f.source.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      const mutation = {header:"SET manifest_digest=repeat('a',64)",envelope:"SET redacted_details=jsonb_set(redacted_details,'{artifactDigest}',to_jsonb(repeat('a',64))) WHERE event_type='MIGRATION_PREPARATION_CANDIDATE'",
        target:"SET canonical_value=jsonb_set(canonical_value,'{name}','\"Substitute\"') WHERE target_table='products'",
        source:"SET source_value=jsonb_set(source_value,'{redactedSourceRecord}','{}')",
        mapping:"SET mapping_value=jsonb_set(mapping_value,'{sourceDigest}',to_jsonb(repeat('b',64)))",
        contributor:'',delta:'',recapture:'',report:''}[kind];
      await f.source.query(mutation ? `UPDATE ${table} ${mutation}` : `DELETE FROM ${table}`);
      await f.source.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      const before = await f.destination.state(), original = await f.source.state();
      await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
      expect(await f.destination.state()).toEqual(before); expect(await f.source.state()).toEqual(original);
    },120_000);

  it.each(['missing-product','substituted-product','operation-binding','claim','receipt','checkpoint'] as const)(
    'exact retry refuses %s without silent repairs',async kind => {
      const f = await fixture();
      await materializeLocalCandidate(f.binding,f.run);
      const table = kind === 'receipt' ? 'migration_local_materializations' : kind === 'checkpoint' ? 'migration_source_records'
        : kind === 'claim' ? 'padlet_evidence_claims' : kind === 'operation-binding' ? 'operations' : 'products';
      await f.destination.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      if (kind === 'missing-product') await f.destination.query("DELETE FROM products WHERE product_id='P2'");
      else if (kind === 'substituted-product') await f.destination.query("UPDATE products SET name='same-count substitution' WHERE product_id='P2'");
      else if (kind === 'operation-binding') await f.destination.query("UPDATE operations SET payload_hash=repeat('a',64)");
      else if (kind === 'claim') await f.destination.query("UPDATE padlet_evidence_claims SET evidence_author_full_name='substitute'");
      else await f.destination.query(`DELETE FROM ${table}`);
      await f.destination.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      const before = await f.destination.state();
      await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
      expect(await f.destination.state()).toEqual(before);
    },120_000);

  it.each(['throw-claim','suppress-product','suppress-receipt'] as const)('rolls back all destination domain/import/receipt rows on %s',async kind => {
    const f = await fixture();
    const table = kind === 'throw-claim' ? 'padlet_evidence_claims' : kind === 'suppress-product' ? 'products' : 'migration_local_materializations';
    await f.destination.query(`CREATE FUNCTION domain_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${kind === 'throw-claim' ? "RAISE EXCEPTION 'synthetic failure';" : 'RETURN NULL;'} END $$`);
    await f.destination.query(`CREATE TRIGGER domain_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION domain_fail()`);
    const before = await f.destination.state(), original = await f.source.state();
    await expect(materializeLocalCandidate(f.binding,f.run)).rejects.toThrow();
    expect(await f.destination.state()).toEqual(before); expect(await f.source.state()).toEqual(original);
    await f.destination.query(`DROP TRIGGER domain_fail ON ${table}`);
    await expect(materializeLocalCandidate(f.binding,f.run)).resolves.toMatchObject({activationAllowed:false});
  },120_000);

  it('enforces runtime RLS/FK/immutable guards and never writes source even during an exact retry',async () => {
    const f = await fixture();
    await f.source.query("CREATE FUNCTION source_no_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'source write forbidden'; END $$");
    for (const table of [...DOMAIN,...FULL,'audit_events','migration_jobs','migration_sources','migration_source_records','migration_snapshots','tenants']) {
      await f.source.query(`CREATE TRIGGER source_no_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION source_no_write()`);
    }
    await materializeLocalCandidate(f.binding,f.run);
    await materializeLocalCandidate(f.binding,f.run);
    await expect(f.destination.run(TENANT,tx => tx.execute(sql`SELECT 1 FROM generator_grant_claims LIMIT 1`))).rejects.toThrow();
    expect((await f.destination.run(OTHER,tx => tx.execute(sql`SELECT * FROM migration_local_materializations`))).rows).toEqual([]);
    for (const table of ['migration_local_materializations','migration_local_disposable_database','transactions','adjustments','padlet_evidence_claims','padlet_claim_digest_tombstones']) {
      await expect(f.destination.run(TENANT,tx => tx.execute(sql`DELETE FROM ${sql.identifier(table)}`))).rejects.toThrow();
    }
    await expect(f.destination.run(TENANT,tx => tx.execute(sql`INSERT INTO accounts(tenant_id,student_id,balance) VALUES(${OTHER},'S1',0)`))).rejects.toThrow();
    await expect(f.destination.run(TENANT,tx => tx.execute(sql`INSERT INTO promotion_products(tenant_id,promotion_product_id,promotion_id,product_id) VALUES(${TENANT},'bad','missing','P1')`))).rejects.toThrow();
  },120_000);

  it('rejects absent/skipped runners and executable or augmented binding objects without touching a DB',async () => {
    const calls = vi.fn();
    const binding: LocalCandidateBinding = {tenantId:TENANT,migrationJobId:JOB,generationId:'local',expectedStateVersion:'1',
      sourceFingerprint:sha256('source'),manifestDigest:sha256('manifest')};
    await expect(materializeLocalCandidate(binding,undefined as never)).rejects.toThrow();
    await expect(materializeLocalCandidate(binding,async () => undefined as never)).rejects.toThrow();
    const proxy = new Proxy(binding,{get:calls,getPrototypeOf:calls,ownKeys:calls});
    const getter = {...binding}; Object.defineProperty(getter,'tenantId',{get:calls});
    for (const input of [proxy,getter,{...binding,manifest:{}},{...binding,expectedStateVersion:'01'}]) {
      await expect(materializeLocalCandidate(input, calls as never)).rejects.toThrow();
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it('requires an injected inspector runner before touching captures or any default connection',async () => {
    const inputAccess = vi.fn(() => Object.prototype);
    const input = new Proxy({}, {getPrototypeOf:inputAccess}) as FinalGenerationPreparationInput;
    for (const runner of [undefined,new Proxy(vi.fn(),{})]) {
      await expect(inspectLegacyFinalGeneration(input,runner as never)).rejects.toThrow();
    }
    expect(inputAccess).not.toHaveBeenCalled();
  });
});
