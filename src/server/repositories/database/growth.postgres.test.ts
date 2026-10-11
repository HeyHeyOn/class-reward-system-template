// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DEFAULT_PET_SETTINGS } from '@/domain/pet';
import { DEFAULT_CLASS_TREE_SETTINGS } from '@/domain/classTree';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createPetCommands } from './pets';
import { createClassTreeCommands } from './classTree';
import { createTaskLedgerCommands } from './taskLedger/commands';
import { createDatabaseTransactionCommands } from './transactionCommands';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
type Run = DisposablePostgres['runTenantTransaction'];
const dialect = new PgDialect();
let db: DisposablePostgres;

function instrument(before?: (query: string) => Promise<void> | void, after?: (query: string) => Promise<void> | void) {
  const queries: SQL[] = [];
  const run: Run = (tenantId, callback) => db.runTenantTransaction(tenantId, (tx) => callback(new Proxy(tx, {
    get(target, key) {
      if (key !== 'execute') return Reflect.get(target, key);
      return async (statement: SQL) => {
        const text = dialect.sqlToQuery(statement).sql;
        queries.push(statement); await before?.(text);
        const result = await target.execute(statement); await after?.(text);
        return result;
      };
    },
  })));
  return { run, queries, texts: () => queries.map((q) => dialect.sqlToQuery(q).sql) };
}
function gate() { let release!: () => void; const ready = new Promise<void>((resolve) => { release = resolve; }); return { ready, release }; }

