import 'server-only';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { after } from 'next/server';
import type { BoardChoiceDto, BoardLinkStatusDto } from '@/lib/boardLinkApi';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { withTenantSnapshot, withTenantTransaction } from '@/server/db/transaction';
import {
  boardLinkError, boardLinksEnabled, BoardLinkError, createBoardClient, type BoardClient, type BoardEvidenceItem,
} from '@/server/ddanssaem/boardClient';
import {
  boardKeyOf, claimBoardLinkSync, deleteBoardLinks, readBoardEvidenceAfter, readBoardLinks, recordBoardLinkSync,
  saveBoardEvidenceAfter, writeBoardLinks,
} from '@/server/repositories/database/boardStore';
import { deletePadletLinks } from '@/server/repositories/database/padletStore';
import { createTaskLedgerCommands, type BoardEvidence } from '@/server/repositories/database/taskLedger/commands';
import { ensureTaskLedger, type RunTenantTransaction } from '@/server/repositories/database/taskLedger/migration';
import type { StudentBankBoardDto } from '@/server/studentBankViews';
import { readLedgerTasks, TaskLedgerError } from '@/server/repositories/database/taskLedger/store';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { logFailure } from '@/server/log';

// 딴쌤 board links of one class (ddanssaem-hub/docs/app-links.md 8): the teacher's boards from the board server,
// linking tasks to a board (and the board's roster to the class), and reading what counts as done. A read of a
// board key (a board, or one group of it) happens at most every BOARD_STALE_SECONDS, when the admin page or a
// student's bank asks for fresh stages.

export const BOARD_STALE_SECONDS = 20;
const EVIDENCE_CONCURRENCY = 4;
const MAX_EVIDENCE_STUDENTS = 60;

export type BoardTasksDto = Readonly<{ tasks: readonly AdminTaskDto[] }>;

type Dependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot: RunTenantTransaction;
  client?: BoardClient;
  env?: Readonly<Record<string, string | undefined>>;
  /** Students asked about in one read (MAX_EVIDENCE_STUDENTS; smaller in tests). */
  evidenceStudents?: number;
}>;

