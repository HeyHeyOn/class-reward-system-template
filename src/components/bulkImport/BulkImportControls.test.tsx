import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XLSX_CONTENT_TYPE } from '@/lib/bulkImport';
import { ProductBulkImport } from './ProductBulkImport';
import { StudentBulkImport } from './StudentBulkImport';

const FIRST_OPERATION = '30000000-0000-4000-8000-000000000001';
const SECOND_OPERATION = '30000000-0000-4000-8000-000000000002';

const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(() => 'blob:template');
const revokeObjectURL = vi.fn();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function xlsxFile(name = '우리반.xlsx', size = 64): File {
  return new File([new Uint8Array(size)], name, { type: XLSX_CONTENT_TYPE });
}

function chooseFile(file: File, noun = '학생') {
  fireEvent.change(screen.getByLabelText(`${noun} 엑셀 파일 선택`), { target: { files: [file] } });
}

const studentPreview = {
  ok: true,
  kind: 'students',
  sheetName: '학생 명단',
  rows: [
    { rowNumber: 2, studentId: '01', name: '김민준', balance: 1000 },
    { rowNumber: 3, studentId: '02', name: '이서연', balance: -200 },
  ],
  errors: [{ rowNumber: 4, column: '학생 번호', message: '이미 등록된 학생 번호예요 (정하은).' }],
  notices: ['양식의 예시 줄 2개는 건너뛰었어요.'],
  readRowCount: 3,
};

function studentCommitResult(operationId: string) {
  return {
    ok: true, kind: 'students', operationId, created: 2, replayed: false,
    items: studentPreview.rows.map(({ rowNumber, studentId, name, balance }) => ({ rowNumber, studentId, name, balance })),
  };
}

function requestBody(callIndex: number): unknown {
  return JSON.parse(String(fetchMock.mock.calls[callIndex][1]?.body));
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
  createObjectURL.mockClear();
  vi.spyOn(crypto, 'randomUUID')
    .mockReturnValueOnce(FIRST_OPERATION)
    .mockReturnValueOnce(SECOND_OPERATION);
  window.history.pushState({}, '', '/c/demo-class/admin/students');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: originalCreateObjectURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: originalRevokeObjectURL });
  window.history.pushState({}, '', '/');
});

