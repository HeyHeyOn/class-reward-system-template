import 'server-only';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PADLET_SUMMARY_LIMIT, padletBoardIdFromAddress, type PadletPost } from '@/domain/padlet';
import { PADLET_ERROR_MESSAGES, type PadletBoardPreviewDto, type PadletErrorCode, type PadletStatusDto, type PadletTasksDto } from '@/lib/padletLinkApi';
import { withTenantSnapshot, withTenantTransaction } from '@/server/db/transaction';
import { fetchPadletBoard, PadletApiError, type PadletBoard } from '@/server/padlet/padletApi';
import { normalizePadletApiKey, openPadletApiKey, padletKeyHint, sealPadletApiKey } from '@/server/padlet/padletKey';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { StudentBankPadletDto } from '@/server/studentBankViews';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import {
  claimPadletBoardSync, deletePadletLinks, readPadletBoardSyncs, readPadletKey, readPadletLinks, recordPadletBoardSync,
  writePadletKey, writePadletLinks,
} from '@/server/repositories/database/padletStore';
import { createTaskLedgerCommands } from '@/server/repositories/database/taskLedger/commands';
import { ensureTaskLedger, type RunTenantTransaction } from '@/server/repositories/database/taskLedger/migration';
import { readLedgerStudents, readLedgerTasks, TaskLedgerError } from '@/server/repositories/database/taskLedger/store';
import type { RepositoryCreators } from '@/server/repositories/factory';

/** How often a board is read at most when screens ask for fresh stages. */
export const PADLET_STALE_SECONDS = 20;

export type ConfiguredPadlet = Readonly<{
  status(): Promise<PadletStatusDto>;
  setKey(apiKey: string | null): Promise<PadletStatusDto>;
  previewBoard(address: string): Promise<PadletBoardPreviewDto>;
  link(request: Readonly<{ taskIds: readonly string[]; address: string; sectionId: string | null }>): Promise<PadletTasksDto>;
  unlink(taskIds: readonly string[]): Promise<PadletTasksDto>;
  /** Reads every linked board now (the teacher pressed 지금 확인). */
  syncNow(): Promise<PadletStatusDto>;
  /** Reads the boards not read in the last 20 seconds, within `budgetMs`; never throws. */
  syncIfStale(budgetMs?: number): Promise<void>;
  /** For the student's bank: task ID → the board (and section) to post on. */
  boardsForBank(): Promise<Map<string, StudentBankPadletDto>>;
}>;

export class PadletLinkError extends TaskLedgerError {
  constructor(readonly padletCode: PadletErrorCode, message: string, status: number) {
    super(`PADLET_${padletCode}`, message, status);
  }
}

const PADLET_STATUS: Readonly<Record<PadletErrorCode, number>> = {
  NO_KEY: 409, KEY_UNREADABLE: 409, INVALID_KEY: 409, NOT_PAYING: 409, NOT_ADMIN: 409, NOT_FOUND: 404,
  RATE_LIMITED: 429, TIMEOUT: 504, UNAVAILABLE: 502,
};

type Dependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
  runTenantSnapshot: RunTenantTransaction;
  fetchBoard?: (boardId: string, apiKey: string, timeoutMs: number) => Promise<PadletBoard>;
  env?: Readonly<Record<string, string | undefined>>;
}>;

