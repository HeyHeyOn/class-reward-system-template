// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const MIGRATIONS = [
  '0001_identity_tenants.sql', '0002_operational.sql', '0003_operations_migrations.sql', '0004_admin_operation_kinds.sql',
  '0005_mutable_entity_versions.sql', '0006_immutable_ledger_guards.sql', '0007_inventory_ledger_guard.sql',
  '0008_product_tombstone_invariant.sql', '0038_class_dashboard.sql', '0043_teacher_accounts.sql',
];
const RUNTIME_FUNCTIONS = [
  'platform_latest_user_agreement(text)', 'platform_has_user_agreement(text,text)', 'platform_record_user_agreement(text,text)',
  'platform_get_user_profile(text)', 'platform_save_user_profile(text,text,jsonb)', 'platform_withdraw_user(text)',
];
const TEACHER = 'google-teacher-1';
const OTHER = 'google-teacher-2';
const USER = '30000000-0000-4000-8000-000000000001';
const OTHER_USER = '30000000-0000-4000-8000-000000000002';
const ACTIVE_CLASS = '40000000-0000-4000-8000-000000000001';
const TRASHED_CLASS = '40000000-0000-4000-8000-000000000002';
const OTHER_CLASS = '40000000-0000-4000-8000-000000000003';
let db: PGlite;