export function createBoardLinkService(dependencies: Dependencies) {
  const { tenantId } = dependencies;
  const env = dependencies.env ?? process.env;
  const client = dependencies.client ?? createBoardClient(env);
  const ledger = createTaskLedgerCommands(dependencies);
  const enabled = () => boardLinksEnabled(env);
  const requireEnabled = () => { if (!enabled()) throw boardLinkError('NOT_CONFIGURED'); };

  async function choices(sub: string): Promise<BoardChoiceDto[]> {
    const boards = await client.listBoards(sub, tenantId);
    return boards.map((board) => ({ ...board, linkedHere: board.linkedClassId === tenantId,
      selectable: board.linkedClassId === null || board.linkedClassId === tenantId }));
  }

  async function syncKey(boardKey: string, manual: boolean): Promise<void> {
    const attempt = await dependencies.runTenantTransaction(tenantId, (tx) => claimBoardLinkSync(tx, tenantId, boardKey, BOARD_STALE_SECONDS, manual));
    if (!attempt) return;
    try {
      const { links, after } = await dependencies.runTenantSnapshot(tenantId, async (tx) => ({
        links: await readBoardLinks(tx, tenantId, boardKey), after: await readBoardEvidenceAfter(tx, tenantId, boardKey) }));
      if (links.length === 0) return;
      const tasks = await ledger.readTasks(links.map((link) => link.taskId));
      // Only students still at 미완료 on a linked task can be moved: ask the board for theirs, a batch at a time,
      // going on after the student the last read stopped at (then from the first again).
      const all = [...new Set(tasks.flatMap((task) => task.students.filter((student) => student.stage === 'PENDING').map((student) => student.studentId)))].sort();
      const batch = dependencies.evidenceStudents ?? MAX_EVIDENCE_STUDENTS;
      const start = after === null ? 0 : Math.max(0, all.findIndex((studentId) => studentId > after));
      const pending = [...all.slice(start), ...all.slice(0, start)].slice(0, batch);
      const nextAfter = all.length > batch ? pending[pending.length - 1] : null;
      const from = tasks.map((task) => task.availableFrom ?? task.createdAt).sort()[0] ?? new Date(0).toISOString();
      const { boardId, groupId, linkedBySub } = links[0];
      const evidence: BoardEvidence[] = [];
      let next = 0;
      async function worker(): Promise<void> {
        while (next < pending.length) {
          const studentId = pending[next++];
          const items: BoardEvidenceItem[] = await client.evidence({ sub: linkedBySub, boardId, groupId, classId: tenantId, studentId, from, to: null });
          for (const item of items) evidence.push({ id: item.id, createdAt: item.createdAt, studentId });
        }
      }
      await Promise.all(Array.from({ length: Math.min(EVIDENCE_CONCURRENCY, pending.length) }, worker));
      await ledger.applyBoardEvidence({ operationId: randomUUID(), boardKey, evidence, syncAttemptId: attempt });
      // Only after a read that counted: a failed one asks the same students again.
      await dependencies.runTenantTransaction(tenantId, (tx) => saveBoardEvidenceAfter(tx, tenantId, boardKey, attempt, nextAfter))
        .catch((error) => logFailure('[board-links] read position not saved', error));
    } catch (error) {
      const code = error instanceof BoardLinkError ? error.code : 'UNAVAILABLE';
      if (!(error instanceof BoardLinkError)) logFailure('[board-links] read failed', error);
      await dependencies.runTenantTransaction(tenantId, (tx) => recordBoardLinkSync(tx, tenantId, boardKey, { ok: false, errorCode: code }, attempt))
        .catch(() => undefined);
    }
  }

  async function linkedKeys(): Promise<string[]> {
    const links = await dependencies.runTenantSnapshot(tenantId, (tx) => readBoardLinks(tx, tenantId));
    return [...new Set(links.map(boardKeyOf))];
  }

  return {
    enabled,

    async status(sub: string): Promise<BoardLinkStatusDto> {
      if (!enabled()) return { enabled: false, boards: [] };
      return { enabled: true, boards: await choices(sub) };
    },

    /** Link the tasks to the board (or one group of it); a board whose roster is linked nowhere is linked to this class first. */
    async link(sub: string, request: Readonly<{ taskIds: readonly string[]; boardId: string; groupId: string | null }>): Promise<BoardTasksDto> {
      requireEnabled();
      const board = (await choices(sub)).find((item) => item.id === request.boardId);
      if (!board) throw boardLinkError('NOT_FOUND');
      if (!board.selectable) throw boardLinkError('LINKED_ELSEWHERE');
      const group = request.groupId === null ? null : board.groups.find((item) => item.id === request.groupId);
      if (request.groupId !== null && !group) throw new TaskLedgerError('BOARD_GROUP_NOT_FOUND', '그 그룹이 보드에 없어요. 보드 목록을 다시 불러와 주세요.', 409);
      if (!board.linkedHere) await client.attach(sub, board.id, tenantId);
      await ensureTaskLedger({ tenantId, runTenantTransaction: dependencies.runTenantTransaction });
      await dependencies.runTenantTransaction(tenantId, async (tx) => {
        const tasks = await readLedgerTasks(tx, tenantId, { taskIds: request.taskIds, lock: true });
        if (tasks.length !== request.taskIds.length) throw new TaskLedgerError('TASK_NOT_FOUND', '없거나 삭제된 과제가 있어요. 목록을 새로 불러와 주세요.', 404);
        const ids = tasks.map((task) => task.taskInstanceId);
        // A task has one link: a Padlet linked before gives way.
        await deletePadletLinks(tx, tenantId, ids);
        await writeBoardLinks(tx, tenantId, ids, { boardId: board.id, boardCode: board.code, boardTitle: board.title, boardFormat: board.format,
          groupId: group?.id ?? null, groupName: group?.name ?? null, linkedBySub: sub });
        await tx.execute(sql`
          UPDATE tasks SET padlet_board_id=NULL, version=version+1, updated_at=GREATEST(clock_timestamp(), updated_at)
          WHERE tenant_id=${tenantId} AND task_instance_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      });
      // Posts already on the board count at once.
      await syncKey(boardKeyOf({ boardId: board.id, groupId: group?.id ?? null }), true);
      return { tasks: await ledger.readTasks(request.taskIds) };
    },

    async unlink(taskIds: readonly string[]): Promise<BoardTasksDto> {
      await dependencies.runTenantTransaction(tenantId, async (tx) => {
        const tasks = await readLedgerTasks(tx, tenantId, { taskIds, lock: true });
        const ids = tasks.map((task) => task.taskInstanceId);
        await deleteBoardLinks(tx, tenantId, ids);
        if (ids.length > 0) {
          await tx.execute(sql`
            UPDATE tasks SET version=version+1, updated_at=GREATEST(clock_timestamp(), updated_at)
            WHERE tenant_id=${tenantId} AND task_instance_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
        }
      });
      return { tasks: await ledger.readTasks(taskIds) };
    },

    /** Reads the board keys not read for a while. Never throws. */
    async syncIfStale(): Promise<void> {
      if (!enabled()) return;
      try {
        for (const key of await linkedKeys()) await syncKey(key, false);
      } catch (error) {
        logFailure('[board-links] sync failed', error);
      }
    },

    /** For the student's bank: task ID → the board (and group) to post on. */
    async boardsForBank(): Promise<Map<string, StudentBankBoardDto>> {
      if (!enabled()) return new Map();
      const links = await dependencies.runTenantSnapshot(tenantId, (tx) => readBoardLinks(tx, tenantId));
      return new Map(links.map((link) => [link.taskId, { title: link.boardTitle, format: link.boardFormat, groupName: link.groupName }]));
    },

    /** The board a student's task links to, for their ticket (8-3). */
    async boardForTask(taskId: string): Promise<Readonly<{ boardId: string; code: string }> | null> {
      const links = await dependencies.runTenantSnapshot(tenantId, (tx) => readBoardLinks(tx, tenantId));
      const link = links.find((item) => item.taskId === taskId);
      return link ? { boardId: link.boardId, code: link.boardCode } : null;
    },
  };
}

