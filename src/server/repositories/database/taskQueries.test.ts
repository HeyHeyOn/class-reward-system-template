import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskSchedule } from '@/domain/types';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import { getTasks as getSheetTasks, type SheetsReader } from '@/server/sheetsRepository';
import {
  createDatabaseTaskQueries,
  type DatabaseTaskQueryDependencies,
} from './taskQueries';

vi.mock('server-only', () => ({}));

const CURRENT: TaskSchedule = {
  ruleVersion: 2,
  effectiveFrom: '2026-08-20T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'WEEKLY', weekdays: [5, 1, 3], time: '09:30' },
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: false,
};
const PENDING: TaskSchedule = {
  ruleVersion: 3,
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'MONTHLY', dayOfMonth: 15, time: '10:00' },
  resetCompletionOnCycle: true,
  resetAssignmentOnCycle: true,
};
const NONE: TaskSchedule = {
  ruleVersion: 1,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'NONE' },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
};

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const tenantId of [harness.tenantOneId, harness.tenantTwoId]) {
    await seedStudent(tenantId, 'S1', '학생 1');
    await seedStudent(tenantId, 'S2', '학생 2');
  }
});

afterEach(async () => {
  await harness?.close();
});

function queries(overrides: Partial<DatabaseTaskQueryDependencies> = {}) {
  return createDatabaseTaskQueries({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    ...overrides,
  });
}

async function seedStudent(tenantId: string, studentId: string, name: string) {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenantId, studentId, name],
  );
}

type TaskSeed = {
  taskId: string;
  taskInstanceId: string;
  title: string;
  description?: string;
  reward?: number;
  isActive?: boolean;
  sortOrder?: number;
  availableFrom?: string | null;
  dueAt?: string | null;
  prerequisiteTaskInstanceId?: string | null;
  padletBoardId?: string | null;
  currentSchedule?: TaskSchedule;
  pendingSchedule?: TaskSchedule | null;
  scheduleSchemaVersion?: number;
  createdAt?: string;
  deletedAt?: string | null;
};

async function seedTask(tenantId: string, task: TaskSeed) {
  const createdAt = task.createdAt ?? '2026-08-01T00:00:00.000Z';
  await harness.database.query(
    `INSERT INTO tasks (
       tenant_id, task_instance_id, task_id, title, description, reward, is_active,
       sort_order, available_from, due_at, prerequisite_task_instance_id,
       padlet_board_id, current_schedule, pending_schedule, schedule_schema_version,
       created_at, updated_at, deleted_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15, $16, $16, $17)`,
    [
      tenantId, task.taskInstanceId, task.taskId, task.title, task.description ?? '',
      task.reward ?? 0, task.isActive ?? true, task.sortOrder ?? 0,
      task.availableFrom ?? null, task.dueAt ?? null,
      task.prerequisiteTaskInstanceId ?? null, task.padletBoardId ?? null,
      JSON.stringify(task.currentSchedule ?? NONE),
      task.pendingSchedule ? JSON.stringify(task.pendingSchedule) : null,
      task.scheduleSchemaVersion ?? 1, createdAt, task.deletedAt ?? null,
    ],
  );
}

