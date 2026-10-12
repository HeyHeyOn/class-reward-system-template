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
const REVISION = '2026-10-08';

async function runtime<T>(tenant: string, callback: () => Promise<T>) {
  await db.exec(`BEGIN; SET LOCAL ROLE crs_app_runtime; SET LOCAL app.tenant_id='${tenant}';`);
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
}, 120000);
afterAll(async () => { await db?.close(); });

type Account = Awaited<ReturnType<typeof seedAccount>>;

/** A teacher who owns one class with a student, a sale and a completed task. */
async function seedAccount(name = 'Synthetic classroom') {
  const userId = randomUUID();
  const subject = `synthetic-${userId}`;
  const tenant = randomUUID();
  const slug = `synthetic-${tenant}`;
  await db.query('INSERT INTO users(id,google_subject,canonical_email,display_name) VALUES ($1,$2,$3,$4)',
    [userId, subject, `${userId}@example.test`, 'Synthetic teacher']);
  await db.query('SELECT platform_record_user_agreement($1,$2)', [subject, REVISION]);
  await db.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES ($1,$2,$3,'ACTIVE')", [tenant, slug, name]);
  await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenant, userId]);
  await db.query("INSERT INTO students(tenant_id,student_id,name) VALUES ($1,'S1','Synthetic student')", [tenant]);
  await db.query(`INSERT INTO transactions(tenant_id,transaction_id,occurred_at,student_id,student_name_snapshot,
    kind,legacy_total_amount,balance_delta,balance_before,balance_after,operator_snapshot)
    VALUES ($1,'X1',now(),'S1','Synthetic student','CHECKOUT',1,-1,10,9,'Synthetic teacher')`, [tenant]);
  await db.query(`INSERT INTO task_completions(tenant_id,completion_id,completed_at,task_id_snapshot,task_name_snapshot,
    student_id,student_name_snapshot,reward_snapshot,balance_before,balance_after,status)
    VALUES ($1,'C1',now(),'T1','Synthetic task','S1','Synthetic student',1,9,10,'COMPLETED')`, [tenant]);
  const session = (await db.query<{ generation: string; session_id: string }>(
    'SELECT * FROM platform_begin_teacher_session($1,$2)', [subject, REVISION])).rows[0];
  return { userId, subject, tenant, slug, name, session };
}

/** Tiny, genuine copies in the immutable families (archives, Padlet claims, historical identities). */
async function seedPrivateCopies(tenant: string) {
  const digest = 'd'.repeat(64);
  await db.query("UPDATE tenants SET lifecycle='DRAFT' WHERE id=$1", [tenant]);
  await db.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES ($1,'job','VALIDATED')", [tenant]);
  await db.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
    VALUES ($1,'job','source','GOOGLE_SHEETS',$2,$3)`, [tenant, `synthetic-sheet-${tenant}`, digest]);
  await db.query(`INSERT INTO legacy_full_snapshot_archives(tenant_id,job_id,source_id,source_digest,projection_digest,
    grid_json,physical_rows,business_rows,captured_at)
    VALUES ($1,'job','source',$2,$2,'[["Synthetic archived student"]]',1,1,now())`, [tenant, digest]);
  await db.query(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash)
    VALUES ($1,'evidence-operation','TASK_REWARD',$2)`, [tenant, digest]);
  const board = `synthetic-board-${tenant}`;
  const tupleDigest = createHash('sha256').update(`${board}\0post`).digest('hex');
  await db.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,
    claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
    VALUES ('PADLET',$1,'post',$2,$3,'evidence-operation',now(),'Synthetic evidence author')`, [board, tupleDigest, tenant]);
  const historicalSchedule = {
    ruleVersion: 1, effectiveFrom: '2026-01-01T00:00:00Z', timeZone: 'Asia/Seoul', recurrence: { type: 'UNAVAILABLE' },
    resetCompletionOnCycle: false, resetAssignmentOnCycle: false, legacyIdentityOnly: true, sourceDigest: digest,
  };
  await db.query(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,is_active,
    current_schedule,created_at,updated_at,deleted_at)
    VALUES ($1,'historical','T-history','Synthetic historical task','',0,false,$2,now(),now(),now())`, [tenant, JSON.stringify(historicalSchedule)]);
  await db.query("UPDATE tenants SET lifecycle='ACTIVE' WHERE id=$1", [tenant]);
}

