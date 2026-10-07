import 'server-only';

import {
  BULK_IMPORT_MAX_ROWS,
  BULK_IMPORT_TEXT_LIMITS,
  isCanonicalOperationId,
  type BulkImportCommitRequest,
  type BulkImportIssue,
  type StudentImportPreview,
  type StudentImportRow,
} from '@/lib/bulkImport';
import { checkPlainText, readInteger, readText } from './cells';
import { fileNotices, hasExactKeys, isPlainRecord, rowList, sortIssues } from './common';
import { BulkImportFileError } from './errors';
import { readImportSheet, type ImportColumn } from './sheetReader';
import { buildTemplateWorkbook, type TemplateColumn, type TemplateSpec } from './template';

type StudentField = 'studentId' | 'name' | 'balance';

export const STUDENT_IMPORT_SHEET_NAME = '학생 명단';
export const STUDENT_TEMPLATE_FILE_NAME = '학생 명단 양식.xlsx';
export const STUDENT_TEMPLATE_ASCII_FILE_NAME = 'student-import-template.xlsx';

const LABEL = { studentId: '학생 번호', name: '이름', balance: '처음 잔액' } as const;
const EXCEL_WHOLE_LIMIT = 999_999_999_999;

const COLUMNS: ReadonlyArray<ImportColumn<StudentField> & TemplateColumn> = [
  {
    field: 'studentId', label: LABEL.studentId, required: true, width: 17, text: true,
    aliases: ['번호', '학번', '학생ID', '학생 아이디', 'ID', '아이디', '출석 번호', 'studentId'],
    description: 'QR 카드와 은행에서 쓰는 학생 고유 번호예요. 반 안에서 겹치면 안 되고, 이미 등록된 번호나 '
      + `삭제한 학생이 쓰던 번호는 쓸 수 없어요. ${BULK_IMPORT_TEXT_LIMITS.studentId}자까지 적을 수 있어요. `
      + "이 열은 텍스트 서식이라 '01'처럼 앞자리 0이 그대로 남아요.",
    examples: ['01', '02'],
    validation: {
      type: 'textLength', operator: 'between', allowBlank: true, formulae: [1, BULK_IMPORT_TEXT_LIMITS.studentId],
      showInputMessage: true, promptTitle: '학생 번호', prompt: '반 안에서 겹치지 않는 번호 (예: 01)',
      showErrorMessage: true, errorTitle: '학생 번호', error: `1~${BULK_IMPORT_TEXT_LIMITS.studentId}자로 적어 주세요.`,
    },
  },
  {
    field: 'name', label: LABEL.name, required: true, width: 16,
    aliases: ['학생 이름', '학생명', '성명', '이름(학생)', 'name'],
    description: `학생 이름이에요. ${BULK_IMPORT_TEXT_LIMITS.studentName}자까지 적을 수 있어요. 같은 이름이 있어도 괜찮아요.`,
    examples: ['김하늘', '이바다'],
    validation: {
      type: 'textLength', operator: 'between', allowBlank: true, formulae: [1, BULK_IMPORT_TEXT_LIMITS.studentName],
      showErrorMessage: true, errorTitle: '이름', error: `1~${BULK_IMPORT_TEXT_LIMITS.studentName}자로 적어 주세요.`,
    },
  },
  {
    field: 'balance', label: LABEL.balance, required: false, width: 16, numFmt: '#,##0',
    aliases: ['시작 잔액', '초기 잔액', '잔액', '처음 금액', '시작 금액', 'balance'],
    description: '학생이 처음 갖고 시작할 화폐예요. 비워 두면 0으로 시작해요. 소수점 없는 정수만 적을 수 있고 '
      + '음수(-)도 돼요. 0이 아니면 거래 내역에 관리자 조정으로 남아요.',
    examples: [1000, null],
    validation: {
      type: 'whole', operator: 'between', allowBlank: true, formulae: [-EXCEL_WHOLE_LIMIT, EXCEL_WHOLE_LIMIT],
      showErrorMessage: true, errorTitle: '처음 잔액', error: '소수점 없는 정수로 적어 주세요.',
    },
  },
];

