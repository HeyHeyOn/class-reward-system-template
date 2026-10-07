import type { Student } from '@/domain/types';
import { tenantApiPath } from '@/lib/tenantApiPath';
import { parseStudentAdminSnapshot } from '@/lib/studentAdminSnapshot';
import type { NewStudentDraft } from './adminTypes';
import { isRecord } from './adminResponse';

export function studentEditorPath(): string {
  return tenantApiPath('/api/students') === '/api/students' ? '/api/students' : '/api/students?includeInactive=1';
}

export function studentEditorSnapshot(value: unknown) {
  // Legacy unscoped Sheets keeps its existing array contract. Scoped central
  // editors require the authorized envelope with preconditions on the same row.
  return studentEditorPath() === '/api/students'
    ? { storage: 'sheets' as const, students: value as Student[] }
    : parseStudentAdminSnapshot(value);
}

export function isCreatedStudent(value: unknown, expected: NewStudentDraft): value is Student {
  if (!isRecord(value) || Object.keys(value).length !== 4) return false;
  return value.studentId === expected.studentId.trim()
    && value.name === expected.name.trim()
    && value.balance === expected.balance
    && value.status === expected.status;
}
