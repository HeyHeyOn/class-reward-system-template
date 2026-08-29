import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseStudentQueries,
  type DatabaseStudentQueryDependencies,
} from '@/server/repositories/database/studentQueries';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';
import { getStudents as getSheetStudents, type SheetsReader } from '@/server/sheetsRepository';

vi.mock('server-only', () => ({}));

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
  await seedStudent(harness.tenantOneId, 'S10', '십번', 1000, 'ACTIVE');
  await seedStudent(harness.tenantOneId, 'S2', '이번', -50, 'ACTIVE');
  await seedStudent(harness.tenantOneId, 'S1', '비활성', 300, 'INACTIVE');
  await seedStudent(harness.tenantTwoId, 'S0', '다른 반', 9999, 'ACTIVE');
});

afterEach(async () => {
  await harness?.close();
});

function queries(overrides: Partial<DatabaseStudentQueryDependencies> = {}) {
  return createDatabaseStudentQueries({
    tenantId: harness.tenantOneId,
    runTenantTransaction: harness.runTenantTransaction,
    ...overrides,
  });
}

async function seedStudent(
  tenantId: string,
  studentId: string,
  name: string,
  balance: number,
  status: 'ACTIVE' | 'INACTIVE',
) {
  await harness.database.query(
    `INSERT INTO students (tenant_id, student_id, name, status)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, studentId, name, status],
  );
  await harness.database.query(
    `INSERT INTO accounts (tenant_id, student_id, balance)
     VALUES ($1, $2, $3)`,
    [tenantId, studentId, balance],
  );
}

describe('database student queries', () => {
  it('matches the Sheets active-student projection and numeric ID ordering', async () => {
    const sheetReader: SheetsReader = {
      getRows: async (sheetName) => sheetName === 'Students' ? [
        ['studentId', 'name', 'balance', 'status'],
        ['S10', '십번', '1000', 'ACTIVE'],
        ['S2', '이번', '-50', 'ACTIVE'],
        ['S1', '비활성', '300', 'INACTIVE'],
      ] : [],
    };
    const expected = await getSheetStudents(sheetReader);

    await expect(queries().getStudents()).resolves.toEqual(expected);
    expect(expected).toEqual([
      { studentId: 'S2', name: '이번', balance: -50, status: 'ACTIVE' },
      { studentId: 'S10', name: '십번', balance: 1000, status: 'ACTIVE' },
    ]);
  });

  it('returns an inactive student by exact ID without exposing another tenant', async () => {
    await expect(queries().getStudentById('S1')).resolves.toEqual({
      studentId: 'S1',
      name: '비활성',
      balance: 300,
      status: 'INACTIVE',
    });
    await expect(queries().getStudentById('S0')).resolves.toBeNull();
  });

  it('hides a tombstoned student from active lists and exact lookup while preserving its row', async () => {
    await harness.database.query(
      `UPDATE students
       SET status='INACTIVE', deleted_at=now(), version=version+1
       WHERE tenant_id=$1 AND student_id='S10'`,
      [harness.tenantOneId],
    );

    await expect(queries().getStudents()).resolves.not.toContainEqual(
      expect.objectContaining({ studentId: 'S10' }),
    );
    await expect(queries().getStudentById('S10')).resolves.toBeNull();
    const preserved = await harness.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM students
       WHERE tenant_id=$1 AND student_id='S10'`,
      [harness.tenantOneId],
    );
    expect(preserved.rows).toEqual([{ count: '1' }]);
  });

  it('fails closed instead of hiding a student whose account row is missing', async () => {
    await harness.database.query(
      'DELETE FROM accounts WHERE tenant_id=$1 AND student_id=$2',
      [harness.tenantOneId, 'S10'],
    );

    await expect(queries().getStudents()).rejects.toThrow(/account|integrity/i);
    await expect(queries().getStudentById('S10')).rejects.toThrow(/account|integrity/i);
  });

  it('rejects non-canonical student IDs before opening a transaction', async () => {
    let transactionOpened = false;
    const runTenantTransaction: DatabaseStudentQueryDependencies['runTenantTransaction'] = <TResult>() => {
      transactionOpened = true;
      return Promise.reject(new Error('unexpected transaction')) as Promise<TResult>;
    };
    await expect(queries({ runTenantTransaction }).getStudentById(' S2')).rejects.toThrow(/student id/i);
    expect(transactionOpened).toBe(false);
  });
});
