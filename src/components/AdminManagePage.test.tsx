import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';

const students = [
  { studentId: 'S001', name: '김민준', balance: 3200, status: 'ACTIVE' },
  { studentId: 'S002', name: '이서연', balance: 1500, status: 'ACTIVE' },
];
const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 19, isActive: true, imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, category: '문구', sortOrder: 2 },
];
const tasks = [
  { taskId: 'T001', title: '책 읽기', description: '책 10분 읽기', reward: 5, maxCompletionsPerStudent: 2, isActive: true, sortOrder: 1, allowedStudentIds: ['S001'] },
  { taskId: 'T002', title: '수학 학습지', description: '1장 풀기', reward: 10, maxCompletionsPerStudent: 1, isActive: true, sortOrder: 2, allowedStudentIds: [] },
];
const transactions = [
  {
    transactionId: 'TX001',
    timestamp: '2026-05-22T01:00:00.000Z',
    studentId: 'S001',
    studentName: '김민준',
    items: [{ productId: 'P001', name: '연필', price: 300, quantity: 2, lineTotal: 600 }],
    totalAmount: 600,
    balanceBefore: 3200,
    balanceAfter: 2600,
    status: 'COMPLETED',
    operator: 'kiosk',
  },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferredResponse(payload: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((res) => { resolve = res; });
  return { resolve, response: gate.then(() => jsonResponse(payload)) };
}

describe('AdminManagePage', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api/students') {
          if (init?.method === 'POST') return jsonResponse({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' });
          return jsonResponse(students);
        }
        if (url === '/api/products?includeInactive=1') return jsonResponse(products);
        if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
        if (url === '/api/transactions') return jsonResponse(transactions);
        if (url === '/api/settings' && init?.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet-new', currencyUnit: '별', appTitle: '햇살반 매점', bankTitle: '햇살반 은행', themeColor: 'purple', fontFamily: 'school-safe-poster', source: 'runtime' });
        if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', fontFamily: 'school-safe-board-marker', source: 'runtime' });
        if (url === '/api/products' && init?.method === 'POST') {
          return jsonResponse({ productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5, isActive: true, imageUrl: 'https://example.com/snack.png', category: '쿠폰', sortOrder: 3 });
        }
        if (url === '/api/tasks' && init?.method === 'POST') {
          return jsonResponse({ taskId: 'T003', title: '영어 단어', description: '5개 외우기', reward: 10, maxCompletionsPerStudent: 1, isActive: true, sortOrder: 3, allowedStudentIds: [] });
        }
        if (url === '/api/tasks/batch' && init?.method === 'PATCH') {
          return jsonResponse([
            { ...tasks[0], title: '책 읽기 수정', description: '책 20분 읽기', reward: 7 },
            tasks[1],
          ]);
        }
        if (url === '/api/tasks/batch' && init?.method === 'DELETE') return jsonResponse({ taskIds: ['T001', 'T002'] });
        if (url === '/api/tasks/completions/reset' && init?.method === 'POST') return jsonResponse({ taskIds: ['T001', 'T002'], deletedCount: 3 });
        if (url === '/api/tasks/T001' && init?.method === 'PATCH') return jsonResponse({ ...tasks[0], title: '책 읽기 수정', reward: 7 });
        if (url === '/api/tasks/T001' && init?.method === 'DELETE') return jsonResponse({ taskId: 'T001' });
        if (url === '/api/students/batch' && init?.method === 'PATCH') {
          return jsonResponse([
            { ...students[0], name: '김민준 수정', balance: 4000 },
            students[1],
          ]);
        }
        if (url === '/api/students/batch' && init?.method === 'DELETE') return jsonResponse({ studentIds: ['S001', 'S002'] });
        if (url === '/api/products/batch' && init?.method === 'PATCH') {
          return jsonResponse([
            { ...products[0], name: '연필 세트', price: 900, imageUrl: 'https://example.com/new-pencil.png' },
            products[1],
          ]);
        }
        if (url === '/api/products/batch' && init?.method === 'DELETE') return jsonResponse({ productIds: ['P001', 'P002'] });
        if (url === '/api/students/S001' && init?.method === 'PATCH') {
          return jsonResponse({ ...students[0], name: '김민준 수정', balance: 4000 });
        }
        if (url === '/api/students/S002' && init?.method === 'PATCH') {
          return jsonResponse(students[1]);
        }
        if (url === '/api/students/S001' && init?.method === 'DELETE') return jsonResponse({ studentId: 'S001' });
        if (url === '/api/students/S002' && init?.method === 'DELETE') return jsonResponse({ studentId: 'S002' });
        if (url === '/api/products/P001' && init?.method === 'DELETE') return jsonResponse({ productId: 'P001' });
        if (url === '/api/products/P002' && init?.method === 'DELETE') return jsonResponse({ productId: 'P002' });
        if (url === '/api/students/bulk' && init?.method === 'PATCH') {
          return jsonResponse([
            { studentId: 'S001', balance: 5000 },
            { studentId: 'S002', balance: 5000 },
          ]);
        }
        if (url === '/api/products/P001' && init?.method === 'PATCH') {
          return jsonResponse({ ...products[0], name: '연필 세트', price: 900, imageUrl: 'https://example.com/new-pencil.png' });
        }
        if (url === '/api/products/P002' && init?.method === 'PATCH') {
          return jsonResponse(products[1]);
        }

        return jsonResponse({ error: 'not found' }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });


  it('removes student number fields and prints QR cards with ID only', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));

    expect(screen.queryByLabelText('새 학생 번호')).toBeNull();
    expect(screen.queryByText('번호')).toBeNull();
    expect(screen.queryByLabelText('S001 번호')).toBeNull();

    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 학생 QR 발급' }));

    expect(screen.getByRole('dialog', { name: '선택 학생 QR 발급' })).toBeTruthy();
    expect(screen.getAllByText('S001').length).toBeGreaterThan(0);
    expect(screen.queryByText(/1번/)).toBeNull();
  });

  it('assigns tasks to selected student IDs from the add-task and task-row buttons', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    fireEvent.click(screen.getByRole('button', { name: '새 과제 과제 부여' }));
    expect(screen.getByText('선택된 학생만 이 과제를 완료할 수 있습니다. 아무 학생도 선택하지 않으면 아무도 완료할 수 없습니다.')).toBeTruthy();
    expect(screen.getByLabelText('전체 학생 과제 부여 선택')).toBeTruthy();
    expect(screen.getByLabelText('S001 김민준 과제 부여')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('S001 김민준 과제 부여'));
    fireEvent.click(screen.getByRole('button', { name: '과제 부여 저장' }));

    fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(screen.getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"allowedStudentIds":["S001"]'),
    })));

    fireEvent.click(screen.getByRole('button', { name: 'T001 과제 부여' }));
    expect((screen.getByLabelText('S001 김민준 과제 부여') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('S002 이서연 과제 부여') as HTMLInputElement).checked).toBe(false);
  });


  it('assigns a selected task to a scanned student QR, saves it immediately, and shows saving progress', async () => {
    const savedTasks = [tasks[0], { ...tasks[1], allowedStudentIds: ['S002'] }];
    const qrTaskSave = deferredResponse(savedTasks);
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      if (url === '/api/tasks/batch' && init?.method === 'PATCH') return qrTaskSave.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    expect(screen.getByRole('dialog', { name: 'QR 과제 부여' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '책 읽기 과제 선택' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '수학 학습지 과제 선택' }));
    expect(screen.getByRole('dialog', { name: '수학 학습지 QR 과제 부여' })).toBeTruthy();
    expect(screen.getByText('수학 학습지')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: 'QR 인식 중' })).toBeTruthy();
    expect(screen.getByText('QR을 인식했습니다. 과제를 부여하는 중입니다.')).toBeTruthy();
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    expect(screen.getByText('변경 사항을 저장하는 중입니다.')).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', expect.objectContaining({
      method: 'PATCH',
      body: expect.stringContaining('"taskId":"T002"'),
    })));
    expect((baseFetch.mock.calls.find(([url, init]) => String(url) === '/api/tasks/batch' && init?.method === 'PATCH')?.[1] as RequestInit).body).toContain('"allowedStudentIds":["S002"]');
    qrTaskSave.resolve();

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 성공' })).toBeTruthy();
    expect(screen.getByText('과제가 부여되었습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 찍기' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));

    fireEvent.click(screen.getByRole('button', { name: 'T002 과제 부여' }));
    expect((screen.getByLabelText('S002 이서연 과제 부여') as HTMLInputElement).checked).toBe(true);
  });

  it('shows a specific failure when QR task assignment scans a duplicate or invalid QR', async () => {
    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));

    fireEvent.click(screen.getByRole('button', { name: 'QR 과제 부여' }));
    fireEvent.click(screen.getByRole('button', { name: '책 읽기 과제 선택' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 실패' })).toBeTruthy();
    expect(screen.getByText('이미 이 과제가 부여된 학생입니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    fireEvent.change(screen.getByLabelText('과제 부여 학생 QR 직접 입력'), { target: { value: 'UNKNOWN' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: 'QR 과제 부여 실패' })).toBeTruthy();
    expect(screen.getByText('잘못된 QR입니다.')).toBeTruthy();
  });

  it('shows loading popups while saving student, product, and task changes', async () => {
    const studentSave = deferredResponse([{ ...students[0], name: '김민준 수정', balance: 3200 }, students[1]]);
    const productSave = deferredResponse([{ ...products[0], name: '연필 세트' }, products[1]]);
    const taskSave = deferredResponse([{ ...tasks[0], title: '책 읽기 수정' }, tasks[1]]);
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      if (url === '/api/students/batch' && init?.method === 'PATCH') return studentSave.response;
      if (url === '/api/products/batch' && init?.method === 'PATCH') return productSave.response;
      if (url === '/api/tasks/batch' && init?.method === 'PATCH') return taskSave.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    expect(screen.getByText('변경 사항을 저장하는 중입니다.')).toBeTruthy();
    studentSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    productSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 저장' }));
    expect(await screen.findByRole('dialog', { name: '변경 사항 저장 중' })).toBeTruthy();
    taskSave.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '변경 사항 저장 중' })).toBeNull());
  });

  it('refreshes student, product, and task lists with a loading popup from section headers', async () => {
    const refreshedStudents = [{ ...students[0], name: '김민준 새로고침', balance: 4100 }, students[1]];
    const refreshedProducts = [{ ...products[0], name: '연필 리필', stock: 30 }, products[1]];
    const refreshedTasks = [{ ...tasks[0], title: '책 읽기 새로고침' }, tasks[1]];
    let studentFetchCount = 0;
    let productFetchCount = 0;
    let taskFetchCount = 0;
    const studentRefresh = deferredResponse(refreshedStudents);
    const productRefresh = deferredResponse(refreshedProducts);
    const taskRefresh = deferredResponse(refreshedTasks);
    const baseFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    baseFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') {
        studentFetchCount += 1;
        return studentFetchCount === 1 ? jsonResponse(students) : studentRefresh.response;
      }
      if (url === '/api/products?includeInactive=1') {
        productFetchCount += 1;
        return productFetchCount === 1 ? jsonResponse(products) : productRefresh.response;
      }
      if (url === '/api/tasks?includeInactive=1') {
        taskFetchCount += 1;
        return taskFetchCount === 1 ? jsonResponse(tasks) : taskRefresh.response;
      }
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue' });
      if (url === '/api/transactions') return jsonResponse(transactions);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '학생 명단 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    expect(screen.getByText('새로고침하는 중입니다.')).toBeTruthy();
    studentRefresh.resolve();
    await screen.findByDisplayValue('김민준 새로고침');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    fireEvent.click(screen.getByRole('button', { name: '상품 · 재고 관리 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    expect(screen.getByText('새로고침하는 중입니다.')).toBeTruthy();
    productRefresh.resolve();
    await screen.findByDisplayValue('연필 리필');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '과제 설정' }));
    fireEvent.click(screen.getByRole('button', { name: '과제 설정 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    taskRefresh.resolve();
    await screen.findByDisplayValue('책 읽기 새로고침');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());
  });

  it('renders unified admin tabs with kiosk-style design language', async () => {
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect(screen.getByText('Class Reward System')).toBeTruthy();
    const logo = screen.getByRole('img', { name: '학급 보상 시스템 로고' });
    expect(logo).toBeTruthy();
    expect(logo.className).toContain('bg-[#365F78]');
    expect(logo.className).toContain("[mask-image:url('/class-reward-system-icon.png')]");
    expect(logo.className).not.toContain('bg-white');
    expect(logo.parentElement?.className).not.toMatch(/bg-|shadow|rounded/);
    const adminTabs = screen.getByTestId('admin-tabs');
    const expectedMenuOrder = ['시스템 설정', '학생 관리', '매점 관리', '과제 설정', '거래 내역 확인', '화폐 지급/회수', '매점 바로가기', '은행 바로가기'];
    let previousIndex = -1;
    for (const menu of expectedMenuOrder) {
      const currentIndex = adminTabs.textContent?.indexOf(menu) ?? -1;
      expect(currentIndex).toBeGreaterThan(previousIndex);
      previousIndex = currentIndex;
    }
    expect(screen.getByRole('tab', { name: '시스템 설정' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '학생 관리' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '매점 관리' })).toBeTruthy();
    expect(await screen.findByText('관리자 목록도 이 설정을 사용합니다: 학생 2명 · 상품 2개')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /학생 QR 출력/ })).toBeNull();
    expect(screen.getByRole('tab', { name: '거래 내역 확인' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /거래 내역 확인/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /시스템 생성기/ })).toBeNull();
    const storeLink = screen.getByRole('link', { name: /매점 바로가기/ });
    const bankLink = screen.getByRole('link', { name: /은행 바로가기/ });
    expect(storeLink.getAttribute('href')).toBe('/');
    expect(storeLink.getAttribute('target')).toBe('_blank');
    expect(storeLink.getAttribute('rel')).toContain('noopener');
    expect(storeLink.textContent).toContain('↗');
    expect(bankLink.getAttribute('href')).toBe('/bank');
    expect(bankLink.getAttribute('target')).toBe('_blank');
    expect(bankLink.getAttribute('rel')).toContain('noopener');
    expect(bankLink.textContent).toContain('↗');
    expect(screen.getByRole('tab', { name: '과제 설정' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '화폐 지급/회수' })).toBeTruthy();
    expect(await screen.findByDisplayValue('별')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 매점')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 은행')).toBeTruthy();
    expect(screen.getByLabelText('테마 색상')).toBeTruthy();
    expect(screen.getByLabelText('글꼴')).toBeTruthy();
    expect(screen.getByDisplayValue('학교안심 보드마카')).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[#EDF5FA]');
    expect(container.querySelector('[data-testid="admin-shell"]')?.getAttribute('style')).toContain('SchoolSafeBoardMarker');
    expect(container.querySelector('[data-testid="admin-tabs"]')?.className).toContain('rounded-[1.5rem]');
    expect(screen.queryByText('Google Sheets 연결')).toBeNull();
    expect(screen.queryByText('잔액과 상태 관리')).toBeNull();
    expect(screen.queryByText('스프레드시트 연결')).toBeNull();
    expect(screen.queryByText('GOOGLE SHEETS')).toBeNull();
  });

  it('saves the selected font family from system settings', async () => {
    render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('글꼴'), { target: { value: 'school-safe-poster' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    await waitFor(() => {
      const settingsPost = vi.mocked(fetch).mock.calls.find(([input, init]) => String(input) === '/api/settings' && init?.method === 'POST');
      expect(settingsPost).toBeTruthy();
      expect(JSON.parse(String(settingsPost?.[1]?.body))).toMatchObject({ fontFamily: 'school-safe-poster' });
    });
  });

  it('uses a softer balanced green admin theme and a darker black admin shell when selected', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'green', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container, unmount } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[#DCF5C9]');
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-green-50');
    unmount();

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'black', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const secondRender = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect(secondRender.container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[#1F1F1F]');
    expect(secondRender.container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-slate-100');
    expect(screen.getByRole('heading', { name: '학급 보상 시스템' }).className).toContain('text-slate-950');
    expect(screen.getByRole('heading', { name: '사용 전 확인' }).className).toContain('text-slate-950');
    expect(screen.getByLabelText('매점 제목').className).toContain('bg-slate-50');
    expect(screen.getByLabelText('매점 제목').className).toContain('text-slate-950');
    fireEvent.click(screen.getByRole('tab', { name: '학생 관리' }));
    expect(await screen.findByLabelText('S001 이름')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '새 학생 추가' }).className).toContain('text-slate-950');
    expect(screen.getByRole('heading', { name: '학생 명단' }).className).toContain('text-slate-950');
    expect(screen.getByLabelText('S001 이름').className).toContain('bg-white');
    expect(screen.getByLabelText('S001 이름').className).toContain('text-slate-950');
  });

  it('uses a blue-leaning low-saturation navy admin palette', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'navy', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[#DCE8F4]');
    expect(screen.getByRole('tab', { name: '시스템 설정' }).className).toContain('bg-[#7FA6C7]');
    expect(screen.getByRole('img', { name: '학급 보상 시스템 로고' }).className).toContain('bg-[#3F6F95]');
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).not.toContain('bg-[#8F97CF]');
  });


  it('keeps the one-time admin QR visible while linked sheet data reloads after password save', async () => {
    const reloadGate = deferredResponse(students);
    let studentCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') {
        studentCalls += 1;
        return studentCalls === 1 ? jsonResponse(students) : reloadGate.response;
      }
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/transactions') return jsonResponse([]);
      if (url === '/api/settings' && init?.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime', adminPasswordConfigured: true });
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);
    await screen.findByRole('heading', { name: '학급 보상 시스템' });
    fireEvent.change(screen.getByLabelText('관리자 암호 설정'), { target: { value: 'new-admin-pass' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    expect(await screen.findByText('관리자 QR 로그인 코드')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeNull();
    expect(screen.getByRole('img', { name: '관리자 로그인 QR' }).getAttribute('src')).toContain('class-store-admin%3Anew-admin-pass');

    reloadGate.resolve();
    await waitFor(() => expect(screen.getByText(/시스템 설정을 저장/)).toBeTruthy());
  });

  it('shows a full screen loading dialog until admin sheet data and theme are loaded', async () => {
    const studentGate = deferredResponse(students);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/students') return studentGate.response;
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'white', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    const { container } = render(<AdminManagePage />);

    expect(screen.getByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '학급 보상 시스템' })).toBeNull();

    studentGate.resolve();
    expect(await screen.findByRole('heading', { name: '학급 보상 시스템' })).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[#FCFCFC]');
  });

  it('preloads payment history before the payment tab is opened', async () => {
    render(<AdminManagePage />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/transactions', { cache: 'no-store' }));
    expect(screen.queryByRole('heading', { name: '최근 거래 (1)' })).toBeNull();

    fireEvent.click(await screen.findByRole('tab', { name: '거래 내역 확인' }));

    expect(await screen.findByRole('heading', { name: '최근 거래 (1)' })).toBeTruthy();
    expect(screen.getByText('김민준')).toBeTruthy();
    expect(screen.getByText('연필 × 2')).toBeTruthy();
    expect(screen.getAllByText('-600별').length).toBeGreaterThan(0);
  });

  it('reloads admin lists from the shared sheet after saving sheet settings', async () => {
    render(<AdminManagePage />);

    await screen.findByText('관리자 목록도 이 설정을 사용합니다: 학생 2명 · 상품 2개');
    fireEvent.change(screen.getByLabelText('Google Sheets 주소 또는 시트 ID'), { target: { value: 'sheet-new' } });
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '햇살반 매점' } });
    fireEvent.change(screen.getByLabelText('은행 제목'), { target: { value: '햇살반 은행' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetIdOrUrl: 'sheet-new', currencyUnit: '별', appTitle: '햇살반 매점', bankTitle: '햇살반 은행', themeColor: 'blue', fontFamily: 'school-safe-board-marker' }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/students', { cache: 'no-store' });
      expect(fetch).toHaveBeenCalledWith('/api/products?includeInactive=1', { cache: 'no-store' });
    });

    expect(await screen.findByText('시스템 설정을 저장했고, 관리자 목록도 같은 시트에서 다시 불러왔습니다.')).toBeTruthy();
  });

  it('uses top bulk save buttons and column headers instead of per-row save buttons', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();
    expect(screen.getByTestId('student-header-row').textContent).toContain('이름');
    expect(screen.getByTestId('student-header-row').textContent).toContain('잔액');
    expect(screen.queryByRole('button', { name: 'S001 학생 저장' })).toBeNull();
    expect(screen.queryByRole('link', { name: /QR 출력/ })).toBeNull();
    expect(screen.getByRole('button', { name: '선택 학생 QR 발급' })).toBeTruthy();

    fireEvent.click(screen.getByLabelText('S001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 학생 QR 발급' }));
    const qrDialog = await screen.findByRole('dialog', { name: '선택 학생 QR 발급' });
    expect(qrDialog).toBeTruthy();
    expect(document.body.classList.contains('qr-selection-printing')).toBe(true);
    const printDocument = document.querySelector('[data-qr-print-document]');
    expect(printDocument).toBeTruthy();
    expect(printDocument?.querySelector('[data-qr-print-grid]')).toBeTruthy();
    expect(screen.getAllByAltText('김민준 QR 코드')[0].getAttribute('src')).toBe('/api/qrcode?value=S001');
    expect(screen.queryByAltText('이서연 QR 코드')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(document.body.classList.contains('qr-selection-printing')).toBe(false);

    fireEvent.change(screen.getByLabelText('S001 이름'), { target: { value: '김민준 수정' } });
    fireEvent.change(screen.getByLabelText('S001 잔액'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 1명 저장 완료'));

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();
    expect(screen.getByTestId('product-header-row').textContent).toContain('상품명');
    expect(screen.getByTestId('product-header-row').textContent).not.toContain('ID');
    expect(screen.getByTestId('product-header-row').textContent).toContain('이미지');
    expect(screen.queryByRole('button', { name: 'P001 상품 저장' })).toBeNull();
    fireEvent.change(screen.getByLabelText('P001 상품명'), { target: { value: '연필 세트' } });
    fireEvent.change(screen.getByLabelText('P001 가격'), { target: { value: '900' } });
    expect(screen.getByRole('button', { name: '선택 저장' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('P001 선택'));
    fireEvent.click(screen.getByRole('button', { name: 'P001 이미지 주소 편집' }));
    expect(await screen.findByRole('dialog', { name: '이미지 주소 편집' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('이미지 주소 전체 입력'), { target: { value: 'https://example.com/new-pencil.png' } });
    fireEvent.click(screen.getByRole('button', { name: '이미지 주소 적용' }));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          students: [
            { studentId: 'S001', name: '김민준 수정', balance: 4000, status: 'ACTIVE' },
            ],
        }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/products/batch', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          products: [
            { productId: 'P001', name: '연필 세트', price: 900, stock: 19, isActive: true, imageUrl: 'https://example.com/new-pencil.png', category: '문구', sortOrder: 1 },
            ],
        }),
      });
    });
    expect(fetch).not.toHaveBeenCalledWith('/api/students/S001', expect.objectContaining({ method: 'PATCH' }));
    expect(fetch).not.toHaveBeenCalledWith('/api/products/P001', expect.objectContaining({ method: 'PATCH' }));

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 상품 1개 저장 완료'));
  });

  it('supports dense selectable rows with bulk student balance editing and deletion', async () => {
    const { container } = render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();
    expect(container.querySelector('[data-testid="student-list"]')?.className).toContain('divide-y');
    const studentRow = container.querySelector('[data-testid="student-row"]');
    expect(studentRow?.className).toContain('grid-cols-[24px_56px_minmax(4rem,1fr)_78px_52px_42px]');
    expect(studentRow?.className).toContain('items-center');
    expect(studentRow?.className).toContain('py-1');
    expect(studentRow?.className).not.toContain('md:grid-cols');
    expect(container.querySelector('[data-testid="student-name-field"]')?.className).toContain('sr-only');

    fireEvent.click(screen.getByLabelText('전체 학생 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 금액'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('선택 학생 작업'), { target: { value: 'set' } });
    fireEvent.click(screen.getByRole('button', { name: '화폐 수정' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'], mode: 'set', amount: 5000 }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 2명 수정 완료'));

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'] }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 2명 삭제 완료'));
    expect(window.alert).not.toHaveBeenCalledWith('S001 삭제 완료');
    expect(window.alert).not.toHaveBeenCalledWith('S002 삭제 완료');

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();
    expect(container.querySelector('[data-testid="product-list"]')?.className).toContain('divide-y');
    const productRow = container.querySelector('[data-testid="product-row"]');
    expect(productRow?.className).toContain('grid-cols-[24px_minmax(3rem,1fr)_56px_48px_36px_minmax(3rem,0.8fr)_40px_30px_34px]');
    expect(productRow?.className).toContain('items-center');
    expect(productRow?.className).toContain('py-1');
    expect(productRow?.className).not.toContain('md:grid-cols');
    expect(container.querySelector('[data-testid="product-name-field"]')?.className).toContain('sr-only');
    const imageButton = screen.getByRole('button', { name: 'P001 이미지 주소 편집' });
    expect(imageButton.className).toContain('truncate');
    fireEvent.click(imageButton);
    expect(await screen.findByRole('dialog', { name: '이미지 주소 편집' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    fireEvent.click(screen.getByLabelText('전체 상품 선택'));
    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/products/batch', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: ['P001', 'P002'] }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 상품 2개 삭제 완료'));
    expect(window.alert).not.toHaveBeenCalledWith('P001 삭제 완료');
    expect(window.alert).not.toHaveBeenCalledWith('P002 삭제 완료');
  });



  it('manages bank tasks with selectable rows, bulk save/delete, completion reset, and description popup', async () => {
    const { container } = render(<AdminManagePage />);
    fireEvent.click(await screen.findByRole('tab', { name: '과제 설정' }));
    expect(await screen.findByDisplayValue('책 읽기')).toBeTruthy();
    expect(screen.getByTestId('task-header-row').textContent).toContain('선택');
    expect(screen.getByTestId('task-header-row').textContent).not.toContain('ID');
    expect(screen.getByTestId('task-header-row').textContent).toContain('상세');
    expect(screen.getByTestId('task-header-row').textContent).not.toContain('저장');
    expect(screen.queryByRole('button', { name: 'T001 과제 저장' })).toBeNull();
    expect(screen.getByTestId('task-panel').className).toContain('min-w-0');
    expect(screen.getByTestId('new-task-card').className).toContain('min-w-0');
    expect(screen.getByTestId('task-list-card').className).toContain('min-w-0');
    expect(screen.getByTestId('task-list-scroll').className).toContain('overflow-x-auto');
    expect(screen.getByTestId('task-bulk-actions').className).toContain('flex-wrap');
    const taskRow = container.querySelector('[data-testid="task-row"]');
    expect(taskRow?.className).toContain('grid-cols-[24px_minmax(5rem,1fr)_64px_64px_48px_38px_52px_minmax(3rem,0.7fr)_46px_40px]');
    expect(taskRow?.className).toContain('items-center');
    expect(screen.queryByLabelText('T001 설명')).toBeNull();

    fireEvent.change(screen.getByLabelText('T001 과제명'), { target: { value: '책 읽기 수정' } });
    fireEvent.change(screen.getByLabelText('T001 보상'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'T001 상세 설정 편집' }));
    expect(await screen.findByRole('dialog', { name: '과제 상세 설정 편집' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('과제 상세 설정 전체 입력'), { target: { value: '책 20분 읽기' } });
    fireEvent.click(screen.getByRole('button', { name: '상세 설정 적용' }));
    expect(screen.getByRole('button', { name: '선택 저장' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByLabelText('T001 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 저장' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          { taskId: 'T001', title: '책 읽기 수정', description: '책 20분 읽기', reward: 7, maxCompletionsPerStudent: 2, isActive: true, sortOrder: 1, allowedStudentIds: ['S001'] },
          ],
      }),
    }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 과제 1개 저장 완료'));
    expect(fetch).not.toHaveBeenCalledWith('/api/tasks/T001', expect.objectContaining({ method: 'PATCH' }));

    fireEvent.click(screen.getByLabelText('전체 과제 선택'));
    fireEvent.click(screen.getByRole('button', { name: '초기화' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/completions/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ['T001', 'T002'] }),
    }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 과제 2개 완료 기록 3건 초기화 완료'));

    fireEvent.click(screen.getByRole('button', { name: 'T001 완료 기록 초기화' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/completions/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ['T001'] }),
    }));

    fireEvent.click(screen.getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks/batch', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskIds: ['T001', 'T002'] }),
    }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 과제 2개 삭제 완료'));

        fireEvent.change(screen.getByLabelText('새 과제명'), { target: { value: '영어 단어' } });
    fireEvent.change(screen.getByLabelText('새 과제 설명'), { target: { value: '5개 외우기' } });
    fireEvent.change(screen.getByLabelText('새 과제 보상'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: '새 과제 추가' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/tasks', expect.objectContaining({ method: 'POST' })));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('T003 과제 추가 완료'));
  });

  it('creates new student and product rows through POST APIs', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 관리' }));
    await screen.findByDisplayValue('김민준');

    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    fireEvent.click(screen.getByRole('button', { name: '새 학생 추가' }));

    fireEvent.click(screen.getByRole('tab', { name: '매점 관리' }));
        fireEvent.change(screen.getByLabelText('새 상품명'), { target: { value: '간식쿠폰' } });
    fireEvent.change(screen.getByLabelText('새 상품 가격'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('새 상품 재고'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('새 상품 카테고리'), { target: { value: '쿠폰' } });
    fireEvent.change(screen.getByLabelText('새 상품 이미지 주소'), { target: { value: 'https://example.com/snack.png' } });
    fireEvent.change(screen.getByLabelText('새 상품 정렬'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '새 상품 추가' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: 'S003', name: '박도윤', balance: 0, status: 'ACTIVE' }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5, isActive: true, imageUrl: 'https://example.com/snack.png', category: '쿠폰', sortOrder: 3 }),
      });
    });

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('S003 추가 완료'));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('P003 추가 완료'));
  });

  it('shows a loading popup after recognizing a currency QR before the result popup', async () => {
    const currencyRequest = deferredResponse([{ studentId: 'S001', balance: 3900 }]);
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return currencyRequest.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    fireEvent.click(screen.getByRole('button', { name: '지급' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    fireEvent.change(await screen.findByLabelText('학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: '화폐 지급 처리 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('QR을 인식했습니다. 화폐를 지급하는 중입니다.');
    currencyRequest.resolve();
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
  });

  it('adjusts one scanned student from the currency grant/collect tab with retryable result popups', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    expect(screen.getByRole('heading', { name: '화폐 지급/회수' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '지급' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '700' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    expect(await screen.findByRole('dialog', { name: '학생 QR 인식' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('학생 QR 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001'], mode: 'add', amount: 700 }),
      });
    });
    expect(await screen.findByRole('dialog', { name: '화폐 지급 성공' })).toBeTruthy();
    expect(screen.getByText('S001 학생에게 700 지급 완료')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '닫기' })).toBeTruthy();
  });

  it('shows a failure popup with retry and cancel when a scanned currency adjustment fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/students') return jsonResponse(students);
      if (url === '/api/products?includeInactive=1') return jsonResponse(products);
      if (url === '/api/tasks?includeInactive=1') return jsonResponse(tasks);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'blue', source: 'runtime' });
      if (url === '/api/students/bulk' && init?.method === 'PATCH') return jsonResponse({ error: '잔액은 0보다 작아질 수 없습니다.' }, { status: 400 });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '화폐 지급/회수' }));
    fireEvent.click(screen.getByRole('button', { name: '회수' }));
    fireEvent.change(screen.getByLabelText('지급/회수 금액'), { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 인식 시작' }));
    fireEvent.change(await screen.findByLabelText('학생 QR 직접 입력'), { target: { value: 'S002' } });
    fireEvent.click(screen.getByRole('button', { name: '직접 입력 적용' }));

    expect(await screen.findByRole('dialog', { name: '화폐 회수 실패' })).toBeTruthy();
    expect(screen.getByText('잔액은 0보다 작아질 수 없습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '취소' })).toBeTruthy();
  });
});
