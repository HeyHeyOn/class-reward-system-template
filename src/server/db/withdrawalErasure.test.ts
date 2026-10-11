// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

type TestDatabase = {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};
let db: TestDatabase;
const OWN = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const OWNER = '20000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '20000000-0000-4000-8000-000000000002';

async function runtime<T>(callback: () => Promise<T>) {
  await db.exec(`BEGIN; SET LOCAL ROLE crs_app_runtime; SET LOCAL app.tenant_id='${OWN}';`);
  try { const value = await callback(); await db.exec('COMMIT'); return value; }
  catch (error) { await db.exec('ROLLBACK'); throw error; }
}

beforeAll(async () => {
  if (process.env.RUN_REAL_POSTGRES === '1') {
    const { createDisposablePostgres } = await import('./testing/disposablePostgres');
    const fixture = await createDisposablePostgres();
    const client = await fixture.owner.connect();
    db = {
      exec: (sql) => client.query(sql),
      query: async <T,>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }),
      close: async () => { client.release(); await fixture.close(); },
    };
  } else {
    db = new PGlite({ extensions: { pgcrypto } });
    const directory = resolve('src/server/db/migrations');
    for (const file of (await readdir(directory)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
      await db.exec(await readFile(resolve(directory, file), 'utf8'));
    }
  }
  await db.exec('CREATE ROLE crs_app_runtime NOSUPERUSER NOBYPASSRLS;');
  await db.exec(await readFile(resolve('src/server/db/provisioning/runtimeGrants.sql'), 'utf8'));
  await db.query(`INSERT INTO users(id,google_subject,canonical_email) VALUES
    ($1,'erasure-owner','erasure@example.test'),($2,'other-owner','other@example.test')`, [OWNER, OTHER_OWNER]);
  await db.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
    ($1,'synthetic-erasure','Synthetic owned class','ACTIVE'),($2,'synthetic-other','Other class','ACTIVE')`, [OWN, OTHER]);
  await db.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$3,'OWNER'),($2,$4,'OWNER')`, [OWN, OTHER, OWNER, OTHER_OWNER]);
  for (const tenant of [OWN, OTHER]) {
    await db.query("INSERT INTO students(tenant_id,student_id,name) VALUES ($1,'S1','Synthetic name')", [tenant]);
    await db.query(`INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,
      kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot)
      VALUES ($1,'X1',now(),'S1','Synthetic name','CHECKOUT',1,-1,10,9,'Synthetic teacher')`, [tenant]);
    await db.query(`INSERT INTO task_completions(tenant_id,completion_id,completed_at,task_id_snapshot,task_name_snapshot,
      student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status)
      VALUES ($1,'C1',now(),'T1','Synthetic task','S1','Synthetic name',1,9,10,'COMPLETED')`, [tenant]);
  }
}, 120000);
afterAll(async () => { await db?.close(); });

async function seedAccount(classCount = 1) {
  const userId = randomUUID();
  const subject = `synthetic-${userId}`;
  const tenants = Array.from({ length: classCount }, () => randomUUID()).sort();
  await db.query('INSERT INTO users(id,google_subject,canonical_email,display_name) VALUES ($1,$2,$3,$4)',
    [userId, subject, `${userId}@example.test`, 'Synthetic teacher']);
  await db.query("SELECT platform_record_user_agreement($1,'2026-10-08')", [subject]);
  await db.query("SELECT platform_save_user_profile($1,'Synthetic nickname','{}'::jsonb)", [subject]);
  for (const tenant of tenants) {
    await db.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES ($1,$2,'Synthetic classroom','ACTIVE')", [tenant, `synthetic-${tenant}`]);
    await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenant, userId]);
    await db.query("INSERT INTO students(tenant_id,student_id,name) VALUES ($1,'S1','Synthetic student')", [tenant]);
  }
  const session = (await db.query<{ generation: string; session_id: string }>(
    "SELECT * FROM platform_begin_teacher_session($1,'2026-10-08')", [subject])).rows[0];
  return { userId, subject, tenants, session };
}