suite('growth locking, reward limits and bounded reads on PostgreSQL', () => {
  beforeAll(async () => {
    db = await createDisposablePostgres();
    await db.owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime;`);
    await db.owner.query((await readFile('src/server/db/provisioning/runtimeGrants.sql', 'utf8')).replaceAll('crs_app_runtime', 'app_runtime'));
  }, 120_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  async function fixture() {
    const tenantId = randomUUID();
    await db.owner.query(`INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,'Synthetic')`, [tenantId, `growth-${tenantId}`]);
    await db.owner.query(`INSERT INTO students(tenant_id,student_id,name,status)
      SELECT $1,'S'||i,'Synthetic '||i,'ACTIVE' FROM generate_series(1,3)i`, [tenantId]);
    await db.owner.query(`INSERT INTO accounts(tenant_id,student_id,balance) SELECT $1,'S'||i,100 FROM generate_series(1,3)i`, [tenantId]);
    const dependencies = { tenantId, runTenantTransaction: db.runTenantTransaction };
    return { tenantId, dependencies, pets: createPetCommands(dependencies), tree: createClassTreeCommands(dependencies),
      ledger: createTaskLedgerCommands(dependencies) };
  }

  it('serializes adjustment and care in student/account→pet order without deadlock or lost growth', async () => {
    const f = await fixture();
    await f.pets.saveSettings({ ...DEFAULT_PET_SETTINGS, enabled: true });
    const adopted = await f.pets.adopt({ studentId: 'S1', operationId: randomUUID(), species: 'cat', name: '펫' });
    const held = gate(), release = gate(), adjusting = gate();
    const careTrace = instrument(undefined, async (q) => {
      if (q.includes('FOR UPDATE OF s, a')) { held.release(); await release.ready; }
    });
    const adjustTrace = instrument((q) => { if (q.includes('FOR UPDATE OF s, a')) adjusting.release(); });
    const care = createPetCommands({ ...f.dependencies, runTenantTransaction: careTrace.run })
      .care({ studentId: 'S1', operationId: randomUUID(), kind: 'WARM' });
    await held.ready;
    const adjustment = createPetCommands({ ...f.dependencies, runTenantTransaction: adjustTrace.run })
      .adjustGrowth({ petId: adopted.pet.petId, operationId: randomUUID(), amount: 1 });
    try {
      await Promise.race([adjusting.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Adjustment did not request account lock')), 2000))]);
      expect(adjustTrace.texts().some((q) => q.includes('FROM pets') && q.includes('FOR UPDATE'))).toBe(false);
    } finally { release.release(); }
    await Promise.all([care, adjustment]);
    expect((await f.pets.studentView('S1')).pet?.growth).toBe(2);
  }, 20_000);

  it('limits free WARM by student/day across graduation and concurrent new requests', async () => {
    const f = await fixture();
    await f.pets.saveSettings({ ...DEFAULT_PET_SETTINGS, enabled: true, goal: 1, rewardAmount: 100, feedDailyLimit: 0 });
    await f.pets.adopt({ studentId: 'S1', operationId: randomUUID(), species: 'dog', name: '첫째' });
    const results = await Promise.allSettled([1, 2].map(() => f.pets.care({ studentId: 'S1', operationId: randomUUID(), kind: 'WARM' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    await f.pets.graduate({ studentId: 'S1', operationId: randomUUID() });
    await f.pets.adopt({ studentId: 'S1', operationId: randomUUID(), species: 'cat', name: '둘째' });
    await expect(f.pets.care({ studentId: 'S1', operationId: randomUUID(), kind: 'WARM' })).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
    expect((await f.pets.studentView('S1')).warmedToday).toBe(true);
    expect((await db.owner.query('SELECT balance::int FROM accounts WHERE tenant_id=$1 AND student_id=$2', [f.tenantId, 'S1'])).rows[0].balance).toBe(200);
  });

  it('defers batch growth, reuses settings once, preserves goal stop/replay and cancellation projections', async () => {
    const f = await fixture();
    await f.pets.saveSettings({ ...DEFAULT_PET_SETTINGS, enabled: true });
    await f.tree.saveSettings({ ...DEFAULT_CLASS_TREE_SETTINGS, enabled: true, goal: 2 });
    for (const studentId of ['S1', 'S2', 'S3']) await f.pets.adopt({ studentId, operationId: randomUUID(), species: 'cat', name: '펫' });
    const task = await f.ledger.createTask({ operationId: randomUUID(), task: { title: 'Synthetic', description: '', reward: 10,
      isActive: true, sortOrder: 0, availableFrom: null, dueAt: null, prerequisiteTaskId: null },
      repeat: { recurrence: { type: 'NONE' }, resetStage: null }, students: ['S1', 'S2', 'S3'].map((studentId) => ({ studentId, stage: 'READY' as const })) });
    const trace = instrument();
    const request = { operationId: randomUUID(), changes: ['S1', 'S2', 'S3'].map((studentId) => ({ taskId: task.taskId, studentId, stage: 'COMPLETED' as const, withReward: true })) };
    const command = createTaskLedgerCommands({ ...f.dependencies, runTenantTransaction: trace.run });
    await command.setStages(request);
    const texts = trace.texts();
    expect(texts.filter((q) => q.includes('to_regclass'))).toHaveLength(1);
    expect(texts.filter((q) => q.includes('FROM growth_settings'))).toHaveLength(1);
    expect(texts.filter((q) => q.includes('FROM pet_settings'))).toHaveLength(1);
    const firstGrowth = texts.findIndex((q) => q.includes('INSERT INTO tree_drops'));
    expect(texts.findLastIndex((q) => q.includes('UPDATE operations'))).toBeLessThan(firstGrowth);
    expect(texts.findLastIndex((q) => q.includes('INSERT INTO task_completions'))).toBeLessThan(firstGrowth);
    await command.setStages(request);
    expect((await db.owner.query('SELECT count(*)::int n FROM tree_drops WHERE tenant_id=$1', [f.tenantId])).rows[0].n).toBe(2);
    expect((await db.owner.query('SELECT count(*)::int n FROM pet_growth WHERE tenant_id=$1', [f.tenantId])).rows[0].n).toBe(3);
    const transactionId = (await db.owner.query("SELECT transaction_id FROM transactions WHERE tenant_id=$1 AND student_id='S1' AND kind='TASK_REWARD'", [f.tenantId])).rows[0].transaction_id;
    await createDatabaseTransactionCommands(f.dependencies).cancel({ transactionId, operationId: randomUUID() });
    expect((await f.tree.studentView('S1')).tree?.drops).toBe(1);
    expect((await f.pets.studentView('S1')).pet?.growth).toBe(0);
    expect((await f.ledger.readTasks())[0].students.find((s) => s.studentId === 'S1')?.stage).toBe('READY');
    console.info('growth batch settings reads: capabilities=1 tree=1 pet=1 for3 rewards; tree effects=2 pet effects=3');
  }, 30_000);

  it('pages microsecond timestamp ties without gaps, isolates cursors and bounds collection/current reads', async () => {
    const f = await fixture();
    await f.pets.saveSettings({ ...DEFAULT_PET_SETTINGS, enabled: true });
    await f.pets.adopt({ studentId: 'S1', operationId: randomUUID(), species: 'dog', name: '현재' });
    const before = await f.pets.studentView('S1');
    await db.owner.query(`INSERT INTO pets(tenant_id,pet_id,student_id,species,color,name,stage,growth,status,adopted_at,hatched_at,
      graduated_at,graduate_operation_id,graduate_reward_amount,graduate_reward_item)
      SELECT $1,'history-'||lpad(i::text,4,'0'),'S1','cat','black','졸업',3,40,'GRADUATED','2026-01-01','2026-01-02',
        '2026-01-03 00:00:00.123000+00'::timestamptz + (i % 2) * interval '1 microsecond','fixture-'||i,0,''
      FROM generate_series(1,1000)i`, [f.tenantId]);
    await db.owner.query(`INSERT INTO pet_cares(tenant_id,care_id,pet_id,student_id,kind,care_date,operation_id,created_at)
      SELECT $1,'old-care-'||i,'history-0001','S1','FEED','2026-01-02','fixture-'||i,'2026-01-02'::timestamptz+i*interval '1 second'
      FROM generate_series(1,1000)i`, [f.tenantId]);
    await db.owner.query('ANALYZE pets; ANALYZE pet_cares');
    await f.pets.setCompanions({ studentId: 'S1', petIds: ['history-0001', 'history-0002'] });
    const trace = instrument();
    const pageCommands = createPetCommands({ ...f.dependencies, runTenantTransaction: trace.run });
    const current = await pageCommands.studentView('S1');
    expect({ ...current, companions: before.companions, lastFedAt: before.lastFedAt }).toEqual(before);
    expect(current.companions).toHaveLength(2);
    expect(current.dex).toEqual([]);
    const first = await pageCommands.dexPage('S1');
    expect(first.entries).toHaveLength(24); expect(first.collection).toHaveLength(1);
    await expect(pageCommands.dexPage('S2', first.nextCursor)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(pageCommands.dexPage('S1', 'invalid')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const ids = first.entries.map((p) => p.petId); let cursor = first.nextCursor;
    while (cursor) { const page = await f.pets.dexPage('S1', cursor); ids.push(...page.entries.map((p) => p.petId)); cursor = page.nextCursor; }
    const expected = (await db.owner.query("SELECT pet_id FROM pets WHERE tenant_id=$1 AND student_id='S1' AND status='GRADUATED' ORDER BY graduated_at DESC,pet_id DESC", [f.tenantId])).rows.map((p) => p.pet_id);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(1000);
    for (const [snippet, index] of [['AS fed', 'pet_cares_latest_feed_idx'], ['LIMIT $3', 'pets_graduated_history_idx'], ['AS wanted(species, color)', 'pets_graduated_collection_idx'], ['FROM pet_rooms r', 'pets_pkey']]) {
      const statement = trace.queries.find((q) => dialect.sqlToQuery(q).sql.includes(snippet));
      expect(statement, snippet).toBeDefined();
      const plan = await db.runTenantTransaction(f.tenantId, (tx) => tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement!}`));
      expect(JSON.stringify(plan.rows)).toContain(index);
    }
    await f.pets.saveSettings({ ...DEFAULT_PET_SETTINGS, enabled: false });
    const disabled = instrument();
    expect((await createPetCommands({ ...f.dependencies, runTenantTransaction: disabled.run }).studentView('S1')).enabled).toBe(false);
    expect(disabled.queries).toHaveLength(1);
    console.info('pet reads: history1000; page24; collection1; currentdex0; disabled SQL1; runtime RLS indexes verified');
  }, 30_000);

  it('uses cancellation index for tree contributions and preserves previous contribution results', async () => {
    const f = await fixture();
    await f.tree.saveSettings({ ...DEFAULT_CLASS_TREE_SETTINGS, enabled: true });
    const operationId = randomUUID();
    await f.tree.water({ studentId: 'S1', operationId });
    await f.tree.water({ studentId: 'S2', operationId: randomUUID() });
    await createDatabaseTransactionCommands(f.dependencies).cancel({ operationId: randomUUID(), transactionId: `tree-water:${operationId}` });
    await db.owner.query(`INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,kind,
      legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot)
      SELECT $1,'history-'||i,clock_timestamp(),'S1','Synthetic','LEGACY',0,0,100,100,'fixture' FROM generate_series(1,5000)i`, [f.tenantId]);
    await db.owner.query('ANALYZE transactions; ANALYZE tree_drops; ANALYZE students');
    const trace = instrument();
    const board = await createClassTreeCommands({ ...f.dependencies, runTenantTransaction: trace.run }).adminBoard();
    expect(board.contributions.map((s) => s.total)).toEqual([0, 1, 0]);
    const statement = trace.queries.find((q) => dialect.sqlToQuery(q).sql.includes('LEFT JOIN transactions r'))!;
    const compiled = dialect.sqlToQuery(statement);
    const old = await db.owner.query(compiled.sql.replace(" AND r.kind='CANCELLATION'", ''), compiled.params);
    const current = await db.owner.query(compiled.sql, compiled.params);
    expect(current.rows).toEqual(old.rows);
    const plan = await db.runTenantTransaction(f.tenantId, (tx) => tx.execute(sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`));
    expect(JSON.stringify(plan.rows)).toContain('transactions_cancellation_lookup_idx');
    console.info('tree contributions: unchanged cancelled/live totals; runtime RLS cancellation index used with5000 unrelated transactions');
  }, 20_000);
});