const TEMPLATE: TemplateSpec = {
  sheetName: STUDENT_IMPORT_SHEET_NAME,
  guideTitle: '학생 명단 양식 작성 방법',
  columns: COLUMNS,
  notes: [
    `'${STUDENT_IMPORT_SHEET_NAME}' 시트의 첫 줄(제목 줄)은 지우지 마세요. 열 순서는 바꿔도 괜찮아요.`,
    '회색 예시 줄은 지우고 둘째 줄부터 학생을 한 줄에 한 명씩 적어 주세요. 예시와 똑같은 줄은 자동으로 건너뛰어요.',
    `한 번에 ${BULK_IMPORT_MAX_ROWS}명까지, 2MB 이하의 엑셀(.xlsx) 파일만 올릴 수 있어요. CSV, .xls, 매크로 파일은 안 돼요.`,
    '파일을 올리면 먼저 미리 보기가 나와요. 확인을 눌러야 학생이 추가되고, 오류가 있는 줄은 추가되지 않아요.',
    '이미 등록된 학생의 이름이나 잔액은 이 파일로 바뀌지 않아요. 학생 목록에서 직접 고쳐 주세요.',
  ],
};

export type ExistingStudent = Readonly<{ studentId: string; name: string; deleted: boolean }>;

export type ParsedStudentFile = Readonly<{
  sheetName: string;
  candidates: ReadonlyArray<StudentImportRow>;
  errors: ReadonlyArray<BulkImportIssue>;
  notices: ReadonlyArray<string>;
  readRowCount: number;
}>;

let templateCache: Promise<Uint8Array> | undefined;

/** The downloadable template (.xlsx bytes); built once per server instance. */
export function createStudentImportTemplate(): Promise<Uint8Array> {
  templateCache ??= buildTemplateWorkbook(TEMPLATE).catch((error: unknown) => {
    templateCache = undefined;
    throw error;
  });
  return templateCache;
}

export async function parseStudentImportFile(bytes: Uint8Array): Promise<ParsedStudentFile> {
  const sheet = await readImportSheet(bytes, COLUMNS, STUDENT_IMPORT_SHEET_NAME);
  const candidates: StudentImportRow[] = [];
  const errors: BulkImportIssue[] = [];
  let examples = 0;
  for (const row of sheet.rows) {
    const studentId = readText(row.cells.studentId, BULK_IMPORT_TEXT_LIMITS.studentId);
    const name = readText(row.cells.name, BULK_IMPORT_TEXT_LIMITS.studentName);
    const balance = readInteger(row.cells.balance);
    if (isExampleRow(studentId, name, balance)) {
      examples += 1;
      continue;
    }
    const issues: BulkImportIssue[] = [];
    const issue = (column: string, message: string) => issues.push({ rowNumber: row.rowNumber, column, message });
    if (!studentId.ok) issue(LABEL.studentId, studentId.message);
    else if (studentId.value === null) issue(LABEL.studentId, '학생 번호를 적어 주세요.');
    if (!name.ok) issue(LABEL.name, name.message);
    else if (name.value === null) issue(LABEL.name, '이름을 적어 주세요.');
    if (!balance.ok) issue(LABEL.balance, balance.message);
    if (issues.length || !studentId.ok || !name.ok || !balance.ok || !studentId.value || !name.value) {
      errors.push(...issues);
      continue;
    }
    candidates.push({ rowNumber: row.rowNumber, studentId: studentId.value, name: name.value, balance: balance.value ?? 0 });
  }

  const readRowCount = sheet.rows.length - examples;
  if (readRowCount > BULK_IMPORT_MAX_ROWS) {
    throw new BulkImportFileError('TOO_MANY_ROWS',
      `한 번에 ${BULK_IMPORT_MAX_ROWS}명까지 올릴 수 있어요. 지금 파일에는 ${readRowCount}줄이 있어요. 파일을 나눠서 올려 주세요.`);
  }
  if (readRowCount === 0) {
    throw new BulkImportFileError('NO_ROWS', '추가할 학생이 없어요. 양식의 둘째 줄부터 학생 번호와 이름을 적어 주세요.');
  }
  return {
    sheetName: sheet.sheetName,
    candidates,
    errors,
    notices: fileNotices(sheet.sheetName, STUDENT_IMPORT_SHEET_NAME, examples, sheet.ignoredHeaders),
    readRowCount,
  };
}

