// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { PadletPost } from '@/domain/padlet';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { PadletApiError, type PadletBoard } from '@/server/padlet/padletApi';
import { createTaskLedgerCommands } from './database/taskLedger/commands';
import { readTaskLedgerHistory } from './database/taskLedger/history';
import { createPadletService } from './configuredPadlet';

vi.mock('server-only', () => ({}));

const ENV = { AUTH_SECRET: 'padlet-test-secret-'.repeat(3) };
const BOARD_ID = 'mvbij1byfal6f0ik';
const ADDRESS = `https://padlet.com/gdteacher5/5-6-${BOARD_ID}`;

let harness: PgliteDatabaseHarness;
let tenantId: string;
let posts: PadletPost[];
let fetchBoard: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  for (const name of (await readdir(resolve(process.cwd(), 'src/server/db/migrations'))).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await harness.database.exec(await readFile(resolve(process.cwd(), 'src/server/db/migrations', name), 'utf8'));
  }
  await harness.database.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;`);
  tenantId = harness.tenantOneId;
  await harness.database.query(`INSERT INTO students (tenant_id, student_id, name, status) VALUES
    ($1,'S1','김민준','ACTIVE'),($1,'S2','이서연','ACTIVE'),($1,'S3','박지후','ACTIVE')`, [tenantId]);
  await harness.database.query(`INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1,'S1',100),($1,'S2',100),($1,'S3',100)`, [tenantId]);
  posts = [];
  fetchBoard = vi.fn(async (boardId: string, apiKey: string): Promise<PadletBoard> => {
    if (apiKey !== 'pdltp_test_key_9876') throw new PadletApiError('INVALID_KEY');
    return { id: boardId, title: '5학년 6반 칭찬 게시판', url: ADDRESS,
      sections: [{ id: 'sec_class', title: '우리 반' }, { id: 'sec_one', title: '1번 김나경' }], posts };
  });
}, 120_000);
afterEach(async () => { await harness?.close(); });

const ledger = () => createTaskLedgerCommands({ tenantId, runTenantTransaction: harness.runTenantTransaction });
const padlet = () => createPadletService({ tenantId, runTenantTransaction: harness.runTenantTransaction,
  runTenantSnapshot: harness.runTenantTransaction, fetchBoard: fetchBoard as never, env: ENV });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
/** A moment after the tasks were made (posts before a task opened never count). */
const later = async () => { await new Promise((done) => setTimeout(done, 15)); return new Date().toISOString(); };
const post = (id: string, author: string, at: string, extra: Partial<PadletPost> = {}): PadletPost =>
  ({ id, createdAt: at, status: 'approved', authorName: author, subject: '', sectionId: 'sec_class', url: null, ...extra });

async function createTask(title: string, students: Array<{ studentId: string; stage: 'PENDING' | 'READY' }>, prerequisiteTaskId: string | null = null) {
  return ledger().createTask({ operationId: randomUUID(), task: { title, description: '', reward: 10, isActive: true, sortOrder: 0,
    availableFrom: null, dueAt: null, prerequisiteTaskId }, repeat: { recurrence: { type: 'NONE' }, resetStage: null }, students });
}

async function stages(): Promise<Record<string, Record<string, string>>> {
  const tasks = await ledger().readTasks();
  return Object.fromEntries(tasks.map((task) => [task.title, Object.fromEntries(task.students.map((row) => [row.studentId, row.stage]))]));
}

describe('padlet links', () => {
  it('keeps the key sealed, needs it before linking, and explains Padlet refusals', async () => {
    await createTask('칭찬 글쓰기', [{ studentId: 'S1', stage: 'PENDING' }]);
    await expect(padlet().previewBoard(ADDRESS)).rejects.toMatchObject({ padletCode: 'NO_KEY', status: 409 });
    await padlet().setKey('pdltp_wrong_key_0000');
    await expect(padlet().previewBoard(ADDRESS)).rejects.toMatchObject({ padletCode: 'INVALID_KEY' });
    const status = await padlet().setKey('pdltp_test_key_9876');
    expect(status.key).toEqual({ saved: true, hint: '9876', readable: true });
    const stored = await harness.database.query<{ api_key_sealed: string }>('SELECT api_key_sealed FROM padlet_settings');
    expect(stored.rows[0].api_key_sealed).toMatch(/^pk1\./);
    expect(stored.rows[0].api_key_sealed).not.toContain('pdltp_test_key');
    expect(await padlet().previewBoard(ADDRESS)).toEqual({ boardId: BOARD_ID, title: '5학년 6반 칭찬 게시판', url: ADDRESS,
      sections: [{ id: 'sec_class', title: '우리 반' }, { id: 'sec_one', title: '1번 김나경' }], postCount: 0 });
    await expect(padlet().previewBoard('https://example.com/nope')).rejects.toMatchObject({ padletCode: 'NOT_FOUND' });
    expect((await padlet().setKey(null)).key).toEqual({ saved: false, hint: null, readable: false });
  }, 120_000);

  it('makes 미완료 students with a post 완료 가능, once per post, and shows it in the history as 패들렛', async () => {
    await createTask('칭찬 글쓰기', [{ studentId: 'S1', stage: 'PENDING' }, { studentId: 'S2', stage: 'PENDING' }]);
    await padlet().setKey('pdltp_test_key_9876');
    posts.push(post('post_old', '김민준', minutesAgo(60 * 24 * 400)), post('post_s1', '김민준', await later()),
      post('post_s3', '박지후', await later()), post('post_x', '성지환', await later(), { subject: '오늘의 칭찬' }));
    const { tasks } = await padlet().link({ taskIds: ['T001'], address: ADDRESS, sectionId: 'sec_class' });
    expect(tasks[0].padlet).toEqual({ boardId: BOARD_ID, boardTitle: '5학년 6반 칭찬 게시판', boardUrl: ADDRESS, sectionId: 'sec_class', sectionTitle: '우리 반',
      lastReadAt: expect.any(String), error: null });
    // Linking reads the board at once: S1's post counts; S3 does not have the task; nobody named 성지환.
    expect((await stages())['칭찬 글쓰기']).toEqual({ S1: 'READY', S2: 'PENDING', S3: 'UNASSIGNED' });

    const status = await padlet().status();
    expect(status.boards).toHaveLength(1);
    expect(status.boards[0]).toMatchObject({ boardId: BOARD_ID, taskIds: ['T001'], error: null });
    expect(status.boards[0].posts.map((item) => [item.postId, item.studentName, item.issue, item.results])).toEqual([
      ['post_x', null, 'UNKNOWN', {}], ['post_s3', '박지후', null, { T001: 'NOT_ASSIGNED' }], ['post_s1', '김민준', null, { T001: 'MOVED' }],
      // Written before the task existed: it never counts.
      ['post_old', '김민준', null, { T001: 'OUTSIDE' }],
    ]);

    // The teacher sends S1 back to 미완료: the same post does not count again, a new one does.
    await ledger().setStages({ operationId: randomUUID(), changes: [{ taskId: 'T001', studentId: 'S1', stage: 'PENDING' }] });
    await padlet().syncNow();
    expect((await stages())['칭찬 글쓰기'].S1).toBe('PENDING');
    posts.push(post('post_s1_again', '김민준', await later()), post('post_s2_other', '이서연', await later(), { sectionId: 'sec_one' }));
    await padlet().syncNow();
    expect((await stages())['칭찬 글쓰기']).toEqual({ S1: 'READY', S2: 'PENDING', S3: 'UNASSIGNED' });

    const history = await harness.runTenantTransaction(tenantId, (tx) => readTaskLedgerHistory(tx, tenantId, 'T001'));
    expect(history.entries.filter((entry) => entry.studentId === 'S1').map((entry) => [entry.stage, entry.cause]))
      .toEqual([['READY', 'PADLET'], ['PENDING', 'TEACHER'], ['READY', 'PADLET'], ['PENDING', 'TEACHER']]);
    const uses = await harness.database.query<{ post_id: string }>('SELECT post_id FROM padlet_post_uses ORDER BY post_id');
    expect(uses.rows.map((row) => row.post_id)).toEqual(['post_s1', 'post_s1_again']);
  }, 120_000);

  it('gives chained tasks one post each, in order, and separate tasks the same post', async () => {
    await createTask('A 읽기', [{ studentId: 'S1', stage: 'PENDING' }]);
    await createTask('B 쓰기', [{ studentId: 'S1', stage: 'PENDING' }], 'T001');
    await createTask('C 발표', [{ studentId: 'S1', stage: 'PENDING' }], 'T002');
    await createTask('따로 과제', [{ studentId: 'S1', stage: 'PENDING' }]);
    await padlet().setKey('pdltp_test_key_9876');
    posts.push(post('post_1', '김민준', await later()));
    await padlet().link({ taskIds: ['T001', 'T002', 'T003', 'T004'], address: ADDRESS, sectionId: null });
    let now = await stages();
    expect([now['A 읽기'].S1, now['B 쓰기'].S1, now['C 발표'].S1, now['따로 과제'].S1]).toEqual(['READY', 'PENDING', 'PENDING', 'READY']);
    posts.push(post('post_2', '김민준', await later()));
    await padlet().syncNow();
    now = await stages();
    expect([now['A 읽기'].S1, now['B 쓰기'].S1, now['C 발표'].S1]).toEqual(['READY', 'READY', 'PENDING']);
    posts.push(post('post_3', '김민준', await later()));
    await padlet().syncNow();
    expect((await stages())['C 발표'].S1).toBe('READY');
  }, 120_000);

  it('reads a board at most once per period for screens, records failures, and unlinks cleanly', async () => {
    await createTask('칭찬 글쓰기', [{ studentId: 'S1', stage: 'PENDING' }]);
    await padlet().setKey('pdltp_test_key_9876');
    await padlet().link({ taskIds: ['T001'], address: ADDRESS, sectionId: null });
    fetchBoard.mockClear();
    await padlet().syncIfStale();
    expect(fetchBoard).not.toHaveBeenCalled();
    await harness.database.query(`UPDATE padlet_board_syncs SET checked_at=clock_timestamp() - interval '1 minute'`);
    fetchBoard.mockRejectedValueOnce(new PadletApiError('RATE_LIMITED'));
    await padlet().syncIfStale();
    expect(fetchBoard).toHaveBeenCalledTimes(1);
    expect((await padlet().status()).boards[0].error).toBe('RATE_LIMITED');

    const { tasks } = await padlet().unlink(['T001']);
    expect(tasks[0].padlet).toBeNull();
    expect((await padlet().status()).boards).toEqual([]);
    expect((await harness.database.query('SELECT 1 FROM padlet_board_syncs')).rows).toHaveLength(0);
  }, 120_000);
});
