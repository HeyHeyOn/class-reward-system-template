// @vitest-environment node
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/server/db/transaction';
import { createTaskLedgerCommands } from './commands';
import type { RunTenantTransaction } from './migration';

vi.mock('server-only', () => ({}));

const TENANT = '20000000-0000-4000-8000-000000000001';
const NOW = '2030-01-01T00:59:59.123456Z';
const FROM = '2029-12-01T00:00:00.000000Z';

function fixture(withSnapshot = true) {
  const dialect = new PgDialect();
  const queries: Array<{ snapshot: number; sql: string; params: unknown[] }> = [];
  let snapshot = 0;
  const run: RunTenantTransaction = async (tenantId, callback) => {
    expect(tenantId).toBe(TENANT);
    const current = ++snapshot;
    const tx = { execute: async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      queries.push({ snapshot: current, ...query });
      if (query.sql.includes('AS ledger_from')) return { rows: [{ ledger_from: FROM }] };
      if (query.sql.includes('clock_timestamp()')) return { rows: [{ now: NOW }] };
      if (query.sql.includes('FROM task_ledger_checkpoints')) return { rows: [] };
      if (query.sql.includes('FROM tasks t')) return { rows: [{
        task_instance_id: 'synthetic-instance', task_id: 'T001', title: 'Synthetic task', description: '',
        reward: '0', is_active: true, sort_order: 0, available_from: null, due_at: null,
        prerequisite_task_instance_id: null, prerequisite_task_id: null, padlet_board_id: null,
        current_schedule: { ruleVersion: 1, effectiveFrom: FROM, timeZone: 'Asia/Seoul',
          recurrence: { type: 'DAILY', time: '10:00' }, resetStage: 'READY',
          resetAssignmentOnCycle: false, resetCompletionOnCycle: true },
        pending_schedule: null, created_at: FROM, updated_at: FROM, version: '1',
      }] };
      if (query.sql.includes('FROM students')) return { rows: [{ student_id: 'S1', name: 'Synthetic student', status: 'ACTIVE' }] };
      if (query.sql.includes('FROM task_assignments')) return { rows: [] };
      if (query.sql.includes('FROM task_padlet_links')) return { rows: [] };
      throw new Error('Unexpected synthetic query');
    } } as unknown as TenantTransaction;
    return callback(tx);
  };
  const runTenantTransaction = vi.fn(run);
  const runTenantSnapshot = vi.fn(run);
  const commands = createTaskLedgerCommands({ tenantId: TENANT, runTenantTransaction: runTenantTransaction as RunTenantTransaction,
    ...(withSnapshot ? { runTenantSnapshot: runTenantSnapshot as RunTenantTransaction } : {}) });
  return { commands, queries, runTenantTransaction, runTenantSnapshot };
}

describe('task ledger board snapshot', () => {
  it('uses one initialization check and one shared clock/data snapshot', async () => {
    const { commands, queries, runTenantTransaction, runTenantSnapshot } = fixture();
    const board = await commands.readBoard();
    expect(board.now).toBe('2030-01-01T00:59:59.123Z');
    expect(board.tasks).toHaveLength(1);
    expect(board.tasks[0].repeat.nextResetAt).toBe('2030-01-01T01:00:00.000Z');
    expect(board.tasks[0].students[0]).toMatchObject({ studentId: 'S1', stage: 'UNASSIGNED' });
    expect(board.tasks[0].padlet).toBeNull();
    expect(runTenantSnapshot).toHaveBeenCalledTimes(2);
    expect(runTenantTransaction).not.toHaveBeenCalled();
    expect(queries.filter(query => query.sql.includes('clock_timestamp()'))).toHaveLength(1);
    expect(queries[0]).toMatchObject({ snapshot: 1 });
    expect(queries.slice(1).every(query => query.snapshot === 2)).toBe(true);
  });

  it('preserves readTasks return shape and task filtering through the shared reader', async () => {
    const { commands, queries } = fixture();
    const tasks = await commands.readTasks(['T001']);
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks[0]).toMatchObject({ taskId: 'T001', title: 'Synthetic task' });
    const taskQuery = queries.find(query => query.sql.includes('FROM tasks t'))!;
    expect(taskQuery.sql).toContain('t.task_id IN');
    expect(taskQuery.params).toContain('T001');
  });

  it('keeps transaction-only callers compatible when no snapshot runner is supplied', async () => {
    const { commands, runTenantTransaction, runTenantSnapshot } = fixture(false);
    expect((await commands.readBoard()).tasks).toHaveLength(1);
    expect(runTenantTransaction).toHaveBeenCalledTimes(2);
    expect(runTenantSnapshot).not.toHaveBeenCalled();
  });
});
