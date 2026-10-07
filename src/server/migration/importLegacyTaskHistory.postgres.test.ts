// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import { createDatabaseTaskCompletionCommand } from '@/server/repositories/database/taskCompletionCommands';
import { createDatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { createDatabaseAdminCommands } from '@/server/repositories/database/adminCommands';
import { createDatabaseTransactionCommands } from '@/server/repositories/database/transactionCommands';
import { createDatabaseTransactionQueries } from '@/server/repositories/database/transactionQueries';
import { taskHistoryFixture, taskHistoryGrid, taskHistoryCarryFixture } from '../../../test-support/legacyTaskFixture';
import { parseLegacyTaskHistory } from './legacyTaskHistory';
import { parseLegacyFinancialHistory } from './legacyFinancialHistory';
import { createLegacyFinancialHistoryImporter } from './importLegacyFinancialHistory';
import { createLegacyTaskHistoryImporter } from './importLegacyTaskHistory';
import { sha256 } from './validators';
vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
let db: DisposablePostgres;
async function seed(gridJson = taskHistoryGrid()) {
  const tenantId = randomUUID(), migrationJobId = randomUUID(), sourceId = randomUUID();
  const plan = parseLegacyTaskHistory(gridJson), money = parseLegacyFinancialHistory(gridJson);
  await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Isolated task history','IMPORTING')", [tenantId,'task-history-'+tenantId]);
  await db.owner.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [tenantId,migrationJobId]);
  await db.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint,schema_version)
    VALUES($1,$2,$3,'GOOGLE_SHEETS',$4,$5,4)`,[tenantId,migrationJobId,sourceId,sha256(tenantId),plan.sourceDigest]);
  for(const [studentId,balance] of Object.entries(money.currentBalances)) {
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,$2,'Test student','ACTIVE')",[tenantId,studentId]);
    await db.owner.query('INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,$2,$3)',[tenantId,studentId,balance]);
  }
  for(const task of plan.tasks) {
    await db.owner.query(`INSERT INTO tasks(tenant_id,task_id,task_instance_id,title,description,reward,is_active,sort_order,current_schedule,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)`,[tenantId,task.taskId,task.taskInstanceId,task.title,task.description,task.reward,task.isActive,task.sortOrder,JSON.stringify(task.schedule),task.createdAt]);
    for(const student of task.allowedStudentIds) await db.owner.query('INSERT INTO task_allowed_students(tenant_id,task_instance_id,student_id) VALUES($1,$2,$3)',[tenantId,task.taskInstanceId,student]);
  }
  const input = { tenantId,migrationJobId,sourceId,gridJson };
  await createLegacyFinancialHistoryImporter(db.runTenantTransaction)(input);
  return {input,plan};
}
const run = (input: Awaited<ReturnType<typeof seed>>['input']) => createLegacyTaskHistoryImporter(db.runTenantTransaction)(input);
const query = (tenantId: string) => createDatabaseTaskCycleQueries({tenantId,runTenantSnapshot:db.runTenantTransaction});
const balances = async (tenantId: string) => (await db.owner.query('SELECT student_id,balance::text,version::text FROM accounts WHERE tenant_id=$1 ORDER BY student_id',[tenantId])).rows;
suite('legacy task state and new operations on native PostgreSQL',()=>{
  beforeAll(async()=>{ expect(process.env.DATABASE_URL).toBeUndefined();db=await createDisposablePostgres();
    await db.owner.query('GRANT SELECT,INSERT ON legacy_task_origins,legacy_transaction_origins TO app_runtime'); },60_000);
  afterAll(async()=>{if(db) expect(await db.close()).toMatchObject({containerRemoved:true,scratchRemoved:true});},60_000);
  it('preserves a historical UNASSIGNED carry through native SQL, protected origins and the application reader', async () => {
    const { input } = await seed(taskHistoryGrid(taskHistoryCarryFixture(false)));
    const before = await balances(input.tenantId);
    const first = await run(input);
    expect(first).toMatchObject({ assignmentRows: 3, completionStateEvents: 2 });
    const snapshot = await query(input.tenantId).loadTaskCycleLedgerSnapshot();
    expect(snapshot.assignments.at(-1)).toMatchObject({ assignmentId: 'CARRY1', source: 'CARRY_FORWARD',
      status: 'UNASSIGNED', previousAssignmentId: 'A2' });
    expect(await run(input)).toEqual({ ...first, replayed: true });
    expect(await balances(input.tenantId)).toEqual(before);
    expect((await db.owner.query('SELECT count(*)::int n FROM operations WHERE tenant_id=$1', [input.tenantId])).rows[0].n).toBe(0);
  });
  it('archives every checkpoint, imports one reward state, reads reset state, and retries without money or operation writes',async()=>{
    const {input}=await seed();const before=await balances(input.tenantId);
    const first=await run(input);expect(first).toMatchObject({assignmentRows:1,completionRows:4,completionStateEvents:2,bankRewards:1,replayed:false});
    expect(await run(input)).toEqual({...first,replayed:true});
    expect(await balances(input.tenantId)).toEqual(before);
    const projections=await query(input.tenantId).listTaskCycleProjections({now:'2026-09-02T00:00:00.000Z',studentId:'S1'});
    expect(projections).toHaveLength(1);
    expect((await db.owner.query('SELECT count(*)::int n FROM operations WHERE tenant_id=$1',[input.tenantId])).rows[0].n).toBe(0);
  });
  it('refuses a second reward after a historical success, and accepts exactly one new command after an explicit historical reset',async()=>{
    const tabs=taskHistoryFixture();tabs.TaskCompletions.pop();const complete=await seed(taskHistoryGrid(tabs));await run(complete.input);
    const command=(tenantId:string)=>createDatabaseTaskCompletionCommand({tenantId,runTenantTransaction:db.runTenantTransaction,
      padletClaims:createDatabasePadletClaimRepository(),now:()=>new Date('2026-10-01T00:00:00.000Z')});
    // Activating owned fixtures only; this is not the production cutover service.
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1",[complete.input.tenantId]);
    await expect(command(complete.input.tenantId).execute({operationId:randomUUID(),taskId:'T1',studentId:'S1'})).rejects.toMatchObject({code:'POLICY'});
    const reset=await seed();await run(reset.input);await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1",[reset.input.tenantId]);
    await expect(command(reset.input.tenantId).execute({operationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',taskId:'T1',studentId:'S1'})).rejects.toMatchObject({code:'OPERATION_CONFLICT'});
    const request={operationId:randomUUID(),taskId:'T1',studentId:'S1'};const first=await command(reset.input.tenantId).execute(request);
    expect(first).toMatchObject({reward:20,balanceBefore:120,balanceAfter:140});
    expect(await command(reset.input.tenantId).execute(request)).toEqual(first);
    await expect(command(reset.input.tenantId).execute({...request,operationId:randomUUID()})).rejects.toMatchObject({code:'POLICY'});
  });
  it('allows one concurrent reward cancellation into a negative balance on native PostgreSQL', async () => {
    const { input } = await seed(); await run(input);
    const tenantId = input.tenantId;
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenantId]);
    const dependency = { tenantId, runTenantTransaction: db.runTenantTransaction };
    const reward = await createDatabaseTaskCompletionCommand({ ...dependency,
      padletClaims: createDatabasePadletClaimRepository(), now: () => new Date('2026-10-01T00:00:00Z') })
      .execute({ operationId: randomUUID(), taskId: 'T1', studentId: 'S1' });
    await createDatabaseAdminCommands({ ...dependency, now: () => new Date('2026-10-01T00:01:00Z') })
      .adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
    const command = createDatabaseTransactionCommands({ ...dependency, now: () => new Date('2026-10-01T00:02:00Z') });
    const requests = [randomUUID(), randomUUID()].map(operationId => ({ operationId, transactionId: reward.transactionId }));
    const results = await Promise.allSettled(requests.map(request => command.cancel(request)));
    const winners = results.filter(result => result.status === 'fulfilled');
    const losers = results.filter(result => result.status === 'rejected');
    expect(winners).toHaveLength(1); expect(losers).toHaveLength(1);
    expect(losers[0].reason).toMatchObject({ code: 'ALREADY_REVERSED' });
    const result = winners[0].value;
    expect(result).toMatchObject({ balanceBefore: 5, balanceAfter: -15, reversalAmount: -20 });
    const beforeRetry = await balances(tenantId);
    expect(beforeRetry[0].balance).toBe('-15');
    expect(await command.cancel({ operationId: result.operationId, transactionId: reward.transactionId })).toEqual(result);
    expect(await balances(tenantId)).toEqual(beforeRetry);
    const pair = await createDatabaseTransactionQueries(dependency).getCancellationPair(reward.transactionId, result.reversalTransactionId);
    expect(pair.cancelledTransaction.status).toBe('CANCELLED');
    expect(pair.reversalTransaction).toMatchObject({ status: 'CANCEL_REVERSAL', balanceBefore: 5, balanceAfter: -15 });
    expect((await db.owner.query(`SELECT balance_before::text, balance_after::text FROM task_completions
      WHERE tenant_id=$1 AND transaction_id=$2 AND status='CANCELLED'`, [tenantId, result.reversalTransactionId])).rows)
      .toEqual([{ balance_before: '5', balance_after: '-15' }]);
    expect((await db.owner.query(`SELECT count(*)::int n FROM transactions WHERE tenant_id=$1 AND reverses_transaction_id=$2`,
      [tenantId, reward.transactionId])).rows[0].n).toBe(1);
    expect((await db.owner.query(`SELECT count(*)::int n FROM operations WHERE tenant_id=$1 AND operation_kind='CANCELLATION'`,
      [tenantId])).rows[0].n).toBe(1);
  });
  it('cancels an imported reward after its historical reset without clearing a newer completion', async () => {
    const { input } = await seed(); await run(input);
    const tenantId = input.tenantId;
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenantId]);
    const dependency = { tenantId, runTenantTransaction: db.runTenantTransaction };
    const task = createDatabaseTaskCompletionCommand({ ...dependency,
      padletClaims: createDatabasePadletClaimRepository(), now: () => new Date('2026-10-01T00:00:00Z') });
    await task.execute({ operationId: randomUUID(), taskId: 'T1', studentId: 'S1' });
    await createDatabaseAdminCommands({ ...dependency, now: () => new Date('2026-10-01T00:01:00Z') })
      .adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
    const command = createDatabaseTransactionCommands({ ...dependency, now: () => new Date('2026-10-01T00:02:00Z') });
    const request = { operationId: randomUUID(), transactionId: 'TASK-LOGICAL-C1' };
    const result = await command.cancel(request);
    expect(result).toMatchObject({ originalKind: 'LEGACY', balanceBefore: 5, balanceAfter: -15,
      cancellationCompletionId: null });
    expect(result.originalCompletionId).not.toBeNull();
    expect(await command.cancel(request)).toEqual(result);
    await expect(command.cancel({ ...request, operationId: randomUUID() })).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
    const state = await query(tenantId).getTaskCycleState('T1', '2026-10-01T00:03:00Z');
    expect(state.students.S1.completed).toBe(true);
    await expect(task.execute({ operationId: randomUUID(), taskId: 'T1', studentId: 'S1' })).rejects.toMatchObject({ code: 'POLICY' });
    const pair = await createDatabaseTransactionQueries(dependency).getCancellationPair(request.transactionId, result.reversalTransactionId);
    expect(pair.cancelledTransaction.status).toBe('CANCELLED');
    expect(pair.reversalTransaction.balanceAfter).toBe(-15);
    expect((await db.owner.query('SELECT count(*)::int n FROM task_completions WHERE tenant_id=$1', [tenantId])).rows[0].n).toBe(3);
  });
  it('cancels a still-completed imported reward with a modern reset and retains the historical operation reservation', async () => {
    const tabs = taskHistoryFixture(); tabs.TaskCompletions.pop();
    const { input } = await seed(taskHistoryGrid(tabs)); await run(input);
    const tenantId = input.tenantId;
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenantId]);
    const dependency = { tenantId, runTenantTransaction: db.runTenantTransaction };
    await createDatabaseAdminCommands({ ...dependency, now: () => new Date('2026-10-01T00:00:00Z') })
      .adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
    const command = createDatabaseTransactionCommands({ ...dependency, now: () => new Date('2026-10-01T00:01:00Z') });
    const request = { operationId: randomUUID(), transactionId: 'TASK-LOGICAL-C1' };
    const result = await command.cancel(request);
    expect(result).toMatchObject({ originalKind: 'LEGACY', balanceBefore: 5, balanceAfter: -15,
      cancellationCompletionId: `task-completion-cancellation:${request.operationId}` });
    expect(await command.cancel(request)).toEqual(result);
    expect((await query(tenantId).getTaskCycleState('T1', '2026-10-01T00:02:00Z')).students.S1.completed).toBe(false);
    const task = createDatabaseTaskCompletionCommand({ ...dependency,
      padletClaims: createDatabasePadletClaimRepository(), now: () => new Date('2026-10-01T00:03:00Z') });
    await expect(task.execute({ operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', taskId: 'T1', studentId: 'S1' }))
      .rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await task.execute({ operationId: randomUUID(), taskId: 'T1', studentId: 'S1' }))
      .toMatchObject({ balanceBefore: -15, balanceAfter: 5, reward: 20 });
    expect(await command.cancel(request)).toEqual(result);
    expect((await query(tenantId).getTaskCycleState('T1', '2026-10-01T00:04:00Z')).students.S1.completed).toBe(true);
  });
  it('reverses imported administrator credits and purchases once, restoring only purchase stock', async () => {
    const tabs = taskHistoryFixture();
    tabs.Students[1][2] = '110';
    tabs.Transactions.push(
      ['OLD-CREDIT', '2026-09-01T00:03:00.000Z', 'S1', 'Test student', JSON.stringify([{ productId: 'P1', name: 'Admin credit', price: -20, quantity: 1, subtotal: -20 }]), '-20', '120', '140', 'ADMIN_ADJUSTMENT', 'admin'],
      ['OLD-PURCHASE', '2026-09-01T00:04:00.000Z', 'S1', 'Test student', JSON.stringify([{ productId: 'P1', name: 'Test product', price: 30, quantity: 1, subtotal: 30 }]), '30', '140', '110', 'COMPLETED', 'kiosk'],
    );
    const { input } = await seed(taskHistoryGrid(tabs)); await run(input);
    const tenantId = input.tenantId;
    await db.owner.query("INSERT INTO products(tenant_id,product_id,name,price,stock,is_active,sort_order) VALUES($1,'P1','Test product',30,2,true,1)", [tenantId]);
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenantId]);
    const dependency = { tenantId, runTenantTransaction: db.runTenantTransaction };
    await createDatabaseAdminCommands({ ...dependency, now: () => new Date('2026-10-01T00:00:00Z') })
      .adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
    const command = createDatabaseTransactionCommands({ ...dependency, now: () => new Date('2026-10-01T00:01:00Z') });
    const attempts = await Promise.allSettled([randomUUID(), randomUUID()].map(operationId =>
      command.cancel({ operationId, transactionId: 'OLD-CREDIT' })));
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.find(r => r.status === 'fulfilled')!.value).toMatchObject({ balanceBefore: 5, balanceAfter: -15, restoredItems: [] });
    expect((await db.owner.query('SELECT stock::text FROM products WHERE tenant_id=$1', [tenantId])).rows).toEqual([{ stock: '2' }]);
    const request = { operationId: randomUUID(), transactionId: 'OLD-PURCHASE' };
    const purchase = await command.cancel(request);
    expect(purchase).toMatchObject({ balanceBefore: -15, balanceAfter: 15, restoredItems: [{ productId: 'P1', productName: 'Test product', quantity: 1 }] });
    expect(await command.cancel(request)).toEqual(purchase);
    const history = await createDatabaseTransactionQueries(dependency).getTransactions();
    expect(history.find(t => t.transactionId === 'OLD-PURCHASE')!.status).toBe('CANCELLED');
    expect((await db.owner.query('SELECT stock::text FROM products WHERE tenant_id=$1', [tenantId])).rows).toEqual([{ stock: '3' }]);
  });
  it('rolls back imported cancellation on a late failure and refuses a legacy label without source provenance', async () => {
    const { input } = await seed(); await run(input);
    const tenantId = input.tenantId;
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenantId]);
    const dependency = { tenantId, runTenantTransaction: db.runTenantTransaction,
      now: () => new Date('2026-10-01T00:00:00Z') };
    const before = await balances(tenantId);
    await expect(createDatabaseTransactionCommands({ ...dependency,
      afterReversalTransaction: async () => { throw new Error('test late failure'); } })
      .cancel({ operationId: randomUUID(), transactionId: 'TASK-LOGICAL-C1' })).rejects.toThrow('test late failure');
    expect(await balances(tenantId)).toEqual(before);
    expect((await db.owner.query('SELECT count(*)::int n FROM operations WHERE tenant_id=$1', [tenantId])).rows[0].n).toBe(0);
    expect((await db.owner.query("SELECT count(*)::int n FROM transactions WHERE tenant_id=$1 AND kind='CANCELLATION'", [tenantId])).rows[0].n).toBe(0);
    await db.owner.query(`INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,
      legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot,legacy_status_snapshot)
      VALUES($1,'UNPROVEN','2026-09-01T00:03:00Z','S1','Test student','LEGACY',-20,20,100,120,'admin','ADMIN_ADJUSTMENT')`, [tenantId]);
    await expect(createDatabaseTransactionCommands(dependency).cancel({ operationId: randomUUID(), transactionId: 'UNPROVEN' }))
      .rejects.toMatchObject({ code: 'MANUAL_RECONCILIATION_REQUIRED' });
    expect(await balances(tenantId)).toEqual(before);
  });
  it('does not waive modern administrator binding or allow history inserts into ACTIVE tenants',async()=>{
    const {input}=await seed();await run(input);
    await expect(db.owner.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,event_type,source)
      SELECT tenant_id,'fake-modern',task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,'ASSIGNED','ADMIN'
      FROM task_assignments WHERE tenant_id=$1 LIMIT 1`,[input.tenantId])).rejects.toThrow(/admin operation binding/);
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1",[input.tenantId]);
    await expect(run(input)).rejects.toThrow(/private migration target/);
    await expect(db.owner.query('DELETE FROM legacy_task_origins WHERE tenant_id=$1',[input.tenantId])).rejects.toThrow(/immutable/);
  });
  it('serializes concurrent imports and rejects a historical marker copied onto a different event',async()=>{
    const {input}=await seed();const results=await Promise.all([run(input),run(input)]);
    expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
    await expect(db.owner.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,event_type,source,legacy_origin_id,created_at)
      SELECT tenant_id,'forged-history',task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,event_type,source,legacy_origin_id,created_at
      FROM task_assignments WHERE tenant_id=$1 LIMIT 1`,[input.tenantId])).rejects.toThrow(/legacy task target mismatch/);
  });
  it('rolls back the entire task history when its last completion insert fails',async()=>{
    const {input}=await seed();const before=await balances(input.tenantId);
    await db.owner.query(`CREATE FUNCTION fail_task_history_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source='ADMIN_RESET' THEN RAISE EXCEPTION 'late task failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_task_history_test BEFORE INSERT ON task_completions FOR EACH ROW EXECUTE FUNCTION fail_task_history_test()`);
    try{await expect(run(input)).rejects.toThrow();}finally{await db.owner.query('DROP TRIGGER fail_task_history_test ON task_completions; DROP FUNCTION fail_task_history_test()');}
    for(const table of ['task_assignments','task_completions','legacy_task_origins']) expect((await db.owner.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,[input.tenantId])).rows[0].n).toBe(0);
    expect(await balances(input.tenantId)).toEqual(before);
  });
  it.skipIf(!process.env.CRS_PRIVATE_BASELINE)('imports all representative task source rows and reads current task state',async()=>{
    const {input,plan}=await seed(await readFile(process.env.CRS_PRIVATE_BASELINE!,'utf8'));const before=await balances(input.tenantId);
    const started=performance.now();const result=await run(input);const durationMs=performance.now()-started;
    expect(result).toMatchObject({assignmentRows:3,completionRows:6,completionStateEvents:4,bankRewards:1});
    expect(await run(input)).toEqual({...result,replayed:true});
    expect(await balances(input.tenantId)).toEqual(before);
    expect(await query(input.tenantId).listTaskCycleProjections({now:'2026-09-30T00:00:00.000Z'})).toHaveLength(plan.tasks.length);
    if(process.env.CRS_TASK_IMPORT_REPORT) await writeFile(process.env.CRS_TASK_IMPORT_REPORT,JSON.stringify({scope:'TASK_HISTORY_ONLY_NOT_FULL_MIGRATION',...result,durationMs,
      nativePostgres:true,readerReadbackMatched:true,fullA_BAccepted:false,claimsPublished:false},null,2)+'\n',{mode:0o600});
  });
  it.skipIf(!process.env.CRS_PRIVATE_BASELINE)('cancels all eligible representative historical credits while preserving existing reversals and source archives', async () => {
    const grid = await readFile(process.env.CRS_PRIVATE_BASELINE!, 'utf8');
    const money = parseLegacyFinancialHistory(grid);
    const { input } = await seed(grid); await run(input);
    const tenantId = input.tenantId;
    await db.owner.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenantId]);
    const dependency = { tenantId, runTenantTransaction: db.runTenantTransaction };
    const command = createDatabaseTransactionCommands({ ...dependency, now: () => new Date('2026-10-05T00:00:00Z') });
    const originalArchives = (await db.owner.query('SELECT * FROM legacy_transaction_origins WHERE tenant_id=$1 ORDER BY source_row_number', [tenantId])).rows;
    const beforeCompletions = (await db.owner.query('SELECT * FROM task_completions WHERE tenant_id=$1 ORDER BY event_sequence', [tenantId])).rows;
    const initial = await balances(tenantId);
    const expected = new Map(initial.map(row => [row.student_id, Number(row.balance)]));
    let successes = 0;
    for (const row of money.records) {
      const request = { operationId: randomUUID(), transactionId: row.transaction.transactionId };
      if (row.transaction.status === 'CANCELLED') {
        await expect(command.cancel(request)).rejects.toMatchObject({ code: 'ALREADY_REVERSED' });
      } else if (row.transaction.status === 'CANCEL_REVERSAL') {
        await expect(command.cancel(request)).rejects.toMatchObject({ code: 'NOT_REVERSIBLE' });
      } else {
        const result = await command.cancel(request);
        expect(await command.cancel(request)).toEqual(result);
        expected.set(row.transaction.studentId, expected.get(row.transaction.studentId)! - row.balanceDelta);
        expect(result.balanceAfter).toBe(expected.get(row.transaction.studentId));
        expect(result.cancellationCompletionId).toBeNull();
        successes++;
      }
    }
    expect(successes).toBe(5);
    for (const row of await balances(tenantId)) expect(Number(row.balance)).toBe(expected.get(row.student_id));
    expect((await db.owner.query('SELECT * FROM legacy_transaction_origins WHERE tenant_id=$1 ORDER BY source_row_number', [tenantId])).rows).toEqual(originalArchives);
    expect((await db.owner.query('SELECT * FROM task_completions WHERE tenant_id=$1 ORDER BY event_sequence', [tenantId])).rows).toEqual(beforeCompletions);
    const history = await createDatabaseTransactionQueries(dependency).getTransactions();
    expect(history).toHaveLength(14);
    expect(history.filter(row => row.status === 'CANCELLED')).toHaveLength(7);
    expect(history.filter(row => row.status === 'CANCEL_REVERSAL')).toHaveLength(7);
    await query(tenantId).listTaskCycleProjections({ now: '2026-10-05T00:01:00Z' });
  });
});
