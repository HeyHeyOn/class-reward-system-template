import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskCompletionEvidence } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import {
  createDatabaseTaskCompletionCommand,
  createTaskRewardPayloadHash,
  TaskRewardCommandError,
  type DatabaseTaskCompletionCommandDependencies,
} from './taskCompletionCommands';
import { createDatabasePadletClaimRepository } from './padletClaims';

vi.mock('server-only', () => ({}));

const NOW = new Date('2026-08-28T03:00:00.000Z');
const STUDENT_ID = 'S001';
const TASK_ID = 'TASK-1';
const TASK_INSTANCE_ID = 'INSTANCE-1';
const BOARD_ID = 'BOARD000000000001';
const OPERATION_ID = '10000000-0000-4000-8000-000000000001';
const EVIDENCE: TaskCompletionEvidence = {
  evidenceProvider: 'PADLET',
  evidenceBoardId: BOARD_ID,
  evidencePostId: 'POST-1',
  evidenceCreatedAt: '2026-08-28T02:00:00.000Z',
  evidenceAuthorFullName: '김민준',
};

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedTenant(harness.tenantOneId);
});

afterEach(async () => {
  await harness?.close();
});

function command(overrides: Partial<DatabaseTaskCompletionCommandDependencies> = {}) {
  return createDatabaseTaskCompletionCommand({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    padletClaims: createDatabasePadletClaimRepository(),
    resolvePadletEvidence: vi.fn().mockResolvedValue(EVIDENCE),
    now: () => NOW,
    ...overrides,
  });
}

async function seedTenant(
  tenantId: string,
  options: { padlet?: boolean; studentName?: string; operationSuffix?: string } = {},
) {
  const suffix = options.operationSuffix ?? '';
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status)
     VALUES ($1, $2, $3, 'ACTIVE')`,
    [tenantId, `${STUDENT_ID}${suffix}`, options.studentName ?? '김민준'],
  );
  await harness.database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance)
     VALUES ($1, $2, 100)`,
    [tenantId, `${STUDENT_ID}${suffix}`],
  );
  await harness.database.query(
    `INSERT INTO tasks
      (tenant_id, task_instance_id, task_id, title, description, reward, is_active,
       sort_order, padlet_board_id, current_schedule, schedule_schema_version,
       created_at, updated_at)
     VALUES ($1, $2, $3, '과제', '설명', 50, true, 1, $4, $5::jsonb, 1, $6, $6)`,
    [
      tenantId,
      `${TASK_INSTANCE_ID}${suffix}`,
      `${TASK_ID}${suffix}`,
      options.padlet === false ? null : BOARD_ID,
      JSON.stringify({
        ruleVersion: 1,
        effectiveFrom: '2026-08-28T00:00:00.000Z',
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '09:00' },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: true,
      }),
      '2026-08-28T00:00:00.000Z',
    ],
  );
  await harness.database.query(
    `INSERT INTO task_allowed_students (tenant_id, task_instance_id, student_id)
     VALUES ($1, $2, $3)`,
    [tenantId, `${TASK_INSTANCE_ID}${suffix}`, `${STUDENT_ID}${suffix}`],
  );
  await harness.database.query(
    `INSERT INTO task_assignments
      (tenant_id, assignment_id, task_id_snapshot, task_instance_id, cycle_id,
       cycle_start_at, cycle_end_at, rule_version, timezone, student_id,
       event_type, source, schema_version, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'Asia/Seoul', $8,
             'ASSIGNED', 'ADMIN', 1, $6)`,
    [
      tenantId,
      `ASSIGNMENT-1${suffix}`,
      `${TASK_ID}${suffix}`,
      `${TASK_INSTANCE_ID}${suffix}`,
      `v1|${TASK_INSTANCE_ID}${suffix}|r1|2026-08-28T00:00:00Z`,
      '2026-08-28T00:00:00.000Z',
      '2026-08-29T00:00:00.000Z',
      `${STUDENT_ID}${suffix}`,
    ],
  );
}

