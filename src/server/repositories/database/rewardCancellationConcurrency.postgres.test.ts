// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/server/db/transaction';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createDatabaseTaskCompletionCommand } from './taskCompletionCommands';
import { createDatabaseTransactionCommands } from './transactionCommands';
import { createDatabaseAdminCommands } from './adminCommands';
import { createDatabasePadletClaimRepository } from './padletClaims';
import { createTaskLedgerCommands } from './taskLedger/commands';

vi.mock('server-only', () => ({}));
const suite = process.env.RUN_REAL_POSTGRES === '1' ? describe : describe.skip;
const A = 'e0400000-0000-4000-8000-000000000001';
const B = 'e0400000-0000-4000-8000-000000000002';
let pg: DisposablePostgres;
// Real clocks: the task ledger stamps tasks with the database clock.
const dependencies = (tenantId = A) => ({ tenantId, runTenantTransaction: pg.runTenantTransaction });
const reward = (tenantId = A) => createDatabaseTaskCompletionCommand({ ...dependencies(tenantId),
  padletClaims: createDatabasePadletClaimRepository(),
  // The post is as old as the task, the earliest instant a submission can count from.
  resolvePadletEvidence: async (request) => ({ evidenceProvider: 'PADLET' as const,
    evidenceBoardId: 'BOARD000000000001', evidencePostId: 'POST-1',
    evidenceCreatedAt: request.cycleStartsAt, evidenceAuthorFullName: 'Synthetic student' }),
});
const cancel = () => createDatabaseTransactionCommands(dependencies());
const input = () => ({ operationId: randomUUID(), taskId: 'T1', studentId: 'S1' });

const ledger = (tenantId = A) => createTaskLedgerCommands(dependencies(tenantId));

async function createTask(tenantId = A, padlet = false, taskId = 'T1') {
  return ledger(tenantId).createTask({
    operationId: randomUUID(),
    task: { title: 'Synthetic task', description: '', reward: 20, isActive: true, sortOrder: 0,
      availableFrom: null, dueAt: null, prerequisiteTaskId: null },
    repeat: { recurrence: { type: 'NONE' }, resetStage: null },
    students: [{ studentId: 'S1', stage: 'READY' }],
  }, { taskId, padletBoardId: padlet ? 'BOARD000000000001' : null });
}

