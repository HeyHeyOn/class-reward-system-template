'use client';

import {
  parseStudentImportCommitResult,
  parseStudentImportPreview,
  type StudentImportCreated,
  type StudentImportRow,
} from '@/lib/bulkImport';
import { BulkImportControls, formatAmount, type BulkImportConfig, type BulkImportControlsProps } from './BulkImportControls';

const STUDENT_IMPORT: BulkImportConfig<StudentImportRow, StudentImportCreated> = {
  noun: '학생',
  countLabel: (count) => `${count}명`,
  successMessage: (count) => `학생 ${count}명을 추가했어요`,
  templatePath: '/api/students/import/template',
  previewPath: '/api/students/import/preview',
  commitPath: '/api/students/import/commit',
  templateFileName: '학생 명단 양식.xlsx',
  parsePreview: parseStudentImportPreview,
  parseCommit: parseStudentImportCommitResult,
  columns: (unit) => [
    { label: '학생 번호', render: (row) => <span className="font-semibold tabular-nums">{row.studentId}</span> },
    { label: '이름', render: (row) => <span className="font-bold">{row.name}</span> },
    {
      label: '처음 잔액',
      align: 'right',
      render: (row) => <span className={row.balance < 0 ? 'text-[var(--crs-danger-text)]' : undefined}>{formatAmount(row.balance, unit)}</span>,
    },
  ],
};

/** 학생 tab header controls: 양식 다운로드 + 엑셀로 일괄 추가 (preview → confirm dialog). */
export function StudentBulkImport(props: BulkImportControlsProps) {
  return <BulkImportControls config={STUDENT_IMPORT} {...props} />;
}
