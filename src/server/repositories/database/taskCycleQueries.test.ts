import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCompletion, TaskSchedule } from '@/domain/types';
import { projectTaskCycleState } from '@/domain/taskCycleState';
import { projectTaskCycleHistoryFromSnapshot } from '@/domain/taskCycleHistory';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import type { TenantTransaction } from '@/server/db/transaction';
import { getTaskCompletions as getSheetTaskCompletions } from '@/server/sheetsRepository';
import {
  createDatabaseTaskCycleQueries,
  type DatabaseTaskCycleQueryDependencies,
} from './taskCycleQueries';

vi.mock('server-only', () => ({}));

const TENANT_ONE_STUDENT = 'S1';
const BANK_OPERATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const BANK_OPERATION_HASH = 'a'.repeat(64);
const SCHEDULE: TaskSchedule = {
  ruleVersion: 1,
  effectiveFrom: '2026-08-01T00:00:00.000Z',
  timeZone: 'Asia/Seoul',
  recurrence: { type: 'NONE' },
  resetCompletionOnCycle: false,
  resetAssignmentOnCycle: false,
};
const COMPLETION_HEADERS = [
  'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward',
  'balanceBefore', 'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId',
  'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId',
  'schemaVersion', 'operationId', 'operationPayloadHash', 'evidenceProvider',
  'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName',
];

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  for (const tenantId of [harness.tenantOneId, harness.tenantTwoId]) {
    await harness.database.query(
      `INSERT INTO students (tenant_id, student_id, name, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [tenantId, TENANT_ONE_STUDENT, tenantId === harness.tenantOneId ? '학생 하나' : '학생 둘'],
    );
    await harness.database.query(
      `INSERT INTO tasks (
         tenant_id, task_instance_id, task_id, title, description, reward, is_active,
         sort_order, current_schedule, schedule_schema_version, created_at, updated_at,
         deleted_at
       ) VALUES ($1, 'I1', 'T1', $2, '', 5, true, 1, $3::jsonb, 1,
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                 '2026-08-02T00:00:00.000Z')`,
      [tenantId, tenantId === harness.tenantOneId ? '삭제된 과제' : '다른 반 미끼', JSON.stringify(SCHEDULE)],
    );
  }
});

afterEach(async () => {
  await harness?.close();
});

function queries(overrides: Partial<DatabaseTaskCycleQueryDependencies> = {}) {
  return createDatabaseTaskCycleQueries({
    tenantId: harness.tenantOneId,
    runTenantSnapshot: harness.runTenantTransaction,
    ...overrides,
  });
}

async function seedAssignment(input: {
  tenantId?: string;
  assignmentId: string;
  eventSequence: number | string;
  eventType?: string;
  source?: string;
  createdAt?: string;
  schemaVersion?: number;
  timezone?: string;
  taskInstanceId?: string;
  taskId?: string;
  studentId?: string;
  cycleId?: string;
  cycleStartAt?: string;
  cycleEndAt?: string | null;
  previousAssignmentId?: string | null;
}) {
  await harness.database.query(
    `INSERT INTO task_assignments (
       tenant_id, assignment_id, event_sequence, task_id_snapshot, task_instance_id,
       cycle_id, cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       event_type, source, previous_assignment_id, created_at, schema_version, note
     ) OVERRIDING SYSTEM VALUE
     VALUES ($1, $2, $3, $4, $5, $6, $7,
             $8, 7, $9, $10, $11, $12, $13, $14, $15, 'note')`,
    [
      input.tenantId ?? harness.tenantOneId, input.assignmentId, input.eventSequence,
      input.taskId ?? 'T1', input.taskInstanceId ?? 'I1', input.cycleId ?? 'cycle-1',
      input.cycleStartAt ?? '2026-08-10T00:00:00.000Z',
      input.cycleEndAt === undefined ? '2026-08-11T00:00:00.000Z' : input.cycleEndAt,
      input.timezone ?? 'Asia/Seoul', input.studentId ?? 'S1', input.eventType ?? 'ASSIGNED',
      input.source ?? 'ADMIN', input.previousAssignmentId ?? null,
      input.createdAt ?? '2026-08-10T01:00:00.000Z', input.schemaVersion ?? 1,
    ],
  );
}

type CompletionSeed = {
  tenantId?: string;
  completionId: string;
  eventSequence: number | string;
  completedAt: string;
  status?: string;
  source?: string | null;
  schemaVersion?: number;
  taskInstanceId?: string | null;
  cycleId?: string | null;
  cycleStartAt?: string | null;
  cycleEndAt?: string | null;
  ruleVersion?: number | null;
  timezone?: string | null;
  assignmentId?: string | null;
  reward?: number | string;
  balanceBefore?: number | string;
  balanceAfter?: number | string;
  operationId?: string | null;
  operationHash?: string | null;
  evidence?: readonly [string | null, string | null, string | null, string | null, string | null];
};

async function seedCompletion(input: CompletionSeed) {
  const cyclePresent = input.taskInstanceId !== null;
  const source = cyclePresent ? (input.source === undefined ? 'ADMIN' : input.source) : null;
  const evidence = input.evidence ?? [null, null, null, null, null];
  await harness.database.query(
    `INSERT INTO task_completions (
       tenant_id, completion_id, event_sequence, completed_at, task_instance_id,
       task_id_snapshot, task_name_snapshot, student_id, student_name_snapshot,
       reward_snapshot, balance_before, balance_after, status, note, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, source, assignment_id,
       operation_id, operation_hash, schema_version, evidence_provider,
       evidence_board_id, evidence_post_id, evidence_created_at,
       evidence_author_full_name
     ) OVERRIDING SYSTEM VALUE
     VALUES ($1, $2, $3, $4, $5, 'T1', '삭제된 과제', 'S1', '학생 하나',
             $6, $7, $8, $9, 'done', $10, $11, $12, $13, $14, $15, $16,
             $17, $18, $19, $20, $21, $22, $23, $24)`,
    [
      input.tenantId ?? harness.tenantOneId, input.completionId, input.eventSequence,
      input.completedAt, cyclePresent ? (input.taskInstanceId ?? 'I1') : null,
      input.reward ?? (source === 'BANK' ? 5 : 0), input.balanceBefore ?? 10,
      input.balanceAfter ?? (source === 'BANK' ? 15 : 10),
      input.status ?? 'COMPLETED', cyclePresent ? (input.cycleId ?? 'cycle-1') : null,
      cyclePresent ? (input.cycleStartAt ?? '2026-08-10T00:00:00.000Z') : null,
      cyclePresent ? (input.cycleEndAt === undefined ? '2026-08-11T00:00:00.000Z' : input.cycleEndAt) : null,
      cyclePresent ? (input.ruleVersion ?? 7) : null,
      cyclePresent ? (input.timezone ?? 'Asia/Seoul') : null,
      source,
      input.assignmentId ?? null, input.operationId ?? null, input.operationHash ?? null,
      input.schemaVersion ?? 1, ...evidence,
    ],
  );
}

function withoutSchemaVersion(completions: TaskCompletion[]) {
  return completions.map((completion) => {
    const projected = { ...completion };
    delete projected.schemaVersion;
    return projected;
  });
}

async function seedCanonicalBankAssignment(assignmentId = 'A-BANK') {
  await seedAssignment({ assignmentId, eventSequence: 1 });
}

async function seedBankCompletion(overrides: Partial<CompletionSeed> = {}) {
  await seedCompletion({
    completionId: 'C-BANK', eventSequence: 1,
    completedAt: '2026-08-10T09:00:00.000Z', source: 'BANK',
    assignmentId: 'A-BANK', operationId: BANK_OPERATION_ID,
    operationHash: BANK_OPERATION_HASH, ...overrides,
  });
}

describe('database task cycle queries', () => {
  it('projects current cycle state from a strict task and both ledgers in one transaction', async () => {
    await harness.database.query(
      `INSERT INTO tasks (
         tenant_id, task_instance_id, task_id, title, description, reward, is_active,
         sort_order, current_schedule, schedule_schema_version, created_at, updated_at
       ) VALUES ($1, 'LIVE-I', 'LIVE', '현재 과제', '', 5, true, 1, $2::jsonb, 1,
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
      [harness.tenantOneId, JSON.stringify(SCHEDULE)],
    );
    await harness.database.query(
      `INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id)
       VALUES ($1, 'LIVE-I', 'S1')`,
      [harness.tenantOneId],
    );
    let transactionCalls = 0;
    const runTenantSnapshot: DatabaseTaskCycleQueryDependencies['runTenantSnapshot'] =
      (tenantId, callback) => {
        transactionCalls += 1;
        return harness.runTenantTransaction(tenantId, callback);
      };
    const now = '2026-08-10T00:00:00.000Z';
    const task = {
      taskId: 'LIVE', taskInstanceId: 'LIVE-I', title: '현재 과제', description: '',
      reward: 5, isActive: true, sortOrder: 1, allowedStudentIds: ['S1'],
      createdAt: '2026-08-01T00:00:00.000Z', schedule: SCHEDULE, pendingSchedule: null,
    };

    await expect(queries({ runTenantSnapshot }).getTaskCycleState('LIVE', now))
      .resolves.toEqual(projectTaskCycleState({ task, now, assignments: [], completions: [] }));
    expect(transactionCalls).toBe(1);
  });

  it('rejects a noncanonical cycle-state task ID before opening a transaction', async () => {
    let transactionOpened = false;
    const runTenantSnapshot: DatabaseTaskCycleQueryDependencies['runTenantSnapshot'] = <TResult>() => {
      transactionOpened = true;
      return Promise.reject(new Error('unexpected transaction')) as Promise<TResult>;
    };
    await expect(queries({ runTenantSnapshot }).getTaskCycleState(' LIVE'))
      .rejects.toThrow(/canonical task id/i);
    expect(transactionOpened).toBe(false);
  });

  it('preserves the Sheets missing-task error for current cycle state', async () => {
    await expect(queries().getTaskCycleState('MISSING', '2026-08-10T00:00:00.000Z'))
      .rejects.toThrow('과제를 찾을 수 없습니다.');
  });

  it('projects assignment-first task history from the strict database ledger snapshot', async () => {
    await seedAssignment({ assignmentId: 'A1', eventSequence: 1, source: 'ADMIN' });
    await seedCompletion({
      completionId: 'C1', eventSequence: 1, source: 'ADMIN',
      completedAt: '2026-08-10T09:00:00.000Z',
    });
    const snapshot = await queries().loadTaskCycleLedgerSnapshot();

    await expect(queries().getTaskCycleHistory({ taskId: 'T1' }))
      .resolves.toEqual(projectTaskCycleHistoryFromSnapshot(snapshot, { taskId: 'T1' }));
  });

  it('filters task history by exact lifecycle instance ID', async () => {
    await seedAssignment({ assignmentId: 'A1', eventSequence: 1, source: 'ADMIN' });
    await seedCompletion({
      completionId: 'LEGACY', eventSequence: 2, taskInstanceId: null, source: null,
      completedAt: '2026-08-09T09:00:00.000Z',
      status: 'LEGACY_OK', reward: 0, balanceBefore: 0, balanceAfter: 0,
    });

    await expect(queries().getTaskCycleHistory({ taskId: 'T1', taskInstanceId: 'I1' }))
      .resolves.toEqual([
        expect.objectContaining({ eventType: 'ASSIGNMENT', eventId: 'A1', taskInstanceId: 'I1' }),
      ]);
  });

  it.each([
    { taskId: ' T1' },
    { taskInstanceId: ' T1-I' },
    { taskId: '' },
  ])('rejects noncanonical history filters before opening a snapshot: %o', async (filter) => {
    let snapshotOpened = false;
    const runTenantSnapshot: DatabaseTaskCycleQueryDependencies['runTenantSnapshot'] = <TResult>() => {
      snapshotOpened = true;
      return Promise.reject(new Error('unexpected snapshot')) as Promise<TResult>;
    };
    await expect(queries({ runTenantSnapshot }).getTaskCycleHistory(filter))
      .rejects.toThrow(/canonical/i);
    expect(snapshotOpened).toBe(false);
  });

  it('reads both ledgers in one tenant transaction and preserves event-sequence order and snapshots', async () => {
    await seedAssignment({ assignmentId: 'A-later-time', eventSequence: 1, source: 'QR', createdAt: '2026-08-10T09:00:00.000Z' });
    await seedAssignment({ assignmentId: 'A-earlier-time', eventSequence: 2, eventType: 'UNASSIGNED', source: 'QR', createdAt: '2026-08-10T01:00:00.000Z' });
    await seedCompletion({ completionId: 'C2', eventSequence: 4, completedAt: '2026-08-10T01:00:00.000Z', status: 'CANCELLED', source: 'ADMIN_RESET' });
    await seedCompletion({
      completionId: 'C1', eventSequence: 3, completedAt: '2026-08-10T09:00:00.000Z',
      source: 'BANK', assignmentId: 'A-later-time', operationId: BANK_OPERATION_ID,
      operationHash: BANK_OPERATION_HASH,
      evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T00:30:00.000Z', '학생 하나'],
    });
    let transactionCalls = 0;
    let executeCalls = 0;
    const runTenantSnapshot: DatabaseTaskCycleQueryDependencies['runTenantSnapshot'] =
      (tenantId, callback) => {
        transactionCalls += 1;
        return harness.runTenantTransaction(tenantId, (transaction) => callback({
          execute(query) {
            executeCalls += 1;
            return transaction.execute(query);
          },
        } as TenantTransaction));
      };

    const snapshot = await queries({ runTenantSnapshot }).loadTaskCycleLedgerSnapshot();

    expect(transactionCalls).toBe(1);
    expect(executeCalls).toBe(1);
    expect(snapshot.assignments.map(({ assignmentId }) => assignmentId)).toEqual(['A-later-time', 'A-earlier-time']);
    expect(snapshot.assignments[1]).toEqual({
      assignmentId: 'A-earlier-time', taskId: 'T1', taskInstanceId: 'I1', cycleId: 'cycle-1',
      cycleStartsAt: '2026-08-10T00:00:00.000Z', cycleEndsAt: '2026-08-11T00:00:00.000Z',
      ruleVersion: 7, timeZone: 'Asia/Seoul', studentId: 'S1', status: 'UNASSIGNED',
      source: 'QR', previousAssignmentId: '', createdAt: '2026-08-10T01:00:00.000Z',
      schemaVersion: 1, note: 'note',
    });
    expect(snapshot.completions.map(({ completionId }) => completionId)).toEqual(['C1', 'C2']);
    expect(snapshot.completions[0]).toMatchObject({
      completionId: 'C1', timestamp: '2026-08-10T09:00:00.000Z', status: 'SUCCESS',
      source: 'BANK', operationId: BANK_OPERATION_ID, operationPayloadHash: BANK_OPERATION_HASH,
      evidenceProvider: 'PADLET', evidenceBoardId: 'BOARD000000000001',
      evidencePostId: 'post_123', evidenceCreatedAt: '2026-08-10T00:30:00.000Z',
      evidenceAuthorFullName: '학생 하나', schemaVersion: 1,
    });
    expect(snapshot.completions[1]).toMatchObject({ status: 'RESET', source: 'ADMIN_RESET' });
  });

  it('sorts completion presentation by completedAt descending and keeps event order for ties', async () => {
    await seedCompletion({ completionId: 'OLD', eventSequence: 2, completedAt: '2026-08-10T01:00:00.000Z' });
    await seedCompletion({ completionId: 'TIE-FIRST', eventSequence: 3, completedAt: '2026-08-10T09:00:00.000Z' });
    await seedCompletion({ completionId: 'TIE-SECOND', eventSequence: 4, completedAt: '2026-08-10T09:00:00.000Z', status: 'IMPORTED_SUCCESS', taskInstanceId: null });

    const completions = await queries().getTaskCompletions();

    expect(completions.map(({ completionId }) => completionId)).toEqual(['TIE-FIRST', 'TIE-SECOND', 'OLD']);
    expect(completions[1].status).toBe('IMPORTED_SUCCESS');
  });

  it('matches the Sheets semantic completion projection and presentation order', async () => {
    await seedCompletion({ completionId: 'SUCCESS', eventSequence: 1, completedAt: '2026-08-10T09:00:00.000Z' });
    await seedCompletion({ completionId: 'RESET', eventSequence: 2, completedAt: '2026-08-10T08:00:00.000Z', status: 'CANCELLED', source: 'ADMIN_RESET' });
    const sheetRows = [
      COMPLETION_HEADERS,
      ['RESET', '2026-08-10T08:00:00.000Z', 'T1', 'S1', '학생 하나', '0', '10', '10', 'RESET', 'done', 'I1', 'cycle-1', '2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '7', 'Asia/Seoul', 'ADMIN_RESET', '', '2'],
      ['SUCCESS', '2026-08-10T09:00:00.000Z', 'T1', 'S1', '학생 하나', '0', '10', '10', 'SUCCESS', 'done', 'I1', 'cycle-1', '2026-08-10T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '7', 'Asia/Seoul', 'ADMIN', '', '2'],
    ];
    const expected = await getSheetTaskCompletions({ getRows: async () => sheetRows });

    const actual = await queries().getTaskCompletions();

    expect(withoutSchemaVersion(actual)).toEqual(withoutSchemaVersion(expected));
    expect(actual.map(({ schemaVersion }) => schemaVersion)).toEqual([1, 1]);
  });

  it('isolates same IDs across tenants and explicit predicates fail closed under mismatched RLS context', async () => {
    await seedAssignment({ assignmentId: 'SHARED', eventSequence: 1 });
    await seedCompletion({ completionId: 'SHARED', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z' });
    await seedAssignment({ tenantId: harness.tenantTwoId, assignmentId: 'SHARED', eventSequence: 1, source: 'QR' });
    await seedCompletion({ tenantId: harness.tenantTwoId, completionId: 'SHARED', eventSequence: 1, completedAt: '2026-08-10T02:00:00.000Z', status: 'CANCELLED', source: 'ADMIN_RESET' });

    await expect(queries().loadTaskCycleLedgerSnapshot()).resolves.toMatchObject({
      assignments: [expect.objectContaining({ assignmentId: 'SHARED', source: 'ADMIN' })],
      completions: [expect.objectContaining({ completionId: 'SHARED', status: 'SUCCESS' })],
    });
    const mismatchedRunner: DatabaseTaskCycleQueryDependencies['runTenantSnapshot'] =
      (_tenantId, callback) => harness.runTenantTransaction(harness.tenantTwoId, callback);
    await expect(queries({ runTenantSnapshot: mismatchedRunner }).loadTaskCycleLedgerSnapshot())
      .resolves.toEqual({ assignments: [], completions: [] });
    await expect(queries({ runTenantSnapshot: mismatchedRunner }).getTaskCompletions())
      .resolves.toEqual([]);
  });

  it('rejects duplicate assignment event sequences after the uniqueness constraint is bypassed', async () => {
    await harness.database.exec('ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_event_sequence_unique');
    await seedAssignment({ assignmentId: 'A1', eventSequence: 1 });
    await seedAssignment({ assignmentId: 'A2', eventSequence: 1 });
    await expect(queries().loadTaskCycleLedgerSnapshot()).rejects.toThrow(/event sequence/i);
  });

  it('rejects duplicate completion event sequences before presentation', async () => {
    await harness.database.exec('ALTER TABLE task_completions DROP CONSTRAINT task_completions_event_sequence_unique');
    await seedCompletion({ completionId: 'C1', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z' });
    await seedCompletion({ completionId: 'C2', eventSequence: 1, completedAt: '2026-08-10T02:00:00.000Z' });
    await expect(queries().getTaskCompletions()).rejects.toThrow(/event sequence/i);
  });

  it('accepts a carry-forward assignment only from an earlier assigned cycle event', async () => {
    await seedAssignment({
      assignmentId: 'A-PREVIOUS', eventSequence: 1, cycleId: 'cycle-0',
      cycleStartAt: '2026-08-09T00:00:00.000Z', cycleEndAt: '2026-08-10T00:00:00.000Z',
    });
    await seedAssignment({
      assignmentId: 'A-CARRY', eventSequence: 2, source: 'CARRY_FORWARD',
      previousAssignmentId: 'A-PREVIOUS',
    });
    await expect(queries().loadTaskCycleLedgerSnapshot()).resolves.toMatchObject({
      assignments: [expect.objectContaining({ assignmentId: 'A-PREVIOUS' }), expect.objectContaining({
        assignmentId: 'A-CARRY', previousAssignmentId: 'A-PREVIOUS',
      })],
    });
  });

  it.each([
    ['missing previous assignment', async () => seedAssignment({ assignmentId: 'BAD', eventSequence: 1, source: 'CARRY_FORWARD' })],
    ['previous assignment on a non-carry event', async () => {
      await seedAssignment({ assignmentId: 'PREVIOUS', eventSequence: 1 });
      await seedAssignment({ assignmentId: 'BAD', eventSequence: 2, previousAssignmentId: 'PREVIOUS' });
    }],
    ['previous unassigned status', async () => {
      await seedAssignment({ assignmentId: 'PREVIOUS', eventSequence: 1, eventType: 'UNASSIGNED', cycleId: 'cycle-0', cycleStartAt: '2026-08-09T00:00:00.000Z', cycleEndAt: '2026-08-10T00:00:00.000Z' });
      await seedAssignment({ assignmentId: 'BAD', eventSequence: 2, source: 'CARRY_FORWARD', previousAssignmentId: 'PREVIOUS' });
    }],
    ['previous assignment has an open-ended cycle', async () => {
      await seedAssignment({
        assignmentId: 'PREVIOUS', eventSequence: 1, cycleId: 'cycle-0',
        cycleStartAt: '2026-08-09T00:00:00.000Z', cycleEndAt: null,
      });
      await seedAssignment({
        assignmentId: 'BAD', eventSequence: 2, source: 'CARRY_FORWARD',
        previousAssignmentId: 'PREVIOUS',
      });
    }],
    ['previous assignment in the same cycle', async () => {
      await seedAssignment({ assignmentId: 'PREVIOUS', eventSequence: 1 });
      await seedAssignment({ assignmentId: 'BAD', eventSequence: 2, source: 'CARRY_FORWARD', previousAssignmentId: 'PREVIOUS' });
    }],
    ['previous assignment for another student', async () => {
      await harness.database.exec('ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_student_fk');
      await seedAssignment({ assignmentId: 'PREVIOUS', eventSequence: 1, studentId: 'S2', cycleId: 'cycle-0', cycleStartAt: '2026-08-09T00:00:00.000Z', cycleEndAt: '2026-08-10T00:00:00.000Z' });
      await seedAssignment({ assignmentId: 'BAD', eventSequence: 2, source: 'CARRY_FORWARD', previousAssignmentId: 'PREVIOUS' });
    }],
    ['previous assignment for another task instance', async () => {
      await harness.database.exec('ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_task_fk');
      await seedAssignment({ assignmentId: 'PREVIOUS', eventSequence: 1, taskInstanceId: 'I2', cycleId: 'cycle-0', cycleStartAt: '2026-08-09T00:00:00.000Z', cycleEndAt: '2026-08-10T00:00:00.000Z' });
      await seedAssignment({ assignmentId: 'BAD', eventSequence: 2, source: 'CARRY_FORWARD', previousAssignmentId: 'PREVIOUS' });
    }],
  ])('rejects carry-forward provenance corruption: %s', async (_label, seed) => {
    await seed();
    await expect(queries().loadTaskCycleLedgerSnapshot()).rejects.toThrow(/assignment/i);
  });

  it.each([
    ['BANK without an assignment', async () => seedBankCompletion({ assignmentId: null })],
    ['completion assignment from another cycle', async () => {
      await seedAssignment({ assignmentId: 'A-BANK', eventSequence: 1, cycleId: 'cycle-0', cycleStartAt: '2026-08-09T00:00:00.000Z', cycleEndAt: '2026-08-10T00:00:00.000Z' });
      await seedBankCompletion();
    }],
    ['completion assignment with an unassigned status', async () => {
      await seedAssignment({ assignmentId: 'A-BANK', eventSequence: 1, eventType: 'UNASSIGNED' });
      await seedBankCompletion();
    }],
    ['completion assignment for another student', async () => {
      await harness.database.exec('ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_student_fk');
      await seedAssignment({ assignmentId: 'A-BANK', eventSequence: 1, studentId: 'S2' });
      await seedBankCompletion();
    }],
    ['completion assignment for another task instance', async () => {
      await harness.database.exec('ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_task_fk');
      await seedAssignment({ assignmentId: 'A-BANK', eventSequence: 1, taskInstanceId: 'I2' });
      await seedBankCompletion();
    }],
    ['ADMIN completion with an unresolved assignment', async () => {
      await harness.database.exec('ALTER TABLE task_completions DROP CONSTRAINT task_completions_assignment_fk');
      await seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', assignmentId: 'MISSING' });
    }],
  ])('rejects completion assignment provenance corruption: %s', async (_label, seed) => {
    await seed();
    await expect(queries().getTaskCompletions()).rejects.toThrow(/assignment/i);
  });

  it.each([
    ['BANK status', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ status: 'CANCELLED' }); }],
    ['BANK missing operation metadata', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ operationId: null, operationHash: null }); }],
    ['BANK noncanonical operation UUID', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ operationId: 'operation-1' }); }],
    ['BANK uppercase operation UUID', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ operationId: BANK_OPERATION_ID.toUpperCase() }); }],
    ['BANK noncanonical operation hash', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ operationHash: 'hash' }); }],
    ['BANK uppercase operation hash', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ operationHash: 'A'.repeat(64) }); }],
    ['BANK balance equation', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ balanceAfter: 14 }); }],
    ['BANK unsafe balance addition', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ balanceBefore: Number.MAX_SAFE_INTEGER, reward: 1, balanceAfter: Number.MAX_SAFE_INTEGER }); }],
    ['ADMIN status', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN', status: 'CANCELLED' })],
    ['ADMIN reward', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN', reward: 1, balanceAfter: 11 })],
    ['ADMIN balance', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN', balanceAfter: 11 })],
    ['ADMIN_RESET status', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN_RESET', status: 'COMPLETED' })],
    ['ADMIN_RESET reward', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN_RESET', status: 'CANCELLED', reward: 1 })],
    ['ADMIN_RESET balance', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN_RESET', status: 'CANCELLED', balanceAfter: 11 })],
    ['CARRY_FORWARD status', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'CARRY_FORWARD', status: 'CANCELLED' })],
    ['CARRY_FORWARD balance', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'CARRY_FORWARD', balanceAfter: 11 })],
  ])('rejects versioned completion invariant corruption: %s', async (_label, seed) => {
    await seed();
    await expect(queries().getTaskCompletions()).rejects.toThrow();
  });

  it('preserves legacy completion semantics without applying versioned writer shapes', async () => {
    await seedCompletion({ completionId: 'LEGACY', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', taskInstanceId: null, status: 'IMPORTED_SUCCESS', reward: 7, balanceBefore: 10, balanceAfter: 17 });
    await expect(queries().getTaskCompletions()).resolves.toEqual([
      expect.objectContaining({ completionId: 'LEGACY', status: 'IMPORTED_SUCCESS', reward: 7, balanceBefore: 10, balanceAfter: 17 }),
    ]);
  });

  it.each([
    ['ADMIN evidence', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T09:00:00.000Z', evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T00:30:00.000Z', '학생 하나'] })],
    ['legacy evidence', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T09:00:00.000Z', taskInstanceId: null, evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T00:30:00.000Z', '학생 하나'] })],
    ['ADMIN_RESET evidence', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T09:00:00.000Z', source: 'ADMIN_RESET', status: 'CANCELLED', evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T00:30:00.000Z', '학생 하나'] })],
    ['CARRY_FORWARD evidence', async () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T09:00:00.000Z', source: 'CARRY_FORWARD', evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T00:30:00.000Z', '학생 하나'] })],
    ['mismatched evidence author', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T00:30:00.000Z', '다른 학생'] }); }],
    ['evidence before cycle start', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-09T23:59:59.999Z', '학생 하나'] }); }],
    ['evidence at cycle end', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-11T00:00:00.000Z', '학생 하나'] }); }],
    ['evidence after completion', async () => { await seedCanonicalBankAssignment(); await seedBankCompletion({ evidence: ['PADLET', 'BOARD000000000001', 'post_123', '2026-08-10T09:00:00.001Z', '학생 하나'] }); }],
  ])('rejects evidence provenance corruption: %s', async (_label, seed) => {
    await seed();
    await expect(queries().getTaskCompletions()).rejects.toThrow(/evidence/i);
  });

  it.each([
    ['assignment schema version', 'ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_schema_version_check', () => seedAssignment({ assignmentId: 'BAD', eventSequence: 1, schemaVersion: 2 })],
    ['assignment event', 'ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_event_type_check', () => seedAssignment({ assignmentId: 'BAD', eventSequence: 1, eventType: 'assigned' })],
    ['assignment source', 'ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_source_check', () => seedAssignment({ assignmentId: 'BAD', eventSequence: 1, source: 'UNKNOWN' })],
    ['assignment timezone', 'ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_timezone_check', () => seedAssignment({ assignmentId: 'BAD', eventSequence: 1, timezone: 'UTC' })],
    ['unsafe assignment event sequence', 'ALTER TABLE task_assignments DROP CONSTRAINT task_assignments_event_sequence_unique', () => seedAssignment({ assignmentId: 'BAD', eventSequence: '9007199254740992' })],
  ])('rejects corrupted %s rows even when the database constraint is bypassed', async (_label, dropConstraint, seed) => {
    await harness.database.exec(dropConstraint);
    await seed();
    await expect(queries().loadTaskCycleLedgerSnapshot()).rejects.toThrow();
  });

  it.each([
    ['completion schema version', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_schema_version_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', schemaVersion: 2 })],
    ['partial cycle metadata', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_cycle_metadata_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: null })],
    ['completion timezone', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_timezone_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', timezone: 'UTC' })],
    ['completion source', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_source_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'UNKNOWN' })],
    ['operation pair', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_operation_pair_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', operationId: 'operation-only' })],
    ['operation source', 'SELECT 1', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'ADMIN', operationId: 'operation', operationHash: 'hash' })],
    ['evidence shape', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_evidence_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', evidence: ['PADLET', null, null, null, null] })],
    ['carry-forward reward', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_carry_forward_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', source: 'CARRY_FORWARD', reward: 1, balanceBefore: 10, balanceAfter: 11 })],
    ['unsafe completion money', 'ALTER TABLE task_completions DROP CONSTRAINT task_completions_reward_check', () => seedCompletion({ completionId: 'BAD', eventSequence: 1, completedAt: '2026-08-10T01:00:00.000Z', reward: '9007199254740992' })],
  ])('rejects corrupted %s rows even when the database constraint is bypassed', async (_label, dropConstraint, seed) => {
    await harness.database.exec(dropConstraint);
    await seed();
    await expect(queries().getTaskCompletions()).rejects.toThrow();
  });
});