describe('StudentBulkImport', () => {
  it('renders the two header buttons', () => {
    render(<StudentBulkImport onImported={vi.fn()} />);
    expect(screen.getByRole('button', { name: '학생 양식 다운로드' }).textContent).toContain('양식 다운로드');
    expect(screen.getByRole('button', { name: '학생 엑셀로 일괄 추가' }).textContent).toContain('엑셀로 일괄 추가');
    expect(screen.getByLabelText('학생 엑셀 파일 선택').getAttribute('accept')).toBe(`.xlsx,${XLSX_CONTENT_TYPE}`);
  });

  it('downloads the template from the class-scoped endpoint', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0x50, 0x4b]), { status: 200, headers: { 'Content-Type': XLSX_CONTENT_TYPE } }));
    render(<StudentBulkImport onImported={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '학생 양식 다운로드' }));

    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/c/demo-class/students/import/template');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.download).toBe('학생 명단 양식.xlsx');
    expect(anchor.href).toBe('blob:template');
  });

  it('explains a failed template download', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, code: 'ADMIN_REQUIRED', error: '관리자 로그인이 필요해요. 다시 로그인해 주세요.' }, 401));
    render(<StudentBulkImport onImported={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '학생 양식 다운로드' }));
    const dialog = await screen.findByRole('dialog', { name: '학생 양식 다운로드 실패' });
    expect(dialog.textContent).toContain('관리자 로그인이 필요해요');
  });

  it('previews the file, then commits on confirm and reports success', async () => {
    const onImported = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json(studentPreview))
      .mockResolvedValueOnce(json(studentCommitResult(FIRST_OPERATION)));
    render(<StudentBulkImport onImported={onImported} unit="원" />);
    const file = xlsxFile();

    chooseFile(file);

    const dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    await within(dialog).findByRole('table', { name: '추가할 학생 미리 보기' });
    const [previewUrl, previewInit] = fetchMock.mock.calls[0];
    expect(previewUrl).toBe('/api/c/demo-class/students/import/preview');
    expect(previewInit?.method).toBe('POST');
    expect(new Headers(previewInit?.headers).get('Content-Type')).toBe(XLSX_CONTENT_TYPE);
    expect(previewInit?.body).toBe(file);
    expect(dialog.textContent).toContain('우리반.xlsx');
    expect(dialog.textContent).toContain('추가할 학생 2명');
    expect(dialog.textContent).toContain('오류 1줄');
    expect(dialog.textContent).toContain('오류가 있는 1줄은 추가되지 않아요');
    expect(within(dialog).getByRole('list', { name: '오류 목록' }).textContent).toContain('4행학생 번호: 이미 등록된 학생 번호예요 (정하은).');
    expect(dialog.textContent).toContain('양식의 예시 줄 2개는 건너뛰었어요.');
    expect(dialog.textContent).toContain('1,000원');
    expect(dialog.textContent).toContain('-200원');
    expect(onImported).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: '학생 2명 추가' }));

    await within(dialog).findByText('학생 2명을 추가했어요');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/c/demo-class/students/import/commit');
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Content-Type')).toBe('application/json');
    expect(requestBody(1)).toEqual({ operationId: FIRST_OPERATION, rows: studentPreview.rows });
    expect(onImported).toHaveBeenCalledWith(2);

    fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('retries an uncertain commit with the same operationId (never a second import)', async () => {
    const onImported = vi.fn();
    fetchMock
      .mockResolvedValueOnce(json(studentPreview))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ ok: false, code: 'OUTCOME_UNCERTAIN', error: '결과를 확인하지 못했어요.' }, 500))
      .mockResolvedValueOnce(json({ ...studentCommitResult(FIRST_OPERATION), replayed: true }));
    render(<StudentBulkImport onImported={onImported} />);
    chooseFile(xlsxFile());
    const dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });

    fireEvent.click(await within(dialog).findByRole('button', { name: '학생 2명 추가' }));
    expect(await within(dialog).findByText('추가 결과를 확인하지 못했어요')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '다시 시도' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    fireEvent.click(await within(dialog).findByRole('button', { name: '다시 시도' }));

    await within(dialog).findByText('학생 2명을 추가했어요');
    expect(dialog.textContent).toContain('이미 처리된 요청이라 한 번만 추가됐어요');
    expect([1, 2, 3].map((index) => (requestBody(index) as { operationId: string }).operationId))
      .toEqual([FIRST_OPERATION, FIRST_OPERATION, FIRST_OPERATION]);
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('shows commit-time conflicts and re-checks the same file with a fresh operation', async () => {
    fetchMock
      .mockResolvedValueOnce(json(studentPreview))
      .mockResolvedValueOnce(json({
        ok: false, code: 'VALIDATION_FAILED', error: '파일을 확인한 뒤에 명단이 바뀌었어요.',
        errors: [{ rowNumber: 2, column: '학생 번호', message: '이미 등록된 학생 번호예요 (김민준).' }],
      }, 409))
      .mockResolvedValueOnce(json({ ...studentPreview, rows: [studentPreview.rows[1]] }));
    const file = xlsxFile();
    render(<StudentBulkImport onImported={vi.fn()} />);
    chooseFile(file);
    const dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '학생 2명 추가' }));

    expect(await within(dialog).findByText('추가하지 못했어요')).toBeTruthy();
    expect(dialog.textContent).toContain('2행학생 번호: 이미 등록된 학생 번호예요 (김민준).');
    expect(within(dialog).queryByRole('button', { name: '다시 시도' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '파일 다시 확인' }));

    expect((await within(dialog).findByRole('button', { name: '학생 1명 추가' }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock.mock.calls[2][0]).toBe('/api/c/demo-class/students/import/preview');
    expect(fetchMock.mock.calls[2][1]?.body).toBe(file);
  });

  it('refuses CSV, legacy .xls and oversized files before uploading', async () => {
    render(<StudentBulkImport onImported={vi.fn()} />);
    chooseFile(new File(['01,김민준'], '명단.csv', { type: 'text/csv' }));
    let dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    expect(dialog.textContent).toContain('엑셀(.xlsx) 파일만 올릴 수 있어요');
    fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));

    chooseFile(xlsxFile('old.xls'));
    dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    expect(dialog.textContent).toContain('옛 엑셀 형식');
    fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));

    chooseFile(xlsxFile('big.xlsx', 2 * 1024 * 1024 + 1));
    dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    expect(dialog.textContent).toContain('2MB 이하');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server explanation for a file it cannot use', async () => {
    fetchMock.mockResolvedValueOnce(json({
      ok: false, code: 'NO_MATCHING_SHEET', error: "양식에 맞는 시트를 찾지 못했어요. '이름' 열을 찾지 못했어요.",
    }, 422));
    render(<StudentBulkImport onImported={vi.fn()} />);
    chooseFile(xlsxFile());
    const dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    expect(await within(dialog).findByText('이 파일은 올릴 수 없어요')).toBeTruthy();
    expect(dialog.textContent).toContain("'이름' 열을 찾지 못했어요");
    expect((within(dialog).getByRole('button', { name: '다른 파일 선택' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('cannot confirm when no row is addable', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...studentPreview, rows: [] }));
    render(<StudentBulkImport onImported={vi.fn()} />);
    chooseFile(xlsxFile());
    const dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    expect(await within(dialog).findByText('추가할 수 있는 줄이 없어요')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '학생 0명 추가' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ignores a preview that arrives after the dialog was cancelled', async () => {
    let resolvePreview: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { resolvePreview = resolve; }));
    render(<StudentBulkImport onImported={vi.fn()} />);
    chooseFile(xlsxFile());
    const dialog = await screen.findByRole('dialog', { name: '엑셀로 학생 추가' });
    expect(within(dialog).getByRole('status').textContent).toContain('파일을 확인하고 있어요');
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    resolvePreview(json(studentPreview));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('ProductBulkImport', () => {
  it('uses the product endpoints and wording', async () => {
    window.history.pushState({}, '', '/c/demo-class/admin/products');
    const onImported = vi.fn();
    const rows = [
      { rowNumber: 2, name: '초코파이', price: 500, stock: 20, category: '간식', imageUrl: null, sortOrder: 5, isActive: true },
      { rowNumber: 3, name: '연필', price: 300, stock: 0, category: null, imageUrl: 'https://example.com/p.png', sortOrder: 6, isActive: false },
    ];
    fetchMock
      .mockResolvedValueOnce(json({ ok: true, kind: 'products', sheetName: '상품 목록', rows, errors: [], notices: [], readRowCount: 2 }))
      .mockResolvedValueOnce(json({
        ok: true, kind: 'products', operationId: FIRST_OPERATION, created: 2, replayed: false,
        items: [{ rowNumber: 2, productId: 'P003', name: '초코파이' }, { rowNumber: 3, productId: 'P004', name: '연필' }],
      }));
    render(<ProductBulkImport onImported={onImported} unit="미소" />);
    expect(screen.getByRole('button', { name: '상품 양식 다운로드' })).toBeTruthy();

    chooseFile(xlsxFile('매점.xlsx'), '상품');
    const dialog = await screen.findByRole('dialog', { name: '엑셀로 상품 추가' });
    const table = await within(dialog).findByRole('table', { name: '추가할 상품 미리 보기' });
    expect(table.textContent).toContain('500미소');
    expect(table.textContent).toContain('숨김');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/c/demo-class/products/import/preview');

    fireEvent.click(within(dialog).getByRole('button', { name: '상품 2개 추가' }));
    await within(dialog).findByText('상품 2개를 추가했어요');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/c/demo-class/products/import/commit');
    expect(requestBody(1)).toEqual({ operationId: FIRST_OPERATION, rows });
    expect(onImported).toHaveBeenCalledWith(2);
  });
});
