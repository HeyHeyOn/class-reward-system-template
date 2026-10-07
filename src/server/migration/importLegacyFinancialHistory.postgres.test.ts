// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createLegacyFinancialHistoryImporter } from './importLegacyFinancialHistory';
import { inspectLegacyFinancialDiscrepancies, parseLegacyFinancialHistory, type LegacyFinancialReview } from './legacyFinancialHistory';
import { sha256 } from './validators';
vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
let db: DisposablePostgres;
const sample = () => JSON.stringify({ spreadsheetId: 'synthetic-sheet', sheets: Object.entries({
  Settings: [['key','value'],['schemaVersion','4']],
  Students: [['studentId','name','balance','status'],['S1','Test student','120','ACTIVE']],
  Transactions: [['transactionId','timestamp','studentId','studentName','items','totalAmount','balanceBefore','balanceAfter','status','operator'],
    ['H1','2026-09-01T00:00:00.000Z','S1','Test student',JSON.stringify([{productId:'T1',name:'Legacy reward',price:-20,quantity:1,subtotal:-20}]),'-20','100','120','TASK_REWARD','bank']],
}).map(([title, rows]) => ({ properties: { title }, data: [{ rowData: rows.map(row => ({ values: row.map(formattedValue => ({ formattedValue })) })) }] })) });
async function seed(gridJson = sample(), financialReview?: LegacyFinancialReview) {
  const tenantId = randomUUID(), migrationJobId = randomUUID(), sourceId = randomUUID();
  const plan = parseLegacyFinancialHistory(gridJson, financialReview);
  await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Isolated history','IMPORTING')", [tenantId,'history-'+tenantId]);
  await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[tenantId,migrationJobId]);
  await db.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint,schema_version)
    VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5,4)`,[tenantId,migrationJobId,sourceId,sha256(tenantId),plan.sourceDigest]);
  for (const [studentId,balance] of Object.entries(plan.currentBalances)) {
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,$2,'Isolated student','ACTIVE')",[tenantId,studentId]);
    await db.owner.query('INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,$2,$3)',[tenantId,studentId,balance]);
  }
  await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active) VALUES($1,'unchanged-stock','Stock canary',5,41,true)",[tenantId]);
  return {tenantId,migrationJobId,sourceId,gridJson,financialReview};
}
async function mutableState(tenant: string) {
  return (await db.owner.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY student_id) FROM accounts a WHERE tenant_id=$1) accounts,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY product_id) FROM products p WHERE tenant_id=$1) products,
    (SELECT count(*)::int FROM operations WHERE tenant_id=$1) operations,
    (SELECT count(*)::int FROM inventory_ledger WHERE tenant_id=$1) inventory`,[tenant])).rows[0];
}
const run = (input: Awaited<ReturnType<typeof seed>>) => createLegacyFinancialHistoryImporter(db.runTenantTransaction)(input);
suite('legacy financial import on native PostgreSQL', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined(); db = await createDisposablePostgres();
    await db.owner.query('GRANT SELECT,INSERT ON legacy_transaction_origins TO app_runtime');
  },60_000);
  afterAll(async () => { if(db) expect(await db.close()).toMatchObject({containerRemoved:true,scratchRemoved:true}); },60_000);
  it('imports exact history into the real transaction reader, retries identically, and changes no current money or stock',async()=>{
    const input=await seed();const before=await mutableState(input.tenantId);
    const first=await run(input);expect(first).toMatchObject({transactions:1,items:1,replayed:false,modernOperationsCreated:0,activated:false});
    expect(await run(input)).toEqual({...first,replayed:true});expect(await mutableState(input.tenantId)).toEqual(before);
    expect((await db.owner.query('SELECT kind,operation_id FROM transactions WHERE tenant_id=$1',[input.tenantId])).rows)
      .toEqual([{kind:'LEGACY',operation_id:null}]);
  });
  it('seals exact owner approval in one immutable audit and rejects another owner or changed approval on replay', async () => {
    const gridJson = sample().replace('TASK_REWARD', 'CANCELLED'), subject = `review-owner-${randomUUID()}`;
    const review: LegacyFinancialReview = { policy: 'PRESERVE_RECORDED_BALANCES', sourceIdentityDigest: sha256('synthetic-sheet'),
      approvedBySubjectDigest: sha256(subject), approvalEvidenceDigest: sha256('explicit preservation decision'),
      discrepancies: inspectLegacyFinancialDiscrepancies(gridJson).discrepancies };
    const input = await seed(gridJson, review), ownerId = randomUUID();
    await db.owner.query('INSERT INTO users(id,google_subject,canonical_email) VALUES($1,$2,$3)', [ownerId, subject, ownerId + '@example.test']);
    await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [input.tenantId, ownerId]);
    const before = await mutableState(input.tenantId);
    await expect(run({ ...input, financialReview: { ...review, approvedBySubjectDigest: sha256('other owner') } })).rejects.toThrow(/review owner mismatch/);
    const first = await run(input); expect(await run(input)).toEqual({ ...first, replayed: true });
    const audit = (await db.owner.query("SELECT actor_user_id,redacted_details FROM audit_events WHERE tenant_id=$1 AND event_type='MIGRATION_FINANCIAL_DISCREPANCIES_PRESERVED'", [input.tenantId])).rows;
    expect(audit).toEqual([{ actor_user_id: ownerId, redacted_details: { sourceDigest: sha256(gridJson), review, balancesPreserved: true, inventedTransactions: 0 } }]);
    await expect(run({ ...input, financialReview: { ...review, approvalEvidenceDigest: sha256('different approval') } })).rejects.toThrow(/review readback mismatch/);
    await expect(db.owner.query('DELETE FROM audit_events WHERE tenant_id=$1', [input.tenantId])).rejects.toThrow(/immutable/);
    expect(await mutableState(input.tenantId)).toEqual(before);
  });
  it('refuses ACTIVE targets and mismatched source bindings',async()=>{
    const input=await seed();await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1",[input.tenantId]);
    await expect(run(input)).rejects.toThrow(/private migration target/);
    const other=await seed();await expect(run({...other,sourceId:input.sourceId})).rejects.toThrow(/source binding/);
    expect((await db.owner.query('SELECT count(*)::int n FROM transactions WHERE tenant_id=ANY($1::uuid[])',[[input.tenantId,other.tenantId]])).rows[0].n).toBe(0);
  });
  it('refuses an occupied destination without appending or replacing its ledger',async()=>{
    const input=await seed();await db.owner.query(`INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,
      legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot) VALUES($1,'unrelated',now(),'S1','Test','LEGACY',0,0,120,120,'fixture')`,[input.tenantId]);
    await expect(run(input)).rejects.toThrow(/source readback/);
    expect((await db.owner.query('SELECT transaction_id FROM transactions WHERE tenant_id=$1',[input.tenantId])).rows).toEqual([{transaction_id:'unrelated'}]);
  });
  it('rolls every inserted transaction and item back after a late source archive failure',async()=>{
    const input=await seed();const before=await mutableState(input.tenantId);
    await db.owner.query(`CREATE FUNCTION fail_origin_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'late failure'; END $$;
      CREATE TRIGGER fail_origin_test BEFORE INSERT ON legacy_transaction_origins FOR EACH ROW EXECUTE FUNCTION fail_origin_test()`);
    try { await expect(run(input)).rejects.toThrow(); }
    finally { await db.owner.query('DROP TRIGGER fail_origin_test ON legacy_transaction_origins; DROP FUNCTION fail_origin_test()'); }
    expect((await db.owner.query('SELECT count(*)::int n FROM transactions WHERE tenant_id=$1',[input.tenantId])).rows[0].n).toBe(0);
    expect((await db.owner.query('SELECT count(*)::int n FROM transaction_items WHERE tenant_id=$1',[input.tenantId])).rows[0].n).toBe(0);
    expect(await mutableState(input.tenantId)).toEqual(before);
  });
  it('isolates immutable provenance by tenant',async()=>{
    const a=await seed(),b=await seed();await run(a);
    expect(await db.runTenantTransaction(b.tenantId,async tx=>(await tx.execute(sql`SELECT transaction_id FROM legacy_transaction_origins WHERE tenant_id=${a.tenantId}`)).rows)).toEqual([]);
    await expect(db.owner.query('DELETE FROM legacy_transaction_origins WHERE tenant_id=$1',[a.tenantId])).rejects.toThrow(/immutable/);
  });
  it.skipIf(!process.env.CRS_PRIVATE_BASELINE)('imports and reads all nine real representative financial rows with no replayed financial effects',async()=>{
    const input=await seed(await readFile(process.env.CRS_PRIVATE_BASELINE!,'utf8'));const before=await mutableState(input.tenantId);
    const start=performance.now();const result=await run(input);const durationMs=performance.now()-start;
    expect(result).toMatchObject({transactions:9,items:9,reversals:2,netRecordedDelta:'20'});
    expect(await run(input)).toEqual({...result,replayed:true});expect(await mutableState(input.tenantId)).toEqual(before);
    if(process.env.CRS_FINANCIAL_IMPORT_REPORT) await writeFile(process.env.CRS_FINANCIAL_IMPORT_REPORT,JSON.stringify({
      scope:'FINANCIAL_HISTORY_ONLY_NOT_FULL_MIGRATION',...result,durationMs,nativePostgres:true,readerReadbackMatched:true,
      fullA_BAccepted:false,claimsPublished:false,
    },null,2)+'\n',{mode:0o600});
  });
});
