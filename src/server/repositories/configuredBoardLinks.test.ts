// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { boardLinkError, type BoardClient, type BoardSummary } from '@/server/ddanssaem/boardClient';
import type { RunTenantTransaction } from './database/taskLedger/migration';
import { writePadletLinks } from './database/padletStore';

vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: (callback: () => unknown) => { void callback(); } }));

import { createBoardLinkService } from './configuredBoardLinks';

const FROM = '2026-01-01T00:00:00.000Z';
const ENV = {
  DDANSSAEM_BOARD_URL: 'https://board.example', DDANSSAEM_LINK_SECRET: 'l'.repeat(40),
  DDANSSAEM_LOGIN: '1', DDANSSAEM_HUB_URL: 'https://hub.example', DDANSSAEM_CLIENT_SECRET: 's'.repeat(40),
};
let lite: PgliteDatabaseHarness;
let run: RunTenantTransaction;
const owner = (text: string, values: unknown[] = []) => lite.database.query(text, values);

beforeAll(async () => {
  lite = await createPgliteDatabaseHarness({ migrationSet: 'base' });
  for (const name of (await readdir(resolve('src/server/db/migrations'))).filter((name) => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) > '0008').sort()) {
    await lite.database.exec(await readFile(resolve('src/server/db/migrations', name), 'utf8'));
  }
  await lite.database.exec(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app_runtime;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app_runtime; REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM app_runtime;`);
  await lite.database.exec((await readFile(resolve('src/server/db/provisioning/runtimeGrants.sql'), 'utf8')).replace(/\bcrs_app_runtime\b/g, 'app_runtime'));
  run = lite.runTenantTransaction;
}, 120_000);
afterAll(async () => { await lite?.close(); }, 30_000);

async function fixture() {
  const tenant = randomUUID();
  await owner("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Synthetic','ACTIVE')", [tenant, `synthetic-${tenant}`]);
  for (const id of ['S1', 'S2']) {
    await owner("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,$2,$3,'ACTIVE')", [tenant, id, `Student ${id}`]);
    await owner('INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,$2,0)', [tenant, id]);
  }
  const schedule = { ruleVersion: 1, effectiveFrom: FROM, timeZone: 'Asia/Seoul', recurrence: { type: 'NONE' }, resetAssignmentOnCycle: false, resetCompletionOnCycle: false };
  for (const [instance, taskId] of [['task-a', 'T001'], ['task-b', 'T002']]) {
    await owner(`INSERT INTO tasks(tenant_id,task_instance_id,task_id,title,description,reward,current_schedule,created_at,updated_at)
      VALUES($1,$2,$3,'Synthetic task','',0,$4,$5,$5)`, [tenant, instance, taskId, JSON.stringify(schedule), FROM]);
  }
  await owner(`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status,result_snapshot,started_at,finished_at,created_at,updated_at)
    VALUES($1,'task-ledger:v1','TASK_ADMIN',$2,'SUCCEEDED',$3,$4,$4,$4,$4)`, [tenant, 'a'.repeat(64), JSON.stringify({ ledgerFrom: FROM }), FROM]);
  for (const student of ['S1', 'S2']) {
    await owner(`INSERT INTO task_assignments(tenant_id,assignment_id,task_instance_id,task_id_snapshot,student_id,event_type,note,
      source,cycle_id,cycle_start_at,rule_version,timezone,created_at)
      VALUES($1,$2,'task-a','T001',$3,'ASSIGNED','stage:pending','CARRY_FORWARD','ledger',$4,1,'Asia/Seoul',$4)`, [tenant, `seed-${student}`, student, FROM]);
  }
  const boards: BoardSummary[] = [
    { id: 'board-free', code: 'free01', title: '1모둠 활동', format: 'group', groups: [{ id: 'g1', name: '1모둠' }], linkedClassId: null },
    { id: 'board-other', code: 'other1', title: '다른 반 보드', format: 'mini', groups: [], linkedClassId: randomUUID() },
  ];
  const evidence: Record<string, { id: string; createdAt: string }[]> = { S1: [{ id: 'post-1', createdAt: new Date().toISOString() }] };
  const client = {
    listBoards: vi.fn(async () => boards),
    attach: vi.fn(async (_sub: string, boardId: string, classId: string) => {
      const board = boards.find((item) => item.id === boardId)!;
      Object.assign(board, { linkedClassId: classId });
      return { linkedClassId: classId };
    }),
    evidence: vi.fn(async (request: { studentId: string }) => evidence[request.studentId] ?? []),
  } satisfies BoardClient;
  const service = createBoardLinkService({ tenantId: tenant, runTenantTransaction: run, runTenantSnapshot: run, client, env: ENV });
  const batched = (evidenceStudents: number) => createBoardLinkService({ tenantId: tenant, runTenantTransaction: run, runTenantSnapshot: run, client, env: ENV, evidenceStudents });
  return { tenant, boards, evidence, client, service, batched };
}

describe('딴쌤 board links of a class', () => {
  it('lists the teacher\'s boards and greys out one linked to another class', async () => {
    const f = await fixture();
    const status = await f.service.status('teacher-sub');
    expect(status.enabled).toBe(true);
    expect(status.boards.map((board) => [board.id, board.selectable, board.linkedHere])).toEqual([['board-free', true, false], ['board-other', false, false]]);
    expect(f.client.listBoards).toHaveBeenCalledWith('teacher-sub', f.tenant);
    const off = createBoardLinkService({ tenantId: f.tenant, runTenantTransaction: run, runTenantSnapshot: run, client: f.client, env: { ...ENV, DDANSSAEM_BOARD_URL: '' } });
    expect(await off.status('teacher-sub')).toEqual({ enabled: false, boards: [] });
  });

  it('links a roster linked nowhere first, replaces a Padlet link, and counts a post already there once', async () => {
    const f = await fixture();
    await run(f.tenant, (tx) => writePadletLinks(tx, f.tenant, ['task-a'], { boardId: 'syntheticboard01', boardTitle: 'Padlet', boardUrl: 'https://padlet.com/x/syntheticboard01', sectionId: null, sectionTitle: null }));
    const { tasks } = await f.service.link('teacher-sub', { taskIds: ['T001'], boardId: 'board-free', groupId: 'g1' });
    expect(f.client.attach).toHaveBeenCalledWith('teacher-sub', 'board-free', f.tenant);
    expect(tasks[0].padlet).toBeNull();
    expect(tasks[0].board).toMatchObject({ boardId: 'board-free', boardCode: 'free01', boardFormat: 'group', groupId: 'g1', groupName: '1모둠', error: null });
    expect(tasks[0].students.find((student) => student.studentId === 'S1')?.stage).toBe('READY');
    expect(tasks[0].students.find((student) => student.studentId === 'S2')?.stage).toBe('PENDING');
    expect(f.client.evidence).toHaveBeenCalledWith(expect.objectContaining({ sub: 'teacher-sub', boardId: 'board-free', groupId: 'g1', classId: f.tenant }));
    const uses = await owner('SELECT evidence_id, student_id FROM board_evidence_uses WHERE tenant_id=$1', [f.tenant]);
    expect(uses.rows).toEqual([{ evidence_id: 'post-1', student_id: 'S1' }]);
    const history = await owner("SELECT count(*)::int AS n FROM task_assignments WHERE tenant_id=$1 AND assignment_id LIKE 'tl-b:%'", [f.tenant]);
    expect(history.rows[0]).toEqual({ n: 1 });
  });

  it('reads a batch of 미완료 students at a time and goes on from where the last read stopped', async () => {
    const f = await fixture();
    // Only S2 posted; one student per read: the first read asks S1, the next goes on to S2.
    delete f.evidence.S1;
    f.evidence.S2 = [{ id: 'post-2', createdAt: new Date().toISOString() }];
    const service = f.batched(1);
    const first = await service.link('teacher-sub', { taskIds: ['T001'], boardId: 'board-free', groupId: null });
    expect(f.client.evidence.mock.calls.map(([request]) => request.studentId)).toEqual(['S1']);
    expect(first.tasks[0].students.find((student) => student.studentId === 'S2')?.stage).toBe('PENDING');
    expect((await owner('SELECT evidence_after FROM board_link_syncs WHERE tenant_id=$1', [f.tenant])).rows).toEqual([{ evidence_after: 'S1' }]);
    await owner("UPDATE board_link_syncs SET checked_at=clock_timestamp() - interval '1 minute' WHERE tenant_id=$1", [f.tenant]);
    await service.syncIfStale();
    expect(f.client.evidence.mock.calls.map(([request]) => request.studentId)).toEqual(['S1', 'S2']);
    const history = await owner("SELECT student_id FROM task_assignments WHERE tenant_id=$1 AND assignment_id LIKE 'tl-b:%'", [f.tenant]);
    expect(history.rows).toEqual([{ student_id: 'S2' }]);
    expect((await owner('SELECT evidence_after FROM board_link_syncs WHERE tenant_id=$1', [f.tenant])).rows).toEqual([{ evidence_after: 'S2' }]);
    // Now only S1 is at 미완료, which fits one read: it is asked again and the position starts over.
    await owner("UPDATE board_link_syncs SET checked_at=clock_timestamp() - interval '1 minute' WHERE tenant_id=$1", [f.tenant]);
    await service.syncIfStale();
    expect(f.client.evidence.mock.calls.map(([request]) => request.studentId)).toEqual(['S1', 'S2', 'S1']);
    expect((await owner('SELECT evidence_after FROM board_link_syncs WHERE tenant_id=$1', [f.tenant])).rows).toEqual([{ evidence_after: null }]);
  });

  it('refuses a board linked to another class or a group the board does not have', async () => {
    const f = await fixture();
    await expect(f.service.link('teacher-sub', { taskIds: ['T001'], boardId: 'board-other', groupId: null })).rejects.toMatchObject({ code: 'LINKED_ELSEWHERE' });
    await expect(f.service.link('teacher-sub', { taskIds: ['T001'], boardId: 'board-free', groupId: 'g9' })).rejects.toMatchObject({ code: 'BOARD_GROUP_NOT_FOUND' });
    await expect(f.service.link('teacher-sub', { taskIds: ['T001'], boardId: 'board-missing', groupId: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.client.attach).not.toHaveBeenCalled();
  });

  it('records why a read failed and keeps the stages, and unlinks leaving what already counted', async () => {
    const f = await fixture();
    f.client.evidence.mockRejectedValueOnce(boardLinkError('TIMEOUT'));
    const linked = await f.service.link('teacher-sub', { taskIds: ['T001'], boardId: 'board-free', groupId: null });
    expect(linked.tasks[0].board).toMatchObject({ error: 'TIMEOUT', lastReadAt: null });
    expect(linked.tasks[0].students.find((student) => student.studentId === 'S1')?.stage).toBe('PENDING');
    expect([...(await f.service.boardsForBank())]).toEqual([['T001', { title: '1모둠 활동', format: 'group', groupName: null }]]);
    expect(await f.service.boardForTask('T001')).toEqual({ boardId: 'board-free', code: 'free01' });
    const { tasks } = await f.service.unlink(['T001']);
    expect(tasks[0].board).toBeNull();
    expect(await f.service.boardForTask('T001')).toBeNull();
  });
});
