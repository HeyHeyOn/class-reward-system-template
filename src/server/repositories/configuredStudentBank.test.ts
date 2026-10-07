// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { projectStudentBankTransactions } from '@/server/studentBankViews';
import { createConfiguredStudentBankReader, createStudentBankRepositoryCreators, type StudentBankReader } from './configuredStudentBank';
import { createDatabaseStudentQueries } from './database/studentQueries';
import { createDatabaseTransactionQueries } from './database/transactionQueries';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;

async function reader(tenantId: string): Promise<StudentBankReader> {
  return createConfiguredStudentBankReader({
    env: { CLASS_STORE_STORAGE: 'postgresql' },
    getCentralTenantContext: () => ({ tenantId, tenantStatus: 'ACTIVE' }),
    creators: createStudentBankRepositoryCreators({
      createDatabaseStudentQueries,
      createDatabaseTransactionQueries,
      withTenantSnapshot: harness.runTenantTransaction,
      createConfiguredSheetsReader: () => { throw new Error('No Sheets fallback'); },
      getTransactions: () => { throw new Error('No Sheets fallback'); },
      confirmStudentLookup: () => { throw new Error('No Sheets fallback'); },
    }),
  });
}

async function seedStudent(tenantId: string, studentId: string, name: string, status: 'ACTIVE' | 'INACTIVE', balance: number) {
  await harness.database.query('INSERT INTO students (tenant_id, student_id, name, status) VALUES ($1, $2, $3, $4)', [tenantId, studentId, name, status]);
  await harness.database.query('INSERT INTO accounts (tenant_id, student_id, balance) VALUES ($1, $2, $3)', [tenantId, studentId, balance]);
}

async function seedTransaction(tenantId: string, values: {
  id: string; at: string; studentId: string; kind: string; total: number; delta: number; before: number; operator: string; status: string;
}) {
  await harness.database.query(
    `INSERT INTO transactions
      (tenant_id, transaction_id, occurred_at, student_id, student_name_snapshot, kind,
       legacy_total_amount, balance_delta, balance_before, balance_after, operator_snapshot,
       legacy_status_snapshot, reverses_transaction_id, schema_version)
     VALUES ($1,$2,$3,$4,'학생',$5,$6,$7,$8,$9,$10,$11,NULL,1)`,
    [tenantId, values.id, values.at, values.studentId, values.kind, values.total, values.delta, values.before,
      values.before + values.delta, values.operator, values.status],
  );
}

beforeAll(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedStudent(harness.tenantOneId, 'S001', '김민준', 'ACTIVE', 105);
  await seedStudent(harness.tenantOneId, 'S002', '이서연', 'INACTIVE', 0);
  await seedStudent(harness.tenantTwoId, 'S001', '다른 반 학생', 'ACTIVE', 999);
  await seedTransaction(harness.tenantOneId, { id: 'GRANT', at: '2026-10-01T00:00:00.000Z', studentId: 'S001', kind: 'ADMIN_ADJUSTMENT', total: -100, delta: 100, before: 0, operator: 'admin', status: 'ADMIN_ADJUSTMENT' });
  await seedTransaction(harness.tenantOneId, { id: 'REWARD', at: '2026-10-02T00:00:00.000Z', studentId: 'S001', kind: 'TASK_REWARD', total: 5, delta: 5, before: 100, operator: 'bank-task-completion', status: 'COMPLETED' });
  await seedTransaction(harness.tenantOneId, { id: 'OTHER-STUDENT', at: '2026-10-03T00:00:00.000Z', studentId: 'S002', kind: 'ADMIN_ADJUSTMENT', total: -7, delta: 7, before: 0, operator: 'admin', status: 'ADMIN_ADJUSTMENT' });
  await seedTransaction(harness.tenantTwoId, { id: 'OTHER-CLASS', at: '2026-10-04T00:00:00.000Z', studentId: 'S001', kind: 'ADMIN_ADJUSTMENT', total: -999, delta: 999, before: 0, operator: 'admin', status: 'ADMIN_ADJUSTMENT' });
}, 60_000);

afterAll(async () => { await harness?.close(); });

describe('configured student bank reader (PostgreSQL)', () => {
  it('confirms active, inactive and unknown students within the class only', async () => {
    const classOne = await reader(harness.tenantOneId);
    await expect(classOne.confirmStudent('S001')).resolves.toEqual({
      status: 'FOUND', student: { studentId: 'S001', name: '김민준', balance: 105, status: 'ACTIVE' },
    });
    await expect(classOne.confirmStudent('S002')).resolves.toEqual({ status: 'INACTIVE' });
    await expect(classOne.confirmStudent('S404')).resolves.toEqual({ status: 'NOT_FOUND' });
    await expect((await reader(harness.tenantTwoId)).confirmStudent('S001')).resolves.toMatchObject({ student: { name: '다른 반 학생' } });
  });

  it('reads only the student\'s own rows of this class, newest first', async () => {
    const transactions = await (await reader(harness.tenantOneId)).getTransactions('S001');
    expect(transactions.map((transaction) => transaction.transactionId)).toEqual(['REWARD', 'GRANT']);
    expect(projectStudentBankTransactions(transactions, 'S001')).toEqual([
      { transactionId: 'REWARD', occurredAt: '2026-10-02T00:00:00.000Z', kind: 'TASK_REWARD', amount: 5, balanceAfter: 105, cancelled: false },
      { transactionId: 'GRANT', occurredAt: '2026-10-01T00:00:00.000Z', kind: 'TEACHER_GRANT', amount: 100, balanceAfter: 100, cancelled: false },
    ]);
  });
});