async function snapshot(tenantId = harness.tenantOneId, studentId = STUDENT_ID) {
  const [account, transactions, completions, operations, claims, audits] = await Promise.all([
    harness.database.query(`SELECT balance::text, version::text FROM accounts WHERE tenant_id=$1 AND student_id=$2`, [tenantId, studentId]),
    harness.database.query(`SELECT *, legacy_total_amount::text AS legacy_total_amount,
      balance_delta::text AS balance_delta, balance_before::text AS balance_before,
      balance_after::text AS balance_after
      FROM transactions WHERE tenant_id=$1 ORDER BY transaction_id`, [tenantId]),
    harness.database.query(`SELECT *, reward_snapshot::text AS reward_snapshot,
      balance_before::text AS balance_before, balance_after::text AS balance_after
      FROM task_completions WHERE tenant_id=$1 ORDER BY completion_id`, [tenantId]),
    harness.database.query(`SELECT * FROM operations WHERE tenant_id=$1 ORDER BY operation_id`, [tenantId]),
    harness.database.query(`SELECT * FROM padlet_evidence_claims ORDER BY board_id, post_id`),
    harness.database.query(`SELECT * FROM audit_events WHERE tenant_id=$1 ORDER BY event_id`, [tenantId]),
  ]);
  return {
    account: account.rows,
    transactions: transactions.rows,
    completions: completions.rows,
    operations: operations.rows,
    claims: claims.rows,
    audits: audits.rows,
  };
}