async function allow(tenantId: string, taskInstanceId: string, studentId: string, createdAt: string) {
  await harness.database.query(
    `INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id, created_at)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, taskInstanceId, studentId, createdAt],
  );
}

const HEADERS = [
  'taskId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt',
  'allowedStudentIds', 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId',
  'taskInstanceId', 'ruleVersion', 'scheduleEffectiveFrom', 'recurrenceTimeZone',
  'recurrenceType', 'recurrenceTime', 'recurrenceWeekday', 'recurrenceDayOfMonth',
  'resetCompletionOnCycle', 'resetAssignmentOnCycle', 'pendingRuleVersion',
  'pendingEffectiveFrom', 'pendingTimeZone', 'pendingRecurrenceType',
  'pendingRecurrenceTime', 'pendingRecurrenceWeekday', 'pendingRecurrenceDayOfMonth',
  'pendingResetCompletionOnCycle', 'pendingResetAssignmentOnCycle', 'recurrenceWeekdays',
  'pendingRecurrenceWeekdays',
];

function sheetRow(values: Record<string, string>): string[] {
  return HEADERS.map((header) => values[header] ?? '');
}

describe('database task queries', () => {
  it('matches the actual Sheets projection, schedule contracts, allowed-ID semantics, and ordering', async () => {
    await seedTask(harness.tenantOneId, {
      taskId: 'BASE', taskInstanceId: 'INSTANCE-BASE', title: '선행', sortOrder: 1,
    });
    await seedTask(harness.tenantOneId, {
      taskId: 'TASK-B', taskInstanceId: 'INSTANCE-B', title: '  나 과제  ',
      description: '  설명  ', reward: 9007199254740991, isActive: false, sortOrder: 2,
      availableFrom: '2026-08-21T01:02:03.000Z', dueAt: '2026-08-31T04:05:06.000Z',
      prerequisiteTaskInstanceId: 'INSTANCE-BASE', padletBoardId: 'BOARD000000000001',
      currentSchedule: CURRENT, pendingSchedule: PENDING,
      createdAt: '2026-08-02T00:00:00.000Z',
    });
    await seedTask(harness.tenantOneId, {
      taskId: 'TASK-A', taskInstanceId: 'INSTANCE-A', title: '가 과제', sortOrder: 2,
    });
    await allow(harness.tenantOneId, 'INSTANCE-B', 'S2', '2026-08-01T00:00:00.000Z');
    await allow(harness.tenantOneId, 'INSTANCE-B', 'S1', '2026-08-02T00:00:00.000Z');

    const reader: SheetsReader = { getRows: async (sheetName) => sheetName === 'Tasks' ? [
      HEADERS,
      sheetRow({ taskId: 'TASK-B', title: '  나 과제  ', description: '  설명  ', reward: '9007199254740991', isActive: 'FALSE', sortOrder: '2', createdAt: '2026-08-02T00:00:00.000Z', allowedStudentIds: 'S2, S1;S2', availableFrom: '2026-08-21T01:02:03.000Z', dueAt: '2026-08-31T04:05:06.000Z', prerequisiteTaskId: 'BASE', padletBoardId: 'BOARD000000000001', taskInstanceId: 'INSTANCE-B', ruleVersion: '2', scheduleEffectiveFrom: '2026-08-20T00:00:00.000Z', recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'WEEKLY', recurrenceTime: '09:30', recurrenceWeekdays: '5,1,3', resetCompletionOnCycle: 'TRUE', resetAssignmentOnCycle: 'FALSE', pendingRuleVersion: '3', pendingEffectiveFrom: '2026-09-01T00:00:00.000Z', pendingTimeZone: 'Asia/Seoul', pendingRecurrenceType: 'MONTHLY', pendingRecurrenceTime: '10:00', pendingRecurrenceDayOfMonth: '15', pendingResetCompletionOnCycle: 'TRUE', pendingResetAssignmentOnCycle: 'TRUE' }),
      sheetRow({ taskId: 'BASE', title: '선행', description: '', reward: '0', isActive: 'TRUE', sortOrder: '1', createdAt: '2026-08-01T00:00:00.000Z', taskInstanceId: 'INSTANCE-BASE', ruleVersion: '1', scheduleEffectiveFrom: '2026-08-01T00:00:00.000Z', recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'NONE', resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE' }),
      sheetRow({ taskId: 'TASK-A', title: '가 과제', description: '', reward: '0', isActive: 'TRUE', sortOrder: '2', createdAt: '2026-08-01T00:00:00.000Z', taskInstanceId: 'INSTANCE-A', ruleVersion: '1', scheduleEffectiveFrom: '2026-08-01T00:00:00.000Z', recurrenceTimeZone: 'Asia/Seoul', recurrenceType: 'NONE', resetCompletionOnCycle: 'FALSE', resetAssignmentOnCycle: 'FALSE' }),
    ] : [] };
    const expected = await getSheetTasks(reader, { includeInactive: true });

    await expect(queries().getTasks()).resolves.toEqual(expected);
    expect(expected.map(({ taskId }) => taskId)).toEqual(['BASE', 'TASK-A', 'TASK-B']);
    expect(expected[2].allowedStudentIds).toEqual(['S2', 'S1']);
    expect(expected[2].schedule?.recurrence).toEqual({ type: 'WEEKLY', weekdays: [1, 3, 5], time: '09:30' });
  });

  it('returns only active tasks while ID lookup still returns an inactive task', async () => {
    await seedTask(harness.tenantOneId, { taskId: 'ACTIVE', taskInstanceId: 'I-A', title: '활성' });
    await seedTask(harness.tenantOneId, { taskId: 'INACTIVE', taskInstanceId: 'I-I', title: '비활성', isActive: false });

    await expect(queries().getActiveTasks()).resolves.toEqual([
      expect.objectContaining({ taskId: 'ACTIVE', isActive: true }),
    ]);
    await expect(queries().getTaskById('INACTIVE')).resolves.toEqual(
      expect.objectContaining({ taskId: 'INACTIVE', isActive: false }),
    );
    await expect(queries().getTaskById('missing')).resolves.toBeNull();
  });

  it('isolates same task and internal IDs plus allowed students across tenants', async () => {
    await seedTask(harness.tenantOneId, { taskId: 'SHARED', taskInstanceId: 'ONE', title: '첫 반' });
    await seedTask(harness.tenantTwoId, { taskId: 'SHARED', taskInstanceId: 'ONE', title: '다른 반' });
    await allow(harness.tenantOneId, 'ONE', 'S1', '2026-08-01T00:00:00.000Z');
    await allow(harness.tenantTwoId, 'ONE', 'S2', '2026-08-01T00:00:00.000Z');

    await expect(queries().getTaskById('SHARED')).resolves.toEqual(
      expect.objectContaining({ title: '첫 반', taskInstanceId: 'ONE', allowedStudentIds: ['S1'] }),
    );
  });

  it('keeps explicit tenant predicates behind an independently mismatched RLS context', async () => {
    await seedTask(harness.tenantOneId, { taskId: 'RLS', taskInstanceId: 'RLS-I', title: '격리' });
    await seedTask(harness.tenantTwoId, { taskId: 'RLS', taskInstanceId: 'RLS-I', title: '다른 반 decoy' });
    const runWithTenantTwoContext: DatabaseTaskQueryDependencies['runTenantTransaction'] =
      (_tenantId, callback) => harness.runTenantTransaction(harness.tenantTwoId, callback);
    const mismatched = queries({ runTenantTransaction: runWithTenantTwoContext });

    await expect(mismatched.getTasks()).resolves.toEqual([]);
    await expect(mismatched.getActiveTasks()).resolves.toEqual([]);
    await expect(mismatched.getTaskById('RLS')).resolves.toBeNull();
  });

  it('hides soft-deleted tasks from every query', async () => {
    await seedTask(harness.tenantOneId, {
      taskId: 'DELETED', taskInstanceId: 'DELETED-I', title: '삭제',
      createdAt: '2026-08-01T00:00:00.000Z', deletedAt: '2026-08-02T00:00:00.000Z',
    });

    await expect(queries().getTasks()).resolves.toEqual([]);
    await expect(queries().getActiveTasks()).resolves.toEqual([]);
    await expect(queries().getTaskById('DELETED')).resolves.toBeNull();
  });

  it('preserves a live task prerequisite ID after the prerequisite is soft-deleted', async () => {
    await seedTask(harness.tenantOneId, {
      taskId: 'OLD-BASE', taskInstanceId: 'OLD-BASE-I', title: '이전 선행',
      deletedAt: '2026-08-02T00:00:00.000Z',
    });
    await seedTask(harness.tenantOneId, {
      taskId: 'LIVE', taskInstanceId: 'LIVE-I', title: '현재',
      prerequisiteTaskInstanceId: 'OLD-BASE-I',
    });

    await expect(queries().getTaskById('LIVE')).resolves.toEqual(
      expect.objectContaining({ prerequisiteTaskId: 'OLD-BASE' }),
    );
  });

  it('isolates prerequisite joins when another tenant reuses the internal instance ID', async () => {
    await seedTask(harness.tenantOneId, {
      taskId: 'BASE-ONE', taskInstanceId: 'COLLIDING-BASE', title: '첫 반 선행',
    });
    await seedTask(harness.tenantTwoId, {
      taskId: 'BASE-TWO', taskInstanceId: 'COLLIDING-BASE', title: '다른 반 선행',
    });
    await seedTask(harness.tenantOneId, {
      taskId: 'LIVE-ONE', taskInstanceId: 'LIVE-ONE-I', title: '현재',
      prerequisiteTaskInstanceId: 'COLLIDING-BASE',
    });

    await expect(queries().getTaskById('LIVE-ONE')).resolves.toEqual(
      expect.objectContaining({ prerequisiteTaskId: 'BASE-ONE' }),
    );
  });

  it('rejects an unsupported task schedule schema version', async () => {
    await seedTask(harness.tenantOneId, {
      taskId: 'FUTURE-SCHEMA', taskInstanceId: 'FUTURE-SCHEMA-I', title: '미래 형식',
      scheduleSchemaVersion: 2,
    });

    await expect(queries().getTaskById('FUTURE-SCHEMA')).rejects.toThrow(/schema version/i);
  });

  it('rejects a valid non-Seoul IANA zone even if the database constraint is bypassed', async () => {
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_current_schedule_check');
    await seedTask(harness.tenantOneId, {
      taskId: 'WRONG-ZONE', taskInstanceId: 'WRONG-ZONE-I', title: '잘못된 시간대',
      currentSchedule: { ...NONE, timeZone: 'Europe/London' },
    });

    await expect(queries().getTaskById('WRONG-ZONE')).rejects.toThrow(/Asia\/Seoul|time zone/i);
  });

  it('rejects an unsafe schedule rule version after the database constraint is bypassed', async () => {
    await harness.database.exec('ALTER TABLE tasks DROP CONSTRAINT tasks_current_schedule_check');
    await seedTask(harness.tenantOneId, {
      taskId: 'UNSAFE-RULE', taskInstanceId: 'UNSAFE-RULE-I', title: '잘못된 버전',
      currentSchedule: { ...NONE, ruleVersion: Number.MAX_SAFE_INTEGER + 1 },
    });

    await expect(queries().getTaskById('UNSAFE-RULE')).rejects.toThrow(/rule version|safe integer/i);
  });

  it.each(['', ' SHARED', 'SHARED '])(
    'rejects noncanonical task ID %j before opening a transaction',
    async (taskId) => {
      let transactionOpened = false;
      const runTenantTransaction: DatabaseTaskQueryDependencies['runTenantTransaction'] =
        <TResult>() => {
          transactionOpened = true;
          return Promise.reject(new Error('unexpected transaction')) as Promise<TResult>;
        };
      await expect(queries({ runTenantTransaction }).getTaskById(taskId)).rejects.toThrow(/task id/i);
      expect(transactionOpened).toBe(false);
    },
  );
});
