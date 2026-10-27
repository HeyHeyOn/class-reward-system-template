// @vitest-environment node
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 0058: sessions and agreements for teachers the 딴쌤 hub signs in, called as the runtime role.
let db: PGlite;
const AVATAR = '{"animal":"cat","color":"sky"}';

async function runtime<T>(callback: () => Promise<T>): Promise<T> {
  await db.exec('BEGIN; SET LOCAL ROLE crs_app_runtime;');
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
type Session = { generation: string; session_id: string };
const begin = async (subject: string, sid: string, nickname = '별빛쌤', terms = '2026-12-05') =>
  (await call<Session>('SELECT * FROM platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb)', [subject, terms, sid, nickname, AVATAR]))[0];
const valid = async (subject: string, session: Session, version: string | null = 'hub') =>
  (await call<{ ok: boolean }>('SELECT platform_validate_teacher_session($1,$2,$3,false,$4) AS ok',
    [subject, session.generation, session.session_id, version]))[0].ok;
const one = async <T>(sql: string, values: unknown[]) => (await db.query<T>(sql, values)).rows[0];

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

describe('딴쌤 accounts (0058)', () => {
  it('starts an agreed class session bound to the hub session and records the hub agreement apart', async () => {
    const subject = `hub-${randomUUID()}`;
    const session = await begin(subject, 'sid-a');
    expect(await valid(subject, session)).toBe(true);
    expect(await valid(subject, session, '2026-10-08')).toBe(false);
    expect((await call<{ has: boolean }>("SELECT platform_has_user_agreement($1,'hub') AS has", [subject]))[0].has).toBe(true);
    expect(await call('SELECT * FROM platform_latest_user_agreement($1)', [subject])).toEqual([]);
    expect((await one<{ v: string }>('SELECT agreement_version AS v FROM user_agreements WHERE google_subject=$1', [subject])).v).toBe('hub:2026-12-05');
    expect((await one<{ hub_sid: string; pending: boolean }>('SELECT hub_sid,pending FROM teacher_auth_sessions WHERE session_id=$1', [session.session_id])))
      .toEqual({ hub_sid: 'sid-a', pending: false });
    const create = (version: string) => call<{ lifecycle: string }>('SELECT * FROM platform_create_draft_class_authenticated($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), subject, `${session.session_id}@example.test`, '별빛쌤', session.generation, session.session_id, version]);
    await expect(create('2026-10-08')).rejects.toThrow(/agreement required/);
    expect((await create('hub'))[0].lifecycle).toBe('DRAFT');
  });

  it('keeps a Google teacher\'s class agreement working beside a hub agreement', async () => {
    const subject = `both-${randomUUID()}`;
    await db.query("SELECT platform_record_user_agreement($1,'2026-10-08')", [subject]);
    await begin(subject, 'sid-b');
    expect((await call<{ has: boolean }>("SELECT platform_has_user_agreement($1,'2026-10-08') AS has", [subject]))[0].has).toBe(true);
    expect((await call<{ agreement_version: string }>('SELECT * FROM platform_latest_user_agreement($1)', [subject]))[0].agreement_version).toBe('2026-10-08');
    await expect(db.query("SELECT platform_record_user_agreement($1,'hub:2026-12-05')", [subject])).rejects.toThrow(/invalid agreement version/);
  });

  it('sets the nickname to the 딴쌤 account name on each sign-in and keeps the class avatar', async () => {
    const subject = `nick-${randomUUID()}`;
    await begin(subject, 'sid-c1', '첫이름');
    expect(await one('SELECT nickname,avatar FROM user_profiles WHERE google_subject=$1', [subject]))
      .toEqual({ nickname: '첫이름', avatar: JSON.parse(AVATAR) });
    await db.query(`UPDATE user_profiles SET avatar='{"animal":"fox","color":"mint"}' WHERE google_subject=$1`, [subject]);
    await begin(subject, 'sid-c2', '바뀐이름', '2027-03-01');
    expect(await one('SELECT nickname,avatar FROM user_profiles WHERE google_subject=$1', [subject]))
      .toEqual({ nickname: '바뀐이름', avatar: { animal: 'fox', color: 'mint' } });
    expect((await db.query('SELECT 1 FROM user_agreements WHERE google_subject=$1', [subject])).rows).toHaveLength(2);
  });

  it('refuses a malformed terms version or hub session', async () => {
    await expect(begin('bad-terms', 'sid', '이름', '12/05')).rejects.toThrow(/invalid hub terms version/);
    await expect(begin('bad-sid', ' sid', '이름')).rejects.toThrow(/invalid hub session/);
    await expect(begin('bad-sid', '', '이름')).rejects.toThrow(/invalid hub session/);
    await expect(begin(' padded', 'sid', '이름')).rejects.toThrow(/invalid google subject/);
  });

  it('ends only the class sessions made from the hub session that signed out', async () => {
    const subject = `logout-${randomUUID()}`;
    const phone = await begin(subject, `sid-phone-${subject}`);
    const laptop = await begin(subject, `sid-laptop-${subject}`);
    expect((await call<{ n: number }>('SELECT platform_end_hub_teacher_sessions($1) AS n', [`sid-phone-${subject}`]))[0].n).toBe(1);
    expect(await valid(subject, phone)).toBe(false);
    expect(await valid(subject, laptop)).toBe(true);
    expect((await call<{ n: number }>('SELECT platform_end_hub_teacher_sessions($1) AS n', [`sid-phone-${subject}`]))[0].n).toBe(0);
    expect((await call<{ n: number }>('SELECT platform_end_hub_teacher_sessions($1) AS n', [' padded']))[0].n).toBe(0);
  });

  it('withdraws the teacher by the class rules when the 딴쌤 account is deleted, once', async () => {
    const subject = `deleted-${randomUUID()}`;
    const userId = randomUUID();
    const tenant = randomUUID();
    const session = await begin(subject, `sid-${subject}`);
    await db.query("INSERT INTO users(id,google_subject,canonical_email,display_name) VALUES ($1,$2,$3,'별빛쌤')", [userId, subject, `${userId}@example.test`]);
    await db.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES ($1,$2,'4학년 2반','ACTIVE')", [tenant, `hub-${tenant}`]);
    await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenant, userId]);
    await db.query("INSERT INTO students(tenant_id,student_id,name) VALUES ($1,'S1','합성 학생')", [tenant]);

    expect((await call<{ n: number }>('SELECT platform_hub_account_deleted($1) AS n', [subject]))[0].n).toBe(1);
    expect(await valid(subject, session)).toBe(false);
    expect((await db.query('SELECT 1 FROM user_agreements WHERE google_subject=$1 UNION ALL SELECT 1 FROM user_profiles WHERE google_subject=$1', [subject])).rows).toEqual([]);
    expect(await one('SELECT display_name,deleted_at IS NOT NULL AS trashed FROM tenants WHERE id=$1', [tenant]))
      .toEqual({ display_name: '탈퇴로 삭제된 학급', trashed: true });
    expect((await db.query('SELECT name FROM students WHERE tenant_id=$1', [tenant])).rows).toEqual([]);
    expect((await one<{ s: string }>('SELECT google_subject AS s FROM users WHERE id=$1', [userId])).s).toBe(`withdrawn:${userId}`);
    // The hub may send the event again: nothing is left to close.
    const withdrawals = (await one<{ n: number }>('SELECT count(*)::int AS n FROM account_withdrawals', [])).n;
    expect((await call<{ n: number }>('SELECT platform_hub_account_deleted($1) AS n', [subject]))[0].n).toBe(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM account_withdrawals', [])).n).toBe(withdrawals);
  });

  it('only ends stray sessions for a 딴쌤 account the class never kept', async () => {
    const withdrawals = (await one<{ n: number }>('SELECT count(*)::int AS n FROM account_withdrawals', [])).n;
    expect((await call<{ n: number }>('SELECT platform_hub_account_deleted($1) AS n', [`never-${randomUUID()}`]))[0].n).toBe(0);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM account_withdrawals', [])).n).toBe(withdrawals);
  });

  it('keeps the runtime away from the session table itself', async () => {
    await expect(call('SELECT hub_sid FROM teacher_auth_sessions', [])).rejects.toThrow();
    await expect(call("UPDATE teacher_auth_sessions SET hub_sid='x'", [])).rejects.toThrow();
  });
});

describe('딴쌤 account name and icon, and the class list activity (0062)', () => {
  const URL_A = 'https://ddanssaem.com/api/avatar/sky.bear.smile.smile.none.svg';
  const URL_B = 'https://ddanssaem.com/api/avatar/mint.cat.basic.smile.none.svg';
  const profile = async (subject: string) => call('SELECT * FROM platform_get_hub_profile($1)', [subject]);

  it('keeps the hub name, icon and picture at each sign-in and takes profile_updated, for a teacher it keeps only', async () => {
    const subject = `hub-${randomUUID()}`;
    const session = (await call<Session>('SELECT * FROM platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb,$6,$7)',
      [subject, '2026-12-05', 'sid-icon', '별빛쌤', AVATAR, URL_A, false]))[0];
    expect(await valid(subject, session)).toBe(true);
    expect(await profile(subject)).toEqual([{ nickname: '별빛쌤', avatar: JSON.parse(AVATAR), avatar_url: URL_A, avatar_from_hub: false }]);
    await call('SELECT * FROM platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb,$6,$7)', [subject, '2026-12-05', 'sid-icon-2', '달빛쌤', '{"face":"cat"}', URL_B, true]);
    expect(await profile(subject)).toEqual([{ nickname: '달빛쌤', avatar: { face: 'cat' }, avatar_url: URL_B, avatar_from_hub: true }]);
    const updated = (sub: string) => call<{ updated: boolean }>('SELECT platform_hub_profile_updated($1,$2,$3::jsonb,$4,$5) AS updated',
      [sub, '햇살쌤', AVATAR, URL_A, true]);
    expect((await updated(subject))[0].updated).toBe(true);
    expect(await profile(subject)).toEqual([{ nickname: '햇살쌤', avatar: JSON.parse(AVATAR), avatar_url: URL_A, avatar_from_hub: true }]);
    expect((await updated(`hub-${randomUUID()}`))[0].updated).toBe(false);
    await expect(call('SELECT platform_hub_profile_updated($1,$2,$3::jsonb,$4,$5)', [subject, '햇살쌤', AVATAR, 'javascript:alert(1)', true]))
      .rejects.toThrow(/user_profiles_avatar_url_check/);
    // The 5-argument sign-in of the build being replaced still works and keeps the icon.
    await begin(subject, 'sid-old');
    expect(await profile(subject)).toEqual([{ nickname: '별빛쌤', avatar: JSON.parse(AVATAR), avatar_url: URL_A, avatar_from_hub: true }]);
  });

  it('lists the teacher\'s classes with when each was last active', async () => {
    const subject = `hub-${randomUUID()}`;
    const session = await begin(subject, 'sid-list');
    await call('SELECT * FROM platform_create_draft_class_authenticated($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), subject, `${session.session_id}@example.test`, '활동 학급', session.generation, session.session_id, 'hub']);
    const rows = await call<{ display_name: string; created_at: Date; last_activity_at: Date }>('SELECT * FROM platform_list_class_dashboard_v2($1)', [subject]);
    expect(rows.map((row) => row.display_name)).toEqual(['활동 학급']);
    expect(new Date(rows[0].last_activity_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[0].created_at).getTime());
  });
});

describe('교사 인증 values (0063)', () => {
  it('keeps when the verification ends and from when it is required, for a teacher the class keeps only', async () => {
    const subject = `hub-${randomUUID()}`;
    await begin(subject, 'sid-verify');
    const read = () => call<{ verified_until: Date | null; required_from: Date | null }>('SELECT * FROM platform_get_teacher_verification($1)', [subject]);
    expect(await read()).toEqual([{ verified_until: null, required_from: null }]);
    const update = (sub: string, until: string | null, from: string | null) =>
      call<{ updated: boolean }>('SELECT platform_hub_verification_updated($1,$2::timestamptz,$3::timestamptz) AS updated', [sub, until, from]);
    expect((await update(subject, '2027-10-27T03:00:00Z', '2026-11-25T15:00:00Z'))[0].updated).toBe(true);
    const [row] = await read();
    expect(new Date(row.verified_until!).toISOString()).toBe('2027-10-27T03:00:00.000Z');
    expect(new Date(row.required_from!).toISOString()).toBe('2026-11-25T15:00:00.000Z');
    expect((await update(subject, null, null))[0].updated).toBe(true);
    expect(await read()).toEqual([{ verified_until: null, required_from: null }]);
    expect((await update(`hub-${randomUUID()}`, null, null))[0].updated).toBe(false);
    expect(await call('SELECT * FROM platform_get_teacher_verification($1)', [`hub-${randomUUID()}`])).toEqual([]);
    // The runtime cannot read or write the profile table itself.
    await expect(call('SELECT verified_until FROM user_profiles LIMIT 1', [])).rejects.toThrow(/permission denied/);
  });
});

describe('hub terms editions (0064)', () => {
  it('records a second edition of the same day as the hub agreement and keeps refusing other shapes', async () => {
    const subject = `hub-${randomUUID()}`;
    const start = (terms: string) => call<Session>('SELECT * FROM platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb,$6,$7)',
      [subject, terms, 'sid-edition', '별빛쌤', AVATAR, null, true]);
    const [session] = await start('2026-10-27.2');
    expect(await valid(subject, session)).toBe(true);
    expect((await one<{ v: string }>('SELECT agreement_version AS v FROM user_agreements WHERE google_subject=$1', [subject])).v).toBe('hub:2026-10-27.2');
    await expect(start('2026-10-27.x')).rejects.toThrow(/invalid hub terms version/);
    // The class's own versions stay plain dates.
    await expect(db.query("INSERT INTO user_agreements(google_subject, agreement_version) VALUES ($1,'2026-10-27.2')", [subject]))
      .rejects.toThrow(/user_agreements_version_check/);
  });
});

describe('review fixes (0065)', () => {
  type Begin8 = (subject: string, sid: string, signedInAt: string | null) => Promise<Session>;
  const begin8: Begin8 = async (subject, sid, signedInAt) => (await call<Session>(
    'SELECT * FROM platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb,$6,$7,$8::timestamptz)',
    [subject, '2026-10-27.2', sid, '별빛쌤', AVATAR, null, true, signedInAt]))[0];
  const end = async (sid: string) => (await call<{ n: number }>('SELECT platform_end_hub_teacher_sessions($1) AS n', [sid]))[0].n;

  it('refuses a sign-in for a hub session that signed out while it was running, in either form', async () => {
    const subject = `late-${randomUUID()}`;
    const sid = `sid-late-${subject}`;
    expect(await end(sid)).toBe(0);
    await expect(begin8(subject, sid, new Date().toISOString())).rejects.toThrow(/hub session ended/);
    await expect(call('SELECT * FROM platform_begin_hub_teacher_session($1,$2,$3,$4,$5::jsonb,$6,$7)',
      [subject, '2026-10-27', sid, '별빛쌤', AVATAR, null, true])).rejects.toThrow(/hub session ended/);
    // Another hub session of the same teacher still signs in, and its sign-out ends it.
    const other = await begin8(subject, `sid-other-${subject}`, new Date().toISOString());
    expect(await valid(subject, other)).toBe(true);
    expect(await end(`sid-other-${subject}`)).toBe(1);
    expect(await valid(subject, other)).toBe(false);
    // Only a hash of the hub session is kept, and the runtime cannot read it.
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM ended_hub_sessions WHERE hub_sid_hash ~ '^[0-9a-f]{64}$'", [])).n).toBeGreaterThanOrEqual(2);
    await expect(call('SELECT 1 FROM ended_hub_sessions', [])).rejects.toThrow(/permission denied/);
  });

  it('refuses a sign-in that began before the account was withdrawn, not one that began after', async () => {
    const subject = `withdrawn-${randomUUID()}`;
    await begin8(subject, `sid-a-${subject}`, null);
    const before = new Date(Date.now() - 1000).toISOString();
    expect((await call<{ n: number }>('SELECT platform_hub_account_deleted($1) AS n', [subject]))[0].n).toBe(0);
    await expect(begin8(subject, `sid-b-${subject}`, before)).rejects.toThrow(/account withdrawn/);
    expect((await db.query('SELECT 1 FROM user_profiles WHERE google_subject=$1', [subject])).rows).toEqual([]);
    const again = await begin8(subject, `sid-c-${subject}`, new Date(Date.now() + 1000).toISOString());
    expect(await valid(subject, again)).toBe(true);
  });

  it('keeps digital products digital in a copied class', async () => {
    const tenant = randomUUID(), user = randomUUID(), subject = `copy-${user}`;
    await db.query('INSERT INTO users(id,google_subject,canonical_email) VALUES ($1,$2,$3)', [user, subject, `${user}@example.test`]);
    await db.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES ($1,$2,'원본','ACTIVE')", [tenant, `copy-${tenant}`]);
    await db.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES ($1,$2,'OWNER')", [tenant, user]);
    await db.query(`INSERT INTO products(tenant_id,product_id,name,price,stock) VALUES ($1,'P1','연필',10,5),($1,'P2','쿠폰',20,5),
      ($1,'P3','배지',30,5),($1,'P4','지운 상품',40,5),($1,'P5','지운 상품 교환권',50,5)`, [tenant]);
    await db.query(`INSERT INTO coupon_products(tenant_id,product_id,digital_kind,voucher_product_id,description) VALUES
      ($1,'P2','CONSUMABLE','P1','연필 한 자루'),($1,'P3','COLLECTIBLE',NULL,'반짝 배지'),($1,'P5','CONSUMABLE','P4','')`, [tenant]);
    await db.query("UPDATE products SET is_active=false, deleted_at=clock_timestamp() WHERE tenant_id=$1 AND product_id='P4'", [tenant]);
    const version = (await one<{ v: string }>('SELECT management_version::text AS v FROM tenants WHERE id=$1', [tenant])).v;
    const result = (await one<{ r: { slug: string } }>("SELECT platform_manage_class($1,$2,$3,'DUPLICATE','복제',$4) AS r",
      [randomUUID(), `copy-${tenant}`, subject, version])).r;
    const copy = (await one<{ id: string }>('SELECT id FROM tenants WHERE slug=$1', [result.slug])).id;
    expect((await db.query('SELECT product_id,digital_kind,voucher_product_id,description FROM coupon_products WHERE tenant_id=$1 ORDER BY product_id', [copy])).rows)
      .toEqual([{ product_id: 'P2', digital_kind: 'CONSUMABLE', voucher_product_id: 'P1', description: '연필 한 자루' },
        { product_id: 'P3', digital_kind: 'COLLECTIBLE', voucher_product_id: null, description: '반짝 배지' },
        // Its 교환권 product was deleted, so it is not copied: the copy stays a plain 소모품.
        { product_id: 'P5', digital_kind: 'CONSUMABLE', voucher_product_id: null, description: '' }]);
  });

  it('adds the board read position and the latest-operation index', async () => {
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='board_link_syncs' AND column_name='evidence_after'", [])).n).toBe(1);
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='operations_tenant_created_at_idx'", [])).n).toBe(1);
  });
});