export type BoardLinkService = ReturnType<typeof createBoardLinkService>;

export function createTenantBoardLinks(tenantId: string): BoardLinkService {
  return createBoardLinkService({ tenantId, runTenantTransaction: withTenantTransaction, runTenantSnapshot: withTenantSnapshot });
}

/** The board links of the class this admin request is for, and the signed-in teacher's 딴쌤 sub. */
export function requestBoardLinks(): Readonly<{ service: BoardLinkService; sub: string | null }> | null {
  const context = getOptionalTrustedTenantRequestContext();
  if (!context || process.env.CLASS_STORE_STORAGE !== 'postgresql') return null;
  return { service: createTenantBoardLinks(context.tenant.id), sub: context.session?.subject ?? null };
}

/** After the response: read the class's linked boards that are stale (the admin page and the bank call it). */
export function scheduleBoardLinkSync(): void {
  const links = requestBoardLinks();
  if (!links || !links.service.enabled()) return;
  after(async () => {
    try {
      await links.service.syncIfStale();
    } catch {
      console.error('[board-links] background sync failed');
    }
  });
}

/** For the student's bank (task ID → board), scheduling a read of stale boards when `sync`. Never throws. */
export async function boardsForStudent(options: Readonly<{ sync: boolean }>): Promise<Map<string, StudentBankBoardDto>> {
  try {
    const links = requestBoardLinks();
    if (!links || !links.service.enabled()) return new Map();
    if (options.sync) scheduleBoardLinkSync();
    return await links.service.boardsForBank();
  } catch {
    console.error('[board-links] student board read failed');
    return new Map();
  }
}
