// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createDatabaseTaskCompletionCommand } from '../taskCompletionCommands';
import { createDatabasePadletClaimRepository } from '../padletClaims';
import { createTaskLedgerCommands } from './commands';
import { readCurrentLedgerStates } from './currentState';
import { groupEvents, readLedgerEvents, readLedgerTasks, stageOf } from './store';

vi.mock('server-only', () => ({}));
const suite=process.env.RUN_REAL_POSTGRES==='1'?describe:describe.skip;
const FROM='2026-01-01T00:00:00.000000Z';
const schedule={ruleVersion:1,effectiveFrom:FROM,timeZone:'Asia/Seoul',recurrence:{type:'NONE'},resetAssignmentOnCycle:false,resetCompletionOnCycle:false};
let db:DisposablePostgres;
suite('task checkpoint runtime and dependency locking on PostgreSQL 17',()=>{
  beforeAll(async()=>{
    db=await createDisposablePostgres();
    await db.owner.query('GRANT SELECT ON task_ledger_checkpoints TO app_runtime');
  },120000);
  afterAll(async()=>{await db?.close();},30000);

  async function fixture(){
    const tenant=randomUUID();
    await db.owner.query('INSERT INTO tenants(id,slug,display_name) VALUES($1,$2,$3)',[tenant,`synthetic-${tenant}`,'Synthetic']);
    await db.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','Synthetic 1','ACTIVE'),($1,'S2','Synthetic 2','ACTIVE')",[tenant]);
    await db.owner.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'S1',100),($1,'S2',100)",[tenant]);
    await db.owner.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule,created_at,updated_at)
      VALUES($1,'a','T001','Synthetic A','',10,$2,$3,$3),($1,'b','T002','Synthetic B','',10,$2,$3,$3)`,[tenant,JSON.stringify(schedule),FROM]);
    await db.owner.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,
      started_at,finished_at,created_at,updated_at) VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,'SUCCEEDED',$3,$4,$4,$4,$4)`,
    [tenant,'a'.repeat(64),JSON.stringify({ledgerFrom:FROM}),FROM]);
    await db.owner.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,
      source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
      VALUES($1,'seed-a','a','T001','S1','ASSIGNED','CARRY_FORWARD','ledger',$2,1,'Asia/Seoul','2026-01-02'),
            ($1,'seed-b','b','T002','S2','ASSIGNED','CARRY_FORWARD','ledger',$2,1,'Asia/Seoul','2026-01-02')`,[tenant,FROM]);
    const bank=createDatabaseTaskCompletionCommand({tenantId:tenant,runTenantTransaction:db.runTenantTransaction,padletClaims:createDatabasePadletClaimRepository()});
    const commands=createTaskLedgerCommands({tenantId:tenant,runTenantTransaction:db.runTenantTransaction});
    return {tenant,bank,commands};
  }

  it('lets an old-style runtime INSERT maintain state without granting projection writes or refresh EXECUTE, and rolls back atomically',async()=>{
    const {tenant}=await fixture();
    await fixture();
    const privileges=await db.runtime.query(`SELECT has_table_privilege(current_user,'task_ledger_checkpoints','INSERT') AS write,
      has_function_privilege(current_user,'refresh_task_ledger_checkpoints(uuid,text,text,timestamptz)','EXECUTE') AS refresh`);
    expect(privileges.rows[0]).toEqual({write:false,refresh:false});
    await db.runTenantTransaction(tenant,async tx=>{
      expect((await readCurrentLedgerStates(tx,tenant,'2026-12-31',{taskInstanceIds:['a','b']})).size).toBe(2);
      expect((await tx.execute(sql`SELECT tenant_id FROM task_ledger_checkpoints WHERE tenant_id<>${tenant}`)).rows).toHaveLength(0);
    });
    await expect(db.runTenantTransaction(tenant,async tx=>{
      await tx.execute(sql`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,
        source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
        VALUES(${tenant},'rollback','a','T001','S1','UNASSIGNED','CARRY_FORWARD','ledger',${FROM}::timestamptz,1,'Asia/Seoul',clock_timestamp())`);
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect((await db.owner.query("SELECT event_id FROM task_ledger_checkpoints WHERE tenant_id=$1 AND event_id='rollback'",[tenant])).rows).toHaveLength(0);
  });

  it('rebuilds a backdated suffix under real PostgreSQL and returns the exact historical fold',async()=>{
    const {tenant}=await fixture();
    await db.owner.query(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,note,
      source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
      VALUES($1,'later','a','T001','S1','ASSIGNED',NULL,'CARRY_FORWARD','ledger',$2,1,'Asia/Seoul','2026-01-04'),
      ($1,'backdated','a','T001','S1','ASSIGNED','stage:pending','CARRY_FORWARD','ledger',$2,1,'Asia/Seoul','2026-01-03')`,[tenant,FROM]);
    await db.runTenantTransaction(tenant,async tx=>{
      const [task]=await readLedgerTasks(tx,tenant,{taskInstanceIds:['a']});
      const old=groupEvents(await readLedgerEvents(tx,tenant,FROM,{taskInstanceIds:['a']})).get('a')?.get('S1');
      for(const now of ['2026-01-03T12:00:00Z','2026-01-05T00:00:00Z']){
        const compact=(await readCurrentLedgerStates(tx,tenant,now,{taskInstanceIds:['a']})).get('a')?.get('S1');
        expect(stageOf(task,compact,now)).toEqual(stageOf(task,old,now));
      }
    });
  });

  it('completes a distinct task/student while another task row is locked, retaining reward idempotency',async()=>{
    const {tenant,bank}=await fixture();
    const blocker=await db.owner.connect();
    await blocker.query('BEGIN'); await blocker.query("SELECT 1 FROM tasks WHERE tenant_id=$1 AND task_instance_id='a' FOR UPDATE",[tenant]);
    try{
      const operationId=randomUUID();
      let timer:ReturnType<typeof setTimeout>|undefined;
      const result=await Promise.race([bank.execute({operationId,taskId:'T002',studentId:'S2'}),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Unrelated task lock blocked completion')),3000);})]).finally(()=>clearTimeout(timer));
      expect(result.balanceAfter).toBe(110);
      expect(await bank.execute({operationId,taskId:'T002',studentId:'S2'})).toEqual(result);
    }finally{await blocker.query('ROLLBACK');blocker.release();}
    expect((await db.owner.query("SELECT balance::text FROM accounts WHERE tenant_id=$1 AND student_id='S2'",[tenant])).rows[0].balance).toBe('110');
  },15000);

  it('serializes opposing dependency edits so a concurrent cycle cannot be committed',async()=>{
    const {tenant,commands}=await fixture();
    const definition=(title:string,prerequisiteTaskId:string)=>({title,description:'',reward:10,isActive:true,sortOrder:0,
      availableFrom:null,dueAt:null,prerequisiteTaskId});
    const results=await Promise.allSettled([
      commands.updateTask('T001',{operationId:randomUUID(),task:definition('Synthetic A','T002')}),
      commands.updateTask('T002',{operationId:randomUUID(),task:definition('Synthetic B','T001')}),
    ]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'PREREQUISITE_CYCLE'}});
    expect((await db.owner.query('SELECT count(*)::int AS count FROM tasks WHERE tenant_id=$1 AND prerequisite_task_instance_id IS NOT NULL',[tenant])).rows[0].count).toBe(1);
  },15000);

  it('rechecks the new prerequisite after a graph edit finishes while completion is waiting',async()=>{
    const {tenant,bank}=await fixture();
    const editor=await db.owner.connect();
    await editor.query('BEGIN');
    await editor.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`task-ledger-graph:${tenant}`]);
    const completion=bank.execute({operationId:randomUUID(),taskId:'T002',studentId:'S2'})
      .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try{
      let waiting=false;
      for(let attempt=0;attempt<100;attempt++){
        waiting=(await db.owner.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted) AS waiting")).rows[0].waiting;
        if(waiting)break;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(waiting).toBe(true);
      // S2 has not completed A, so the freshly linked prerequisite forbids B.
      await editor.query("UPDATE tasks SET prerequisite_task_instance_id='a' WHERE tenant_id=$1 AND task_instance_id='b'",[tenant]);
      await editor.query('COMMIT');
    }finally{await editor.query('ROLLBACK');editor.release();}
    expect((await completion).error).toMatchObject({code:'POLICY'});
    expect((await db.owner.query("SELECT balance::text FROM accounts WHERE tenant_id=$1 AND student_id='S2'",[tenant])).rows[0].balance).toBe('100');
  },15000);
});
