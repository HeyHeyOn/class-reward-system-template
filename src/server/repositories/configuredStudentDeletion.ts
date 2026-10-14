import 'server-only';

import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/repositories/sheets/lazy';
import { deleteStudent, deleteStudentsBatch } from '@/server/repositories/sheets/lazy';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { parseStorageSelection } from './context';
import { createDatabaseStudentCommands, StudentAdminConflictError, StudentAdminRefusalError } from './database/studentCommands';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class StudentDeletionRequestError extends Error {
  constructor() {
    super('학생 삭제 요청 형식이 올바르지 않아요. 새로고침 후 다시 시도해 주세요.');
    this.name = 'StudentDeletionRequestError';
  }
}

/**
 * Deletes students. A Sheets class removes the rows, as before. A PostgreSQL class keeps the row
 * (and every transaction and task event that names the student) and marks it deleted: INACTIVE
 * plus deleted_at, checked against the version the teacher saw, under one operation ID.
 */
export async function createConfiguredStudentDeletion(request?: Request): Promise<{
  /** Body: PostgreSQL `{ operationId, expectedStudentVersion }`; Sheets needs none. */
  delete(studentId: string, body: unknown): Promise<{ studentId: string }>;
  /** Body: PostgreSQL `{ operationId, students: [{ studentId, expectedStudentVersion }] }`; Sheets `{ studentIds }`. */
  deleteBatch(body: unknown): Promise<{ studentIds: string[] }>;
}> {
  const context = getOptionalTrustedTenantRequestContext();
  // PG authority is never supplied by body/query/header OR a deployment tenant env.
  const authority = parseStorageSelection(
    { CLASS_STORE_STORAGE: context ? 'postgresql' : (process.env.CLASS_STORE_STORAGE ?? 'sheets') },
    context ? { tenantId: context.tenant.id, tenantStatus: context.tenant.lifecycle } : undefined,
  );
  const database = () => {
    if (authority.storage !== 'postgresql') throw new Error('PostgreSQL authority is required.');
    return createDatabaseStudentCommands({ tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction });
  };
  return {
    async delete(studentId, body) {
      if (!studentId.trim() || studentId.trim() !== studentId) throw new StudentDeletionRequestError();
      if (authority.storage !== 'postgresql') return deleteStudent(await createConfiguredSheetsStore(request), studentId);
      const input = parseVersioned(body, ['operationId', 'expectedStudentVersion']);
      if (!isVersion(input.expectedStudentVersion)) throw new StudentDeletionRequestError();
      await database().deactivate({ operationId: input.operationId as string, studentId,
        expectedStudentVersion: input.expectedStudentVersion });
      return { studentId };
    },
    async deleteBatch(body) {
      if (authority.storage !== 'postgresql') {
        const studentIds = isRecord(body) && Array.isArray(body.studentIds) ? body.studentIds.map((id: unknown) => String(id)) : [];
        return deleteStudentsBatch(await createConfiguredSheetsStore(request), studentIds);
      }
      const input = parseVersioned(body, ['operationId', 'students']);
      if (!Array.isArray(input.students) || input.students.length === 0) throw new StudentDeletionRequestError();
      const students = input.students.map((row: unknown) => {
        if (!isRecord(row) || Object.keys(row).sort().join('|') !== 'expectedStudentVersion|studentId'
          || typeof row.studentId !== 'string' || !row.studentId.trim() || row.studentId.trim() !== row.studentId
          || !isVersion(row.expectedStudentVersion)) throw new StudentDeletionRequestError();
        return { studentId: row.studentId, expectedStudentVersion: row.expectedStudentVersion };
      });
      if (new Set(students.map((row) => row.studentId)).size !== students.length) throw new StudentDeletionRequestError();
      await database().deactivateBatch({ operationId: input.operationId as string, students });
      return { studentIds: students.map((row) => row.studentId) };
    },
  };
}

function parseVersioned(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(body) || Object.keys(body).sort().join('|') !== [...keys].sort().join('|')
    || typeof body.operationId !== 'string' || !UUID.test(body.operationId)) throw new StudentDeletionRequestError();
  return body;
}

function isVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The response for a failed deletion; every PostgreSQL refusal tells the teacher what to do, in Korean. */
export function studentDeletionFailure(error: unknown): Response {
  if (error instanceof StudentDeletionRequestError) {
    return Response.json({ error: error.message, code: 'INVALID_REQUEST' }, { status: 400 });
  }
  if (error instanceof StudentAdminConflictError) {
    return Response.json({ error: '학생 정보가 그사이 바뀌었어요. 학생 목록을 새로 불러온 뒤 다시 삭제해 주세요.', code: error.code }, { status: 409 });
  }
  if (error instanceof StudentAdminRefusalError) {
    return Response.json({ error: error.message, code: error.code }, { status: 404 });
  }
  if (!getOptionalTrustedTenantRequestContext()) {
    // Sheets keeps its own messages, as before.
    return Response.json({ error: error instanceof Error ? error.message : '학생을 삭제하지 못했어요.' }, { status: 400 });
  }
  console.error('[student-deletion] unexpected failure', error instanceof Error ? error.message : 'unknown');
  return Response.json({ error: '학생을 삭제하지 못했어요. 잠시 뒤 다시 시도해 주세요.' }, { status: 500 });
}

/** The optional JSON body of a DELETE (Sheets requests send none). */
export async function readStudentDeletionBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StudentDeletionRequestError();
  }
}