async function withdrawThroughRuntime(account: Awaited<ReturnType<typeof seedAccount>>) {
  return runtime(() => db.query<{ result: { closedClasses: number } }>(
    "SELECT platform_mutate_teacher_account('WITHDRAW',$1,$2,$3,'{}'::jsonb) AS result",
    [account.subject, account.session.generation, account.session.session_id]));
}

async function assertTenantPayloadsErased(tenant: string) {
  const columns = (await db.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name
    FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenant_id','claimed_by_tenant_id')`)).rows;
  for (const column of columns) {
    const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${column.table_name}" WHERE "${column.column_name}"=$1`, [tenant]);
    expect(result.rows[0].n, column.table_name).toBe(0);
  }
}

/** Tiny, genuine FK-linked copies covering every erasure-aware immutable trigger family. */
async function seedPrivateCopies(tenant: string) {
  const digest = 'd'.repeat(64);
  await db.query("UPDATE tenants SET lifecycle='DRAFT' WHERE id=$1", [tenant]);
  await db.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES ($1,'job','VALIDATED')", [tenant]);
  await db.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
    VALUES ($1,'job','source','GOOGLE_SHEETS',$2,$3)`, [tenant, `synthetic-sheet-${tenant}`, digest]);
  await db.query(`INSERT INTO migration_source_records(tenant_id,job_id,source_id,record_id,source_collection,
    source_record_id,source_row_hash,redacted_record,canonical_record)
    VALUES ($1,'job','source','record','Students','S1',$2,'{"name":"Synthetic copied student"}','{"name":"Synthetic copied student"}')`, [tenant, digest]);
  await db.query(`INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count)
    VALUES ($1,'job','source','snapshot','PREFLIGHT',$2,'{"historicalName":"Synthetic student"}',1)`, [tenant, digest]);
  await db.query(`INSERT INTO legacy_full_snapshot_archives(tenant_id,job_id,source_id,source_digest,projection_digest,
    grid_json,physical_rows,business_rows,captured_at)
    VALUES ($1,'job','source',$2,$2,'[["Synthetic archived student"]]',1,1,now())`, [tenant, digest]);
  await db.query(`INSERT INTO legacy_redis_snapshot_archives(tenant_id,job_id,source_id,source_digest,snapshot)
    VALUES ($1,'job','source',$2,'{"name":"Synthetic legacy student"}')`, [tenant, digest]);
  await db.query(`INSERT INTO legacy_claim_publications(tenant_id,job_id,source_id,source_digest,tombstone_count)
    VALUES ($1,'job','source',$2,1)`, [tenant, digest]);
  await db.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash)
    VALUES ($1,'evidence-operation','TASK_REWARD',$2)`, [tenant, digest]);
  const board = `synthetic-board-${tenant}`;
  const tupleDigest = createHash('sha256').update(`${board}\0post`).digest('hex');
  await db.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,
    claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
    VALUES ('PADLET',$1,'post',$2,$3,'evidence-operation',now(),'Synthetic evidence author')`, [board, tupleDigest, tenant]);
  await db.query(`INSERT INTO audit_events(tenant_id,event_id,job_id,operation_id,event_type,redacted_details)
    VALUES ($1,'event','job','evidence-operation','SYNTHETIC','{"historicalName":"Synthetic student"}')`, [tenant]);
  await db.query(`INSERT INTO migration_full_generations(tenant_id,migration_job_id,generation_id,candidate_generation_id,
    original_generation_id,plan_id,expected_state_version,source_fingerprint,manifest_digest)
    VALUES ($1,'job','generation','event','event','event',1,$2,$2)`, [tenant, digest]);
  await db.query(`INSERT INTO migration_full_sources(tenant_id,migration_job_id,generation_id,source_ordinal,source_value)
    VALUES ($1,'job','generation',0,'{"source":{"kind":"SHEET"},"name":"Synthetic generation student"}')`, [tenant]);
  const historicalSchedule = {
    ruleVersion: 1, effectiveFrom: '2026-01-01T00:00:00Z', timeZone: 'Asia/Seoul', recurrence: { type: 'UNAVAILABLE' },
    resetCompletionOnCycle: false, resetAssignmentOnCycle: false, legacyIdentityOnly: true, sourceDigest: digest,
  };
  await db.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,is_active,
    current_schedule,created_at,updated_at,deleted_at)
    VALUES ($1,'historical','T-history','Synthetic historical task','',0,false,$2,now(),now(),now())`, [tenant, JSON.stringify(historicalSchedule)]);
  await db.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenant]);
  return tupleDigest;
}