// Keep both actual PostgreSQL connections waiting before releasing the task
// lock. Promise overlap alone would not establish a database race.
async function race<T>(start: () => Promise<T>[]) {
  const gate = await pg.owner.connect();
  let pending: Promise<PromiseSettledResult<T>>[] = [];
  try {
    await gate.query('BEGIN');
    await gate.query('SELECT * FROM tasks ORDER BY tenant_id,task_id FOR UPDATE');
    pending = start().map(p => p.then(value => ({ status: 'fulfilled' as const, value }),
      reason => ({ status: 'rejected' as const, reason })));
    const deadline = Date.now() + 10000;
    let pids: number[] = [];
    while (Date.now() < deadline) {
      pids = (await pg.owner.query("SELECT pid FROM pg_stat_activity WHERE usename='app_runtime' AND wait_event_type='Lock'")).rows.map(r => r.pid);
      if (new Set(pids).size >= pending.length) break;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    expect(new Set(pids).size).toBeGreaterThanOrEqual(pending.length);
    console.info('PILOT_REWARD_RACE', JSON.stringify({ blockedBackendPids: pids }));
    await gate.query('ROLLBACK');
    return await Promise.all(pending);
  } finally {
    await gate.query('ROLLBACK'); gate.release(); await Promise.all(pending);
  }
}

async function verifyLedger(tenantId = A) {
  const rows = (await pg.owner.query(`SELECT balance_before,balance_delta,balance_after FROM transactions
    WHERE tenant_id=$1 AND student_id='S1' ORDER BY event_sequence`, [tenantId])).rows;
  let balance = 100;
  for (const row of rows) {
    expect(Number(row.balance_before)).toBe(balance);
    balance += Number(row.balance_delta);
    expect(Number(row.balance_after)).toBe(balance);
  }
  expect(Number((await pg.owner.query("SELECT balance FROM accounts WHERE tenant_id=$1 AND student_id='S1'", [tenantId])).rows[0].balance)).toBe(balance);
  expect((await pg.owner.query("SELECT 1 FROM operations WHERE status='PENDING'")).rowCount).toBe(0);
  return balance;
}

suite('pilot native reward and cancellation races', () => {
  beforeEach(async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    pg = await createDisposablePostgres(); pg.runtime.options.max = 4;
    for (const tenant of [A, B]) {
      // Synthetic concurrency fixtures only; this is not migration activation.
      await pg.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1::uuid,$1::text,'Synthetic race','ACTIVE')", [tenant]);
      await pg.owner.query("INSERT INTO students(tenant_id,student_id,name,status) VALUES($1,'S1','Synthetic student','ACTIVE')", [tenant]);
      await pg.owner.query("INSERT INTO accounts(tenant_id,student_id,balance) VALUES($1,'S1',100)", [tenant]);
    }
  }, 60000);
  afterEach(async () => { if (pg) await pg.close(); }, 60000);

  it('concurrent identical reward requests and a later retry create one reward', async () => {
    await createTask(); const request = input();
    const replies = await race(() => [reward().execute(request), reward().execute(request)]);
    expect(replies.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(replies[0]).toEqual(replies[1]);
    expect(await reward().execute(request)).toEqual((replies[0] as PromiseFulfilledResult<unknown>).value);
    await expect(reward().execute({ ...request, payloadHash: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await verifyLedger()).toBe(120);
    expect((await pg.owner.query("SELECT 1 FROM transactions WHERE kind='TASK_REWARD'")).rowCount).toBe(1);
  }, 60000);

  it('two cancellation requests reclaim the reward once, allowing a negative balance', async () => {
    await createTask(); const first = await reward().execute(input());
    await createDatabaseAdminCommands(dependencies()).adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
    const requests = [0, 1].map(() => ({ operationId: randomUUID(), transactionId: first.transactionId }));
    const replies = await race(() => requests.map(r => cancel().cancel(r)));
    expect(replies.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(replies.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual(['ALREADY_REVERSED']);
    expect(await verifyLedger()).toBe(-15);
    expect((await pg.owner.query("SELECT 1 FROM transactions WHERE kind='CANCELLATION'")).rowCount).toBe(1);
    const [task] = await ledger().readTasks(['T1']);
    expect(task.students.find((row) => row.studentId === 'S1')?.stage).toBe('READY');
  }, 60000);

  it('different-task reward and cancellation on one account preserve the balance chain', async () => {
    await createTask(); const first = await reward().execute(input());
    await createTask(A, false, 'T2');
    await createDatabaseAdminCommands(dependencies()).adjust({ operationId: randomUUID(), studentIds: ['S1'], mode: 'set', amount: 5 });
    const replies = await race<unknown>(() => [
      cancel().cancel({ operationId: randomUUID(), transactionId: first.transactionId }),
      reward().execute({ ...input(), taskId: 'T2' }),
    ]);
    expect(replies.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await verifyLedger()).toBe(5);
    expect((await pg.owner.query("SELECT 1 FROM transactions WHERE kind='CANCELLATION'")).rowCount).toBe(1);
  }, 60000);

  it('the same Padlet post raced across classes rewards exactly one historical owner', async () => {
    await createTask(A, true); await createTask(B, true);
    const replies = await race(() => [reward(A).execute(input()), reward(B).execute(input())]);
    expect(replies.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(replies.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual(['EVIDENCE_CONFLICT']);
    expect((await pg.owner.query('SELECT 1 FROM padlet_evidence_claims')).rowCount).toBe(1);
    expect((await pg.owner.query("SELECT 1 FROM transactions WHERE kind='TASK_REWARD'")).rowCount).toBe(1);
    expect([await verifyLedger(A), await verifyLedger(B)].sort()).toEqual([100, 120]);
  }, 60000);

  it('a lost result after committed cancellation can be retried without another reversal', async () => {
    await createTask(); const first = await reward().execute(input());
    const request = { operationId: randomUUID(), transactionId: first.transactionId };
    let committed: unknown;
    let lost = false;
    // Lose only the reply of the transaction that committed the cancellation (earlier lookups pass).
    const loseAcknowledgement = async <T>(tenant: string, callback: (tx: TenantTransaction) => Promise<T>): Promise<T> => {
      const result = await pg.runTenantTransaction(tenant, callback);
      if (!lost && (await pg.owner.query("SELECT 1 FROM transactions WHERE kind='CANCELLATION'")).rowCount) {
        lost = true;
        committed = result;
        throw new Error('TEST_LOST_APPLICATION_RESPONSE_AFTER_COMMIT');
      }
      return result;
    };
    await expect(createDatabaseTransactionCommands({ tenantId: A, runTenantTransaction: loseAcknowledgement }).cancel(request))
      .rejects.toThrow('TEST_LOST_APPLICATION_RESPONSE_AFTER_COMMIT');
    expect(await cancel().cancel(request)).toEqual(committed);
    expect(await verifyLedger()).toBe(100);
    expect((await pg.owner.query("SELECT 1 FROM transactions WHERE kind='CANCELLATION'")).rowCount).toBe(1);
  }, 60000);
});