/** Checks rows against each other and against the class's current students (incl. deleted ones). */
export function validateStudentRows(
  rows: ReadonlyArray<StudentImportRow>,
  existing: ReadonlyMap<string, ExistingStudent>,
): { valid: StudentImportRow[]; errors: BulkImportIssue[] } {
  const rowsById = new Map<string, number[]>();
  for (const row of rows) {
    if (typeof row.studentId === 'string') rowsById.set(row.studentId, [...rowsById.get(row.studentId) ?? [], row.rowNumber]);
  }
  const valid: StudentImportRow[] = [];
  const errors: BulkImportIssue[] = [];
  for (const row of rows) {
    const issues: BulkImportIssue[] = [];
    const issue = (column: string, message: string) => issues.push({ rowNumber: row.rowNumber, column, message });
    const idProblem = checkPlainText(row.studentId, BULK_IMPORT_TEXT_LIMITS.studentId);
    if (idProblem) issue(LABEL.studentId, idProblem);
    const nameProblem = checkPlainText(row.name, BULK_IMPORT_TEXT_LIMITS.studentName);
    if (nameProblem) issue(LABEL.name, nameProblem);
    if (!Number.isSafeInteger(row.balance)) issue(LABEL.balance, '소수점 없는 정수로 적어 주세요.');
    if (!idProblem) {
      const others = (rowsById.get(row.studentId) ?? []).filter((rowNumber) => rowNumber !== row.rowNumber);
      if (others.length) issue(LABEL.studentId, `${rowList(others)}과 학생 번호가 겹쳐요.`);
      const found = existing.get(row.studentId);
      if (found?.deleted) issue(LABEL.studentId, '삭제한 학생이 쓰던 번호라 다시 쓸 수 없어요. 다른 번호를 적어 주세요.');
      else if (found) issue(LABEL.studentId, `이미 등록된 학생 번호예요 (${found.name}).`);
    }
    if (issues.length) errors.push(...issues);
    else valid.push(row);
  }
  return { valid, errors };
}

export function buildStudentImportPreview(
  parsed: ParsedStudentFile,
  existing: ReadonlyMap<string, ExistingStudent>,
): StudentImportPreview {
  const checked = validateStudentRows(parsed.candidates, existing);
  return {
    ok: true,
    kind: 'students',
    sheetName: parsed.sheetName,
    rows: checked.valid,
    errors: sortIssues([...parsed.errors, ...checked.errors]),
    notices: parsed.notices,
    readRowCount: parsed.readRowCount,
  };
}

const COMMIT_ROW_KEYS = ['balance', 'name', 'rowNumber', 'studentId'];

/** Strict shape check of the confirm request; semantic checks run again inside the commit. */
export function parseStudentImportCommitRequest(value: unknown): BulkImportCommitRequest<StudentImportRow> | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['operationId', 'rows'])) return null;
  if (!isCanonicalOperationId(value.operationId)) return null;
  const rows = value.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > BULK_IMPORT_MAX_ROWS) return null;
  const seen = new Set<number>();
  const parsed: StudentImportRow[] = [];
  for (const row of rows) {
    if (!isPlainRecord(row) || !hasExactKeys(row, COMMIT_ROW_KEYS)) return null;
    if (!Number.isSafeInteger(row.rowNumber) || (row.rowNumber as number) < 2 || seen.has(row.rowNumber as number)
      || typeof row.studentId !== 'string' || typeof row.name !== 'string'
      || !Number.isSafeInteger(row.balance)) return null;
    seen.add(row.rowNumber as number);
    parsed.push({ rowNumber: row.rowNumber as number, studentId: row.studentId, name: row.name, balance: row.balance as number });
  }
  return { operationId: value.operationId, rows: parsed };
}

function isExampleRow(
  studentId: ReturnType<typeof readText>,
  name: ReturnType<typeof readText>,
  balance: ReturnType<typeof readInteger>,
): boolean {
  if (!studentId.ok || !name.ok || !balance.ok) return false;
  return COLUMNS[0].examples.some((example, index) => studentId.value === example
    && name.value === COLUMNS[1].examples[index]
    && balance.value === (COLUMNS[2].examples[index] ?? null));
}
