// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { readCurrentLedgerStates } from './currentState';
import { groupEvents, readLedgerEvents, readLedgerTasks, stageOf } from './store';

vi.mock('server-only', () => ({}));
const FROM = '2026-01-01T00:00:00.000000Z';
const END = '2026-12-31T00:00:00.000000Z';
let db: PgliteDatabaseHarness;
let tenant: string;
let sequence = 0;
const schedule = { ruleVersion: 1, effectiveFrom: FROM, timeZone: 'Asia/Seoul', recurrence: { type: 'DAILY', time: '09:00' },
  resetStage: 'PENDING', resetAssignmentOnCycle: false, resetCompletionOnCycle: true };
beforeAll(async () => {
  db = await createPgliteDatabaseHarness({ migrationSet: 'base' }); tenant = db.tenantOneId;
  for (const name of (await readdir(resolve('src/server/db/migrations'))).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0,4) > '0008' && n.slice(0,4) <= '0041').sort()) {
    await db.database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
  }
  await db.database.exec('GRANT SELECT ON task_ledger_checkpoints TO app_runtime');
  for (const id of [tenant, db.tenantTwoId]) {
    await db.database.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','Synthetic','ACTIVE')",[id]);
    await db.database.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule)
      VALUES($1,'task','T001','Synthetic','',0,$2)`,[id,JSON.stringify(schedule)]);
  }
  await marker(FROM);
},120000);
afterAll(async () => { await db?.close(); });
async function marker(from: string) {
  await db.database.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,started_at,finished_at,created_at,updated_at)
    VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,'SUCCEEDED',$3::jsonb,$4,$4,$4,$4)
    ON CONFLICT(tenant_id,operation_id) DO UPDATE SET result_snapshot=excluded.result_snapshot`,[tenant,'a'.repeat(64),JSON.stringify({ledgerFrom:from}),FROM]);
}
async function event(kind: 'READY'|'PENDING'|'UNASSIGNED'|'COMPLETED'|'UNCOMPLETED', at: string) {
  const id = `synthetic-${++sequence}`;
  if (kind==='COMPLETED'||kind==='UNCOMPLETED') {
    await db.database.query(`INSERT INTO task_completions(tenant_id,completion_id,completed_at,task_instance_id,task_id_snapshot,
      task_name_snapshot,student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status,cycle_id,cycle_start_at,
      rule_version,timezone,source,created_at) VALUES($1,$2,$3,'task','T001','Synthetic','S1','Synthetic',0,0,0,$4,'ledger',$5,1,'Asia/Seoul','CARRY_FORWARD',$3)`,
    [tenant,id,at,kind==='COMPLETED'?'COMPLETED':'CANCELLED',FROM]);
  } else {
    await db.database.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,
      event_type,note,source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
      VALUES($1,$2,'task','T001','S1',$3,$4,'CARRY_FORWARD','ledger',$5,1,'Asia/Seoul',$6)`,
    [tenant,id,kind==='UNASSIGNED'?'UNASSIGNED':'ASSIGNED',kind==='PENDING'?'stage:pending':null,FROM,at]);
  }
}
async function compareAt(now: string, from=FROM) {
  return db.runTenantTransaction(tenant,async tx => {
    const [task] = await readLedgerTasks(tx,tenant);
    const old = groupEvents(await readLedgerEvents(tx,tenant,from,{taskInstanceIds:['task']})).get('task')?.get('S1');
    const current = (await readCurrentLedgerStates(tx,tenant,now,{taskInstanceIds:['task']})).get('task')?.get('S1');
    expect(stageOf(task,current,now)).toEqual(stageOf(task,old,now));
    return current;
  });
}
describe.sequential('indexed task ledger checkpoints',() => {
  it('matches the original fold for equal stages, repeated completion/cancellation, microsecond ties and resets',async () => {
    const kinds = ['READY','READY','COMPLETED','COMPLETED','UNCOMPLETED','UNCOMPLETED','READY','PENDING','COMPLETED','READY','UNASSIGNED','COMPLETED','UNCOMPLETED'] as const;
    for (const [i,kind] of kinds.entries()) {
      const at=`2026-01-02T00:00:00.${String(Math.floor(i/2)+1).padStart(6,'0')}Z`;
      await event(kind,at); await compareAt(at); await compareAt(END);
    }
    // Every historic prefix remains available, not just the latest state.
    for(let i=0;i<8;i++) await compareAt(`2026-01-02T00:00:00.${String(i).padStart(6,'0')}Z`);
  });
  it('rebuilds an affected suffix after arbitrary backdating, including a tied assignment inserted after completion',async () => {
    await event('PENDING','2026-01-02T00:00:00.000003Z');
    await event('COMPLETED','2026-01-02T00:00:00.000000Z');
    await event('READY','2026-01-02T00:00:00.000000Z');
    for(let i=0;i<8;i++) await compareAt(`2026-01-02T00:00:00.${String(i).padStart(6,'0')}Z`);
    await compareAt(END);
  });
  it('invalidates the complete derived prefix when ledgerFrom changes and restores it when moved back',async () => {
    const shifted='2026-01-02T00:00:00.000004Z';
    // Owner-only repair simulation; ordinary runtime cannot change a succeeded marker.
    await db.database.exec('ALTER TABLE operations DISABLE TRIGGER operations_update_guard');
    try {
      await marker(shifted); await compareAt(END,shifted);
      await marker(FROM); await compareAt(END);
    } finally { await db.database.exec('ALTER TABLE operations ENABLE TRIGGER operations_update_guard'); }
  });
  it('transfers one checkpoint per pair after a long redundant history and keeps tenant RLS',async () => {
    await db.database.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,
      source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
      SELECT $1,'long-'||n,'task','T001','S1','ASSIGNED','CARRY_FORWARD','ledger',$2,1,'Asia/Seoul',
        '2026-02-01'::timestamptz+n*interval '1 microsecond' FROM generate_series(1,2000)n`,[tenant,FROM]);
    const snapshot=await compareAt(END); expect(snapshot?.latestAssignment?.id).toBe('long-2000');
    await db.runTenantTransaction(tenant,async tx => {
      const result=await readCurrentLedgerStates(tx,tenant,END,{taskInstanceIds:['task']});
      expect(result.size).toBe(1);expect(result.get('task')?.size).toBe(1);
      expect((await tx.execute(sql`SELECT tenant_id FROM task_ledger_checkpoints WHERE tenant_id=${db.tenantTwoId}`)).rows).toHaveLength(0);
    });
  },30000);
  it('verifies a full backfill without exposing event rows and detects derived-state corruption',async () => {
    const verify=await readFile(resolve('src/server/db/provisioning/taskLedgerCheckpoints.verify.sql'),'utf8');
    const clean=await db.database.query<Record<string,number>>(verify);
    expect(clean.rows[0]).toMatchObject({missing_count:0,orphan_count:0,metadata_mismatch_count:0,fold_mismatch_count:0});
    await db.database.query("UPDATE task_ledger_checkpoints SET stage='UNASSIGNED' WHERE tenant_id=$1 AND event_id='long-2000'",[tenant]);
    expect(Number((await db.database.query<Record<string,number>>(verify)).rows[0].fold_mismatch_count)).toBe(1);
    await db.database.query('SELECT refresh_tenant_task_ledger_checkpoints($1)',[tenant]);
    expect(Number((await db.database.query<Record<string,number>>(verify)).rows[0].fold_mismatch_count)).toBe(0);
  });
});
