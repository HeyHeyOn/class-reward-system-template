import 'server-only';

import type { Student } from '@/domain/types';
import type { VersionedAdminStudent } from '@/lib/studentAdminSnapshot';
import { withTenantTransaction } from '@/server/db/transaction';
import { createConfiguredSheetsStore } from '@/server/repositories/sheets/lazy';
import { updateStudentDetailsBatchWithBalanceTransactions } from '@/server/repositories/sheets/lazy';
import type { StudentEditorUpdate } from '@/server/sheetsRepository';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { parseStorageSelection } from './context';
import { createDatabaseStudentCommands, type UpdateStudentAdminBatchInput } from './database/studentCommands';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS = ['studentId', 'name', 'balance', 'status'];
const VERSIONS = ['expectedStudentVersion', 'expectedAccountVersion'];

export async function createConfiguredStudentMutation(request?: Request): Promise<{
  updateBatch(input: unknown): Promise<Array<Student | VersionedAdminStudent>>;
}> {
  const context = getOptionalTrustedTenantRequestContext();
  // PG authority is never supplied by body/query/header OR a deployment tenant env.
  const authority = parseStorageSelection(
    { CLASS_STORE_STORAGE: context ? 'postgresql' : (process.env.CLASS_STORE_STORAGE ?? 'sheets') },
    context ? { tenantId: context.tenant.id, tenantStatus: context.tenant.lifecycle } : undefined,
  );
  return {
    async updateBatch(input) {
      validateBatch(input, authority.storage);
      if (authority.storage === 'postgresql') {
        const result = await createDatabaseStudentCommands({
          tenantId: authority.tenantId, runTenantTransaction: withTenantTransaction,
        }).updateBatch(input as unknown as UpdateStudentAdminBatchInput);
        return result.students.map((student) => ({
          studentId: student.studentId, name: student.name, balance: student.balance, status: student.status,
          studentVersion: student.studentVersionAfter, accountVersion: student.accountVersionAfter,
        }));
      }
      // Deliberately retains the existing omitted-balance and Sheets atomic-batch behavior.
      return updateStudentDetailsBatchWithBalanceTransactions(
        await createConfiguredSheetsStore(request), input.students as StudentEditorUpdate[], input.operationId,
      );
    },
  };
}

function validateBatch(input: unknown, storage: 'postgresql' | 'sheets'): asserts input is {
  operationId: string; students: Record<string, unknown>[];
} {
  const invalid = () => new Error('올바른 학생 명단 저장 요청이 아닙니다.');
  if (!isRecord(input) || Object.keys(input).sort().join('|') !== 'operationId|students'
    || typeof input.operationId !== 'string' || !UUID.test(input.operationId) || !Array.isArray(input.students)) throw invalid();
  const allowed = storage === 'postgresql' ? [...KEYS, ...VERSIONS] : KEYS;
  for (const row of input.students) {
    if (!isRecord(row) || Object.keys(row).some((key) => !allowed.includes(key))
      || typeof row.studentId !== 'string' || typeof row.name !== 'string'
      || (row.status !== 'ACTIVE' && row.status !== 'INACTIVE')
      || (Object.hasOwn(row, 'balance') && !Number.isSafeInteger(row.balance))) throw invalid();
    if (storage === 'postgresql' && (!row.studentId.trim() || !row.name.trim() || !Number.isSafeInteger(row.balance)
      || VERSIONS.some((key) => !Number.isSafeInteger(row[key]) || Number(row[key]) < 1))) throw invalid();
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
