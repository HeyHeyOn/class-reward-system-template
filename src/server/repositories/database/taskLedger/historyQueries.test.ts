// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { compareInstants, ledgerTimeline } from '@/domain/taskLedger';
import type { TaskHistoryEntryDto } from '@/lib/taskLedgerApi';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { historyCause, readTaskLedgerHistory } from './history';
import { parseTaskHistoryPageRequest } from './historyQueries';
import * as store from './store';

vi.mock('server-only', () => ({}));
const NOW = '2026-10-07T12:00:00.000000Z';
let h: PgliteDatabaseHarness;
let serial = 0;
const schedule = (recurrence: object = { type: 'NONE' }, resetStage: string | null = null, effectiveFrom = '2026-01-01T00:00:00.000Z') => ({
  ruleVersion: 1, effectiveFrom, timeZone: 'Asia/Seoul', recurrence, resetAssignmentOnCycle: resetStage === 'UNASSIGNED',
  resetCompletionOnCycle: resetStage !== null && resetStage !== 'COMPLETED', resetStage,
});
beforeAll(async () => {
  h = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  await h.database.exec(await readFile('src/server/db/migrations/0041_task_ledger_checkpoints.sql', 'utf8'));
  await h.database.exec(await readFile('src/server/db/migrations/0042_task_history_projection.sql', 'utf8'));
  await h.database.exec('GRANT SELECT ON task_history_revisions,task_history_prefixes,task_history_entries TO app_runtime');
  await h.database.query(`INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','첫째','ACTIVE'),($1,'S2','둘째','ACTIVE')`, [h.tenantOneId]);
  await h.database.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,started_at,finished_at,created_at,updated_at)
    VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,'SUCCEEDED',$3::jsonb,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
  [h.tenantOneId, 'a'.repeat(64), JSON.stringify({ ledgerFrom: '2026-01-01T00:00:00Z' })]);
  vi.spyOn(store, 'clockNow').mockResolvedValue(NOW);
  vi.stubEnv('AUTH_SECRET', 'synthetic-history-cursor-signing-secret-only');
}, 120_000);
afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await h?.close(); });

async function task(current = schedule(), pending: object | null = null) {
  const id = `history-${++serial}`;
  await h.database.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule,pending_schedule,created_at,updated_at)
    VALUES($1,$2,$2,'기록','',0,$3::jsonb,$4::jsonb,'2025-01-01','2025-01-01')`, [h.tenantOneId, id, JSON.stringify(current), pending ? JSON.stringify(pending) : null]);
  return id;
}
type Event = { kind: 'A' | 'C' | 'X'; at: string; stage?: string; student?: string; source?: string; id?: string; completedAt?: string; note?: string; reward?: number };
async function event(task: string, e: Event) {
  const id = e.id ?? `event-${++serial}`;
  if (e.kind === 'A') await h.database.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,event_type,source,created_at,note)
    VALUES($1,$2,$3,$3,'ledger','1970-01-01',1,'Asia/Seoul',$4,$5,$6,$7,$8)`,
  [h.tenantOneId, id, task, e.student ?? 'S1', e.stage === 'UNASSIGNED' ? 'UNASSIGNED' : 'ASSIGNED', e.source ?? 'ADMIN', e.at, e.stage === 'PENDING' ? 'stage:pending' : e.note ?? null]);
  else await h.database.query(`INSERT INTO task_completions(tenant_id,completion_id,completed_at,task_instance_id,task_id_snapshot,task_name_snapshot,student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status,source,cycle_id,cycle_start_at,rule_version,timezone,created_at,note)
    VALUES($1,$2,$3,$4,$4,'기록',$5,'이름',$6,0,0,$7,$8,'ledger','1970-01-01',1,'Asia/Seoul',$9,$10)`,
  [h.tenantOneId, id, e.completedAt ?? e.at, task, e.student ?? 'S1', e.reward ?? 0, e.kind === 'C' ? 'COMPLETED' : 'CANCELLED', e.source ?? 'ADMIN', e.at, e.note ?? null]);
}
const page = (id: string, request = {}) => h.runTenantTransaction(h.tenantOneId, (tx) => readTaskLedgerHistory(tx, h.tenantOneId, id, request));
async function allPages(id: string, limit = 2, studentId = '') {
  const rows: TaskHistoryEntryDto[] = []; let cursor: string | null = null;
  for (let i = 0; i < 200; i += 1) {
    const result = await page(id, { limit, cursor, studentId }); rows.push(...result.entries); cursor = result.nextCursor ?? null;
    if (!cursor) return rows;
  }
  throw Error('cursor failed to finish');
}
async function reference(id: string) {
  return h.runTenantTransaction(h.tenantOneId, async (tx) => {
    const [t] = await store.readLedgerTasks(tx, h.tenantOneId, { taskIds: [id] });
    const grouped = store.groupEvents(await store.readLedgerEvents(tx, h.tenantOneId, null, { taskInstanceIds: [id] }));
    const out: TaskHistoryEntryDto[] = [];
    for (const [studentId, events] of grouped.get(id) ?? []) for (const step of ledgerTimeline({ events, windows: store.taskWindows(t), now: NOW, resetsFrom: '2026-01-01T00:00:00Z' })) {
      const cause = step.event ? historyCause(step.event) : 'AUTO_RESET';
      if (cause === null || (step.event && step.stage === step.previousStage && cause !== 'BANK')) continue;
      out.push({ id: step.event ? `E:${step.event.table}:${step.event.id}` : `R:reset:${studentId}:${step.at}`, at: step.event?.completedAt ?? step.at,
        studentId, studentName: studentId === 'S1' ? '첫째' : '둘째', stage: step.stage, previousStage: step.previousStage, cause,
        reward: step.event?.table === 'C' && step.event.kind === 'COMPLETED' && step.event.reward > 0 ? step.event.reward : null });
    }
    return out;
  });
}
const comparable = (rows: readonly TaskHistoryEntryDto[]) => rows.map((e) => ({ ...e, at: e.at.replace(/(\.\d{3})000Z$/, '$1Z') })).sort((a, b) => a.id.localeCompare(b.id));

