// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Temporal } from '@js-temporal/polyfill';
import { ledgerTimeline } from '@/domain/taskLedger';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { historyCause, readTaskLedgerHistory } from './history';
import * as store from './store';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const NOW = '2026-10-07T12:00:00.000000Z';
let db: DisposablePostgres;
suite('history projection on isolated PostgreSQL 17', () => {
  beforeAll(async () => {
    db = await createDisposablePostgres();
    await db.owner.query('GRANT SELECT ON task_history_revisions,task_history_prefixes,task_history_entries TO app_runtime');
    vi.stubEnv('AUTH_SECRET', 'synthetic-native-history-cursor-only');
    vi.spyOn(store, 'clockNow').mockResolvedValue(NOW);
  }, 120_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await db?.close(); }, 30_000);
  it('matches precise timeline and paginates resets through the real runtime role, then invalidates changed schedules', async () => {
    const tenant = randomUUID();
    await db.owner.query('INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,$3)', [tenant, `history-${tenant}`, 'Synthetic history']);
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','Synthetic','ACTIVE')", [tenant]);
    const schedule = { ruleVersion: 1, effectiveFrom: '2026-01-01T00:00:00Z', timeZone: 'Asia/Seoul',
      recurrence: { type: 'MONTHLY', dayOfMonth: 31, time: '09:00' }, resetStage: 'COMPLETED', resetAssignmentOnCycle: false, resetCompletionOnCycle: false };
    await db.owner.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule,created_at,updated_at)
      VALUES($1,'history','T001','Synthetic','',0,$2,'2026-01-01','2026-01-01')`, [tenant, JSON.stringify(schedule)]);
    await db.owner.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,started_at,finished_at,created_at,updated_at)
      VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,$3,$4,'2026-01-01','2026-01-01','2026-01-01','2026-01-01')`,
    [tenant, 'a'.repeat(64), 'SUCCEEDED', JSON.stringify({ ledgerFrom: '2026-01-01T00:00:00Z' })]);
    await db.owner.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,source,cycle_id,cycle_start_at,rule_version,timezone,created_at,note)
      VALUES($1,'tl-s:1','history','T001','S1','ASSIGNED','CARRY_FORWARD','ledger','1970-01-01',1,'Asia/Seoul','2026-01-02T01:00:00.000001Z','stage:pending'),
        ($1,'tl-s:2','history','T001','S1','ASSIGNED','CARRY_FORWARD','ledger','1970-01-01',1,'Asia/Seoul','2026-02-03T01:00:00.000001Z',NULL),
        ($1,'tl-s:3','history','T001','S1','ASSIGNED','CARRY_FORWARD','ledger','1970-01-01',1,'Asia/Seoul','2026-02-03T01:00:00.000002Z','stage:pending')`, [tenant]);
    const reference = await db.runTenantTransaction(tenant, async (tx) => {
      const [task] = await store.readLedgerTasks(tx, tenant, { taskIds: ['T001'] });
      const events = await store.readLedgerEvents(tx, tenant, null, { taskInstanceIds: ['history'] });
      return ledgerTimeline({ events, windows: store.taskWindows(task), now: NOW, resetsFrom: '2026-01-01T00:00:00Z' })
        .filter((step) => !step.event || (historyCause(step.event) !== null && step.stage !== step.previousStage))
        .map((step) => ({ id: step.event ? `E:${step.event.table}:${step.event.id}` : `R:reset:S1:${step.at}`,
          at: Temporal.Instant.from(step.at).toString({ fractionalSecondDigits: 6 }), stage: step.stage, previousStage: step.previousStage }));
    });
    const actual = []; let cursor: string | null = null;
    do {
      const p = await db.runTenantTransaction(tenant, (tx) => readTaskLedgerHistory(tx, tenant, 'T001', { limit: 1, cursor }));
      actual.push(...p.entries.map(({ id, at, stage, previousStage }) => ({ id, at: Temporal.Instant.from(at).toString({ fractionalSecondDigits: 6 }), stage, previousStage })));
      cursor = p.nextCursor ?? null;
    } while (cursor);
    expect(actual.map((e) => e.id).length).toBe(new Set(actual.map((e) => e.id)).size);
    expect(actual.sort((a, b) => a.id.localeCompare(b.id))).toEqual(reference.sort((a, b) => a.id.localeCompare(b.id)));
    const first = await db.runTenantTransaction(tenant, (tx) => readTaskLedgerHistory(tx, tenant, 'T001', { limit: 1 }));
    await db.owner.query(`UPDATE tasks SET current_schedule=jsonb_set(current_schedule,'{resetStage}','"READY"') WHERE tenant_id=$1`, [tenant]);
    await expect(db.runTenantTransaction(tenant, (tx) => readTaskLedgerHistory(tx, tenant, 'T001', { limit: 1, cursor: first.nextCursor })))
      .rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
    const acl = (await db.runtime.query(`SELECT has_table_privilege(current_user,'task_history_entries','INSERT,UPDATE,DELETE') AS write,
      has_function_privilege(current_user,'task_history_rebuild_task(uuid,text)','EXECUTE') AS refresh`)).rows[0];
    expect(acl).toEqual({ write: false, refresh: false });
  }, 30_000);
});