describe('database task completion command', () => {
  it('atomically rewards, snapshots completion/evidence, globally claims, and stores exact success', async () => {
    const result = await command().execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });

    expect(result).toEqual({
      ok: true,
      operationId: OPERATION_ID,
      taskId: TASK_ID,
      taskInstanceId: TASK_INSTANCE_ID,
      taskTitle: '과제',
      studentId: STUDENT_ID,
      studentName: '김민준',
      reward: 50,
      balanceBefore: 100,
      balanceAfter: 150,
      cycleId: `v1|${TASK_INSTANCE_ID}|r1|2026-08-28T00:00:00Z`,
      transactionId: `task-reward:${OPERATION_ID}`,
      completionId: `task-completion:${OPERATION_ID}`,
      evidence: EVIDENCE,
    });
    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '150', version: '2' }]);
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({
      kind: 'TASK_REWARD', student_name_snapshot: '김민준',
      legacy_total_amount: '50', balance_delta: '50', balance_before: '100', balance_after: '150',
      operation_id: OPERATION_ID,
    });
    expect(state.completions).toHaveLength(1);
    expect(state.completions[0]).toMatchObject({
      task_id_snapshot: TASK_ID, task_name_snapshot: '과제', student_name_snapshot: '김민준',
      reward_snapshot: '50', status: 'COMPLETED', source: 'BANK', assignment_id: 'ASSIGNMENT-1',
      evidence_provider: 'PADLET', evidence_board_id: BOARD_ID, evidence_post_id: 'POST-1',
      evidence_author_full_name: '김민준', operation_id: OPERATION_ID,
    });
    expect(state.claims).toHaveLength(1);
    expect(state.claims[0]).toMatchObject({
      provider: 'PADLET', board_id: BOARD_ID, post_id: 'POST-1',
      claimed_by_tenant_id: harness.tenantOneId, claimed_by_operation_id: OPERATION_ID,
      evidence_author_full_name: '김민준',
    });
    expect(state.operations).toHaveLength(1);
    expect(state.operations[0]).toMatchObject({
      operation_kind: 'TASK_REWARD', status: 'SUCCEEDED', result_snapshot: result,
      payload_hash: createTaskRewardPayloadHash({
        taskId: TASK_ID, taskInstanceId: TASK_INSTANCE_ID, taskTitle: '과제',
        studentId: STUDENT_ID, studentName: '김민준', assignmentId: 'ASSIGNMENT-1',
        cycleId: result.cycleId, cycleStartsAt: '2026-08-28T00:00:00Z',
        cycleEndsAt: '2026-08-29T00:00:00Z', reward: 50, evidence: EVIDENCE,
      }),
    });
    expect(state.audits).toEqual([
      expect.objectContaining({
        operation_id: OPERATION_ID,
        event_type: 'TASK_REWARD_COMPLETED',
        entity_type: 'TASK_COMPLETION',
        entity_id: `task-completion:${OPERATION_ID}`,
        redacted_details: {
          cycleId: `v1|${TASK_INSTANCE_ID}|r1|2026-08-28T00:00:00Z`,
          reward: 50,
          studentId: STUDENT_ID,
          taskId: TASK_ID,
          taskInstanceId: TASK_INSTANCE_ID,
          transactionId: `task-reward:${OPERATION_ID}`,
        },
        occurred_at: NOW,
      }),
    ]);
  });

  it('returns the exact stored result on retry without another provider call or mutation', async () => {
    const resolvePadletEvidence = vi.fn().mockResolvedValue(EVIDENCE);
    const taskCommand = command({ resolvePadletEvidence });
    const first = await taskCommand.execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });
    const second = await taskCommand.execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });

    expect(second).toEqual(first);
    expect(resolvePadletEvidence).toHaveBeenCalledOnce();
    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '150', version: '2' }]);
    expect(state.transactions).toHaveLength(1);
    expect(state.completions).toHaveLength(1);
    expect(state.claims).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it.each([
    ['missing', `DELETE FROM audit_events WHERE tenant_id=$1 AND operation_id=$2`],
    ['corrupt', `UPDATE audit_events SET redacted_details=jsonb_build_object('taskId', 'forged') WHERE tenant_id=$1 AND operation_id=$2`],
  ])('rejects exact replay when the task reward audit is %s', async (_label, mutation) => {
    const taskCommand = command();
    await taskCommand.execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });
    await harness.database.query(`ALTER TABLE audit_events DISABLE TRIGGER USER`);
    try {
      await harness.database.query(mutation, [harness.tenantOneId, OPERATION_ID]);
    } finally {
      await harness.database.query(`ALTER TABLE audit_events ENABLE TRIGGER USER`);
    }

    await expect(taskCommand.execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID,
    })).rejects.toThrow(/audit integrity/i);
    expect((await snapshot()).transactions).toHaveLength(1);
  });

  it('rejects a different payload for a completed operation without appending an audit', async () => {
    const taskCommand = command();
    await taskCommand.execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });
    const before = await snapshot();

    await expect(taskCommand.execute({
      operationId: OPERATION_ID,
      taskId: TASK_ID,
      studentId: STUDENT_ID,
      payloadHash: 'b'.repeat(64),
    })).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['transaction operation ID', `UPDATE transactions SET operation_id='other-operation' WHERE tenant_id=$1 AND transaction_id=$2`],
    ['completion source', `UPDATE task_completions SET source='ADMIN' WHERE tenant_id=$1 AND transaction_id=$2`],
    ['transaction legacy status', `UPDATE transactions SET legacy_status_snapshot='PENDING' WHERE tenant_id=$1 AND transaction_id=$2`],
    ['transaction legacy total', `UPDATE transactions SET legacy_total_amount=49 WHERE tenant_id=$1 AND transaction_id=$2`],
    ['transaction student name', `UPDATE transactions SET student_name_snapshot='다른 이름' WHERE tenant_id=$1 AND transaction_id=$2`],
  ])('rejects replay when immutable %s does not match the reward operation', async (_label, mutation) => {
    const resolvePadletEvidence = vi.fn().mockResolvedValue(EVIDENCE);
    const taskCommand = command({ resolvePadletEvidence });
    await taskCommand.execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });
    await harness.withImmutableLedgerTampering(() => harness.database.query(
      mutation,
      [harness.tenantOneId, `task-reward:${OPERATION_ID}`],
    ));

    await expect(taskCommand.execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID,
    })).rejects.toThrow(/stored|snapshot|binding/i);
    expect(resolvePadletEvidence).toHaveBeenCalledOnce();
  });

  it('rejects a pre-seeded succeeded result without matching immutable reward snapshots', async () => {
    const result = {
      ok: true,
      operationId: OPERATION_ID,
      taskId: TASK_ID,
      taskInstanceId: 'FORGED-INSTANCE',
      taskTitle: '과제',
      studentId: STUDENT_ID,
      studentName: '김민준',
      reward: 50,
      balanceBefore: 100,
      balanceAfter: 150,
      cycleId: 'forged-cycle',
      transactionId: `task-reward:${OPERATION_ID}`,
      completionId: `task-completion:${OPERATION_ID}`,
      evidence: EVIDENCE,
    };
    await harness.database.query(
      `INSERT INTO operations
        (tenant_id, operation_id, operation_kind, payload_hash, status, result_snapshot,
         attempt_count, started_at, finished_at, created_at, updated_at)
       VALUES ($1, $2, 'TASK_REWARD', $3, 'SUCCEEDED', $4::jsonb,
               1, $5, $5, $5, $5)`,
      [harness.tenantOneId, OPERATION_ID, 'a'.repeat(64), JSON.stringify(result), NOW.toISOString()],
    );

    await expect(command().execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID }))
      .rejects.toThrow(/stored|snapshot|binding/i);
  });

  it('performs obvious authorization before provider resolution and leaves no partial operation', async () => {
    await harness.database.query(`UPDATE students SET status='INACTIVE' WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, STUDENT_ID]);
    const resolvePadletEvidence = vi.fn().mockResolvedValue(EVIDENCE);

    await expect(command({ resolvePadletEvidence }).execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID }))
      .rejects.toMatchObject({ code: 'POLICY' });
    expect(resolvePadletEvidence).not.toHaveBeenCalled();
    expect((await snapshot()).operations).toHaveLength(0);
  });

  it('leaves no mutation when the provider fails', async () => {
    const before = await snapshot();
    const providerFailure = new Error('provider credential detail');

    const thrown = await command({ resolvePadletEvidence: vi.fn().mockRejectedValue(providerFailure) })
      .execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID })
      .catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(TaskRewardCommandError);
    expect(thrown).toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(JSON.stringify(thrown)).not.toContain('credential');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects expanded provider evidence before hashing or opening the write transaction', async () => {
    const before = await snapshot();
    const expanded = { ...EVIDENCE, body: 'private provider detail' } as TaskCompletionEvidence;

    await expect(command({ resolvePadletEvidence: vi.fn().mockResolvedValue(expanded) }).execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID,
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await snapshot()).toEqual(before);
  });

  it('hashes semantically identical evidence independently of property insertion order', () => {
    const reordered = {
      evidenceAuthorFullName: EVIDENCE.evidenceAuthorFullName,
      evidenceCreatedAt: EVIDENCE.evidenceCreatedAt,
      evidencePostId: EVIDENCE.evidencePostId,
      evidenceBoardId: EVIDENCE.evidenceBoardId,
      evidenceProvider: EVIDENCE.evidenceProvider,
    } as TaskCompletionEvidence;
    const payload = {
      taskId: TASK_ID, taskInstanceId: TASK_INSTANCE_ID, taskTitle: '과제',
      studentId: STUDENT_ID, studentName: '김민준', assignmentId: 'ASSIGNMENT-1',
      cycleId: `v1|${TASK_INSTANCE_ID}|r1|2026-08-28T00:00:00Z`,
      cycleStartsAt: '2026-08-28T00:00:00Z', cycleEndsAt: '2026-08-29T00:00:00Z',
      reward: 50,
    };
    expect(createTaskRewardPayloadHash({ ...payload, evidence: reordered }))
      .toBe(createTaskRewardPayloadHash({ ...payload, evidence: EVIDENCE }));
  });

  it('fails closed when authoritative board/student/cycle state drifts after provider allocation', async () => {
    const resolvePadletEvidence = vi.fn(async () => {
      await harness.database.query(`UPDATE students SET name='다른 이름' WHERE tenant_id=$1 AND student_id=$2`, [harness.tenantOneId, STUDENT_ID]);
      return EVIDENCE;
    });

    await expect(command({ resolvePadletEvidence }).execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '100', version: '1' }]);
    expect(state.transactions).toHaveLength(0);
    expect(state.completions).toHaveLength(0);
    expect(state.operations).toHaveLength(0);
    expect(state.claims).toHaveLength(0);
  });

  it('fails closed when current allowed-student membership is removed after assignment', async () => {
    await harness.database.query(
      `DELETE FROM task_allowed_students WHERE tenant_id=$1 AND task_instance_id=$2 AND student_id=$3`,
      [harness.tenantOneId, TASK_INSTANCE_ID, STUDENT_ID],
    );
    const resolvePadletEvidence = vi.fn().mockResolvedValue(EVIDENCE);

    await expect(command({ resolvePadletEvidence }).execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID,
    })).rejects.toMatchObject({ code: 'POLICY' });
    expect(resolvePadletEvidence).not.toHaveBeenCalled();
    expect((await snapshot()).operations).toHaveLength(0);
  });

  it('rewards an ordinary non-Padlet task without provider or claim behavior', async () => {
    await harness.database.query(`UPDATE tasks SET padlet_board_id=NULL WHERE tenant_id=$1 AND task_instance_id=$2`, [harness.tenantOneId, TASK_INSTANCE_ID]);
    const resolvePadletEvidence = vi.fn();

    const result = await command({ resolvePadletEvidence }).execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });

    expect(result.ok).toBe(true);
    expect(result.evidence).toBeUndefined();
    expect(resolvePadletEvidence).not.toHaveBeenCalled();
    expect((await snapshot()).claims).toHaveLength(0);
  });

  it('uses the same captured now for a newly effective pending schedule and provider allocation', async () => {
    await harness.database.query(
      `UPDATE tasks SET pending_schedule=$3::jsonb
       WHERE tenant_id=$1 AND task_instance_id=$2`,
      [harness.tenantOneId, TASK_INSTANCE_ID, JSON.stringify({
        ruleVersion: 2,
        effectiveFrom: NOW.toISOString(),
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'DAILY', time: '09:00' },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: true,
      })],
    );
    const resolvePadletEvidence = vi.fn().mockResolvedValue({
      ...EVIDENCE,
      evidenceCreatedAt: NOW.toISOString(),
    });

    const result = await command({ resolvePadletEvidence }).execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID,
    });

    expect(resolvePadletEvidence).toHaveBeenCalledWith(expect.objectContaining({
      now: NOW.toISOString(),
      cycleId: `v1|${TASK_INSTANCE_ID}|r2|${NOW.toISOString().replace('.000Z', 'Z')}`,
      cycleStartsAt: NOW.toISOString().replace('.000Z', 'Z'),
    }));
    expect(result.cycleId).toBe(`v1|${TASK_INSTANCE_ID}|r2|${NOW.toISOString().replace('.000Z', 'Z')}`);
    expect((await snapshot()).completions[0]).toMatchObject({ rule_version: 2 });
  });

  it('uses a serialized PGlite fallback so one global board/post rewards exactly once across tenants', async () => {
    await seedTenant(harness.tenantTwoId, { operationSuffix: '-TWO' });
    const secondOperation = '10000000-0000-4000-8000-000000000002';
    const second = createDatabaseTaskCompletionCommand({
      tenantId: harness.tenantTwoId,
      runTenantTransaction: harness.runTenantTransaction,
      padletClaims: createDatabasePadletClaimRepository(),
      resolvePadletEvidence: vi.fn().mockResolvedValue(EVIDENCE),
      now: () => NOW,
    });

    const firstResult = await command().execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID });
    const secondError = await second.execute({ operationId: secondOperation, taskId: `${TASK_ID}-TWO`, studentId: `${STUDENT_ID}-TWO` })
      .catch((error: unknown) => error);

    expect(firstResult.ok).toBe(true);
    expect(secondError).toMatchObject({ code: 'EVIDENCE_CONFLICT' });
    expect((await snapshot(harness.tenantTwoId, `${STUDENT_ID}-TWO`)).account).toEqual([{ balance: '100', version: '1' }]);
    expect((await snapshot()).claims).toHaveLength(1);
  });

  it('checks irreversible legacy tuple digest tombstones through the shared registry', async () => {
    const tupleDigest = createHash('sha256').update(BOARD_ID).update('\0').update(EVIDENCE.evidencePostId).digest('hex');
    await harness.database.query(
      `INSERT INTO padlet_claim_digest_tombstones (tuple_digest, source_provenance)
       VALUES ($1, 'legacy-v1')`,
      [tupleDigest],
    );

    await expect(command().execute({ operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID }))
      .rejects.toMatchObject({ code: 'EVIDENCE_CONFLICT' });
    const state = await snapshot();
    expect(state.account).toEqual([{ balance: '100', version: '1' }]);
    expect(state.operations).toHaveLength(0);
    expect(state.transactions).toHaveLength(0);
  });

  it.each([
    ['malformed operation UUID', { operationId: 'not-a-uuid' }],
    ['noncanonical operation UUID', { operationId: 'A0000000-0000-4000-8000-000000000001' }],
    ['malformed supplied hash', { payloadHash: 'bad' }],
  ])('rejects %s before acquiring tenant transaction authority', async (_label, override) => {
    const calls = vi.fn();
    const runTenantTransaction: DatabaseTaskCompletionCommandDependencies['runTenantTransaction'] = async (tenantId, callback) => {
      calls();
      return harness.runTenantTransaction(tenantId, callback);
    };

    await expect(command({ runTenantTransaction }).execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID, ...override,
    })).rejects.toThrow(/operation|hash/i);
    expect(calls).not.toHaveBeenCalled();
  });

  it('rolls back account, ledgers, operation, and claim after an injected mid-mutation failure', async () => {
    const before = await snapshot();
    await expect(command({
      afterAccountUpdate: vi.fn().mockRejectedValue(new Error('injected')),
    }).execute({
      operationId: OPERATION_ID, taskId: TASK_ID, studentId: STUDENT_ID,
    })).rejects.toThrow('injected');
    expect(await snapshot()).toEqual(before);
  });

  it('recognizes a known claim constraint through a code-only wrapper', async () => {
    const repository = createDatabasePadletClaimRepository();
    const transaction = {
      execute: vi.fn().mockRejectedValue({
        code: '23505',
        cause: {
          code: '23505',
          constraint: 'padlet_claim_digest_registry_pkey',
        },
      }),
    } as unknown as TenantTransaction;

    await expect(repository.claim(transaction, {
      tenantId: harness.tenantOneId,
      operationId: OPERATION_ID,
      evidence: EVIDENCE,
      claimedAt: NOW,
    })).resolves.toBe('CONFLICT');
  });

  it('propagates unrelated unique violations from the global claim statement', async () => {
    const repository = createDatabasePadletClaimRepository();
    const transaction = {
      execute: vi.fn().mockRejectedValue({
        code: '23505',
        constraint: 'unrelated_unique_constraint',
      }),
    } as unknown as TenantTransaction;

    await expect(repository.claim(transaction, {
      tenantId: harness.tenantOneId,
      operationId: OPERATION_ID,
      evidence: EVIDENCE,
      claimedAt: NOW,
    })).rejects.toMatchObject({ constraint: 'unrelated_unique_constraint' });
  });

  it('contains deterministic PostgreSQL lock ordering and atomic global claim SQL', async () => {
    const [commandSource, claimSource] = await Promise.all([
      readFile(resolve(process.cwd(), 'src/server/repositories/database/taskCompletionCommands.ts'), 'utf8'),
      readFile(resolve(process.cwd(), 'src/server/repositories/database/padletClaims.ts'), 'utf8'),
    ]);

    expect(commandSource).toMatch(/LOCK ORDER/);
    expect(commandSource).toMatch(/FROM operations[\s\S]*FOR UPDATE/);
    expect(commandSource).toMatch(/ORDER BY task_instance_id[\s\S]*FOR UPDATE/);
    expect(commandSource).toMatch(/FOR UPDATE OF s, a/);
    expect(commandSource).toMatch(/ORDER BY event_sequence[\s\S]*FOR UPDATE/);
    expect(claimSource).toMatch(/INSERT INTO padlet_evidence_claims/);
    expect(claimSource).toMatch(/tuple_digest/);
  });
});
