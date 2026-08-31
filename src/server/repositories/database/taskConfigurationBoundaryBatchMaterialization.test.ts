import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDatabaseTaskAdminCommands } from './taskAdminCommands';
import {
  materializeTaskConfigurationBoundaryCyclesInternal,
  type TaskConfigurationBoundaryMaterializationTarget,
} from './taskCycleMaterialization';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const CREATED_AT = new Date('2026-08-30T01:00:00.000Z');
const NOW = new Date('2026-08-30T02:00:00.000Z');
const HASH = 'b'.repeat(64);
let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await harness.database.exec(await readFile(resolve(
    process.cwd(), 'src/server/db/migrations/0010_task_admin_invariants.sql',
  ), 'utf8'));
  await harness.database.query(`INSERT INTO students
    (tenant_id, student_id, name, status, created_at, updated_at)
    VALUES ($1, 'S001', 'Student one', 'ACTIVE', $2, $2)`,
  [harness.tenantOneId, CREATED_AT.toISOString()]);
});

afterEach(async () => harness.close());

type Captured = Readonly<{ statement: string; params: readonly unknown[] }>;

async function seedTargets(count: number, completedIndexes = new Set<number>()) {
  const admin = createDatabaseTaskAdminCommands({ tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction, now: () => CREATED_AT });
  const targets: TaskConfigurationBoundaryMaterializationTarget[] = [];
  for (let index = 0; index < count; index += 1) {
    const taskId = `TASK-BATCH-${String(index).padStart(2, '0')}`;
    const created = await admin.create({ operationId: `create-${taskId}`, taskId,
      title: taskId, description: '', reward: 1, isActive: true, sortOrder: index,
      allowedStudentIds: ['S001'], schedule: { recurrence: { type: 'DAILY', time: '09:00' },
        timeZone: 'Asia/Seoul', resetCompletionOnCycle: true, resetAssignmentOnCycle: true } });
    const taskInstanceId = created.tasks[0].taskInstanceId;
    const assignment = (await harness.database.query(`SELECT assignment_id, cycle_id,
      cycle_start_at, cycle_end_at, rule_version FROM task_assignments
      WHERE tenant_id=$1 AND task_instance_id=$2 ORDER BY event_sequence DESC LIMIT 1`,
    [harness.tenantOneId, taskInstanceId])).rows[0] as Record<string, unknown>;
    if (completedIndexes.has(index)) {
      const operationId = `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await harness.database.query(`INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
         attempt_count, started_at, finished_at, created_at, updated_at)
        VALUES ($1, $2, 'TASK_ADMIN', $3, 'SUCCEEDED', '{}'::jsonb, 1, $4, $4, $4, $4)`,
      [harness.tenantOneId, operationId, HASH, '2026-08-30T01:30:00.000Z']);
      await harness.database.query(`INSERT INTO task_completions
        (tenant_id, completion_id, completed_at, task_instance_id, task_id_snapshot,
         task_name_snapshot, student_id, student_name_snapshot, reward_snapshot,
         balance_before, balance_after, status, note, cycle_id, cycle_start_at, cycle_end_at,
         rule_version, timezone, source, assignment_id, transaction_id, operation_id,
         operation_hash, admin_operation_id, admin_operation_hash, schema_version,
         evidence_provider, evidence_board_id, evidence_post_id, evidence_created_at,
         evidence_author_full_name, created_at)
        VALUES ($1, $2, $3, $4, $5, $5, 'S001', 'Student one', 0, 10, 10,
         'COMPLETED', NULL, $6, $7, $8, $9, 'Asia/Seoul', 'ADMIN', $10,
         NULL, NULL, NULL, $11, $12, 1, NULL, NULL, NULL, NULL, NULL, $3)`,
      [harness.tenantOneId, `completion-${index}`, '2026-08-30T01:30:00.000Z',
        taskInstanceId, taskId, assignment.cycle_id, assignment.cycle_start_at,
        assignment.cycle_end_at, assignment.rule_version, assignment.assignment_id,
        operationId, HASH]);
    }
    const newStart = NOW.toISOString().replace('.000Z', 'Z');
    targets.push({ taskId, taskInstanceId,
      oldCycle: { cycleId: assignment.cycle_id as string,
        startsAt: (assignment.cycle_start_at as Date).toISOString(),
        endsAt: (assignment.cycle_end_at as Date).toISOString(),
        nextResetAt: (assignment.cycle_end_at as Date).toISOString() },
      oldRuleVersion: assignment.rule_version as number,
      newCycle: { cycleId: `v1|${taskInstanceId}|r2|${newStart.replace('.000Z', 'Z')}`,
        startsAt: newStart, endsAt: '2026-08-31T02:00:00.000Z',
        nextResetAt: '2026-08-31T02:00:00.000Z' },
      newRuleVersion: 2, timeZone: 'Asia/Seoul', now: NOW });
  }
  return targets;
}

function classify(statement: string) {
  if (statement.startsWith('select task_instance_id, student_id, created_at from task_allowed_students')) return 'mirror-read';
  if (statement.startsWith('select assignment_id,') && statement.includes('(task_instance_id, cycle_id) in')) return 'assignment-verify';
  if (statement.startsWith('select completion_id,') && statement.includes('(task_instance_id, cycle_id) in')) return 'completion-verify';
  if (statement.startsWith('select assignment_id,') && statement.includes('from task_assignments')) return 'assignment-read';
  if (statement.startsWith('select completion_id,') && statement.includes('from task_completions')) return 'completion-read';
  if (statement.startsWith('with recursive') || (statement.startsWith('select transaction_id,')
    && statement.includes('from transactions'))) return 'transaction-reference-read';
  if (statement.startsWith('select operation_id, operation_kind, payload_hash from operations')) return 'operation-reference-read';
  if (statement.startsWith('insert into task_assignments')) return 'assignment-insert';
  if (statement.startsWith('insert into task_completions')) return 'completion-insert';
  return `other:${statement}`;
}

async function run(targets: readonly TaskConfigurationBoundaryMaterializationTarget[],
  mutate?: (statement: string, result: { rows: unknown[] }) => { rows: unknown[] }) {
  const captured: Captured[] = []; const dialect = new PgDialect();
  const result = await harness.runTenantTransaction(harness.tenantOneId, async (transaction) => {
    const tx = { ...transaction, execute: async (wrapper: SQLWrapper) => {
      const query = dialect.sqlToQuery(wrapper.getSQL());
      const statement = query.sql.toLowerCase().replace(/\s+/g, ' ').trim();
      captured.push({ statement, params: query.params });
      const actual = await transaction.execute(wrapper) as { rows: unknown[] };
      return mutate?.(statement, actual) ?? actual;
    } } as unknown as TenantTransaction;
    return materializeTaskConfigurationBoundaryCyclesInternal({
      tx, tenantId: harness.tenantOneId, targets,
    });
  });
  return { result, captured };
}

describe('set-wise configuration-boundary task materialization', () => {
  it('materializes valid B1 assignment and B2 completion provenance for one target', async () => {
    const targets = await seedTargets(1, new Set([0]));
    const { result } = await run(targets);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ taskId: targets[0].taskId,
      taskInstanceId: targets[0].taskInstanceId });
    expect(result[0].assignmentEventIds).toHaveLength(1);
    expect(result[0].completionEventIds).toHaveLength(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result[0])).toBe(true);
  });

  it('uses the same constant set-wise query classifier for one and twenty targets', async () => {
    const one = await run(await seedTargets(1, new Set([0])));
    await harness.close();
    harness = await createPgliteDatabaseHarness();
    await harness.database.exec(await readFile(resolve(
      process.cwd(), 'src/server/db/migrations/0010_task_admin_invariants.sql',
    ), 'utf8'));
    await harness.database.query(`INSERT INTO students
      (tenant_id, student_id, name, status, created_at, updated_at)
      VALUES ($1, 'S001', 'Student one', 'ACTIVE', $2, $2)`,
    [harness.tenantOneId, CREATED_AT.toISOString()]);
    const twenty = await run(await seedTargets(20, new Set([0, 19])));
    const categories = (items: readonly Captured[]) => items.map((item) => classify(item.statement));
    expect(categories(one.captured)).toEqual(categories(twenty.captured));
    expect(categories(twenty.captured)).toEqual([
      'mirror-read', 'assignment-read', 'completion-read', 'operation-reference-read',
      'assignment-insert', 'completion-insert', 'assignment-verify', 'completion-verify',
    ]);
    expect(twenty.result).toHaveLength(20);
  });

  it('rolls back every earlier write when later-target completion RETURNING evidence is corrupted', async () => {
    const targets = await seedTargets(2, new Set([0, 1]));
    let corrupted = false;
    await expect(run(targets, (statement, result) => {
      if (!corrupted && statement.startsWith('insert into task_completions')) {
        corrupted = true;
        const rows = result.rows.map((row) => ({ ...(row as Record<string, unknown>) }));
        (rows.at(-1) as Record<string, unknown>).completion_id = 'wrong-later-completion';
        return { rows };
      }
      return result;
    })).rejects.toThrow(/completion insert.*integrity/i);
    expect(corrupted).toBe(true);
    const assignments = await harness.database.query(`SELECT assignment_id FROM task_assignments
      WHERE tenant_id=$1 AND source='CARRY_FORWARD'`, [harness.tenantOneId]);
    const completions = await harness.database.query(`SELECT completion_id FROM task_completions
      WHERE tenant_id=$1 AND source='CARRY_FORWARD'`, [harness.tenantOneId]);
    expect(assignments.rows).toEqual([]);
    expect(completions.rows).toEqual([]);
  });
});
