// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { BulkImportFileError } from './errors';
import {
  buildStudentImportPreview,
  createStudentImportTemplate,
  parseStudentImportCommitRequest,
  parseStudentImportFile,
  type ExistingStudent,
} from './studentImport';
import { assertSafeXlsxContainer } from './xlsxContainer';
import { loadWorkbook, workbookBytes, type FixtureCell } from './testing/workbookFixtures';

vi.mock('server-only', () => ({}));

const HEADER = ['학생 번호 (필수)', '이름 (필수)', '처음 잔액 (선택)'];

async function sheet(rows: FixtureCell[][], name = '학생 명단') {
  // General cell format, as in a teacher's own workbook (dates stay dates).
  return workbookBytes([{ name, rows }]);
}

async function fileError(promise: Promise<unknown>): Promise<BulkImportFileError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BulkImportFileError) return error;
    throw error;
  }
  throw new Error('expected a file error');
}

describe('student template', () => {
  it('is a safe xlsx with the input sheet, examples, text IDs, validations and a guide sheet', async () => {
    const bytes = await createStudentImportTemplate();
    expect(() => assertSafeXlsxContainer(bytes)).not.toThrow();
    const workbook = await loadWorkbook(bytes);
    expect(workbook.worksheets.map((worksheet) => worksheet.name)).toEqual(['학생 명단', '작성 방법']);
    const input = workbook.worksheets[0];
    expect([1, 2, 3].map((column) => input.getRow(1).getCell(column).value)).toEqual(HEADER);
    expect(input.getRow(2).getCell(1).value).toBe('01');
    expect(input.getRow(2).getCell(4).value).toContain('예시');
    expect(input.getColumn(1).numFmt).toBe('@');
    expect(input.getColumn(1).width).toBeGreaterThan(10);
    expect(input.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(input.getCell('C10').dataValidation).toMatchObject({ type: 'whole' });
    const guide = workbook.worksheets[1];
    const guideText = guide.getSheetValues().flat().map(String).join(' ');
    expect(guideText).toContain('학생 번호');
    expect(guideText).toContain('필수');
    expect(guideText).toContain('200명');
  });

  it('an untouched template has only example rows, so it is refused kindly', async () => {
    const error = await fileError(parseStudentImportFile(await createStudentImportTemplate()));
    expect(error.code).toBe('NO_ROWS');
    expect(error.message).toContain('추가할 학생이 없어요');
  });

  it('a filled template skips the examples left in place', async () => {
    const workbook = await loadWorkbook(await createStudentImportTemplate());
    const input = workbook.worksheets[0];
    input.getRow(4).values = ['03', '박구름', 500];
    input.getRow(5).values = ['04', '최별'];
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer() as ArrayBuffer);
    const parsed = await parseStudentImportFile(bytes);
    expect(parsed.candidates).toEqual([
      { rowNumber: 4, studentId: '03', name: '박구름', balance: 500 },
      { rowNumber: 5, studentId: '04', name: '최별', balance: 0 },
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.readRowCount).toBe(2);
    expect(parsed.notices).toContain('양식의 예시 줄 2개는 건너뛰었어요.');
  });
});

describe('student file parsing', () => {
  it('reads a clean sheet', async () => {
    const parsed = await parseStudentImportFile(await sheet([HEADER, ['01', '김민준', 1000], ['02', '이서연', null]]));
    expect(parsed.sheetName).toBe('학생 명단');
    expect(parsed.candidates).toEqual([
      { rowNumber: 2, studentId: '01', name: '김민준', balance: 1000 },
      { rowNumber: 3, studentId: '02', name: '이서연', balance: 0 },
    ]);
    expect(parsed.notices).toEqual([]);
  });

  it('matches headers by name in any order, after a title line, with aliases and extra columns', async () => {
    const bytes = await workbookBytes([{ name: 'Sheet1', rows: [
      ['3학년 2반 학생 명단'],
      [],
      ['비고', ' 성명 ', '잔액', '번호'],
      ['반장', '  김민준 ', ' 1,000원 ', ' 07 '],
      [],
      [null, '이서연', '-200', 8],
      [],
      [],
    ] }]);
    const parsed = await parseStudentImportFile(bytes);
    expect(parsed.candidates).toEqual([
      { rowNumber: 4, studentId: '07', name: '김민준', balance: 1000 },
      { rowNumber: 6, studentId: '8', name: '이서연', balance: -200 },
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.notices).toEqual(["'Sheet1' 시트를 읽었어요.", "모르는 열('비고')은 읽지 않았어요."]);
  });

  it('keeps the zero padding a number format shows (typed 1, displayed 01)', async () => {
    const bytes = await workbookBytes([{
      name: '학생 명단', rows: [HEADER, [1, '김민준'], [12, '이서연'], [3, '박도윤']], formats: { A2: '00', A3: '00', A4: '0' },
    }]);
    const parsed = await parseStudentImportFile(bytes);
    expect(parsed.candidates.map((row) => row.studentId)).toEqual(['01', '12', '3']);
  });

  it('prefers the template sheet and ignores hidden sheets', async () => {
    const bytes = await workbookBytes([
      { name: '숨김', state: 'hidden', rows: [HEADER, ['99', '숨은 학생']] },
      { name: '메모', rows: [['아무 내용']] },
      { name: '학생 명단', rows: [HEADER, ['01', '김민준']], textColumns: [1] },
    ]);
    const parsed = await parseStudentImportFile(bytes);
    expect(parsed.sheetName).toBe('학생 명단');
    expect(parsed.candidates.map((row) => row.studentId)).toEqual(['01']);
  });

  it('reports bad cells per row with Excel row numbers', async () => {
    const parsed = await parseStudentImportFile(await sheet([
      HEADER,
      [new Date(Date.UTC(2026, 2, 1)), '날짜 번호', 0],
      ['02', null, 0],
      ['03', '소수 잔액', 12.5],
      ['04', '글자 잔액', '많이'],
      ['05', { formula: 'A1/0', result: { error: '#DIV/0!' } }, 0],
      ['06', true, 0],
      ['07', '정상', '300'],
      [null, '번호 없음', 100],
      ['x'.repeat(51), '긴 번호', 0],
    ]));
    expect(parsed.candidates).toEqual([{ rowNumber: 8, studentId: '07', name: '정상', balance: 300 }]);
    expect(parsed.errors).toEqual([
      { rowNumber: 2, column: '학생 번호', message: expect.stringContaining('날짜로 바뀌어') },
      { rowNumber: 3, column: '이름', message: '이름을 적어 주세요.' },
      { rowNumber: 4, column: '처음 잔액', message: '소수점 없이 정수로 적어 주세요.' },
      { rowNumber: 5, column: '처음 잔액', message: '숫자로 적어 주세요.' },
      { rowNumber: 6, column: '이름', message: expect.stringContaining('#DIV/0!') },
      { rowNumber: 7, column: '이름', message: expect.stringContaining('TRUE/FALSE') },
      { rowNumber: 9, column: '학생 번호', message: '학생 번호를 적어 주세요.' },
      { rowNumber: 10, column: '학생 번호', message: '50자 이하로 적어 주세요.' },
    ]);
    expect(parsed.readRowCount).toBe(9);
  });

  it('flags duplicates in the file and conflicts with existing or deleted students', async () => {
    const parsed = await parseStudentImportFile(await sheet([
      HEADER, ['01', '김민준'], ['02', '이서연'], ['01', '박도윤'], ['10', '기존'], ['11', '삭제됨'], ['12', '새 학생'],
    ]));
    const existing = new Map<string, ExistingStudent>([
      ['10', { studentId: '10', name: '정하은', deleted: false }],
      ['11', { studentId: '11', name: '전학생', deleted: true }],
    ]);
    const preview = buildStudentImportPreview(parsed, existing);
    expect(preview.rows.map((row) => row.studentId)).toEqual(['02', '12']);
    expect(preview.errors).toEqual([
      { rowNumber: 2, column: '학생 번호', message: '4행과 학생 번호가 겹쳐요.' },
      { rowNumber: 4, column: '학생 번호', message: '2행과 학생 번호가 겹쳐요.' },
      { rowNumber: 5, column: '학생 번호', message: '이미 등록된 학생 번호예요 (정하은).' },
      { rowNumber: 6, column: '학생 번호', message: expect.stringContaining('삭제한 학생') },
    ]);
    expect(preview).toMatchObject({ ok: true, kind: 'students', readRowCount: 6 });
  });

  it('refuses more than 200 data rows', async () => {
    const rows: FixtureCell[][] = [HEADER];
    for (let index = 1; index <= 201; index += 1) rows.push([String(index), `학생${index}`]);
    const error = await fileError(parseStudentImportFile(await sheet(rows)));
    expect(error.code).toBe('TOO_MANY_ROWS');
    expect(error.message).toContain('201줄');
  });

  it('accepts exactly 200 rows', async () => {
    const rows: FixtureCell[][] = [HEADER];
    for (let index = 1; index <= 200; index += 1) rows.push([String(index), `학생${index}`]);
    const parsed = await parseStudentImportFile(await sheet(rows));
    expect(parsed.candidates).toHaveLength(200);
  });

  it('refuses sheets without the required headers and names what is missing', async () => {
    const missing = await fileError(parseStudentImportFile(await sheet([['학생 번호', '반'], ['01', '3-2']])));
    expect(missing.code).toBe('NO_MATCHING_SHEET');
    expect(missing.message).toContain("'이름' 열을 찾지 못했어요");
    const garbage = await fileError(parseStudentImportFile(await sheet([['가', '나'], ['1', '2']], '아무거나')));
    expect(garbage.code).toBe('NO_MATCHING_SHEET');
    expect(garbage.message).toContain("'학생 번호', '이름'");
  });

  it('refuses a header row that names the same column twice', async () => {
    const error = await fileError(parseStudentImportFile(await sheet([['번호', '이름', '학생 번호'], ['1', '가', '2']])));
    expect(error.message).toContain("'학생 번호' 열이 두 번");
  });

  it('refuses files with headers but no students', async () => {
    const error = await fileError(parseStudentImportFile(await sheet([HEADER, [], []])));
    expect(error.code).toBe('NO_ROWS');
  });
});

describe('student commit request', () => {
  const operationId = '10000000-0000-4000-8000-000000000001';
  const row = { rowNumber: 2, studentId: '01', name: '김민준', balance: 0 };

  it('accepts the exact preview row shape', () => {
    expect(parseStudentImportCommitRequest({ operationId, rows: [row] })).toEqual({ operationId, rows: [row] });
  });

  it.each([
    ['missing operationId', { rows: [row] }],
    ['non-UUID operationId', { operationId: 'abc', rows: [row] }],
    ['extra top-level key', { operationId, rows: [row], force: true }],
    ['empty rows', { operationId, rows: [] }],
    ['extra row key', { operationId, rows: [{ ...row, status: 'INACTIVE' }] }],
    ['fractional balance', { operationId, rows: [{ ...row, balance: 1.5 }] }],
    ['header row number', { operationId, rows: [{ ...row, rowNumber: 1 }] }],
    ['duplicate row numbers', { operationId, rows: [row, { ...row, studentId: '02' }] }],
    ['too many rows', { operationId, rows: Array.from({ length: 201 }, (_, index) => ({ ...row, rowNumber: index + 2, studentId: String(index) })) }],
  ])('rejects %s', (_label, body) => {
    expect(parseStudentImportCommitRequest(body)).toBeNull();
  });
});
