// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 0059: a year after a withdrawal, its record, the shells it left and the identifier hash go.
let db: PGlite;
const hash = (subject: string) => createHash('sha256').update(subject).digest('hex');
const one = async <T>(sql: string, values: unknown[] = []) => (await db.query<T>(sql, values)).rows[0];
const count = async (sql: string, values: unknown[] = []) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${sql}`, values)).n;

async function expire() {
  await db.exec('BEGIN; SET LOCAL ROLE crs_app_runtime;');
  try {
    const result = await one<{ result: Record<string, number> }>('SELECT platform_expire_withdrawal_records() AS result');
    await db.exec('COMMIT');
    return result.result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

type Teacher = Readonly<{ subject: string; userId: string; classId: string; purgedClassId: string }>;

/** A teacher with one live class, one class erased earlier and a signed-in session. */
async function teacher(): Promise<Teacher> {
  const userId = randomUUID();
  const subject = `retention-${userId}`;
  const classId = randomUUID();
  const purgedClassId = randomUUID();
  await db.query('INSERT INTO users(id,google_subject,canonical_email,display_name) VALUES ($1,$2,$3,$4)',
    [userId, subject, `${userId}@example.test`, '합성 선생님']);
  await db.query("SELECT platform_record_user_agreement($1,'2026-10-08')", [subject]);
  await db.query("SELECT platform_save_user_profile($1,'합성 닉네임','{}'::jsonb)", [subject]);
  await db.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES ($1,$2,'합성 학급','ACTIVE')", [classId, `c-${classId}`]);
  await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [classId, userId]);
  await db.query("INSERT INTO students(tenant_id,student_id,name) VALUES ($1,'S1','합성 학생')", [classId]);
  await db.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES ($1,$2,'삭제된 학급','SUSPENDED')", [purgedClassId, `purged-${purgedClassId}`]);
  await db.query('INSERT INTO class_purges(operation_id,class_id,user_id) VALUES ($1,$2,$3)', [randomUUID(), purgedClassId, userId]);
  await db.query("SELECT * FROM platform_begin_teacher_session($1,'2026-10-08')", [subject]);
  return { subject, userId, classId, purgedClassId };
}
const withdraw = (t: Teacher) => db.query('SELECT platform_withdraw_user($1)', [t.subject]);
const age = (t: Teacher, interval: string) => db.query(
  `UPDATE account_withdrawals SET withdrawn_at=withdrawn_at - $2::interval, residual_purged_at=residual_purged_at - $2::interval WHERE user_id=$1`,
  [t.userId, interval]);
const left = async (t: Teacher) => ({
  record: await count('account_withdrawals WHERE user_id=$1', [t.userId]),
  classes: await count('tenants WHERE id = ANY($1)', [[t.classId, t.purgedClassId]]),
  purges: await count('class_purges WHERE user_id=$1', [t.userId]),
  account: await count('users WHERE id=$1', [t.userId]),
  identity: await count('teacher_identity_generations WHERE subject_hash=$1', [hash(t.subject)]),
});
const ALL = { record: 1, classes: 2, purges: 1, account: 1, identity: 1 };
const NONE = { record: 0, classes: 0, purges: 0, account: 0, identity: 0 };

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  const directory = resolve('src/server/db/migrations');
  for (const file of (await readdir(directory)).filter((file) => /^\d{4}_.*\.sql$/.test(file)).sort()) {
    await db.exec(await readFile(resolve(directory, file), 'utf8'));
  }
  await db.exec('CREATE ROLE crs_app_runtime NOSUPERUSER NOBYPASSRLS;');
  await db.exec(await readFile(resolve('src/server/db/provisioning/runtimeGrants.sql'), 'utf8'));
}, 120000);
afterAll(async () => { await db?.close(); });

describe('withdrawal records kept for one year (0059)', () => {
  it('records the identifier hash with each withdrawal', async () => {
    const t = await teacher();
    await withdraw(t);
    expect((await one<{ subject_hash: string }>('SELECT subject_hash FROM account_withdrawals WHERE user_id=$1', [t.userId])).subject_hash).toBe(hash(t.subject));
    expect(await left(t)).toEqual(ALL);
  });

  it('erases a record past its year with every shell it left, and keeps the younger ones and everyone else', async () => {
    const old = await teacher();
    const recent = await teacher();
    const live = await teacher();
    await withdraw(old);
    await withdraw(recent);
    await age(old, '1 year 1 day');
    await age(recent, '364 days');

    expect(await expire()).toEqual({ records: 1, classes: 2, accounts: 1, identities: 1 });
    expect(await left(old)).toEqual(NONE);
    expect(await left(recent)).toEqual(ALL);
    expect(await left(live)).toEqual({ record: 0, classes: 2, purges: 1, account: 1, identity: 1 });
    expect(await count('user_agreements WHERE google_subject=$1', [live.subject])).toBe(1);
    expect(await count('students WHERE tenant_id=$1', [live.classId])).toBe(1);
    expect(await count('teacher_auth_sessions WHERE subject_hash=$1', [hash(live.subject)])).toBe(1);

    expect(await expire()).toEqual({ records: 0, classes: 0, accounts: 0, identities: 0 });
  });

  it('keeps the identifier hash of a Google account that signed up again', async () => {
    const back = await teacher();
    await withdraw(back);
    await age(back, '2 years');
    await db.query("SELECT platform_record_user_agreement($1,'2026-10-08')", [back.subject]);
    await db.query("SELECT * FROM platform_begin_teacher_session($1,'2026-10-08')", [back.subject]);

    await expire();
    expect(await left(back)).toEqual({ record: 0, classes: 0, purges: 0, account: 0, identity: 1 });
    expect(await count('user_agreements WHERE google_subject=$1', [back.subject])).toBe(1);
  });

  it('leaves a shell another class still names, without its name or address', async () => {
    const helper = await teacher();
    const owner = await teacher();
    await db.query("INSERT INTO audit_events(tenant_id,event_id,actor_user_id,event_type) VALUES ($1,'helped',$2,'SYNTHETIC')", [owner.classId, helper.userId]);
    await withdraw(helper);
    await age(helper, '1 year 1 day');

    await expire();
    expect(await left(helper)).toEqual({ record: 0, classes: 0, purges: 0, account: 1, identity: 0 });
    expect(await one('SELECT google_subject LIKE $2 AS unlinked, display_name FROM users WHERE id=$1', [helper.userId, 'withdrawn:%']))
      .toEqual({ unlinked: true, display_name: null });
    expect(await count('audit_events WHERE tenant_id=$1', [owner.classId])).toBe(1);
  });

  it('erases identifier hashes of older records only once none of them is left within its year', async () => {
    const legacy = await teacher();
    const orphan = `orphan-${randomUUID()}`;
    await withdraw(legacy);
    await db.query('UPDATE account_withdrawals SET subject_hash=NULL WHERE user_id=$1', [legacy.userId]);
    await db.query('INSERT INTO teacher_identity_generations(subject_hash) VALUES ($1)', [hash(orphan)]);

    await expire();
    expect(await left(legacy)).toEqual(ALL);
    expect(await count('teacher_identity_generations WHERE subject_hash=$1', [hash(orphan)])).toBe(1);

    await age(legacy, '1 year 1 day');
    await expire();
    expect(await left(legacy)).toEqual(NONE);
    expect(await count('teacher_identity_generations WHERE subject_hash=$1', [hash(orphan)])).toBe(0);
    const live = (await db.query<{ subject_hash: string }>('SELECT subject_hash FROM teacher_identity_generations')).rows.length;
    expect(live).toBeGreaterThan(0);
  });

  it('gives the runtime nothing but the daily expiry', async () => {
    await db.exec('BEGIN; SET LOCAL ROLE crs_app_runtime;');
    try {
      await expect(db.query("SELECT platform_identity_in_use('x')")).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('ROLLBACK');
    }
    await db.exec('BEGIN; SET LOCAL ROLE crs_app_runtime;');
    try {
      await expect(db.query('SELECT count(*) FROM account_withdrawals')).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec('ROLLBACK');
    }
  });
});
