import 'server-only';

import type { TaskAssignmentStatus } from '@/domain/types';
import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { withTenantSnapshot } from '@/server/db/transaction';
import type { CentralTenantContextInput } from '@/server/repositories/context';
import type { RepositoryCreators } from '@/server/repositories/factory';
import { createDatabaseTaskQueries } from '@/server/repositories/database/taskQueries';
import { createDatabaseTaskCycleQueries } from '@/server/repositories/database/taskCycleQueries';
import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
  type CompatibilityCentralTenantEnv,
} from '@/server/repositories/configuredRepository';
import {
  getTaskAssignmentStatus,
  getTaskById,
  getTasks,
  type SheetsReader,
} from '@/server/sheetsRepository';
import {
  getTaskCycleProjection,
  getTaskHistoryDetail,
  listTaskCycleProjections,
  type TaskCycleProjectionDto,
} from '@/server/repositories/sheets/taskHistoryQueries';
import { buildBankTaskProjection, type BankTaskDto } from '@/server/taskReadProjection';

export type TaskReader = Readonly<{
  listTaskCycleProjections: (options?: {
    studentId?: string; includeInactive?: boolean; now?: string;
  }) => Promise<TaskCycleProjectionDto[]>;
  getTaskCycleProjection: (
    taskId: string,
    options?: { studentId?: string; now?: string },
  ) => Promise<TaskCycleProjectionDto | null>;
  getTaskAssignmentStatus: (taskId: string) => Promise<TaskAssignmentStatus>;
  getTaskHistoryDetail: (
    filter: { taskId: string; taskInstanceId?: string },
    now?: string,
  ) => Promise<TaskHistoryDetailDto>;
  getBankTasks: (now?: string) => Promise<BankTaskDto[]>;
}>;

type TaskQueryFactory = (dependencies: {
  tenantId: string;
  runTenantTransaction: typeof withTenantSnapshot;
}) => ReturnType<typeof createDatabaseTaskQueries>;

type TaskCycleQueryFactory = (dependencies: {
  tenantId: string;
  runTenantSnapshot: typeof withTenantSnapshot;
  taskQueries: ReturnType<typeof createDatabaseTaskQueries>;
}) => TaskReader;

type SheetsTaskFunctions = Readonly<{
  listTaskCycleProjections: typeof listTaskCycleProjections;
  getTaskById: typeof getTaskById;
  getTaskCycleProjection: typeof getTaskCycleProjection;
  getTaskAssignmentStatus: typeof getTaskAssignmentStatus;
  getTaskHistoryDetail: typeof getTaskHistoryDetail;
  getTasks: typeof getTasks;
}>;

type TaskCreatorDependencies = Readonly<{
  createDatabaseTaskQueries: TaskQueryFactory;
  createDatabaseTaskCycleQueries: TaskCycleQueryFactory;
  withTenantSnapshot: typeof withTenantSnapshot;
  createConfiguredSheetsReader: (request?: Request) => Promise<SheetsReader>;
  sheets: SheetsTaskFunctions;
}>;

export type ConfiguredTaskOptions = Readonly<{
  env: CompatibilityCentralTenantEnv;
  getCentralTenantContext: (
    env: CompatibilityCentralTenantEnv,
  ) => CentralTenantContextInput | undefined;
  creators: RepositoryCreators<TaskReader, TaskReader>;
}>;

export function createTaskRepositoryCreators(
  dependencies: TaskCreatorDependencies,
  request?: Request,
): RepositoryCreators<TaskReader, TaskReader> {
  return {
    createPostgresql(authority) {
      const taskQueries = dependencies.createDatabaseTaskQueries({
        tenantId: authority.tenantId,
        runTenantTransaction: dependencies.withTenantSnapshot,
      });
      return dependencies.createDatabaseTaskCycleQueries({
        tenantId: authority.tenantId,
        runTenantSnapshot: dependencies.withTenantSnapshot,
        taskQueries,
      });
    },
    createSheets() {
      let readerPromise: Promise<SheetsReader> | undefined;
      const configuredReader = () => {
        readerPromise ??= dependencies.createConfiguredSheetsReader(request);
        return readerPromise;
      };
      return {
        async listTaskCycleProjections(options = {}) {
          return dependencies.sheets.listTaskCycleProjections(await configuredReader(), options);
        },
        async getTaskCycleProjection(taskId, options = {}) {
          const reader = await configuredReader();
          const task = await dependencies.sheets.getTaskById(reader, taskId);
          return task ? dependencies.sheets.getTaskCycleProjection(reader, task, options) : null;
        },
        async getTaskAssignmentStatus(taskId) {
          return dependencies.sheets.getTaskAssignmentStatus(await configuredReader(), taskId);
        },
        async getTaskHistoryDetail(filter, now) {
          const reader = await configuredReader();
          return now === undefined
            ? dependencies.sheets.getTaskHistoryDetail(reader, filter)
            : dependencies.sheets.getTaskHistoryDetail(reader, filter, now);
        },
        async getBankTasks(now = new Date().toISOString()) {
          const tasks = await dependencies.sheets.getTasks(
            await configuredReader(),
            { includeInactive: true },
          );
          return buildBankTaskProjection(tasks, now);
        },
      };
    },
  };
}

function productionCreators(request?: Request) {
  return createTaskRepositoryCreators({
    createDatabaseTaskQueries,
    createDatabaseTaskCycleQueries,
    withTenantSnapshot,
    createConfiguredSheetsReader,
    sheets: {
      listTaskCycleProjections,
      getTaskById,
      getTaskCycleProjection,
      getTaskAssignmentStatus,
      getTaskHistoryDetail,
      getTasks,
    },
  }, request);
}

export function createConfiguredTaskReader(): Promise<TaskReader>;
export function createConfiguredTaskReader(request: Request): Promise<TaskReader>;
export function createConfiguredTaskReader(options: ConfiguredTaskOptions): Promise<TaskReader>;
export async function createConfiguredTaskReader(
  requestOrOptions?: Request | ConfiguredTaskOptions,
): Promise<TaskReader> {
  const options = isConfiguredTaskOptions(requestOrOptions) ? requestOrOptions : undefined;
  const request = options ? undefined : requestOrOptions as Request | undefined;
  const repository = await resolveCompatibilityConfiguredRepository({
    env: options?.env ?? process.env,
    getCentralTenantContext: options?.getCentralTenantContext
      ?? getCompatibilityCentralTenantContext,
    creators: options?.creators ?? productionCreators(request),
  });
  return repository.adapter;
}

function isConfiguredTaskOptions(value: Request | ConfiguredTaskOptions | undefined):
  value is ConfiguredTaskOptions {
  return Boolean(value && typeof value === 'object' && 'creators' in value);
}