async function version(tenant: string) {
  return (await db.query<{ v: string }>('SELECT management_version::text AS v FROM tenants WHERE id=$1', [tenant])).rows[0].v;
}

/** Moves the class to the trash the way the class list does. */
async function trash(account: Account) {
  const current = await version(account.tenant);
  await runtime(account.tenant, () => db.query(
    "SELECT platform_manage_class_authenticated($1,$2,$3,'DELETE',$4,$5::bigint,$6,$7,$8) AS result",
    [randomUUID(), account.slug, account.subject, account.name, current,
      account.session.generation, account.session.session_id, REVISION]));
}

async function purge(account: Account, overrides: Partial<{ operation: string; name: string; version: string; subject: string; session: Account['session'] }> = {}) {
  const session = overrides.session ?? account.session;
  const expected = overrides.version ?? await version(account.tenant);
  return runtime(account.tenant, async () => (await db.query<{ result: Record<string, unknown> }>(
    'SELECT platform_purge_class_authenticated($1,$2,$3,$4,$5::bigint,$6,$7,$8) AS result',
    [overrides.operation ?? randomUUID(), account.slug, overrides.subject ?? account.subject, overrides.name ?? account.name,
      expected, session.generation, session.session_id, REVISION])).rows[0].result);
}

async function payloadRows(tenant: string) {
  const columns = (await db.query<{ table_name: string; column_name: string }>(`SELECT table_name,column_name
    FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenant_id','claimed_by_tenant_id')`)).rows;
  let total = 0;
  const left: string[] = [];
  for (const column of columns) {
    const n = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${column.table_name}" WHERE "${column.column_name}"=$1`, [tenant])).rows[0].n;
    total += n;
    if (n) left.push(column.table_name);
  }
  return { total, left };
}