async function runtime<T>(callback: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN; SET LOCAL ROLE account_runtime;');
  try {
    const result = await callback();
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}
const call = <T>(sql: string, values: unknown[]) => runtime(async () => (await db.query<T>(sql, values)).rows);

describe('teacher accounts (0043): agreements, profiles and withdrawal', () => {
  beforeAll(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    for (const name of MIGRATIONS) await db.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8'));
    await db.exec(`CREATE ROLE account_runtime NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public TO account_runtime;
      GRANT EXECUTE ON FUNCTION ${RUNTIME_FUNCTIONS.map((name) => `public.${name}`).join(',')} TO account_runtime;`);
    await db.query(`INSERT INTO users(id,google_subject,canonical_email,display_name) VALUES
      ($1,$3,'teacher@example.com','김선생'),($2,$4,'other@example.com','이선생')`, [USER, OTHER_USER, TEACHER, OTHER]);
    await db.query(`INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES
      ($1,'kim-active','6학년 3반','ACTIVE'),($2,'kim-trashed','작년 반','ACTIVE'),($3,'lee-class','이선생 반','ACTIVE')`,
    [ACTIVE_CLASS, TRASHED_CLASS, OTHER_CLASS]);
    await db.query(`INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$4,'OWNER'),($2,$4,'OWNER'),($3,$5,'OWNER')`,
      [ACTIVE_CLASS, TRASHED_CLASS, OTHER_CLASS, USER, OTHER_USER]);
    await db.query(`INSERT INTO students(tenant_id,student_id,name) VALUES ($1,'1','홍길동'),($1,'2','김철수'),($2,'1','박영희'),($3,'1','최민수')`,
      [ACTIVE_CLASS, TRASHED_CLASS, OTHER_CLASS]);
    await db.query(`INSERT INTO tenant_settings(tenant_id,settings) VALUES ($1,'{"className":"6학년 3반"}'),($2,'{"className":"이선생 반"}')`,
      [ACTIVE_CLASS, OTHER_CLASS]);
    await db.query(`UPDATE tenants SET deleted_at=now(),deleted_lifecycle='ACTIVE',lifecycle='SUSPENDED' WHERE id=$1`, [TRASHED_CLASS]);
  }, 60000);
  afterAll(async () => { await db?.close(); });

  it('keeps the runtime away from the tables themselves', async () => {
    await expect(call('SELECT * FROM user_agreements', [])).rejects.toThrow();
    await expect(call('SELECT * FROM user_profiles', [])).rejects.toThrow();
    await expect(call('SELECT * FROM account_withdrawals', [])).rejects.toThrow();
  });

  it('records an agreement once per version and reports the latest one', async () => {
    expect((await call<{ has: boolean }>('SELECT platform_has_user_agreement($1,$2) AS has', [TEACHER, '2026-10-08']))[0].has).toBe(false);
    expect(await call('SELECT * FROM platform_latest_user_agreement($1)', [TEACHER])).toEqual([]);
    const [first] = await call<{ at: Date }>('SELECT platform_record_user_agreement($1,$2) AS at', [TEACHER, '2026-10-08']);
    const [again] = await call<{ at: Date }>('SELECT platform_record_user_agreement($1,$2) AS at', [TEACHER, '2026-10-08']);
    expect(again.at).toEqual(first.at);
    await call('SELECT platform_record_user_agreement($1,$2)', [TEACHER, '2026-12-01']);
    expect((await call<{ has: boolean }>('SELECT platform_has_user_agreement($1,$2) AS has', [TEACHER, '2026-10-08']))[0].has).toBe(true);
    expect((await call<{ agreement_version: string }>('SELECT * FROM platform_latest_user_agreement($1)', [TEACHER]))[0].agreement_version).toBe('2026-12-01');
    await expect(call('SELECT platform_record_user_agreement($1,$2)', [TEACHER, 'latest'])).rejects.toThrow(/invalid agreement version/);
    await expect(call('SELECT platform_record_user_agreement($1,$2)', [' padded', '2026-10-08'])).rejects.toThrow(/invalid google subject/);
  });

  it('saves a profile only for an account that has agreed, within the bounds', async () => {
    const avatar = { v: 1, background: 'sky', face: 'bear', eyes: 'smile', mouth: 'smile', accessory: 'none' };
    await expect(call('SELECT platform_save_user_profile($1,$2,$3)', [OTHER, '이선생', avatar])).rejects.toThrow(/agreement required/);
    await call('SELECT platform_save_user_profile($1,$2,$3)', [TEACHER, '별빛쌤', avatar]);
    await call('SELECT platform_save_user_profile($1,$2,$3)', [TEACHER, '햇살쌤', avatar]);
    expect(await call('SELECT nickname, avatar FROM platform_get_user_profile($1)', [TEACHER])).toEqual([{ nickname: '햇살쌤', avatar }]);
    await expect(call('SELECT platform_save_user_profile($1,$2,$3)', [TEACHER, '가'.repeat(21), avatar])).rejects.toThrow();
    await expect(call('SELECT platform_save_user_profile($1,$2,$3)', [TEACHER, ' 공백 ', avatar])).rejects.toThrow();
    await expect(call('SELECT platform_save_user_profile($1,$2,$3)', [TEACHER, '햇살쌤', [1, 2]])).rejects.toThrow();
  });

  it('withdraws: closes the owned classes, erases student names, unlinks the account, and leaves other teachers alone', async () => {
    await call('SELECT platform_record_user_agreement($1,$2)', [OTHER, '2026-10-08']);
    const [result] = await call<{ count: number }>('SELECT platform_withdraw_user($1) AS count', [TEACHER]);
    expect(result.count).toBe(2);

    const classes = (await db.query<{ id: string; display_name: string; lifecycle: string; deleted_at: Date | null }>(
      'SELECT id, display_name, lifecycle, deleted_at FROM tenants ORDER BY id')).rows;
    expect(classes.find((row) => row.id === ACTIVE_CLASS)).toMatchObject({ display_name: '탈퇴로 삭제된 학급', lifecycle: 'SUSPENDED' });
    expect(classes.find((row) => row.id === ACTIVE_CLASS)?.deleted_at).not.toBeNull();
    expect(classes.find((row) => row.id === TRASHED_CLASS)).toMatchObject({ display_name: '탈퇴로 삭제된 학급', lifecycle: 'SUSPENDED' });
    expect(classes.find((row) => row.id === OTHER_CLASS)).toMatchObject({ display_name: '이선생 반', lifecycle: 'ACTIVE', deleted_at: null });

    const names = (await db.query<{ tenant_id: string; name: string; status: string }>('SELECT tenant_id, name, status FROM students ORDER BY tenant_id, student_id')).rows;
    expect(names.filter((row) => row.tenant_id !== OTHER_CLASS).every((row) => row.name === '삭제된 학생' && row.status === 'INACTIVE')).toBe(true);
    expect(names.find((row) => row.tenant_id === OTHER_CLASS)).toMatchObject({ name: '최민수', status: 'ACTIVE' });
    expect((await db.query('SELECT settings FROM tenant_settings WHERE tenant_id=$1', [ACTIVE_CLASS])).rows[0]).toEqual({ settings: {} });

    expect((await db.query('SELECT count(*)::int AS n FROM tenant_memberships WHERE user_id=$1', [USER])).rows[0]).toEqual({ n: 0 });
    const [account] = (await db.query<{ google_subject: string; canonical_email: string; display_name: string | null }>(
      'SELECT google_subject, canonical_email, display_name FROM users WHERE id=$1', [USER])).rows;
    expect(account).toEqual({ google_subject: `withdrawn:${USER}`, canonical_email: `withdrawn-${USER}@withdrawn.invalid`, display_name: null });
    expect(await call('SELECT * FROM platform_get_user_profile($1)', [TEACHER])).toEqual([]);
    expect(await call('SELECT * FROM platform_latest_user_agreement($1)', [TEACHER])).toEqual([]);
    expect((await call<{ has: boolean }>('SELECT platform_has_user_agreement($1,$2) AS has', [OTHER, '2026-10-08']))[0].has).toBe(true);

    const [withdrawal] = (await db.query<{ user_id: string; tenant_ids: string[] }>('SELECT user_id, tenant_ids FROM account_withdrawals')).rows;
    expect(withdrawal.user_id).toBe(USER);
    expect([...withdrawal.tenant_ids].sort()).toEqual([ACTIVE_CLASS, TRASHED_CLASS]);
    // The closed classes stay read-only behind the trash guard.
    await expect(db.query("UPDATE students SET name='다시' WHERE tenant_id=$1", [ACTIVE_CLASS])).rejects.toThrow(/class is in trash/);
  });

  it('withdraws an account that never created a class, and refuses a withdrawn identifier', async () => {
    await call('SELECT platform_record_user_agreement($1,$2)', ['google-new-teacher', '2026-10-08']);
    expect((await call<{ count: number }>('SELECT platform_withdraw_user($1) AS count', ['google-new-teacher']))[0].count).toBe(0);
    expect(await call('SELECT * FROM platform_latest_user_agreement($1)', ['google-new-teacher'])).toEqual([]);
    await expect(call('SELECT platform_withdraw_user($1)', [`withdrawn:${USER}`])).rejects.toThrow(/invalid google subject/);
  });
});
