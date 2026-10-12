// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createClassDashboardRepository, createClassManagementCommand, type ClassManagementInput } from './classDashboard';
import { createTeacherSessionStore } from '@/server/teacherSession';
import { currentLegalRevision } from '@/lib/legalDocuments';
vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
let db: DisposablePostgres;
const schedule = { ruleVersion: 3, effectiveFrom: '2026-01-01T00:00:00.000Z', timeZone: 'Asia/Seoul', recurrence: { type: 'ONCE' }, resetCompletionOnCycle: false, resetAssignmentOnCycle: false };
async function identity(subject:string) {
  const store=createTeacherSessionStore(db.owner);
  const value={subject,...await store.begin(subject,currentLegalRevision().version)};
  await store.mutate(value,'AGREE',{version:currentLegalRevision().version});
  return {accountGeneration:value.accountGeneration,sessionId:value.sessionId};
}
async function fixture(lifecycle = 'ACTIVE') {
  const tenant = randomUUID(), user = randomUUID(), admin = randomUUID(), subject = `owner-${user}`, slug = `class-${tenant}`;
  await db.owner.query(`INSERT INTO users(id,google_subject,canonical_email) VALUES($1,$2,$3),($4,$5,$6)`, [user,subject,`${user}@example.invalid`,admin,`admin-${admin}`,`${admin}@example.invalid`]);
  await db.owner.query('INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,$3,$4)', [tenant,slug,'원본 학급',lifecycle]);
  await db.owner.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER'),($1,$3,'ADMIN')`, [tenant,user,admin]);
  await db.owner.query(`INSERT INTO tenant_settings(tenant_id,settings) VALUES($1,$2)`, [tenant,{className:'원본 학급',currencyUnit:'별',themeColor:'white',externalSecret:'must-not-copy'}]);
  await db.owner.query(`INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'s1','가상 학생','ACTIVE'),($1,'s2','가상 비활성','INACTIVE')`, [tenant]);
  await db.owner.query(`INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'s1',-100),($1,'s2',300)`, [tenant]);
  await db.owner.query(`INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES($1,'p1','가상 상품',50,8)`, [tenant]);
  await db.owner.query(`INSERT INTO promotions(tenant_id,promotion_id,name,description,type,fixed_discount,starts_at,ends_at) VALUES($1,'promo','가상 할인','','FIXED_DISCOUNT',5,'2026-01-01','2030-01-01')`, [tenant]);
  await db.owner.query(`INSERT INTO promotion_products(tenant_id,promotion_product_id,promotion_id,product_id) VALUES($1,'link','promo','p1')`, [tenant]);
  await db.owner.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule,padlet_board_id) VALUES($1,'task-a','a','가상 과제 A','',20,$2,'private-board'),($1,'task-b','b','가상 과제 B','',30,$2,NULL)`, [tenant,schedule]);
  await db.owner.query(`UPDATE tasks SET prerequisite_task_instance_id='task-a',pending_schedule=$2 WHERE tenant_id=$1 AND task_id='b'`, [tenant,{...schedule,ruleVersion:4,effectiveFrom:'2099-01-01T00:00:00Z'}]);
  await db.owner.query(`INSERT INTO task_allowed_students(tenant_id,task_instance_id,student_id) VALUES($1,'task-a','s1')`, [tenant]);
  await db.owner.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'old-operation','STUDENT_ADMIN',$2)`, [tenant,'a'.repeat(64)]);
  const binding=await identity(subject);
  return { tenant, subject, slug, binding, adminSubject:`admin-${admin}`, input:(action:ClassManagementInput['action'],name='원본 학급',expectedVersion='1'):ClassManagementInput => ({operationId:randomUUID(),slug,subject,action,name,expectedVersion,...binding}) };
}
async function state(tenant:string) {
  const result:Record<string,unknown[]> = {};
  for (const table of ['students','accounts','products','promotions','promotion_products','tasks','task_allowed_students','tenant_settings','operations','transactions','transaction_items','inventory_ledger','task_assignments','task_completions']) {
    result[table] = (await db.owner.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE tenant_id=$1 ORDER BY to_jsonb(t)::text`, [tenant])).rows;
  }
  return result;
}
suite('class dashboard on native PostgreSQL', () => {
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined(); db=await createDisposablePostgres();
    await db.owner.query(`GRANT EXECUTE ON FUNCTION platform_list_class_dashboard(text),
      platform_manage_class_authenticated(uuid,text,text,text,text,bigint,uuid,uuid,text),platform_list_memberships_by_google_subject(text),
      platform_purge_class_authenticated(uuid,text,text,text,bigint,uuid,uuid,text),
      platform_find_tenant_by_slug(text) TO app_runtime;
      REVOKE ALL ON FUNCTION platform_manage_class(uuid,text,text,text,text,bigint) FROM app_runtime`);
  },60_000);
  afterAll(async () => { if(db) expect(await db.close()).toMatchObject({containerRemoved:true,scratchRemoved:true}); },60_000);
  it('copies live configuration with new identities, zero balances and paused work, preserving source', async () => {
    const f=await fixture(); const before=await state(f.tenant); const command=createClassManagementCommand(db.runtime);
    const result=await command.execute(f.input('DUPLICATE','새 학급'));
    expect(result).toMatchObject({displayName:'새 학급',lifecycle:'ACTIVE',managementVersion:'1',replayed:false});
    const newId=(await db.owner.query('SELECT id FROM tenants WHERE slug=$1',[result.slug])).rows[0].id;
    expect(await state(f.tenant)).toEqual(before);
    expect((await db.owner.query('SELECT balance FROM accounts WHERE tenant_id=$1',[newId])).rows).toEqual([{balance:'0'},{balance:'0'}]);
    expect((await db.owner.query('SELECT stock FROM products WHERE tenant_id=$1',[newId])).rows).toEqual([{stock:'8'}]);
    expect((await db.owner.query('SELECT is_active FROM promotions WHERE tenant_id=$1',[newId])).rows).toEqual([{is_active:false}]);
    const tasks=(await db.owner.query('SELECT * FROM tasks WHERE tenant_id=$1 ORDER BY task_id',[newId])).rows;
    expect(tasks).toHaveLength(2); expect(tasks[0].task_instance_id).not.toBe('task-a');
    expect(tasks[1].prerequisite_task_instance_id).toBe(tasks[0].task_instance_id);
    for(const t of tasks) { expect(t.is_active).toBe(false); expect(t.current_schedule.ruleVersion).toBe(1); expect(t.pending_schedule).toBeNull(); expect(t.padlet_board_id).toBeNull(); }
    expect((await db.owner.query('SELECT task_instance_id FROM task_allowed_students WHERE tenant_id=$1',[newId])).rows).toEqual([{task_instance_id:tasks[0].task_instance_id}]);
    expect((await db.owner.query('SELECT role FROM tenant_memberships WHERE tenant_id=$1',[newId])).rows).toEqual([{role:'OWNER'}]);
    const copied=await state(newId);
    for(const table of ['operations','transactions','inventory_ledger','task_assignments','task_completions']) expect(copied[table]).toEqual([]);
    expect(JSON.stringify(copied.tenant_settings)).not.toContain('externalSecret');
    const dashboard=await createClassDashboardRepository(db.runtime).listByGoogleSubject(f.subject);
    expect(dashboard).toHaveLength(2); expect(dashboard[0].dashboard).toMatchObject({studentCount:2,productCount:1,taskCount:2});
  });
  it('serializes concurrent replay, rejects changed payload and does not create another copy', async () => {
    const f=await fixture(), input=f.input('DUPLICATE','복제 학급');
    const clients=await Promise.all([db.runtime.connect(),db.runtime.connect()]);
    try {
      const results=await Promise.all(clients.map(c=>createClassManagementCommand(c).execute(input)));
      expect(new Set(results.map(r=>r.slug)).size).toBe(1); expect(results.map(r=>r.replayed).sort()).toEqual([false,true]);
      await expect(createClassManagementCommand(clients[0]).execute({...input,name:'다른 이름'})).rejects.toMatchObject({code:'23505'});
      expect(await createClassDashboardRepository(clients[0]).listByGoogleSubject(f.subject)).toHaveLength(2);
    } finally { clients.forEach(c=>c.release()); }
  });
  it('denies non-owners and direct runtime receipt access without changing source', async () => {
    const f=await fixture(),before=await state(f.tenant),command=createClassManagementCommand(db.runtime);
    for(const subject of [f.adminSubject,'foreign']) {
      const binding=await identity(subject);
      for(const action of ['RENAME','DUPLICATE','DELETE','RESTORE'] as const)
        await expect(command.execute({...f.input(action),subject,...binding})).rejects.toMatchObject({code:'42501'});
    }
    await expect(db.runtime.query('SELECT * FROM class_management_operations')).rejects.toMatchObject({code:'42501'});
    expect(await state(f.tenant)).toEqual(before);
    expect((await db.owner.query("SELECT has_function_privilege('public','platform_manage_class(uuid,text,text,text,text,bigint)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false);
    await expect(db.runtime.query('SELECT platform_manage_class($1,$2,$3,$4,$5,$6)',[randomUUID(),f.slug,f.subject,'RENAME','Forbidden',1])).rejects.toMatchObject({code:'42501'});
  });
  it.each(['ACTIVE','DRAFT'])('trashes and restores %s without changing balances or history', async lifecycle => {
    const f=await fixture(lifecycle),before=await state(f.tenant),command=createClassManagementCommand(db.runtime),input=f.input('DELETE');
    expect(await command.execute(input)).toMatchObject({lifecycle:'SUSPENDED',managementVersion:'2'});
    expect(await command.execute(input)).toMatchObject({replayed:true});
    expect(await state(f.tenant)).toEqual(before);
    expect((await db.runtime.query('SELECT * FROM platform_list_memberships_by_google_subject($1)',[f.subject])).rows).toEqual([]);
    const rows=await createClassDashboardRepository(db.runtime).listByGoogleSubject(f.subject);
    expect(rows[0].dashboard?.deletedAt).toBeTruthy();
    expect(await createClassDashboardRepository(db.runtime).listByGoogleSubject(f.adminSubject)).toEqual([]);
    const c=await db.runtime.connect();
    try { await c.query('BEGIN'); await c.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
      await expect(c.query("UPDATE accounts SET balance=999 WHERE tenant_id=$1 AND student_id='s1'",[f.tenant])).rejects.toMatchObject({code:'23505'});
    } finally { await c.query('ROLLBACK'); c.release(); }
    expect(await command.execute(f.input('RESTORE','원본 학급','2'))).toMatchObject({lifecycle,managementVersion:'3'});
    expect(await state(f.tenant)).toEqual(before);
    expect((await db.owner.query('SELECT credential_version FROM tenants WHERE id=$1',[f.tenant])).rows[0].credential_version).toBe(3);
  });
  it('renames both visible names and rejects stale management versions or wrong deletion confirmation', async () => {
    const f=await fixture(),command=createClassManagementCommand(db.runtime);
    await expect(command.execute(f.input('DELETE','wrong'))).rejects.toMatchObject({code:'23505'});
    expect(await command.execute(f.input('RENAME','바뀐 이름'))).toMatchObject({displayName:'바뀐 이름',managementVersion:'2'});
    expect((await db.owner.query("SELECT settings->>'className' AS name FROM tenant_settings WHERE tenant_id=$1",[f.tenant])).rows[0].name).toBe('바뀐 이름');
    await expect(command.execute(f.input('DELETE','바뀐 이름'))).rejects.toMatchObject({code:'23505'});
    await expect(db.owner.query("UPDATE tenants SET deleted_at=now(),lifecycle='SUSPENDED' WHERE id=$1",[f.tenant])).rejects.toMatchObject({code:'23514'});
  });
  it('erases a class only from the trash, by its owner with the exact name, leaving it off every list', async () => {
    const f=await fixture(),command=createClassManagementCommand(db.runtime);
    await expect(command.execute(f.input('PURGE'))).rejects.toMatchObject({code:'23505'});
    expect(await command.execute(f.input('DELETE','원본 학급','1'))).toMatchObject({managementVersion:'2'});
    await expect(command.execute({...f.input('PURGE','원본 학급','2'),subject:f.adminSubject})).rejects.toMatchObject({code:'28000'});
    await expect(command.execute(f.input('PURGE','틀린 이름','2'))).rejects.toMatchObject({code:'23505'});
    const purge=f.input('PURGE','원본 학급','2');
    expect(await command.execute(purge)).toMatchObject({slug:f.slug,action:'PURGE',lifecycle:'SUSPENDED',managementVersion:'3',replayed:false});
    expect(await command.execute(purge)).toMatchObject({action:'PURGE',replayed:true});
    for (const rows of Object.values(await state(f.tenant))) expect(rows).toEqual([]);
    expect((await db.owner.query('SELECT slug,display_name FROM tenants WHERE id=$1',[f.tenant])).rows).toEqual([{slug:`purged-${f.tenant}`,display_name:'삭제된 학급'}]);
    expect(await createClassDashboardRepository(db.runtime).listByGoogleSubject(f.subject)).toEqual([]);
    expect(await createClassDashboardRepository(db.runtime).listByGoogleSubject(f.adminSubject)).toEqual([]);
  });
  it('rolls back a copy after a late failure instead of leaving a half-created class', async () => {
    const f=await fixture(); const before=(await db.owner.query('SELECT count(*) AS n FROM tenants')).rows;
    await db.owner.query(`CREATE FUNCTION fail_management_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late failure'; END $$;
      CREATE TRIGGER fail_management_test BEFORE INSERT ON class_management_operations FOR EACH ROW EXECUTE FUNCTION fail_management_test()`);
    try { await expect(createClassManagementCommand(db.runtime).execute(f.input('DUPLICATE','롤백 학급'))).rejects.toMatchObject({code:'P0001'});
      expect((await db.owner.query('SELECT count(*) AS n FROM tenants')).rows).toEqual(before);
    } finally { await db.owner.query('DROP TRIGGER fail_management_test ON class_management_operations; DROP FUNCTION fail_management_test()'); }
  });
  it('waits for an in-flight write before trashing, then rejects a stale request after trash commits', async () => {
    const f=await fixture(); const writer=await db.runtime.connect(); const manager=await db.runtime.connect();
    try {
      await writer.query('BEGIN'); await writer.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
      await writer.query("UPDATE accounts SET balance=777 WHERE tenant_id=$1 AND student_id='s1'",[f.tenant]);
      const pid=(await manager.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const deletion=createClassManagementCommand(manager).execute(f.input('DELETE'));
      let waiting=false; const deadline=Date.now()+5000;
      while(Date.now()<deadline) { const r=await db.owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid]); if(r.rows[0].blocked) {waiting=true;break;} await new Promise(r=>setTimeout(r,20)); }
      expect(waiting).toBe(true); await writer.query('COMMIT'); await deletion;
      await writer.query('BEGIN'); await writer.query("SELECT set_config('app.tenant_id',$1,true)",[f.tenant]);
      await expect(writer.query("UPDATE accounts SET balance=999 WHERE tenant_id=$1 AND student_id='s1'",[f.tenant])).rejects.toMatchObject({code:'23505'});
      await writer.query('ROLLBACK');
      expect((await db.owner.query("SELECT balance FROM accounts WHERE tenant_id=$1 AND student_id='s1'",[f.tenant])).rows[0].balance).toBe('777');
    } finally { await writer.query('ROLLBACK'); writer.release(); manager.release(); }
  });
  it('queues management behind withdrawal before taking a tenant lock, then rejects the stale session', async () => {
    const f=await fixture(); const withdrawal=await db.owner.connect(); const manager=await db.runtime.connect();
    try {
      await withdrawal.query('BEGIN');
      await createTeacherSessionStore(withdrawal).mutate({subject:f.subject,...f.binding},'WITHDRAW',{});
      const pid=(await manager.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const result=createClassManagementCommand(manager).execute(f.input('DUPLICATE','Must not survive'))
        .then(()=>({code:'accepted'}),error=>({code:error.code}));
      let blocked=false;
      for(let attempt=0;attempt<100&&!blocked;attempt++) {
        blocked=(await db.owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
        if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await withdrawal.query('COMMIT');
      expect(await result).toEqual({code:'28000'});
      expect((await db.owner.query("SELECT count(*)::int AS n FROM tenants WHERE display_name='Must not survive'")).rows[0].n).toBe(0);
      expect((await db.owner.query('SELECT count(*)::int AS n FROM users WHERE google_subject=$1',[f.subject])).rows[0].n).toBe(0);
    } finally { await withdrawal.query('ROLLBACK'); withdrawal.release(); manager.release(); }
  },20_000);
  it('lets an admitted copy commit before withdrawal, which then erases both owned classes', async () => {
    const f=await fixture(); const manager=await db.runtime.connect(); const withdrawal=await db.owner.connect();
    try {
      await manager.query('BEGIN');
      const copied=await createClassManagementCommand(manager).execute(f.input('DUPLICATE','Before withdrawal'));
      const copiedId=(await manager.query('SELECT id FROM platform_find_tenant_by_slug($1)',[copied.slug])).rows[0].id;
      const pid=(await withdrawal.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const result=createTeacherSessionStore(withdrawal).mutate({subject:f.subject,...f.binding},'WITHDRAW',{})
        .then(value=>value,error=>({error:error.code}));
      let blocked=false;
      for(let attempt=0;attempt<100&&!blocked;attempt++) {
        blocked=(await db.owner.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked',[pid])).rows[0].blocked;
        if(!blocked) await new Promise(resolve=>setTimeout(resolve,10));
      }
      expect(blocked).toBe(true);
      await manager.query('COMMIT');
      expect(await result).toEqual({closedClasses:2});
      expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=ANY($1::uuid[])',[[f.tenant,copiedId]])).rows)
        .toEqual([{lifecycle:'SUSPENDED'},{lifecycle:'SUSPENDED'}]);
    } finally { await manager.query('ROLLBACK'); manager.release(); withdrawal.release(); }
  },20_000);
});