describe('indexed historical timeline', () => {
  it.each([
    [{ type: 'DAILY', time: '09:00' }, 'READY'],
    [{ type: 'WEEKLY', weekdays: [1, 3, 7], time: '09:00' }, 'PENDING'],
    [{ type: 'MONTHLY', dayOfMonth: 31, time: '09:00' }, 'COMPLETED'],
    [{ type: 'DAILY', time: '09:00' }, 'UNASSIGNED'],
  ])('matches the original timeline for %j reset to %s, including legacy rows and cancellation', async (recurrence, stage) => {
    const id = await task(schedule(recurrence, stage));
    for (const e of [
      { kind: 'A', at: '2025-12-01T01:00:00Z', stage: 'PENDING', source: 'LEGACY_SEED' },
      { kind: 'C', at: '2025-12-02T01:00:00Z', completedAt: '2025-11-30T01:00:00Z' },
      { kind: 'A', at: '2026-01-01T01:00:00Z', stage: 'PENDING', source: 'CARRY_FORWARD' },
      { kind: 'C', at: '2026-02-01T02:00:00Z', source: 'BANK', reward: 30 },
      { kind: 'C', at: '2026-02-01T02:00:01Z', source: 'BANK', reward: 30 },
      { kind: 'X', at: '2026-02-03T02:00:00Z' },
      { kind: 'A', at: '2026-02-03T02:00:00.000001Z', stage: 'READY' },
      { kind: 'A', at: '2026-02-03T02:00:00.000002Z', stage: 'PENDING' },
      { kind: 'C', at: '2026-02-28T02:00:00Z' },
      { kind: 'A', at: '2026-03-03T02:00:00Z', stage: 'READY', student: 'S2' },
    ] as Event[]) await event(id, e);
    const actual = await allPages(id, 2);
    expect(comparable(actual)).toEqual(comparable(await reference(id)));
    expect(new Set(actual.map((e) => e.id)).size).toBe(actual.length);
    for (let i = 1; i < actual.length; i++) expect(compareInstants(actual[i - 1].at, actual[i].at)).toBeGreaterThanOrEqual(0);
  });

  it('keeps a frozen tail reset across ordinary appended events, and filters students in storage', async () => {
    const id = await task(schedule({ type: 'DAILY', time: '09:00' }, 'READY'));
    await event(id, { kind: 'A', at: '2026-10-01T01:00:00Z', stage: 'PENDING' });
    await event(id, { kind: 'A', at: '2026-10-01T01:00:00Z', stage: 'PENDING', student: 'S2' });
    const expected = await allPages(id, 1);
    const first = await page(id, { limit: 1 });
    await event(id, { kind: 'A', at: '2026-10-08T01:00:00Z', stage: 'PENDING' });
    const actual = [...first.entries]; let cursor = first.nextCursor;
    while (cursor) { const p = await page(id, { limit: 1, cursor }); actual.push(...p.entries); cursor = p.nextCursor; }
    expect(actual).toEqual(expected);
    expect((await allPages(id, 1, 'S2')).every((e) => e.studentId === 'S2')).toBe(true);
  });

  it('invalidates a cursor on a backdated insertion or changed schedule, then matches rebuilt reference', async () => {
    const id = await task(schedule({ type: 'DAILY', time: '09:00' }, 'READY'));
    await event(id, { kind: 'A', at: '2026-01-01T01:00:00Z', stage: 'PENDING' });
    await event(id, { kind: 'C', at: '2026-01-05T01:00:00Z' });
    const first = await page(id, { limit: 1 });
    await event(id, { kind: 'A', at: '2026-01-03T01:00:00Z', stage: 'UNASSIGNED' });
    await expect(page(id, { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'HISTORY_CHANGED', status: 409 });
    expect(comparable(await allPages(id))).toEqual(comparable(await reference(id)));
    const second = await page(id, { limit: 1 });
    await h.database.query('UPDATE tasks SET current_schedule=$3::jsonb WHERE tenant_id=$1 AND task_instance_id=$2', [h.tenantOneId, id, JSON.stringify(schedule())]);
    await expect(page(id, { cursor: second.nextCursor })).rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
    expect(comparable(await allPages(id))).toEqual(comparable(await reference(id)));
  });

  it('matches pending windows and an event exactly on a reset boundary', async () => {
    const id = await task(schedule({ type: 'DAILY', time: '09:00' }, 'PENDING'), schedule({ type: 'DAILY', time: '09:00' }, 'COMPLETED', '2026-02-01T00:00:00.000Z'));
    await event(id, { kind: 'A', at: '2026-01-01T01:00:00Z', stage: 'READY' });
    await event(id, { kind: 'A', at: '2026-01-02T00:00:00Z', stage: 'READY' });
    await event(id, { kind: 'X', at: '2026-02-03T01:00:00Z' });
    expect(comparable(await allPages(id, 1))).toEqual(comparable(await reference(id)));
  });

  it('has no gaps at microsecond and same-instant ties, and rejects a reused task/filter cursor', async () => {
    const id = await task();
    for (const [at, stage] of [['2026-03-01T00:00:00.000001Z','PENDING'],['2026-03-01T00:00:00.000002Z','READY'],['2026-03-01T00:00:00.000002Z','PENDING']]) await event(id, { kind: 'A', at, stage });
    const actual = await allPages(id, 1);
    expect(actual).toHaveLength(3); expect(actual[0].at).toBe('2026-03-01T00:00:00.000002Z');
    expect(actual.map((e) => e.stage)).toEqual(['PENDING', 'READY', 'PENDING']);
    expect(comparable(actual)).toEqual(comparable(await reference(id)));
    const first = await page(id, { limit: 1 });
    await expect(page(id, { cursor: first.nextCursor, studentId: 'S2' })).rejects.toMatchObject({ name: 'TaskLedgerRequestError' });
    await expect(page(await task(), { cursor: first.nextCursor })).rejects.toMatchObject({ name: 'TaskLedgerRequestError' });
  });

  it('separates colliding assignment/completion IDs and orders imported completion display times', async () => {
    const id = await task();
    await event(id, { kind: 'A', id: 'same-id', at: '2026-01-01T00:00:00Z', stage: 'READY' });
    await event(id, { kind: 'C', id: 'same-id', at: '2026-02-01T00:00:00Z', completedAt: '2025-12-01T00:00:00Z' });
    const rows = await allPages(id, 1);
    expect(rows.map((e) => e.id)).toEqual(['E:A:same-id', 'E:C:same-id']);
    expect(comparable(rows)).toEqual(comparable(await reference(id)));
  });

  it('uses the original no-repeat fallback for malformed legacy schedules', async () => {
    for (const current of [schedule({ type: 'MONTHLY', time: '09:00' }, 'READY'), schedule({ type: 'WEEKLY', time: '09:00' }, 'READY')]) {
      const id = await task(current);
      await event(id, { kind: 'A', at: '2026-01-01T01:00:00Z', stage: 'PENDING' });
      await event(id, { kind: 'C', at: '2026-03-01T01:00:00Z' });
      expect(comparable(await allPages(id, 1))).toEqual(comparable(await reference(id)));
    }
  });

  it('keeps projections read-only and tenant isolated, with maintenance functions unavailable to runtime', async () => {
    const id = await task(); await event(id, { kind: 'A', at: '2026-01-01T00:00:00Z', stage: 'READY' });
    const rows = await h.runTenantTransaction(h.tenantTwoId, (tx) => tx.execute(sql`SELECT * FROM task_history_entries WHERE task_instance_id=${id}`));
    expect(rows.rows).toHaveLength(0);
    await expect(h.runTenantTransaction(h.tenantOneId, (tx) => tx.execute(sql`DELETE FROM task_history_entries WHERE task_instance_id=${id}`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(h.runTenantTransaction(h.tenantOneId, (tx) => tx.execute(sql`SELECT task_history_rebuild_task(${h.tenantOneId}::uuid,${id})`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  it('projects a batch once and returns bounded rows without re-reading source history', async () => {
    const id = await task();
    const before = Number((await h.database.query<{ last_value: number }>('SELECT last_value FROM task_history_version_seq')).rows[0].last_value);
    await h.database.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_id_snapshot,task_instance_id,cycle_id,cycle_start_at,rule_version,timezone,student_id,event_type,source,created_at,note)
      SELECT $1,$2||':'||g,$2,$2,'ledger','1970-01-01',1,'Asia/Seoul','S1','ASSIGNED','ADMIN',
        '2026-03-01'::timestamptz+g*interval '1 microsecond',CASE WHEN g%2=0 THEN 'stage:pending' END FROM generate_series(1,1200) g`, [h.tenantOneId, id]);
    const after = Number((await h.database.query<{ last_value: number }>('SELECT last_value FROM task_history_version_seq')).rows[0].last_value);
    expect(after - before).toBe(1200);
    const seen: Array<{ sql: string; params: unknown[] }> = [];
    const result = await h.runTenantTransaction(h.tenantOneId, async (tx) => {
      const original = tx.execute.bind(tx);
      const spy = vi.spyOn(tx, 'execute').mockImplementation((query) => {
        seen.push(new PgDialect().sqlToQuery(query as ReturnType<typeof sql>));
        return original(query);
      });
      try { return await readTaskLedgerHistory(tx, h.tenantOneId, id, { limit: 5 }); } finally { spy.mockRestore(); }
    });
    expect(result.entries).toHaveLength(5); expect(result.nextCursor).toBeTruthy();
    expect(seen.some((q) => /FROM\s+task_(assignments|completions)\b/i.test(q.sql))).toBe(false);
    expect(seen.some((q) => q.sql.includes('task_history_entries') && q.sql.includes('LIMIT') && q.params.includes(6))).toBe(true);
  });

  it('refuses tampered and expired cursors', async () => {
    const id = await task();
    await event(id, { kind: 'A', at: '2026-01-01T01:00:00Z', stage: 'PENDING' });
    await event(id, { kind: 'A', at: '2026-01-01T02:00:00Z', stage: 'READY' });
    const first = await page(id, { limit: 1 });
    const [payload, signature] = first.nextCursor!.split('.');
    const modified = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), cutoff: '0' })).toString('base64url');
    await expect(page(id, { cursor: `${modified}.${signature}` })).rejects.toMatchObject({ name: 'TaskLedgerRequestError' });
    vi.mocked(store.clockNow).mockResolvedValueOnce('2026-10-07T12:31:00.000000Z');
    await expect(page(id, { cursor: first.nextCursor })).rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
  });

  it('rejects malformed and duplicated request parameters', () => {
    expect(parseTaskHistoryPageRequest(new URLSearchParams())).toEqual({ limit: 50, cursor: null, studentId: '' });
    for (const q of ['limit=0','limit=101','limit=2&limit=3','studentId= S1','cursor=!!!']) expect(() => parseTaskHistoryPageRequest(new URLSearchParams(q))).toThrow();
  });
});
