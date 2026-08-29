import 'server-only';

import { sql } from 'drizzle-orm';
import type { Student, StudentStatus } from '@/domain/types';
import type { TenantTransaction } from '@/server/db/transaction';

type RunTenantTransaction = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type DatabaseStudentQueryDependencies = Readonly<{
  tenantId: string;
  runTenantTransaction: RunTenantTransaction;
}>;

type StudentRow = {
  student_id: string;
  name: string;
  balance: string | number | bigint | null;
  status: string;
};

export function createDatabaseStudentQueries(dependencies: DatabaseStudentQueryDependencies) {
  return {
    async getStudents(): Promise<Student[]> {
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT s.student_id, s.name, a.balance, s.status
          FROM students s
          LEFT JOIN accounts a
            ON a.tenant_id = s.tenant_id AND a.student_id = s.student_id
          WHERE s.tenant_id = ${dependencies.tenantId} AND s.status = 'ACTIVE'
        `);
        return (result.rows as StudentRow[])
          .map(toStudent)
          .sort(compareStudentsLikeSheets);
      });
    },

    async getStudentById(studentId: string): Promise<Student | null> {
      assertCanonicalStudentId(studentId);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const result = await transaction.execute(sql`
          SELECT s.student_id, s.name, a.balance, s.status
          FROM students s
          LEFT JOIN accounts a
            ON a.tenant_id = s.tenant_id AND a.student_id = s.student_id
          WHERE s.tenant_id = ${dependencies.tenantId} AND s.student_id = ${studentId}
        `);
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) throw new Error('Student query returned duplicate rows.');
        return toStudent(result.rows[0] as StudentRow);
      });
    },
  };
}

function assertCanonicalStudentId(studentId: string): void {
  if (!studentId || studentId.trim() !== studentId) {
    throw new Error('A canonical student ID is required.');
  }
}

function toStudent(row: StudentRow): Student {
  if (row.balance === null) {
    throw new Error('Student account integrity check failed.');
  }
  if (row.status !== 'ACTIVE' && row.status !== 'INACTIVE') {
    throw new Error('Student status is invalid.');
  }
  const balance = Number(row.balance);
  if (!Number.isSafeInteger(balance)) {
    throw new Error('Student balance is outside the safe integer range.');
  }
  return {
    studentId: row.student_id,
    name: row.name,
    balance,
    status: row.status as StudentStatus,
  };
}

function compareStudentsLikeSheets(left: Student, right: Student): number {
  return left.studentId.localeCompare(right.studentId, 'ko-KR', { numeric: true })
    || left.name.localeCompare(right.name);
}
