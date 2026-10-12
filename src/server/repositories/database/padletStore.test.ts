// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PadletPost } from '@/domain/padlet';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { RunTenantTransaction } from './taskLedger/migration';
import { createTaskLedgerCommands } from './taskLedger/commands';
import { claimPadletBoardSync, deletePadletLinks, lockPadletBoardSyncAttempt, readPadletBoardSyncs,
  recordPadletBoardSync, writePadletLinks } from './padletStore';

vi.mock('server-only', () => ({}));
const REAL = process.env.RUN_REAL_POSTGRES === '1';
const BOARD = 'syntheticboard01';
const FROM = '2026-01-01T00:00:00.000Z';
let native: DisposablePostgres | undefined;
let lite: PgliteDatabaseHarness | undefined;
let run: RunTenantTransaction;
const owner = (text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> =>
  native ? native.owner.query(text, values) : lite!.database.query(text, values);
const exec = async (text: string) => { if (native) await native.owner.query(text); else await lite!.database.exec(text); };

beforeAll(async () => {
  if (REAL) { native = await createDisposablePostgres(); run = native.runTenantTransaction; }
  else {
    lite = await createPgliteDatabaseHarness({ migrationSet: 'base' });
    for (const name of (await readdir(resolve('src/server/db/migrations'))).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
      await lite.database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
    }
    run = lite.runTenantTransaction;
  }
  await exec(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime;`);
  await exec((await readFile(resolve('src/server/db/provisioning/runtimeGrants.sql'), 'utf8')).replace(/\bcrs_app_runtime\b/g, 'app_runtime'));
}, 120_000);
afterAll(async () => { await native?.close(); await lite?.close(); }, 30_000);

async function fixture() {
  const tenant = randomUUID();
  await owner("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$3,'ACTIVE')", [tenant, `synthetic-${tenant}`, 'Synthetic']);
  await owner("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','Synthetic Student','ACTIVE')", [tenant]);
  await owner("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'S1',100)", [tenant]);
  const schedule = { ruleVersion: 1, effectiveFrom: FROM, timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false };
  await owner(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule,created_at,updated_at)
    VALUES($1,'task-a','T001','Synthetic task','',0,$2,$3,$3)`, [tenant, JSON.stringify(schedule), FROM]);
  await owner(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,
    started_at,finished_at,created_at,updated_at) VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,$3,$4,$5,$5,$5,$5)`,
  [tenant, 'a'.repeat(64), 'SUCCEEDED', JSON.stringify({ ledgerFrom: FROM }), FROM]);
  await owner(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,note,
    source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
    VALUES($1,'seed','task-a','T001','S1','ASSIGNED','stage:pending','CARRY_FORWARD','ledger',$2,1,'Asia/Seoul',$2)`, [tenant, FROM]);
  await run(tenant, (tx) => writePadletLinks(tx, tenant, ['task-a'], { boardId: BOARD, boardTitle: 'Synthetic board',
    boardUrl: `https://padlet.com/padlets/${BOARD}`, sectionId: null, sectionTitle: null }));
  const commands = createTaskLedgerCommands({ tenantId: tenant, runTenantTransaction: run });
  const claim = (manual = false) => run(tenant, (tx) => claimPadletBoardSync(tx, tenant, BOARD, 20, manual));
  const record = (attempt: string | undefined, ok = true, errorCode = 'TIMEOUT') => run(tenant, (tx) =>
    recordPadletBoardSync(tx, tenant, BOARD, ok ? { ok: true, summary: [] } : { ok: false, errorCode }, attempt));
  const state = () => run(tenant, async (tx) => (await readPadletBoardSyncs(tx, tenant))[0]);
  const expire = () => owner("UPDATE padlet_board_syncs SET checked_at=clock_timestamp()-interval '2 minutes', sync_lease_until=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [tenant]);
  const post: PadletPost = { id: 'synthetic-post-1', createdAt: new Date().toISOString(), status: 'approved', authorName: 'Synthetic Student', subject: '', sectionId: null, url: null };
  return { tenant, commands, claim, record, state, expire, post };
}

describe('Padlet leased attempts and atomic result fencing', () => {
  it('shares one lease between automatic and manual requests and only manual bypasses freshness', async () => {
    const f = await fixture();
    const first = await f.claim();
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    expect(await f.claim()).toBeNull();
    expect(await f.claim(true)).toBeNull();
    expect(await f.state()).toMatchObject({ checking: true, retryAt: null });
    expect(await f.record(undefined, false)).toBe(false);
    expect(await f.record(first!, true)).toBe(true);
    expect(await f.record(first!, false)).toBe(false);
    expect(await f.state()).toMatchObject({ checking: false, errorCode: null });
    expect(await f.claim()).toBeNull();
    expect(await f.claim(true)).not.toBeNull();
  });

  it('discards both late failure and late success after lease takeover, preserving the current result', async () => {
    const f = await fixture();
    const old = await f.claim();
    await f.expire();
    const current = await f.claim();
    expect(current).not.toBe(old);
    expect(await f.record(old!, false)).toBe(false);
    expect(await f.record(old!, true)).toBe(false);
    expect(await f.state()).toMatchObject({ checking: true, succeededAt: null, errorCode: null });
    expect(await f.record(current!, false, 'RATE_LIMITED')).toBe(true);
    const saved = await f.state();
    expect(saved).toMatchObject({ checking: false, errorCode: 'RATE_LIMITED', retryAt: expect.any(String) });
    expect(Date.parse(saved.retryAt!) - Date.parse(saved.checkedAt!)).toBeGreaterThanOrEqual(59_999);
    expect(await f.record(old!, true)).toBe(false);
    expect(await f.state()).toEqual(saved);
  });

  it('enforces the rate-limit cooldown for manual, automatic and tokenless legacy writes', async () => {
    const f = await fixture();
    const attempt = await f.claim();
    await f.record(attempt!, false, 'RATE_LIMITED');
    await owner("UPDATE padlet_board_syncs SET checked_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1", [f.tenant]);
    expect(await f.claim()).toBeNull();
    expect(await f.claim(true)).toBeNull();
    expect(await f.record(undefined)).toBe(false);
    await owner("UPDATE padlet_board_syncs SET retry_after=clock_timestamp()-interval '1 second' WHERE tenant_id=$1", [f.tenant]);
    expect(await f.claim(true)).not.toBeNull();
  });

  it('fences stale ledger application before changing stages, post uses or summaries', async () => {
    const f = await fixture();
    const old = await f.claim();
    await f.expire();
    const current = await f.claim();
    const operationId = randomUUID();
    expect(await f.commands.applyPadletBoard({ operationId, boardId: BOARD, posts: [f.post], syncAttemptId: old! })).toEqual({ moved: 0 });
    expect((await f.commands.readTasks())[0].students[0].stage).toBe('PENDING');
    expect((await owner('SELECT * FROM padlet_post_uses WHERE tenant_id=$1', [f.tenant])).rows).toHaveLength(0);
    expect(await f.state()).toMatchObject({ checking: true, succeededAt: null, summary: [] });
    expect(await f.commands.applyPadletBoard({ operationId: randomUUID(), boardId: BOARD, posts: [f.post], syncAttemptId: current! })).toEqual({ moved: 1 });
    expect((await f.commands.readTasks())[0].students[0].stage).toBe('READY');
    const saved = await f.state();
    expect(saved).toMatchObject({ checking: false, errorCode: null, succeededAt: expect.any(String) });
    expect(await f.commands.applyPadletBoard({ operationId, boardId: BOARD, posts: [f.post], syncAttemptId: old! })).toEqual({ moved: 0 });
    expect(await f.record(old!, false)).toBe(false);
    expect(await f.state()).toEqual(saved);
    expect((await owner('SELECT * FROM padlet_post_uses WHERE tenant_id=$1', [f.tenant])).rows).toHaveLength(1);
  });

  it('never resurrects a sync row after unlink and rejects claims for deleted tasks or inactive classes', async () => {
    const f = await fixture();
    const old = await f.claim();
    await run(f.tenant, (tx) => deletePadletLinks(tx, f.tenant, ['task-a']));
    expect(await f.record(old!, false)).toBe(false);
    expect(await f.record(undefined)).toBe(false);
    expect(await f.claim(true)).toBeNull();
    expect(await f.state()).toBeUndefined();
    const deleted = await fixture();
    await owner('UPDATE tasks SET deleted_at=clock_timestamp(),is_active=false WHERE tenant_id=$1', [deleted.tenant]);
    expect(await deleted.claim(true)).toBeNull();
    const suspended = await fixture();
    await owner("UPDATE tenants SET lifecycle='SUSPENDED' WHERE id=$1", [suspended.tenant]);
    expect(await suspended.claim(true)).toBeNull();
    const trash = await fixture();
    await owner("UPDATE tenants SET deleted_at=clock_timestamp(),deleted_lifecycle='ACTIVE',lifecycle='SUSPENDED' WHERE id=$1", [trash.tenant]);
    expect(await trash.claim(true)).toBeNull();
  });

  it('does not apply an admitted attempt after class deletion', async () => {
    const f = await fixture();
    const attempt = await f.claim();
    const before = await owner('SELECT count(*)::int AS count FROM operations WHERE tenant_id=$1', [f.tenant]);
    await owner("UPDATE tenants SET deleted_at=clock_timestamp(),deleted_lifecycle='ACTIVE',lifecycle='SUSPENDED' WHERE id=$1", [f.tenant]);
    expect(await f.record(attempt!, false)).toBe(false);
    await expect(f.commands.applyPadletBoard({ operationId: randomUUID(), boardId: BOARD, posts: [f.post], syncAttemptId: attempt! })).rejects.toThrow();
    expect((await owner('SELECT count(*)::int AS count FROM operations WHERE tenant_id=$1', [f.tenant])).rows).toEqual(before.rows);
    expect((await owner('SELECT * FROM padlet_post_uses WHERE tenant_id=$1', [f.tenant])).rows).toHaveLength(0);
  });

  it('keeps attempts tenant-scoped under the ordinary runtime RLS role', async () => {
    const one = await fixture();
    const two = await fixture();
    const token = await two.claim();
    expect(await run(one.tenant, (tx) => claimPadletBoardSync(tx, two.tenant, BOARD, 20, true))).toBeNull();
    expect(await run(one.tenant, (tx) => lockPadletBoardSyncAttempt(tx, two.tenant, BOARD, token!))).toBe(false);
    expect(await run(one.tenant, (tx) => recordPadletBoardSync(tx, two.tenant, BOARD, { ok: false, errorCode: 'TIMEOUT' }, token!))).toBe(false);
    expect(await one.record(token!, false)).toBe(false);
    expect(await two.state()).toMatchObject({ checking: true, errorCode: null });
    await run(one.tenant, async (tx) => {
      expect((await tx.execute(sql`SELECT board_id FROM padlet_board_syncs WHERE tenant_id=${two.tenant}`)).rows).toHaveLength(0);
    });
  });
});

// PGlite cannot model independent concurrent transactions. These cases run only in the owned
// PostgreSQL opt-in pass of this same file, through two real runtime wire-protocol connections.
describe.runIf(REAL)('Padlet lease concurrency on PostgreSQL', () => {
  it('admits exactly one of concurrent manual and automatic claims', async () => {
    const f = await fixture();
    const results = await Promise.all([f.claim(), f.claim(true)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await f.state()).toMatchObject({ checking: true });
  });

  it('holds the final token lock until commit so an expired attempt cannot be replaced mid-apply', async () => {
    const f = await fixture();
    const old = await f.claim();
    await f.expire();
    let release!: () => void;
    let locked!: () => void;
    const canFinish = new Promise<void>((done) => { release = done; });
    const isLocked = new Promise<void>((done) => { locked = done; });
    const first = run(f.tenant, async (tx) => {
      await tx.execute(sql`SELECT task_instance_id FROM tasks WHERE tenant_id=${f.tenant} ORDER BY task_instance_id FOR UPDATE`);
      expect(await lockPadletBoardSyncAttempt(tx, f.tenant, BOARD, old!)).toBe(true);
      locked();
      await canFinish;
      expect(await recordPadletBoardSync(tx, f.tenant, BOARD, { ok: true, summary: [] }, old!)).toBe(true);
    });
    await isLocked;
    let secondFinished = false;
    const second = f.claim(true).then((token) => { secondFinished = true; return token; });
    try { await new Promise((done) => setTimeout(done, 75)); expect(secondFinished).toBe(false); }
    finally { release(); }
    await first;
    const next = await second;
    expect(next).toBeTruthy();
    expect(next).not.toBe(old);
    expect(await f.record(old!, false)).toBe(false);
  });

  it('does not recreate a sync row when unlink commits while a claim waits for task locks', async () => {
    const f = await fixture();
    let release!: () => void;
    let locked!: () => void;
    const canUnlink = new Promise<void>((done) => { release = done; });
    const isLocked = new Promise<void>((done) => { locked = done; });
    const unlink = run(f.tenant, async (tx) => {
      await tx.execute(sql`SELECT task_instance_id FROM tasks WHERE tenant_id=${f.tenant} ORDER BY task_instance_id FOR UPDATE`);
      locked();
      await canUnlink;
      await deletePadletLinks(tx, f.tenant, ['task-a']);
    });
    await isLocked;
    let claimFinished = false;
    const claim = f.claim(true).then((token) => { claimFinished = true; return token; });
    try { await new Promise((done) => setTimeout(done, 75)); expect(claimFinished).toBe(false); }
    finally { release(); }
    await unlink;
    expect(await claim).toBeNull();
    expect(await f.state()).toBeUndefined();
  });
});
