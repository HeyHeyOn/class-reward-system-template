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
      return dependencies.runTenantTransaction(dependencies.tenantId, (transaction) =>
        readDatabaseStudents(transaction, dependencies.tenantId));
    },

    async getStudentById(studentId: string): Promise<Student | null> {
      assertCanonicalStudentId(studentId);
      return dependencies.runTenantTransaction(dependencies.tenantId, async (transaction) => {
        const students = await readDatabaseStudents(transaction, dependencies.tenantId, studentId, false);
        if (students.length > 1) throw new Error('Student query returned duplicate rows.');
        return students[0] ?? null;
      });
    },
  };
}

export async function readDatabaseStudents(
  transaction: TenantTransaction,
  tenantId: string,
  studentId?: string,
  activeOnly = true,
): Promise<Student[]> {
  const result = await transaction.execute(sql`
    SELECT s.student_id, s.name, a.balance, s.status
    FROM students s
    LEFT JOIN accounts a
      ON a.tenant_id = s.tenant_id AND a.student_id = s.student_id
    WHERE s.tenant_id = ${tenantId}
      AND s.deleted_at IS NULL
      ${activeOnly ? sql`AND s.status = 'ACTIVE'` : sql``}
      ${studentId === undefined ? sql`` : sql`AND s.student_id = ${studentId}`}
  `);
  return (result.rows as StudentRow[])
    .map(toStudent)
    .sort(compareStudentsLikeSheets);
}

export async function readDatabaseActiveStudentIdentities(
  transaction: TenantTransaction,
  tenantId: string,
): Promise<ReadonlyArray<Readonly<{ studentId: string; name: string }>>> {
  const result = await transaction.execute(sql`
    SELECT student_id, name FROM students
    WHERE tenant_id = ${tenantId} AND status = 'ACTIVE' AND deleted_at IS NULL
    ORDER BY student_id
  `);
  return (result.rows as Array<Record<string, unknown>>).map((row) => {
    if (typeof row.student_id !== 'string' || !row.student_id
      || typeof row.name !== 'string' || !row.name) {
      throw new Error('Student identity integrity check failed.');
    }
    return { studentId: row.student_id, name: row.name };
  }).sort((left, right) => left.studentId.localeCompare(right.studentId, 'ko-KR', { numeric: true })
    || left.name.localeCompare(right.name));
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
