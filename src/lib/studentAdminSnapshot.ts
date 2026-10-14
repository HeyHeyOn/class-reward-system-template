import type { Student } from '@/domain/types';

export type VersionedAdminStudent = Student & { studentVersion: number; accountVersion: number };
export type StudentAdminSnapshot =
  | { storage: 'postgresql'; students: VersionedAdminStudent[] }
  | { storage: 'sheets'; students: Student[] };

export function parseStudentAdminSnapshot(value: unknown): StudentAdminSnapshot {
  if (!value || typeof value !== 'object' || !('storage' in value) || !('students' in value)
    || (value.storage !== 'postgresql' && value.storage !== 'sheets') || !Array.isArray(value.students)) {
    throw new Error('학생 관리자 응답 형식이 올바르지 않아요.');
  }
  const seen = new Set<string>();
  for (const row of value.students) {
    if (!row || typeof row !== 'object' || typeof row.studentId !== 'string' || !row.studentId.trim()
      || seen.has(row.studentId) || typeof row.name !== 'string' || !row.name.trim()
      || !Number.isSafeInteger(row.balance) || !['ACTIVE', 'INACTIVE'].includes(row.status)
      || (value.storage === 'postgresql' && (!Number.isSafeInteger(row.studentVersion) || row.studentVersion < 1
        || !Number.isSafeInteger(row.accountVersion) || row.accountVersion < 1))) {
      throw new Error('학생 관리자 응답 형식이 올바르지 않아요.');
    }
    seen.add(row.studentId);
  }
  return value as StudentAdminSnapshot;
}
