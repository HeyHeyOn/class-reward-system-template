// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { createClassCreationCommand } from '@/server/repositories/database/classCreation';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createTeacherSessionStore } from '@/server/teacherSession';
import { currentLegalRevision } from '@/lib/legalDocuments';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const version = currentLegalRevision().version;
let db: DisposablePostgres;

suite('teacher session mutation serialization on PostgreSQL', () => {
  beforeAll(async () => {
    db = await createDisposablePostgres();
    await db.owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime;
      GRANT EXECUTE ON FUNCTION public.platform_begin_teacher_session(text,text),
        public.platform_validate_teacher_session(text,uuid,uuid,boolean,text),
        public.platform_mutate_teacher_account(text,text,uuid,uuid,jsonb),
        public.platform_end_teacher_session(text,uuid,uuid),
        public.platform_create_draft_class_authenticated(uuid,text,text,text,uuid,uuid,text) TO app_runtime;`);
  }, 120_000);
  afterAll(async () => { await db?.close(); }, 30_000);

  it.each(['AGREE', 'CREATE'] as const)('rejects an already-admitted stale %s queued behind a committing withdrawal', async action => {
    const sessions = createTeacherSessionStore(db.runtime);
    const subject = `synthetic-session-concurrency-${action}`;
    const identity = { subject, ...await sessions.begin(subject, version) };
    await sessions.mutate(identity, 'AGREE', { version });
    expect(await sessions.valid(identity, false, version)).toBe(true);
    const owner = await db.owner.connect();
    const waiter = await db.runtime.connect();
    let committed = false;
    try {
      const { rows: [{ pid }] } = await waiter.query('SELECT pg_backend_pid() AS pid');
      await owner.query('BEGIN');
      await createTeacherSessionStore(owner).mutate(identity, 'WITHDRAW', {});
      // A separate request can have passed its initial read while withdrawal is uncommitted.
      expect(await sessions.valid(identity, false, version)).toBe(true);
      const operation = action === 'AGREE' ? createTeacherSessionStore(waiter).mutate(identity, 'AGREE', { version })
        : createClassCreationCommand(waiter).create({ ...identity,operationId:randomUUID(),email:`${subject}@example.test`,displayName:'Rejected class' });
      const stale = operation.then(() => ({ accepted: true, code: null }), error => ({ accepted: false, code: error.code }));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        waiting = (await db.owner.query("SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await owner.query('COMMIT'); committed = true;
      expect(await stale).toEqual({ accepted: false, code: '28000' });
      expect(await sessions.valid(identity, false, version)).toBe(false);
      expect((await db.owner.query('SELECT count(*)::int n FROM users WHERE google_subject=$1',[subject])).rows[0].n).toBe(0);
      const fresh = await sessions.begin(subject, version);
      expect(fresh.agreed).toBe(false);
      expect(fresh.accountGeneration).not.toBe(identity.accountGeneration);
    } finally {
      if (!committed) await owner.query('ROLLBACK');
      owner.release(); waiter.release();
    }
  }, 20_000);

  it('denies direct table/old mutation access and rejects expired or mismatched bindings', async () => {
    const sessions = createTeacherSessionStore(db.runtime);
    const identity = { subject: 'synthetic-expiry', ...await sessions.begin('synthetic-expiry', version) };
    expect(await sessions.valid({ ...identity, subject: 'synthetic-other' }, true, null)).toBe(false);
    await db.owner.query(`UPDATE teacher_auth_sessions SET authenticated_at=now()-interval '2 hours',
      expires_at=now()-interval '1 hour' WHERE session_id=$1`, [identity.sessionId]);
    expect(await sessions.valid(identity, true, null)).toBe(false);
    await expect(sessions.mutate(identity, 'WITHDRAW', {})).rejects.toMatchObject({ code: '28000' });
    await expect(db.runtime.query('SELECT * FROM teacher_auth_sessions')).rejects.toMatchObject({ code: '42501' });
    await expect(db.runtime.query('SELECT * FROM teacher_identity_generations')).rejects.toMatchObject({ code: '42501' });
    await expect(db.runtime.query('SELECT platform_withdraw_user($1)', [identity.subject])).rejects.toMatchObject({ code: '42501' });
    await expect(db.runtime.query('SELECT platform_record_user_agreement($1,$2)', [identity.subject, version])).rejects.toMatchObject({ code: '42501' });
    await expect(db.runtime.query('SELECT * FROM platform_create_draft_class($1,$2,$3,$4)',
      [randomUUID(),identity.subject,'synthetic@example.test','Denied'])).rejects.toMatchObject({ code:'42501' });
    await expect(db.runtime.query('SELECT platform_lock_teacher_session($1,$2,$3,$4)',
      [identity.subject,identity.accountGeneration,identity.sessionId,version])).rejects.toMatchObject({ code:'42501' });
  });
});
