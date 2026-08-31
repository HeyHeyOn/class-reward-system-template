import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { SQLWrapper } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  materializeTaskNaturalCycleInternal,
  taskNaturalAssignmentMaterializationId,
} from './taskCycleMaterialization';

vi.mock('server-only', () => ({}));

const TENANT = 'tenant';
const TASK_ID = 'TASK-NATURAL';
const INSTANCE = 'natural-instance';
const STUDENT = 'S001';
const NOW = new Date('2026-08-31T01:00:00.000Z');
const PRIOR_START = new Date('2026-08-30T00:00:00.000Z');
const CURRENT_START = new Date('2026-08-31T00:00:00.000Z');
const CURRENT_END = new Date('2026-09-01T00:00:00.000Z');
const priorCycleId = `v1|${INSTANCE}|r1|2026-08-30T00:00:00Z`;
const currentCycleId = `v1|${INSTANCE}|r1|2026-08-31T00:00:00Z`;

const assignment = (overrides: Record<string, unknown> = {}) => ({
  assignment_id: 'prior-assignment', event_sequence: '1', cycle_id: priorCycleId,
  cycle_start_at: PRIOR_START, cycle_end_at: CURRENT_START, rule_version: 1,
  timezone: 'Asia/Seoul', student_id: STUDENT, event_type: 'ASSIGNED',
  source: 'ADMIN', ...overrides,
});
const completion = (overrides: Record<string, unknown> = {}) => ({
  completion_id: 'prior-completion', event_sequence: '1', cycle_id: priorCycleId,
  cycle_start_at: PRIOR_START, cycle_end_at: CURRENT_START, rule_version: 1,
  timezone: 'Asia/Seoul', student_id: STUDENT, student_name_snapshot: 'Student one',
  task_name_snapshot: 'Natural task', status: 'COMPLETED', source: 'ADMIN',
  reward_snapshot: '25', balance_after: '125', assignment_id: 'prior-assignment',
  ...overrides,
});

type Captured = Readonly<{ statement: string; params: readonly unknown[] }>;
function fakeTx(input: Readonly<{
  mirrors?: string[];
  assignments?: Record<string, unknown>[];
  completions?: Record<string, unknown>[];
}> = {}) {
  const dialect = new PgDialect();
  const mirrors = [...(input.mirrors ?? [STUDENT])];
  const assignments = [...(input.assignments ?? [assignment()])];
  const completions = [...(input.completions ?? [completion()])];
  const writes: Captured[] = [];
  const tx = { execute: async (wrapper: SQLWrapper) => {
    const query = dialect.sqlToQuery(wrapper.getSQL());
    const statement = query.sql.toLowerCase().replace(/\s+/g, ' ').trim();
    if (statement.startsWith('select task_instance_id, task_id from tasks')) {
      return { rows: [{ task_instance_id: INSTANCE, task_id: TASK_ID }] };
    }
    if (statement.startsWith('select student_id from task_allowed_students')) {
      return { rows: mirrors.map((student_id) => ({ student_id })) };
    }
    if (statement.startsWith('select assignment_id,')) return { rows: assignments };
    if (statement.startsWith('select completion_id,')) return { rows: completions };
    if (statement.startsWith('delete from task_allowed_students')) {
      writes.push({ statement, params: query.params });
      const index = mirrors.indexOf(query.params[2] as string);
      if (index >= 0) mirrors.splice(index, 1);
      return { rows: [] };
    }
    if (statement.startsWith('insert into task_assignments')) {
      writes.push({ statement, params: query.params });
      assignments.push(assignment({
        assignment_id: query.params[1], event_sequence: String(assignments.length + 1),
        cycle_id: query.params[4], cycle_start_at: query.params[5], cycle_end_at: query.params[6],
        rule_version: query.params[7], source: 'CARRY_FORWARD',
        previous_assignment_id: query.params[9],
      }));
      return { rows: [{ assignment_id: query.params[1] }] };
    }
    if (statement.startsWith('insert into task_completions')) {
      writes.push({ statement, params: query.params });
      completions.push(completion({
        completion_id: query.params[1], event_sequence: String(completions.length + 1),
        cycle_id: query.params[10], cycle_start_at: query.params[11], cycle_end_at: query.params[12],
        rule_version: query.params[13], source: 'CARRY_FORWARD', reward_snapshot: '0',
        balance_after: String(query.params[9]), assignment_id: query.params[14],
      }));
      return { rows: [{ completion_id: query.params[1] }] };
    }
    throw new Error(`unexpected statement: ${statement}`);
  } } as unknown as TenantTransaction;
  return { tx, mirrors, assignments, completions, writes };
}

function invoke(tx: TenantTransaction, flags: Readonly<{
  resetAssignmentOnCycle: boolean;
  resetCompletionOnCycle: boolean;
}>, isAvailable = true) {
  return materializeTaskNaturalCycleInternal({
    tx, tenantId: TENANT, taskId: TASK_ID, taskInstanceId: INSTANCE,
    taskTitle: 'Natural task', schedule: {
      ruleVersion: 1, effectiveFrom: '2026-08-29T00:00:00.000Z',
      recurrence: { type: 'DAILY' }, ...flags,
    },
    cycle: { cycleId: currentCycleId, startsAt: CURRENT_START.toISOString(),
      endsAt: CURRENT_END.toISOString(), nextResetAt: CURRENT_END.toISOString() },
    isAvailable, now: NOW,
  });
}

