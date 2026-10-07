// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createDatabaseCatalogQueries } from '@/server/repositories/database/catalogQueries';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { taskHistoryFixture } from '../../../test-support/legacyTaskFixture';
import { createLegacyFullSnapshotImporter } from './importLegacyFullSnapshot';
import { parseLegacyFullSnapshot } from './legacyFullSnapshot';
import { canonicalJson, sha256 } from './validators';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import type { LegacyFinancialReview } from './legacyFinancialHistory';
import { readOfflineGoogleGrid } from './offlineGoogleGrid';
import { createHeaderIndex, parseTaskAssignmentRow, parseTaskCompletionRow } from '@/server/sheetsRows';
vi.mock('server-only',()=>({}));
const suite=process.env.RUN_REAL_POSTGRES==='1'?describe:describe.skip;
let db:DisposablePostgres;
function fixture(){
  const base=taskHistoryFixture();base.Settings.push(['classTimeZone','Asia/Seoul'],['currencyUnit','별'],['fontFamily','sans']);
  const tabs={...base, Products:[['productId','name','price','stock','isActive','imageUrl','category','sortOrder'],['P1','Product','5','41','TRUE','','','1']],
    Adjustments:[['adjustmentId','timestamp','studentId','amount','mode','operator']],
    Promotions:[['promotionId','name','description','type','value','buyQuantity','freeQuantity','startsAt','endsAt','isActive','sortOrder','createdAt','updatedAt','schemaVersion']],
    PromotionProducts:[['promotionProductId','promotionId','productId','createdAt','schemaVersion']]};
  return JSON.stringify({spreadsheetId:'synthetic-full',sheets:Object.entries(tabs).map(([title,rows])=>({properties:{title},data:[{rowData:rows.map(cells=>({values:cells.map(formattedValue=>({formattedValue}))}))}]}))});
}
async function seed(gridJson=fixture()){
  const tenantId=randomUUID(),migrationJobId=randomUUID(),sourceId=randomUUID();
  await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Full source test','IMPORTING')",[tenantId,'full-source-'+tenantId]);
  await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[tenantId,migrationJobId]);
  await db.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint,schema_version)
    VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5,4)`,[tenantId,migrationJobId,sourceId,sha256(tenantId),sha256(gridJson)]);
  return{tenantId,migrationJobId,sourceId,gridJson,capturedAt:'2026-09-29T09:36:55.078Z'};
}
const run=(input:Awaited<ReturnType<typeof seed>>)=>createLegacyFullSnapshotImporter(db.runTenantTransaction)(input);
suite('atomic complete private Sheets import',()=>{
  beforeAll(async()=>{expect(process.env.DATABASE_URL).toBeUndefined();db=await createDisposablePostgres();await db.owner.query('GRANT SELECT,INSERT ON legacy_transaction_origins,legacy_task_origins,legacy_full_snapshot_archives TO app_runtime');},60_000);
  afterAll(async()=>{if(db)expect(await db.close()).toMatchObject({containerRemoved:true,scratchRemoved:true});},60_000);
  it('imports definitions, current balances/stock and full history together, then reconciles exact retry',async()=>{
    const input=await seed(),first=await run(input);expect(first).toMatchObject({financialRows:1,assignmentRows:1,completionSourceRows:4,completionStateEvents:2,activated:false,claimsPublished:false});
    expect(await run(input)).toEqual({...first,replayed:true});
    expect((await db.owner.query('SELECT balance::text FROM accounts WHERE tenant_id=$1',[input.tenantId])).rows).toEqual([{balance:'120'}]);
    expect((await db.owner.query('SELECT stock::text FROM products WHERE tenant_id=$1',[input.tenantId])).rows).toEqual([{stock:'41'}]);
    expect((await db.owner.query("SELECT settings->>'fontFamily' AS font FROM tenant_settings WHERE tenant_id=$1",[input.tenantId])).rows[0].font).toBe('sans');
    expect((await db.owner.query('SELECT count(*)::int n FROM operations WHERE tenant_id=$1',[input.tenantId])).rows[0].n).toBe(0);
  });
  it('rolls all current data and history back when the final full archive write fails',async()=>{
    const input=await seed();await db.owner.query(`CREATE FUNCTION full_archive_fail_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'archive failure'; END $$;
      CREATE TRIGGER full_archive_fail_test BEFORE INSERT ON legacy_full_snapshot_archives FOR EACH ROW EXECUTE FUNCTION full_archive_fail_test()`);
    try{await expect(run(input)).rejects.toThrow();}finally{await db.owner.query('DROP TRIGGER full_archive_fail_test ON legacy_full_snapshot_archives; DROP FUNCTION full_archive_fail_test()');}
    for(const table of ['students','accounts','products','tasks','tenant_settings','transactions','transaction_items','task_assignments','task_completions','legacy_transaction_origins','legacy_task_origins','legacy_full_snapshot_archives']){
      expect((await db.owner.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,[input.tenantId])).rows[0].n).toBe(0);
    }
    expect((await run(input)).replayed).toBe(false);
  });
  it('refuses an occupied target and refuses current-state drift on a retry',async()=>{
    const occupied=await seed();await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'unrelated','Keep','ACTIVE')",[occupied.tenantId]);
    await expect(run(occupied)).rejects.toThrow(/empty business tables/);
    const input=await seed();await run(input);await db.owner.query('UPDATE products SET stock=99 WHERE tenant_id=$1',[input.tenantId]);
    await expect(run(input)).rejects.toThrow(/reconciliation mismatch/);
    expect((await db.owner.query('SELECT stock::text FROM products WHERE tenant_id=$1',[input.tenantId])).rows[0].stock).toBe('99');
  });
  it('retains deleted-task events through an immutable non-runnable identity without exposing a current task', async () => {
    const grid = JSON.parse(fixture());
    const tasks = grid.sheets.find((s: { properties: { title: string } }) => s.properties.title === 'Tasks');
    tasks.data[0].rowData = tasks.data[0].rowData.slice(0, 1);
    const input = await seed(JSON.stringify(grid)), first = await run(input);
    const query = createDatabaseTaskCycleQueries({ tenantId: input.tenantId, runTenantSnapshot: db.runTenantTransaction });
    expect(await query.listTaskCycleProjections({ includeInactive: true, now: input.capturedAt })).toEqual([]);
    expect((await query.getTaskCompletions()).length).toBe(2);
    const identity = (await db.owner.query("SELECT is_active,deleted_at IS NOT NULL AS sealed,current_schedule->'recurrence' AS recurrence FROM tasks WHERE tenant_id=$1", [input.tenantId])).rows;
    expect(identity).toEqual([{ is_active: false, sealed: true, recurrence: { type: 'UNAVAILABLE' } }]);
    await expect(db.owner.query('UPDATE tasks SET deleted_at=NULL,is_active=true WHERE tenant_id=$1', [input.tenantId])).rejects.toThrow(/immutable/);
    await expect(db.owner.query('DELETE FROM tasks WHERE tenant_id=$1', [input.tenantId])).rejects.toThrow(/immutable/);
    expect(await run(input)).toEqual({ ...first, replayed: true });
  });
  it.skipIf(!process.env.CRS_FRESH_PRIVATE_BASELINE)('imports the fresh deployed TEST business snapshot and reconciles an exact replay',async()=>{
    const gridJson=await readFile(process.env.CRS_FRESH_PRIVATE_BASELINE!,'utf8');
    const input={...await seed(gridJson),capturedAt:process.env.CRS_FRESH_CAPTURED_AT!};
    const start=performance.now(),result=await run(input),durationMs=performance.now()-start;
    expect(result).toMatchObject({physicalRows:59,businessRows:49,financialRows:13,assignmentRows:3,completionSourceRows:6,
      currentCounts:{students:4,accounts:4,products:4,tasks:2,promotions:1,promotion_products:1,tenant_settings:1},activated:false,claimsPublished:false});
    expect(await run(input)).toEqual({...result,replayed:true});
    if(process.env.CRS_FRESH_FULL_IMPORT_REPORT)await writeFile(process.env.CRS_FRESH_FULL_IMPORT_REPORT,
      JSON.stringify({...result,durationMs,nativePostgres:true,sourceArchiveReadbackMatched:true,currentStateReadbackMatched:true,
        credentialTabsExcluded:['Recovery'],fullA_BAccepted:false,limit:'Read-only source capture; writer freeze and Redis history not proven'},null,2)+'\n',{mode:0o600});
  });
  it.skipIf(!process.env.CRS_PRIVATE_BASELINE)('imports and reconciles all 43 representative business rows plus 10 headers in one native transaction',async()=>{
    const input=await seed(await readFile(process.env.CRS_PRIVATE_BASELINE!,'utf8'));const start=performance.now();const result=await run(input),durationMs=performance.now()-start;
    expect(result).toMatchObject({physicalRows:53,businessRows:43,financialRows:9,assignmentRows:3,completionSourceRows:6,completionStateEvents:4,
      currentCounts:{students:3,accounts:3,products:3,tasks:2,promotions:1,promotion_products:1,tenant_settings:1}});
    expect(await run(input)).toEqual({...result,replayed:true});
    const catalog=createDatabaseCatalogQueries({tenantId:input.tenantId,runTenantTransaction:db.runTenantTransaction});
    expect(await catalog.getPromotions()).toHaveLength(1);
    const tasks=createDatabaseTaskCycleQueries({tenantId:input.tenantId,runTenantSnapshot:db.runTenantTransaction});
    expect(await tasks.listTaskCycleProjections({includeInactive:true,now:'2026-09-30T00:00:00.000Z'})).toHaveLength(2);
    if(process.env.CRS_FULL_IMPORT_REPORT)await writeFile(process.env.CRS_FULL_IMPORT_REPORT,JSON.stringify({...result,durationMs,nativePostgres:true,
      sourceArchiveReadbackMatched:true,currentStateReadbackMatched:true,fullA_BAccepted:false,limit:'Redis and live acquisition not verified'},null,2)+'\n',{mode:0o600});
  });
  it.skipIf(!process.env.CRS_OPERATING_PRIVATE_BASELINE)('rehearses the approved operating copy with exact current states and a sealed absent task identity', async () => {
    const gridJson = await readFile(process.env.CRS_OPERATING_PRIVATE_BASELINE!, 'utf8');
    const financialReview: LegacyFinancialReview = JSON.parse(await readFile(process.env.CRS_OPERATING_FINANCIAL_REVIEW!, 'utf8'));
    const identity = JSON.parse(await readFile(process.env.CRS_OPERATING_OWNER_IDENTITY!, 'utf8'));
    const input = { ...await seed(gridJson), financialReview, capturedAt: process.env.CRS_OPERATING_CAPTURED_AT! };
    const ownerId = randomUUID();
    await db.owner.query('INSERT INTO users(id,google_subject,canonical_email) VALUES($1,$2,$3)', [ownerId, identity.subject, ownerId + '@example.test']);
    await db.owner.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')", [input.tenantId, ownerId]);
    const plan = await parseLegacyFullSnapshot(input), start = performance.now(), first = await run(input);
    expect(first).toMatchObject({ physicalRows: 3170, businessRows: 3159, financialRows: 1243, assignmentRows: 1112,
      completionSourceRows: 725, completionStateEvents: 305, activated: false, claimsPublished: false });
    const query = createDatabaseTaskCycleQueries({ tenantId: input.tenantId, runTenantSnapshot: db.runTenantTransaction });
    const sourceTabs = readOfflineGoogleGrid(gridJson).tabs;
    const sourceAssignments = sourceTabs.TaskAssignments.slice(1).map(r => parseTaskAssignmentRow(r, createHeaderIndex(sourceTabs.TaskAssignments[0]))).filter(r => r !== null);
    const sourceCompletions = sourceTabs.TaskCompletions.slice(1).map(r => parseTaskCompletionRow(r, createHeaderIndex(sourceTabs.TaskCompletions[0]))).filter(r => r !== null);
    const states: { taskIndex: number; assigned: number; completed: number; matches: boolean }[] = [];
    const stateOnly = (state: ReturnType<typeof projectTaskCycleState>) => ({ taskId: state.taskId, taskInstanceId: state.taskInstanceId,
      cycleId: state.cycle.cycleId, assigned: [...state.assignedStudentIds].sort(), completed: [...state.completedStudentIds].sort() });
    for (const [taskIndex, task] of plan.taskHistory.tasks.entries()) {
      const expected = projectTaskCycleState({ task, now: input.capturedAt,
        assignments: sourceAssignments, completions: sourceCompletions });
      const actual = await query.getTaskCycleState(task.taskId, input.capturedAt);
      const matches = sha256(canonicalJson(stateOnly(actual))) === sha256(canonicalJson(stateOnly(expected)));
      expect(matches, `task ${taskIndex} current business state`).toBe(true);
      states.push({ taskIndex, assigned: actual.assignedStudentIds.length, completed: actual.completedStudentIds.length, matches });
    }
    expect((await query.listTaskCycleProjections({ includeInactive: true, now: input.capturedAt })).length).toBe(8);
    const identities = (await db.owner.query("SELECT task_instance_id FROM tasks WHERE tenant_id=$1 AND current_schedule->>'legacyIdentityOnly'='true'", [input.tenantId])).rows;
    expect(identities.length).toBe(1);
    await expect(db.owner.query('UPDATE tasks SET deleted_at=NULL,is_active=true WHERE tenant_id=$1 AND task_instance_id=$2',
      [input.tenantId, identities[0].task_instance_id])).rejects.toThrow(/immutable/);
    expect(await run(input)).toEqual({ ...first, replayed: true });
    expect((await db.owner.query('SELECT count(*)::int n FROM operations WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
    if (process.env.CRS_OPERATING_IMPORT_REPORT) await writeFile(process.env.CRS_OPERATING_IMPORT_REPORT,
      JSON.stringify({ ...first, durationMs: performance.now() - start, nativePostgres: true, states, historicalIdentities: identities.length,
        financialReviewAudited: true, exactRetryMatched: true, limits: 'Private copy rehearsal; no live cutover or writer exclusion.' }, null, 2), { mode: 0o600 });
  }, 120_000);
});
