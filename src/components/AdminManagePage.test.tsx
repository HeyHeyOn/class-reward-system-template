import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';

const students = [
  { studentId: 'S001', name: '김민준', number: 1, balance: 3200, status: 'ACTIVE' },
  { studentId: 'S002', name: '이서연', number: 2, balance: 1500, status: 'ACTIVE' },
];
const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 19, isActive: true, imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, category: '문구', sortOrder: 2 },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AdminManagePage', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api/students') {
          if (init?.method === 'POST') return jsonResponse({ studentId: 'S003', name: '박도윤', number: 3, balance: 0, status: 'ACTIVE' });
          return jsonResponse(students);
        }
        if (url === '/api/products?includeInactive=1') return jsonResponse(products);
        if (url === '/api/settings' && init?.method === 'POST') return jsonResponse({ spreadsheetId: 'sheet-new', currencyUnit: '별', appTitle: '햇살반 매점', themeColor: 'purple', source: 'runtime' });
        if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', themeColor: 'blue', source: 'runtime' });
        if (url === '/api/products' && init?.method === 'POST') {
          return jsonResponse({ productId: 'P003', name: '간식쿠폰', price: 1000, stock: 5, isActive: true, imageUrl: 'https://example.com/snack.png', category: '쿠폰', sortOrder: 3 });
        }
        if (url === '/api/students/S001' && init?.method === 'PATCH') {
          return jsonResponse({ ...students[0], name: '김민준 수정', balance: 4000 });
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

        return jsonResponse({ error: 'not found' }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders unified admin tabs with kiosk-style design language', async () => {
    const { container } = render(<AdminManagePage />);

    expect(await screen.findByRole('heading', { name: '관리자 센터' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '시트 설정' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '학생 명단' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '재고 관리' })).toBeTruthy();
    expect(await screen.findByText('관리자 목록도 이 설정을 사용합니다: 학생 2명 · 상품 2개')).toBeTruthy();
    expect(screen.getByRole('link', { name: /학생 QR 출력/ }).getAttribute('href')).toBe('/admin/student-qrs');
    expect(screen.getByRole('link', { name: /결제 내역 확인/ }).getAttribute('href')).toBe('/admin/transactions');
    expect(screen.getByDisplayValue('별')).toBeTruthy();
    expect(screen.getByDisplayValue('학급 매점')).toBeTruthy();
    expect(screen.getByLabelText('테마 색상')).toBeTruthy();
    expect(container.querySelector('[data-testid="admin-shell"]')?.className).toContain('bg-[#dbeaf6]');
    expect(container.querySelector('[data-testid="admin-tabs"]')?.className).toContain('rounded-[1.5rem]');
  });

  it('reloads admin lists from the shared sheet after saving sheet settings', async () => {
    render(<AdminManagePage />);

    await screen.findByText('관리자 목록도 이 설정을 사용합니다: 학생 2명 · 상품 2개');
    fireEvent.change(screen.getByLabelText('Google Sheets 주소 또는 시트 ID'), { target: { value: 'sheet-new' } });
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '햇살반 매점' } });
    fireEvent.click(screen.getByRole('button', { name: '시트 ID 저장' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetIdOrUrl: 'sheet-new', currencyUnit: '별', appTitle: '햇살반 매점', themeColor: 'blue' }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/students', { cache: 'no-store' });
      expect(fetch).toHaveBeenCalledWith('/api/products?includeInactive=1', { cache: 'no-store' });
    });

    expect(await screen.findByText('시트 ID를 저장했고, 관리자 목록도 같은 시트에서 다시 불러왔습니다.')).toBeTruthy();
  });

  it('loads students and products, then saves edited values through PATCH APIs', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 명단' }));
    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('S001 이름'), { target: { value: '김민준 수정' } });
    fireEvent.change(screen.getByLabelText('S001 잔액'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: 'S001 학생 저장' }));
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('S001 저장 완료'));

    fireEvent.click(screen.getByRole('tab', { name: '재고 관리' }));
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('P001 상품명'), { target: { value: '연필 세트' } });
    fireEvent.change(screen.getByLabelText('P001 가격'), { target: { value: '900' } });
    fireEvent.change(screen.getByLabelText('P001 이미지 주소'), { target: { value: 'https://example.com/new-pencil.png' } });
    fireEvent.click(screen.getByRole('button', { name: 'P001 상품 저장' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/S001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '김민준 수정', number: 1, balance: 4000, status: 'ACTIVE' }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/products/P001', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '연필 세트', price: 900, stock: 19, isActive: true, imageUrl: 'https://example.com/new-pencil.png', category: '문구', sortOrder: 1 }),
      });
    });

    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('P001 저장 완료'));
  });

  it('supports dense selectable rows with bulk student balance editing and deletion', async () => {
    const { container } = render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 명단' }));
    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();
    expect(container.querySelector('[data-testid="student-list"]')?.className).toContain('divide-y');

    fireEvent.click(screen.getByLabelText('전체 학생 선택'));
    fireEvent.change(screen.getByLabelText('선택 학생 금액'), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText('선택 학생 작업'), { target: { value: 'set' } });
    fireEvent.click(screen.getByRole('button', { name: '선택 학생 재화 적용' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/bulk', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentIds: ['S001', 'S002'], mode: 'set', amount: 5000 }),
      });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 2명 수정 완료'));

    fireEvent.click(screen.getByRole('button', { name: '선택 학생 삭제' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students/S001', { method: 'DELETE' });
      expect(fetch).toHaveBeenCalledWith('/api/students/S002', { method: 'DELETE' });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 학생 2명 삭제 완료'));
    expect(window.alert).not.toHaveBeenCalledWith('S001 삭제 완료');
    expect(window.alert).not.toHaveBeenCalledWith('S002 삭제 완료');

    fireEvent.click(screen.getByRole('tab', { name: '재고 관리' }));
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();
    expect(container.querySelector('[data-testid="product-list"]')?.className).toContain('divide-y');
    fireEvent.click(screen.getByLabelText('전체 상품 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 상품 삭제' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/products/P001', { method: 'DELETE' });
      expect(fetch).toHaveBeenCalledWith('/api/products/P002', { method: 'DELETE' });
    });
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('선택 상품 2개 삭제 완료'));
    expect(window.alert).not.toHaveBeenCalledWith('P001 삭제 완료');
    expect(window.alert).not.toHaveBeenCalledWith('P002 삭제 완료');
  });

  it('creates new student and product rows through POST APIs', async () => {
    render(<AdminManagePage />);

    fireEvent.click(await screen.findByRole('tab', { name: '학생 명단' }));
    await screen.findByDisplayValue('김민준');

    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S003' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '박도윤' } });
    fireEvent.change(screen.getByLabelText('새 학생 번호'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: '새 학생 추가' }));

    fireEvent.click(screen.getByRole('tab', { name: '재고 관리' }));
    fireEvent.change(screen.getByLabelText('새 상품 ID'), { target: { value: 'P003' } });
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
        body: JSON.stringify({ studentId: 'S003', name: '박도윤', number: 3, balance: 0, status: 'ACTIVE' }),
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
});