describe('withdrawal erasure: complete payload removal with isolated immutable guards', () => {
  it('does not grant runtime access to the erasure context, purge entry point or old unversioned mutators', async () => {
    for (const name of ['withdrawal_erasure_context', 'teacher_identity_generations', 'teacher_auth_sessions']) {
      await expect(runtime(() => db.exec(`SELECT * FROM ${name}`))).rejects.toThrow(/permission denied/);
    }
    await expect(runtime(() => db.query('SELECT platform_purge_withdrawal($1)', [randomUUID()]))).rejects.toThrow(/permission denied/);
    await expect(runtime(() => db.query("SELECT platform_withdraw_user('erasure-owner')"))).rejects.toThrow(/permission denied/);
    await expect(runtime(() => db.query("SELECT platform_record_user_agreement('erasure-owner','2026-10-08')"))).rejects.toThrow(/permission denied/);
    await expect(runtime(() => db.query('SELECT platform_withdrawal_erasure_allowed($1)', [OWN]))).rejects.toThrow(/permission denied/);
    await expect(runtime(() => db.query(`INSERT INTO withdrawal_erasure_context(backend_pid,transaction_id,class_id,withdrawal_id)
      VALUES (pg_backend_pid(),txid_current(),$1,$2)`, [OWN, randomUUID()]))).rejects.toThrow(/permission denied/);
  });

  it('orders the manifest before every referenced tenant table in the actual migrated schema', async () => {
    const migration = await readFile(resolve('src/server/db/migrations/0053_withdrawal_erasure.sql'), 'utf8');
    const manifest = [...migration.match(/v_tables text\[\] := ARRAY\[([\s\S]*?)\];/)![1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    const order = new Map(manifest.map((table, index) => [table, index]));
    const foreignKeys = (await db.query<{ child: string; parent: string; name: string }>(`SELECT
      child.relname AS child,parent.relname AS parent,c.conname AS name
      FROM pg_constraint c JOIN pg_class child ON child.oid=c.conrelid JOIN pg_class parent ON parent.oid=c.confrelid
      WHERE c.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace`)).rows;
    expect(manifest).toHaveLength(85);
    for (const fk of foreignKeys) {
      if (!order.has(fk.parent) || fk.child === fk.parent) continue;
      expect(order.has(fk.child), `${fk.name}: omitted child ${fk.child}`).toBe(true);
      expect(order.get(fk.child)!, `${fk.name}: ${fk.child} before ${fk.parent}`).toBeLessThan(order.get(fk.parent)!);
    }
  });

  it('keeps live ledger rows immutable even if the runtime sets fake erasure GUCs', async () => {
    await expect(runtime(async () => {
      await db.exec("SET LOCAL app.withdrawal_erasure='true'; SET LOCAL app.erasure='true';");
      return db.query("UPDATE transactions SET transaction_id='changed' WHERE tenant_id=$1", [OWN]);
    })).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM task_completions WHERE tenant_id=$1', [OTHER])).rejects.toThrow(/append-only/);
    await expect(db.exec('TRUNCATE legacy_full_snapshot_archives')).rejects.toThrow(/immutable/);
  });

  it('fails closed and rolls back withdrawal when a new tenant payload table is not in the erasure manifest', async () => {
    await db.exec('CREATE TABLE public.synthetic_new_payload(tenant_id uuid NOT NULL, payload text);');
    await expect(db.query("SELECT platform_withdraw_user('erasure-owner')")).rejects.toThrow(/manifest needs schema update/);
    expect((await db.query('SELECT lifecycle FROM tenants WHERE id=$1', [OWN])).rows).toEqual([{ lifecycle: 'ACTIVE' }]);
    expect((await db.query("SELECT count(*)::int AS n FROM users WHERE google_subject='erasure-owner'")).rows).toEqual([{ n: 1 }]);
    await db.exec('DROP TABLE public.synthetic_new_payload;');
  });

  it('erases all owned tenant payloads atomically, keeps other classes and permanently blocks reuse of erased evidence', async () => {
    // The global digest remains a one-way replay reservation after identity-bearing claim rows go.
    const digest = 'a'.repeat(64);
    await db.query("INSERT INTO padlet_claim_digest_registry(tuple_digest,claim_kind) VALUES ($1,'CLAIM')", [digest]);
    expect((await db.query("SELECT platform_withdraw_user('erasure-owner') AS n")).rows).toEqual([{ n: 1 }]);
    const tables = (await db.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name
      FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenant_id','claimed_by_tenant_id')`)).rows;
    for (const table of tables) {
      const result = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${table.table_name}" WHERE "${table.column_name}"=$1`, [OWN]);
      expect(result.rows[0].n, table.table_name).toBe(0);
    }
    expect((await db.query('SELECT name FROM students WHERE tenant_id=$1', [OTHER])).rows).toEqual([{ name: 'Synthetic name' }]);
    expect((await db.query('SELECT student_name_snapshot FROM transactions WHERE tenant_id=$1', [OTHER])).rows).toEqual([{ student_name_snapshot: 'Synthetic name' }]);
    const withdrawal = (await db.query<{ id: string; done: boolean }>('SELECT id,residual_purged_at IS NOT NULL AS done FROM account_withdrawals WHERE user_id=$1', [OWNER])).rows[0];
    expect(withdrawal.done).toBe(true);
    expect((await db.query('SELECT platform_purge_withdrawal($1) AS n', [withdrawal.id])).rows).toEqual([{ n: 0 }]);
    expect((await db.query('SELECT count(*)::int AS n FROM withdrawal_erasure_context')).rows).toEqual([{ n: 0 }]);
    expect((await db.query('SELECT slug,lifecycle FROM tenants WHERE id=$1', [OWN])).rows).toEqual([{ slug: `withdrawn-${OWN}`, lifecycle: 'SUSPENDED' }]);
    await expect(db.query("INSERT INTO padlet_claim_digest_registry(tuple_digest,claim_kind) VALUES ($1,'CLAIM')", [digest])).rejects.toThrow(/duplicate/);
    await expect(db.query("UPDATE transactions SET student_name_snapshot='changed' WHERE tenant_id=$1", [OTHER])).rejects.toThrow(/immutable/);
  });

  it('refuses a backlog record for an owner account that has not withdrawn', async () => {
    const id = randomUUID();
    await db.query('INSERT INTO account_withdrawals(id,user_id,tenant_ids) VALUES ($1,$2,$3)', [id, OTHER_OWNER, [OTHER]]);
    await expect(db.query('SELECT platform_purge_withdrawal($1)', [id])).rejects.toThrow(/withdrawn owner required/);
    expect((await db.query('SELECT count(*)::int AS n FROM students WHERE tenant_id=$1', [OTHER])).rows).toEqual([{ n: 1 }]);
  });

  it('erases an already-trashed class through the runtime session wrapper and revokes every teacher session', async () => {
    const account = await seedAccount();
    const [tenant] = account.tenants;
    await db.query("UPDATE tenants SET deleted_at=now(),deleted_lifecycle='ACTIVE',lifecycle='SUSPENDED' WHERE id=$1", [tenant]);
    const anotherSession = (await db.query<{ generation: string; session_id: string }>(
      "SELECT * FROM platform_begin_teacher_session($1,'2026-10-08')", [account.subject])).rows[0];
    expect((await withdrawThroughRuntime(account)).rows).toEqual([{ result: { closedClasses: 1 } }]);
    await assertTenantPayloadsErased(tenant);
    for (const session of [account.session, anotherSession]) {
      expect((await db.query("SELECT platform_validate_teacher_session($1,$2,$3,false,'2026-10-08') AS valid",
        [account.subject, session.generation, session.session_id])).rows).toEqual([{ valid: false }]);
    }
    expect((await db.query('SELECT nickname FROM user_profiles WHERE google_subject=$1', [account.subject])).rows).toEqual([]);
    expect((await db.query('SELECT agreement_version FROM user_agreements WHERE google_subject=$1', [account.subject])).rows).toEqual([]);
    expect((await db.query('SELECT google_subject,canonical_email,display_name FROM users WHERE id=$1', [account.userId])).rows)
      .toEqual([{ google_subject: `withdrawn:${account.userId}`, canonical_email: `withdrawn-${account.userId}@withdrawn.invalid`, display_name: null }]);
    const retained = (await db.query<{ generation: string; sessions: number }>(`SELECT g.generation,
      (SELECT count(*)::int FROM teacher_auth_sessions s WHERE s.subject_hash=g.subject_hash) AS sessions
      FROM teacher_identity_generations g WHERE g.subject_hash=encode(digest($1,'sha256'),'hex')`, [account.subject])).rows[0];
    expect(retained.generation).not.toBe(account.session.generation);
    expect(retained.sessions).toBe(0);
  });

  it('revokes newly issued durable sessions when a legacy owner caller withdraws the account', async () => {
    const account = await seedAccount();
    const anotherSession = (await db.query<{ generation: string; session_id: string }>(
      "SELECT * FROM platform_begin_teacher_session($1,'2026-10-08')", [account.subject])).rows[0];
    const sessions = [account.session, anotherSession];
    for (const session of sessions) {
      expect((await db.query("SELECT platform_validate_teacher_session($1,$2,$3,false,'2026-10-08') AS valid",
        [account.subject, session.generation, session.session_id])).rows).toEqual([{ valid: true }]);
    }
    // A rolling deployment may still use the owner-only, pre-session mutator.
    expect((await db.query('SELECT platform_withdraw_user($1) AS n', [account.subject])).rows).toEqual([{ n: 1 }]);
    await assertTenantPayloadsErased(account.tenants[0]);
    for (const session of sessions) {
      expect((await db.query("SELECT platform_validate_teacher_session($1,$2,$3,false,'2026-10-08') AS valid",
        [account.subject, session.generation, session.session_id])).rows).toEqual([{ valid: false }]);
    }
    const retained = (await db.query<{ generation: string; sessions: number }>(`SELECT g.generation,
      (SELECT count(*)::int FROM teacher_auth_sessions s WHERE s.subject_hash=g.subject_hash) AS sessions
      FROM teacher_identity_generations g WHERE g.subject_hash=encode(digest($1,'sha256'),'hex')`, [account.subject])).rows[0];
    expect(retained.generation).not.toBe(account.session.generation);
    expect(retained.sessions).toBe(0);
  });

  it('removes actual Padlet claims, immutable source archives and historical identities while retaining replay reservations', async () => {
    const account = await seedAccount();
    const otherAccount = await seedAccount();
    const [tenant] = account.tenants;
    const [otherTenant] = otherAccount.tenants;
    const tuple = await seedPrivateCopies(tenant);
    await seedPrivateCopies(otherTenant);
    await expect(db.query('DELETE FROM legacy_full_snapshot_archives WHERE tenant_id=$1', [tenant])).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM migration_full_generations WHERE tenant_id=$1', [tenant])).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM tasks WHERE tenant_id=$1', [tenant])).rejects.toThrow(/Historical task identities are immutable/);
    expect((await withdrawThroughRuntime(account)).rows).toEqual([{ result: { closedClasses: 1 } }]);
    await assertTenantPayloadsErased(tenant);
    expect((await db.query('SELECT grid_json FROM legacy_full_snapshot_archives WHERE tenant_id=$1', [otherTenant])).rows)
      .toEqual([{ grid_json: '[["Synthetic archived student"]]' }]);
    expect((await db.query('SELECT evidence_author_full_name FROM padlet_evidence_claims WHERE claimed_by_tenant_id=$1', [otherTenant])).rows)
      .toEqual([{ evidence_author_full_name: 'Synthetic evidence author' }]);
    expect((await db.query('SELECT claim_kind FROM padlet_claim_digest_registry WHERE tuple_digest=$1', [tuple])).rows)
      .toEqual([{ claim_kind: 'CLAIM' }]);
    await expect(db.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,
      claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
      VALUES ('PADLET',$1,'post',$2,$3,'evidence-operation',now(),'Synthetic replay')`, [`synthetic-board-${tenant}`, tuple, otherTenant])).rejects.toThrow(/duplicate/);
  });

  it('rolls back identity, sessions and every owned class when deletion fails after the first class was erased', async () => {
    const account = await seedAccount(2);
    const [firstTenant, secondTenant] = account.tenants;
    // Test-only failure injection. Production triggers remain enabled and unchanged.
    await db.exec(`CREATE FUNCTION public.synthetic_erasure_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.students WHERE tenant_id='${firstTenant}'::uuid) THEN
          RAISE EXCEPTION 'first class was not erased';
        END IF;
        RAISE EXCEPTION 'synthetic failure after first class erased';
      END $$;
      CREATE TRIGGER synthetic_erasure_failure BEFORE DELETE ON public.students
        FOR EACH ROW WHEN (OLD.tenant_id='${secondTenant}'::uuid) EXECUTE FUNCTION public.synthetic_erasure_failure();`);
    try {
      await expect(withdrawThroughRuntime(account)).rejects.toThrow(/synthetic failure after first class erased/);
      expect((await db.query('SELECT google_subject FROM users WHERE id=$1', [account.userId])).rows).toEqual([{ google_subject: account.subject }]);
      expect((await db.query('SELECT count(*)::int AS n FROM students WHERE tenant_id=ANY($1::uuid[])', [account.tenants])).rows).toEqual([{ n: 2 }]);
      expect((await db.query('SELECT count(*)::int AS n FROM tenant_memberships WHERE user_id=$1', [account.userId])).rows).toEqual([{ n: 2 }]);
      expect((await db.query("SELECT count(*)::int AS n FROM tenants WHERE id=ANY($1::uuid[]) AND lifecycle='ACTIVE' AND deleted_at IS NULL", [account.tenants])).rows).toEqual([{ n: 2 }]);
      expect((await db.query('SELECT count(*)::int AS n FROM account_withdrawals WHERE user_id=$1', [account.userId])).rows).toEqual([{ n: 0 }]);
      expect((await db.query('SELECT count(*)::int AS n FROM withdrawal_erasure_context')).rows).toEqual([{ n: 0 }]);
      expect((await db.query("SELECT platform_validate_teacher_session($1,$2,$3,false,'2026-10-08') AS valid",
        [account.subject, account.session.generation, account.session.session_id])).rows).toEqual([{ valid: true }]);
    } finally {
      await db.exec('DROP TRIGGER synthetic_erasure_failure ON public.students; DROP FUNCTION public.synthetic_erasure_failure();');
    }
  });
});
