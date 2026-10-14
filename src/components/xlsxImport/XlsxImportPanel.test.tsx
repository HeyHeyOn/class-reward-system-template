import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XlsxImportPanel, type XlsxImportPreview } from './XlsxImportPanel';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const digest = 'd'.repeat(64);
function preview(overrides: Partial<XlsxImportPreview> = {}): XlsxImportPreview {
  return {
    ok: true, mode: 'start', fileName: 'crs.xlsx', fileDigest: digest, canImport: true, blocked: null,
    summary: { students: 2, activeStudents: 2, totalBalance: 15, products: 1, activeProducts: 1, totalStock: 4, promotions: 0,
      tasks: 1, activeTasks: 1, readyAssignments: 1, completedAssignments: 1,
      history: { transactions: 3, adjustments: 0, taskAssignments: 2, taskCompletions: 1 },
      settings: { currencyUnit: '점', appTitle: '시험 매점', bankTitle: '시험 은행' } },
    issues: [{ level: 'warning', sheet: null, row: null, message: '잔액은 그대로 옮기고, 이전 거래·과제 기록은 옮기지 않아요. 이전 기록은 올린 원본 파일에 그대로 남아 있어요.' },
      { level: 'warning', sheet: 'PromotionProducts', row: 3, message: '이 행사 연결은 옮기지 않아요.' }],
    students: [{ studentId: 'S01', name: '가람', balance: 10, status: 'ACTIVE' }, { studentId: 'S02', name: '나래', balance: 5, status: 'ACTIVE' }],
    products: [{ productId: 'P1', name: '연필', price: 2, stock: 4, isActive: true }],
    promotions: [],
    tasks: [{ taskId: 'TA', title: '독서 기록', reward: 2, isActive: true, schedule: '반복 없음', ready: 1, completed: 1,
      availableFrom: '2030-03-02T00:00:00.000Z', dueAt: null }],
    ...overrides,
  };
}
const xlsxFile = () => new File([new Uint8Array([0x50, 0x4b, 3, 4])], 'crs.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

async function upload(file = xlsxFile()) {
  fireEvent.change(screen.getByLabelText('구글 시트 버전 파일(.xlsx) 선택'), { target: { files: [file] } });
}

describe('XlsxImportPanel', () => {
  it('keeps the file input inert before hydration', () => {
    const document = new DOMParser().parseFromString(renderToString(<XlsxImportPanel slug="class-a" mode="start" />), 'text/html');
    expect((document.querySelector('input[type=file]') as HTMLInputElement).disabled).toBe(true);
  });

  it('previews, confirms and imports, then opens the class admin', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json({ ok: true, replayed: false, adminHref: '/c/class-a/admin', message: '가져오기를 마쳤어요.' }));
    vi.stubGlobal('fetch', fetcher);
    const navigate = vi.fn();
    render(<XlsxImportPanel slug="class-a" mode="start" navigate={navigate} />);
    await upload();
    const region = await screen.findByRole('region', { name: '가져올 내용 미리보기' });
    expect(within(region).getByText('2명')).toBeDefined();
    expect(within(region).getByText('15점')).toBeDefined();
    expect(within(region).getByText(/행사 상품 시트 3행/)).toBeDefined();
    expect(within(region).getByText(/이전 기록은 올린 원본 파일에 그대로 남아 있어요/)).toBeDefined();
    expect(within(region).getByText(/^시작 2030\. 3\. 2\./).textContent).toMatch(/9:00/);
    expect(fetcher.mock.calls[0][0]).toBe('/api/c/class-a/migrations/xlsx/preview');
    const sent = fetcher.mock.calls[0][1].body as FormData;
    expect((sent.get('file') as File).name).toBe('crs.xlsx');

    fireEvent.click(screen.getByRole('button', { name: '이 파일로 학급 시작하기' }));
    const dialog = screen.getByRole('dialog', { name: '가져오기 전에 확인해 주세요' });
    expect(within(dialog).getByText(/학급 사용을 시작하고/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: '가져오기' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/c/class-a/admin'));
    expect(fetcher.mock.calls[1][0]).toBe('/api/c/class-a/migrations/xlsx/commit');
    const committed = fetcher.mock.calls[1][1].body as FormData;
    expect(committed.get('fileDigest')).toBe(digest);
    expect(committed.get('operationId')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(screen.getByRole('status').textContent).toContain('가져오기를 마쳤어요.');
    expect(screen.getByRole('link', { name: '학급 관리 열기' }).getAttribute('href')).toBe('/c/class-a/admin');
  });

  it('retries an uncertain import with the same operation and file', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(preview({ mode: 'import' })))
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(Response.json({ ok: true, replayed: true, adminHref: '/c/class-a/admin' }));
    vi.stubGlobal('fetch', fetcher);
    const navigate = vi.fn();
    render(<XlsxImportPanel slug="class-a" mode="import" navigate={navigate} />);
    await upload();
    fireEvent.click(await screen.findByRole('button', { name: '이 파일로 가져오기' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '가져오기' }));
    fireEvent.click(await screen.findByRole('button', { name: '같은 파일로 다시 확인' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    const first = fetcher.mock.calls[1][1].body as FormData, second = fetcher.mock.calls[2][1].body as FormData;
    expect(second.get('operationId')).toBe(first.get('operationId'));
    expect(second.get('fileDigest')).toBe(first.get('fileDigest'));
  });

  it('shows blocking errors and never offers the import', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(preview({ canImport: false,
      issues: [{ level: 'error', sheet: 'Students', row: 4, message: '잔액(balance)은 정수여야 해요.' }] }))));
    render(<XlsxImportPanel slug="class-a" mode="start" />);
    await upload();
    const alert = await screen.findByText(/학생 시트 4행/);
    expect(alert.closest('li')?.textContent).toContain('잔액(balance)은 정수여야 해요.');
    expect(screen.getByText('고쳐야 할 내용 1건')).toBeDefined();
    expect((screen.getByRole('button', { name: '이 파일로 학급 시작하기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('explains a class that already has data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(preview({ mode: 'import', canImport: false, blocked: 'NOT_EMPTY',
      blockedMessage: '이미 학생·상품·과제가 있는 학급이라 가져올 수 없어요.' }))));
    render(<XlsxImportPanel slug="class-a" mode="import" />);
    await upload();
    expect(await screen.findByText('이 학급에는 가져올 수 없어요')).toBeDefined();
    expect((screen.getByRole('button', { name: '이 파일로 가져오기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses non-xlsx and oversized files before uploading', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(<XlsxImportPanel slug="class-a" mode="start" />);
    await upload(new File(['a,b'], 'students.csv', { type: 'text/csv' }));
    expect(screen.getByRole('alert').textContent).toContain('엑셀(.xlsx) 파일만');
    const big = xlsxFile();
    Object.defineProperty(big, 'size', { value: 10 * 1024 * 1024 + 1 });
    await upload(big);
    expect(screen.getByRole('alert').textContent).toContain('10MB');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shows a definite refusal and lets the teacher choose another file', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json(preview()))
      .mockResolvedValueOnce(Response.json({ error: '미리보기한 파일과 다른 파일이에요.' }, { status: 409 })));
    render(<XlsxImportPanel slug="class-a" mode="start" />);
    await upload();
    fireEvent.click(await screen.findByRole('button', { name: '이 파일로 학급 시작하기' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '가져오기' }));
    expect((await screen.findByRole('alert')).textContent).toContain('미리보기한 파일과 다른 파일이에요.');
    fireEvent.click(screen.getByRole('button', { name: '다른 파일 고르기' }));
    expect(screen.getByLabelText('구글 시트 버전 파일(.xlsx) 선택')).toBeDefined();
  });
});