export function createPadletService(dependencies: Dependencies): ConfiguredPadlet {
  const { tenantId } = dependencies;
  const env = dependencies.env ?? process.env;
  const ledger = createTaskLedgerCommands({ tenantId, runTenantTransaction: dependencies.runTenantTransaction,
    runTenantSnapshot: dependencies.runTenantSnapshot });
  const fetchBoard = dependencies.fetchBoard
    ?? ((boardId: string, apiKey: string, timeoutMs: number) => fetchPadletBoard({ boardId, apiKey, timeoutMs }));

  function failure(code: PadletErrorCode): never {
    throw new PadletLinkError(code, PADLET_ERROR_MESSAGES[code], PADLET_STATUS[code]);
  }

  async function apiKey(): Promise<{ key: string } | { error: PadletErrorCode }> {
    const stored = await dependencies.runTenantSnapshot(tenantId, (tx) => readPadletKey(tx, tenantId));
    if (!stored) return { error: 'NO_KEY' };
    const key = openPadletApiKey(stored.sealed, tenantId, env);
    return key ? { key } : { error: 'KEY_UNREADABLE' };
  }

  async function readBoardOrFail(boardId: string, timeoutMs: number): Promise<PadletBoard> {
    const key = await apiKey();
    if ('error' in key) failure(key.error);
    try {
      return await fetchBoard(boardId, key.key, timeoutMs);
    } catch (error) {
      failure(error instanceof PadletApiError ? error.code : 'UNAVAILABLE');
    }
  }

  /** Reads one board and applies its posts; records what happened. */
  async function syncBoard(boardId: string, timeoutMs: number): Promise<void> {
    const key = await apiKey();
    let board: PadletBoard | null = null;
    let code: PadletErrorCode | null = 'error' in key ? key.error : null;
    if ('key' in key) {
      try {
        board = await fetchBoard(boardId, key.key, timeoutMs);
      } catch (error) {
        code = error instanceof PadletApiError ? error.code : 'UNAVAILABLE';
      }
    }
    if (!board) {
      const errorCode = code ?? 'UNAVAILABLE';
      await dependencies.runTenantTransaction(tenantId, (tx) => recordPadletBoardSync(tx, tenantId, boardId, { ok: false, errorCode }));
      return;
    }
    const posts: PadletPost[] = [...board.posts];
    const plan = await ledger.planPadletBoard(boardId, posts);
    if (!plan) return;
    if (plan.moves.length > 0) {
      await ledger.applyPadletBoard({ operationId: randomUUID(), boardId, posts });
      return;
    }
    await dependencies.runTenantTransaction(tenantId, (tx) =>
      recordPadletBoardSync(tx, tenantId, boardId, { ok: true, summary: plan.outcomes.slice(0, PADLET_SUMMARY_LIMIT) }));
  }

  async function linkedBoards(): Promise<string[]> {
    return dependencies.runTenantSnapshot(tenantId, async (tx) => [...new Set((await readPadletLinks(tx, tenantId)).map((link) => link.boardId))]);
  }

  async function status(): Promise<PadletStatusDto> {
    return dependencies.runTenantSnapshot(tenantId, async (tx) => {
      const key = await readPadletKey(tx, tenantId);
      const links = await readPadletLinks(tx, tenantId);
      const syncs = new Map((await readPadletBoardSyncs(tx, tenantId)).map((row) => [row.boardId, row]));
      const students = new Map((await readLedgerStudents(tx, tenantId)).map((student) => [student.studentId, student.name]));
      const now = await tx.execute(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
      const taskIdOf = new Map(links.map((link) => [link.taskInstanceId, link.taskId]));
      const boards = [...new Set(links.map((link) => link.boardId))].map((boardId) => {
        const own = links.filter((link) => link.boardId === boardId);
        const sync = syncs.get(boardId);
        return {
          boardId, title: own[0].boardTitle, url: own[0].boardUrl, taskIds: own.map((link) => link.taskId),
          checkedAt: sync?.checkedAt ?? null, succeededAt: sync?.succeededAt ?? null,
          error: (sync?.errorCode ?? null) as PadletErrorCode | null,
          posts: (sync?.summary ?? []).map((post) => ({
            ...post, studentName: post.studentId ? students.get(post.studentId) ?? null : null,
            results: Object.fromEntries(Object.entries(post.results).flatMap(([instance, result]) => {
              const taskId = taskIdOf.get(instance);
              return taskId ? [[taskId, result]] : [];
            })),
          })),
        };
      });
      const readable = key ? openPadletApiKey(key.sealed, tenantId, env) !== null : false;
      return { now: String((now.rows[0] as { now: string }).now), key: { saved: Boolean(key), hint: key?.hint ?? null, readable }, boards };
    });
  }

  async function tasksDto(taskIds: readonly string[]): Promise<PadletTasksDto> {
    return { tasks: await ledger.readTasks(taskIds) };
  }

  return {
    status,

    async setKey(value) {
      if (value === null) {
        await dependencies.runTenantTransaction(tenantId, (tx) => writePadletKey(tx, tenantId, null));
        return status();
      }
      const key = normalizePadletApiKey(value);
      if (!key) failure('INVALID_KEY');
      await dependencies.runTenantTransaction(tenantId, (tx) =>
        writePadletKey(tx, tenantId, { sealed: sealPadletApiKey(key, tenantId, env), hint: padletKeyHint(key) }));
      return status();
    },

    async previewBoard(address) {
      const boardId = padletBoardIdFromAddress(address);
      if (!boardId) throw new PadletLinkError('NOT_FOUND', '패들렛 게시판 주소가 아니에요. 게시판을 열고 주소창의 주소를 그대로 붙여 넣어 주세요.', 400);
      const board = await readBoardOrFail(boardId, 8_000);
      return { boardId, title: board.title, url: board.url, sections: board.sections, postCount: board.posts.length };
    },

    async link(request) {
      const boardId = padletBoardIdFromAddress(request.address);
      if (!boardId) throw new PadletLinkError('NOT_FOUND', '패들렛 게시판 주소가 아니에요. 게시판을 열고 주소창의 주소를 그대로 붙여 넣어 주세요.', 400);
      const board = await readBoardOrFail(boardId, 8_000);
      const section = request.sectionId === null ? null : board.sections.find((item) => item.id === request.sectionId);
      if (request.sectionId !== null && !section) throw new PadletLinkError('NOT_FOUND', '그 섹션이 게시판에 없어요. 게시판을 다시 불러와 주세요.', 409);
      await ensureTaskLedger({ tenantId, runTenantTransaction: dependencies.runTenantTransaction });
      await dependencies.runTenantTransaction(tenantId, async (tx) => {
        const tasks = await readLedgerTasks(tx, tenantId, { taskIds: request.taskIds, lock: true });
        if (tasks.length !== request.taskIds.length) throw new TaskLedgerError('TASK_NOT_FOUND', '없거나 삭제된 과제가 있어요. 목록을 새로 불러와 주세요.', 404);
        const ids = tasks.map((task) => task.taskInstanceId);
        await writePadletLinks(tx, tenantId, ids, { boardId, boardTitle: board.title, boardUrl: board.url,
          sectionId: section?.id ?? null, sectionTitle: section?.title ?? null });
        // A board picked the old way (checked only when the student pressed 완료) gives way to the link.
        await tx.execute(sql`
          UPDATE tasks SET padlet_board_id=NULL, version=version+1, updated_at=GREATEST(clock_timestamp(), updated_at)
          WHERE tenant_id=${tenantId} AND task_instance_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
      });
      // Posts already on the board count at once.
      await syncBoard(boardId, 8_000).catch((error: unknown) => {
        console.error('[padlet] first read after linking failed', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
      });
      return tasksDto(request.taskIds);
    },

    async unlink(taskIds) {
      await dependencies.runTenantTransaction(tenantId, async (tx) => {
        const tasks = await readLedgerTasks(tx, tenantId, { taskIds, lock: true });
        const ids = tasks.map((task) => task.taskInstanceId);
        await deletePadletLinks(tx, tenantId, ids);
        if (ids.length > 0) {
          await tx.execute(sql`
            UPDATE tasks SET version=version+1, updated_at=GREATEST(clock_timestamp(), updated_at)
            WHERE tenant_id=${tenantId} AND task_instance_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
        }
      });
      return tasksDto(taskIds);
    },

    async syncNow() {
      // The teacher asked: read every board now. Applying is recomputed under locks and a post is used
      // once per task, so a double press only reads twice.
      for (const boardId of await linkedBoards()) await syncBoard(boardId, 8_000);
      return status();
    },

    async syncIfStale(budgetMs = 4_000) {
      const started = Date.now();
      try {
        const key = await dependencies.runTenantSnapshot(tenantId, (tx) => readPadletKey(tx, tenantId));
        if (!key) return;
        for (const boardId of await linkedBoards()) {
          const left = budgetMs - (Date.now() - started);
          if (left < 500) return;
          const turn = await dependencies.runTenantTransaction(tenantId, (tx) => claimPadletBoardSync(tx, tenantId, boardId, PADLET_STALE_SECONDS));
          if (turn) await syncBoard(boardId, Math.min(left, 6_000));
        }
      } catch (error) {
        console.error('[padlet] sync failed', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
      }
    },

    async boardsForBank() {
      return dependencies.runTenantSnapshot(tenantId, async (tx) =>
        new Map((await readPadletLinks(tx, tenantId)).map((link) => [link.taskId, {
          title: link.boardTitle, url: link.boardUrl, ...(link.sectionTitle ? { sectionTitle: link.sectionTitle } : {}),
        }])));
    },
  };
}

export type ConfiguredPadletOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredPadlet, ConfiguredPadlet>;
}>;

const unsupported = (): never => {
  throw new TaskLedgerError('UNSUPPORTED', '이 기능은 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
};

export function createPadletRepositoryCreators(): RepositoryCreators<ConfiguredPadlet, ConfiguredPadlet> {
  return {
    createPostgresql: (authority) => createPadletService({ tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction,
      runTenantSnapshot: withTenantSnapshot }),
    createSheets: () => ({
      status: unsupported, setKey: unsupported, previewBoard: unsupported, link: unsupported, unlink: unsupported, syncNow: unsupported,
      syncIfStale: async () => undefined, boardsForBank: async () => new Map(),
    }),
  };
}

/** For the teacher's board: reads the boards not read lately. Never fails the caller. */
export async function syncPadletBoardsIfStale(request: Request): Promise<void> {
  try {
    await (await createConfiguredPadlet(request)).syncIfStale();
  } catch (error) {
    console.error('[padlet] sync failed', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
  }
}

/**
 * For the student's task list: reads stale boards first when `sync` (so a post just written counts),
 * then which tasks are linked. Never fails the caller; a class without links costs one small read.
 */
export async function padletBoardsForStudent(request: Request, options: Readonly<{ sync: boolean }>): Promise<Map<string, StudentBankPadletDto>> {
  try {
    const padlet = await createConfiguredPadlet(request);
    if (options.sync) await padlet.syncIfStale(3_000);
    return await padlet.boardsForBank();
  } catch (error) {
    console.error('[padlet] student board read failed', error instanceof Error ? `${error.name}: ${error.message}` : 'unknown');
    return new Map();
  }
}

export async function createConfiguredPadlet(requestOrOptions?: Request | ConfiguredPadletOptions): Promise<ConfiguredPadlet> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createPadletRepositoryCreators(),
  });
  return repository.adapter;
}