describe('class purge: erasing a class in the trash for good', () => {
  it('lets the runtime reach only the session-checked entry point', async () => {
    const account = await seedAccount();
    for (const name of ['class_erasure_context', 'class_purges']) {
      await expect(runtime(account.tenant, () => db.exec(`SELECT * FROM ${name}`))).rejects.toThrow(/permission denied/);
    }
    await expect(runtime(account.tenant, () => db.query("SELECT platform_purge_class($1,$2,$3,$4,1)",
      [randomUUID(), account.slug, account.subject, account.name]))).rejects.toThrow(/permission denied/);
    await expect(runtime(account.tenant, () => db.query('SELECT platform_class_erasure_tables()'))).rejects.toThrow(/permission denied/);
  });

  it('erases only a class in the trash, owned by the caller, confirmed by its exact name and current version', async () => {
    const account = await seedAccount();
    const stranger = await seedAccount();
    // Still in use: not in the trash.
    await expect(purge(account)).rejects.toMatchObject({ code: '23505' });
    await trash(account);
    await expect(purge(account, { name: 'Another name' })).rejects.toMatchObject({ code: '23505' });
    await expect(purge(account, { version: '1' })).rejects.toMatchObject({ code: '23505' });
    await expect(purge(account, { subject: stranger.subject, session: stranger.session })).rejects.toMatchObject({ code: '42501' });
    expect((await payloadRows(account.tenant)).total).toBeGreaterThan(0);
  });

  it('deletes every row of the class, leaves an anonymous tombstone and other classes untouched, and answers a retry the same', async () => {
    const account = await seedAccount('6학년 3반');
    const other = await seedAccount('Other classroom');
    await seedPrivateCopies(account.tenant);
    await seedPrivateCopies(other.tenant);
    await trash(account);
    // In the trash the immutable rows stay immutable.
    await expect(db.query('DELETE FROM legacy_full_snapshot_archives WHERE tenant_id=$1', [account.tenant])).rejects.toThrow(/immutable/);
    await expect(db.query('DELETE FROM transactions WHERE tenant_id=$1', [account.tenant])).rejects.toThrow();

    const operation = randomUUID();
    const result = await purge(account, { operation });
    expect(result).toMatchObject({ slug: account.slug, action: 'PURGE', replayed: false });
    expect(await payloadRows(account.tenant)).toEqual({ total: 0, left: [] });
    expect((await db.query('SELECT slug,display_name,lifecycle,deleted_at IS NOT NULL AS trashed FROM tenants WHERE id=$1', [account.tenant])).rows)
      .toEqual([{ slug: `purged-${account.tenant}`, display_name: '삭제된 학급', lifecycle: 'SUSPENDED', trashed: true }]);
    expect((await db.query('SELECT slug FROM platform_list_class_dashboard($1)', [account.subject])).rows).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM class_erasure_context')).rows).toEqual([{ n: 0 }]);
    expect((await db.query('SELECT class_id,user_id FROM class_purges WHERE operation_id=$1', [operation])).rows)
      .toEqual([{ class_id: account.tenant, user_id: account.userId }]);

    // The other class keeps everything, and stays immutable.
    expect((await payloadRows(other.tenant)).total).toBeGreaterThan(5);
    expect((await db.query('SELECT name FROM students WHERE tenant_id=$1', [other.tenant])).rows).toEqual([{ name: 'Synthetic student' }]);
    await expect(db.query("UPDATE transactions SET student_name_snapshot='changed' WHERE tenant_id=$1", [other.tenant])).rejects.toThrow(/immutable/);

    // A retry of the same request (an answer lost on the way) gets the same answer; nobody else may reuse it.
    expect(await purge(account, { operation, version: result.managementVersion as string })).toMatchObject({ action: 'PURGE', replayed: true });
    await expect(purge(other, { operation })).rejects.toMatchObject({ code: '23505' });
  });

  it('fails closed and changes nothing when a new class table is missing from the erasure manifest', async () => {
    const account = await seedAccount();
    await trash(account);
    await db.exec('CREATE TABLE public.synthetic_new_payload(tenant_id uuid NOT NULL, payload text);');
    try {
      await expect(purge(account)).rejects.toThrow(/manifest needs schema update/);
      expect((await db.query('SELECT count(*)::int AS n FROM students WHERE tenant_id=$1', [account.tenant])).rows).toEqual([{ n: 1 }]);
      expect((await db.query('SELECT slug FROM tenants WHERE id=$1', [account.tenant])).rows).toEqual([{ slug: account.slug }]);
    } finally {
      await db.exec('DROP TABLE public.synthetic_new_payload;');
    }
  });

  it('keeps account withdrawal erasing through the same shared manifest', async () => {
    const account = await seedAccount();
    await seedPrivateCopies(account.tenant);
    expect((await db.query('SELECT platform_withdraw_user($1) AS n', [account.subject])).rows).toEqual([{ n: 1 }]);
    expect(await payloadRows(account.tenant)).toEqual({ total: 0, left: [] });
  });
  it('passes over a listed table that a later cleanup dropped (reward_vouchers is due to go)', async () => {
    const account = await seedAccount();
    await trash(account);
    await db.exec('DROP TABLE public.reward_vouchers;');
    expect(await purge(account)).toMatchObject({ action: 'PURGE', replayed: false });
    expect(await payloadRows(account.tenant)).toEqual({ total: 0, left: [] });
    const other = await seedAccount();
    expect((await db.query('SELECT platform_withdraw_user($1) AS n', [other.subject])).rows).toEqual([{ n: 1 }]);
    expect(await payloadRows(other.tenant)).toEqual({ total: 0, left: [] });
  });

});
