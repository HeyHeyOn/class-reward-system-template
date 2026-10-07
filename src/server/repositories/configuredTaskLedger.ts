import 'server-only';

import type { TaskBoardDto, TaskHistoryDto } from '@/lib/taskLedgerApi';
import { withTenantSnapshot, withTenantTransaction } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import { createTaskLedgerCommands } from '@/server/repositories/database/taskLedger/commands';
import { readTaskLedgerHistory } from '@/server/repositories/database/taskLedger/history';
import { ensureTaskLedger } from '@/server/repositories/database/taskLedger/migration';
import { TaskLedgerError } from '@/server/repositories/database/taskLedger/store';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { resolveStudentQrForCurrentTenant } from '@/server/studentQr';

type Commands = ReturnType<typeof createTaskLedgerCommands>;

/** The task ledger of one PostgreSQL class (tasks without cycles). */
export type ConfiguredTaskLedger = Omit<Commands, 'readTasks' | 'readBoard'> & Readonly<{
  board(): Promise<TaskBoardDto>;
  history(taskId: string): Promise<TaskHistoryDto>;
}>;

export type ConfiguredTaskLedgerOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (env: CompatibilityCentralTenantEnv) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<ConfiguredTaskLedger, ConfiguredTaskLedger>;
}>;

const unsupported = (): never => {
  throw new TaskLedgerError('UNSUPPORTED', '이 기능은 새 방식(PostgreSQL) 학급에서만 쓸 수 있어요.', 404);
};

export function createTaskLedgerRepositoryCreators(): RepositoryCreators<ConfiguredTaskLedger, ConfiguredTaskLedger> {
  return {
    createPostgresql(authority) {
      const dependencies = {
        tenantId: authority.tenantId,
        runTenantTransaction: withTenantTransaction,
        runTenantSnapshot: withTenantSnapshot,
        resolveStudentQr: (value: string) => resolveStudentQrForCurrentTenant(value).studentId,
      };
      const commands = createTaskLedgerCommands(dependencies);
      return {
        ...commands,
        async board() {
          return commands.readBoard();
        },
        async history(taskId) {
          await ensureTaskLedger(dependencies);
          return withTenantSnapshot(authority.tenantId, (tx) => readTaskLedgerHistory(tx, authority.tenantId, taskId));
        },
      };
    },
    createSheets: () => ({
      board: unsupported, history: unsupported, createTask: unsupported, updateTask: unsupported, deleteTasks: unsupported,
      setStages: unsupported, resetTasks: unsupported, setRepeat: unsupported, qrStage: unsupported,
    }),
  };
}

export async function createConfiguredTaskLedger(
  requestOrOptions?: Request | ConfiguredTaskLedgerOptions,
): Promise<ConfiguredTaskLedger> {
  const options = requestOrOptions && !(requestOrOptions instanceof Request) ? requestOrOptions : undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? createTaskLedgerRepositoryCreators(),
  });
  return repository.adapter;
}