function deterministicId(domain: string, prefix: string) {
  const digest = createHash('sha256').update(JSON.stringify({ domain,
    source: 'CARRY_FORWARD', taskInstanceId: INSTANCE, cycleId: currentCycleId,
    studentId: STUDENT }), 'utf8').digest('hex');
  return `${prefix}:${digest}`;
}

describe('natural task-cycle materialization', () => {
  it('resets assignment without carrying completion or resurrecting its mirror', async () => {
    const fake = fakeTx();
    const result = await invoke(fake.tx, {
      resetAssignmentOnCycle: true, resetCompletionOnCycle: false,
    });
    expect(result).toEqual({ assignmentEventIds: [], completionEventIds: [] });
    expect(fake.mirrors).toEqual([]);
    expect(fake.writes.filter((write) => write.statement.startsWith('insert'))).toEqual([]);
  });

  it('carries assignment but not completion when only completion resets', async () => {
    const fake = fakeTx();
    const result = await invoke(fake.tx, {
      resetAssignmentOnCycle: false, resetCompletionOnCycle: true,
    });
    expect(result.assignmentEventIds).toEqual([
      taskNaturalAssignmentMaterializationId(INSTANCE, currentCycleId, STUDENT),
    ]);
    expect(result.completionEventIds).toEqual([]);
    expect(fake.mirrors).toEqual([STUDENT]);
  });

  it('carries writer-compatible assignment and successful completion once with no balance change', async () => {
    const fake = fakeTx();
    const flags = { resetAssignmentOnCycle: false, resetCompletionOnCycle: false };
    const first = await invoke(fake.tx, flags);
    expect(first).toEqual({
      assignmentEventIds: [deterministicId('task-assignment-materialization-v1',
        'task-assignment-materialization')],
      completionEventIds: [deterministicId('task-completion-materialization-v1',
        'task-completion-materialization')],
    });
    const assignmentWrite = fake.writes.find((write) =>
      write.statement.startsWith('insert into task_assignments'))!;
    expect(assignmentWrite.statement).toContain("'assigned', 'carry_forward'");
    expect(assignmentWrite.params.slice(2, 10)).toEqual([
      TASK_ID, INSTANCE, currentCycleId, CURRENT_START, CURRENT_END, 1, STUDENT,
      'prior-assignment',
    ]);
    const completionWrite = fake.writes.find((write) =>
      write.statement.startsWith('insert into task_completions'))!;
    expect(completionWrite.statement).toContain("0,");
    expect(completionWrite.statement).toContain("'completed'");
    expect(completionWrite.statement).toContain("'carry_forward'");
    expect(completionWrite.params[8]).toBe(125);
    expect(completionWrite.params[9]).toBe(125);
    expect(completionWrite.params[14]).toBe(first.assignmentEventIds[0]);

    await expect(invoke(fake.tx, flags)).resolves.toEqual({
      assignmentEventIds: [], completionEventIds: [],
    });
    expect(fake.writes.filter((write) => write.statement.startsWith('insert into task_assignments')))
      .toHaveLength(1);
    expect(fake.writes.filter((write) => write.statement.startsWith('insert into task_completions')))
      .toHaveLength(1);
  });

  it('does not resurrect a removed student or any assignment for an unavailable task', async () => {
    const removed = fakeTx({ mirrors: [] });
    await expect(invoke(removed.tx, {
      resetAssignmentOnCycle: false, resetCompletionOnCycle: false,
    })).resolves.toEqual({ assignmentEventIds: [], completionEventIds: [] });
    expect(removed.writes).toEqual([]);

    const unavailable = fakeTx();
    await expect(invoke(unavailable.tx, {
      resetAssignmentOnCycle: false, resetCompletionOnCycle: false,
    }, false)).resolves.toEqual({ assignmentEventIds: [], completionEventIds: [] });
    expect(unavailable.writes.some((write) => write.statement.startsWith('insert'))).toBe(false);
  });

  it('does not carry completion from an older assignment in the immediate cycle', async () => {
    const latest = assignment({ assignment_id: 'latest-assignment', event_sequence: '3' });
    const fake = fakeTx({ assignments: [assignment(), latest], completions: [completion()] });
    const result = await invoke(fake.tx, {
      resetAssignmentOnCycle: false, resetCompletionOnCycle: false,
    });
    expect(result.assignmentEventIds).toHaveLength(1);
    expect(result.completionEventIds).toEqual([]);
    expect(fake.writes.filter((write) => write.statement.startsWith('insert into task_completions')))
      .toEqual([]);
  });

  it('uses only the exact immediately preceding effective cycle instead of stale global success', async () => {
    const staleStart = new Date('2026-08-29T00:00:00.000Z');
    const staleEnd = new Date('2026-08-30T00:00:00.000Z');
    const staleCycleId = `v1|${INSTANCE}|r1|2026-08-29T00:00:00Z`;
    const fake = fakeTx({ assignments: [assignment({ cycle_id: staleCycleId,
      cycle_start_at: staleStart, cycle_end_at: staleEnd })], completions: [completion({
      cycle_id: staleCycleId, cycle_start_at: staleStart, cycle_end_at: staleEnd,
    })] });
    await expect(invoke(fake.tx, {
      resetAssignmentOnCycle: false, resetCompletionOnCycle: false,
    })).resolves.toEqual({ assignmentEventIds: [], completionEventIds: [] });
    expect(fake.writes).toEqual([]);
  });
});
