import type { Student } from '@/domain/types';
import { createHeaderIndex, parseStudentRow } from '@/server/sheetsRows';
import type { TabularReader } from '@/server/storage/tabularStore';

export type ConfirmedStudentLookup =
  | { status: 'FOUND'; student: Student }
  | { status: 'NOT_FOUND' }
  | { status: 'INACTIVE' }
  | { status: 'UNAVAILABLE' };

type SnapshotStudentLookup = ConfirmedStudentLookup;

export async function confirmStudentLookup(
  reader: TabularReader,
  studentId: string,
): Promise<ConfirmedStudentLookup> {
  const first = classifyStudentRows(await reader.getRows('Students'), studentId);
  if (first.status === 'FOUND') return first;

  const freshRows = reader.getRowsFresh
    ? await reader.getRowsFresh('Students')
    : await reader.getRows('Students');
  const second = classifyStudentRows(freshRows, studentId);
  if (second.status === 'FOUND') return second;
  if (first.status === second.status && (second.status === 'NOT_FOUND' || second.status === 'INACTIVE')) {
    return second;
  }
  return { status: 'UNAVAILABLE' };
}

function classifyStudentRows(rows: string[][], studentId: string): SnapshotStudentLookup {
  const [headers, ...dataRows] = rows;
  if (!headers) return { status: 'UNAVAILABLE' };
  const headerIndex = createHeaderIndex(headers);
  const studentIdIndex = headerIndex.get('studentId');
  if (studentIdIndex === undefined) return { status: 'UNAVAILABLE' };

  const row = dataRows.find((candidate) => (candidate[studentIdIndex] ?? '').trim() === studentId);
  if (!row) return { status: 'NOT_FOUND' };
  const student = parseStudentRow(row, headerIndex);
  if (!student) return { status: 'UNAVAILABLE' };
  if (student.status !== 'ACTIVE') return { status: 'INACTIVE' };
  return { status: 'FOUND', student };
}
