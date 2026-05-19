import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminManagePage } from './AdminManagePage';

const students = [{ studentId: 'S001', name: '김민준', number: 1, balance: 3200, status: 'ACTIVE' }];
const products = [{ productId: 'P001', name: '연필', price: 300, stock: 19, isActive: true, category: '문구', sortOrder: 1 }];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('AdminManagePage', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api/students') {
          if (init?.method === 'POST') return jsonResponse({ studentId: 'S002', name: '이서연', number: 2, balance: 0, status: 'ACTIVE' });
          return jsonResponse(students);
        }
        if (url === '/api/products?includeInactive=1') return jsonResponse(products);
        if (url === '/api/products' && init?.method === 'POST') {
          return jsonResponse({ productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, category: '문구', sortOrder: 2 });
        }
        if (url === '/api/students/S001' && init?.method === 'PATCH') {
          return jsonResponse({ ...students[0], name: '김민준 수정', balance: 4000 });
        }
        if (url === '/api/products/P001' && init?.method === 'PATCH') {
          return jsonResponse({ ...products[0], name: '연필 세트', price: 900 });
        }

        return jsonResponse({ error: 'not found' }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('loads students and products, then saves edited values through PATCH APIs', async () => {
    render(<AdminManagePage />);

    expect(await screen.findByDisplayValue('김민준')).toBeTruthy();
    expect(await screen.findByDisplayValue('연필')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('S001 이름'), { target: { value: '김민준 수정' } });
    fireEvent.change(screen.getByLabelText('S001 잔액'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: 'S001 학생 저장' }));

    fireEvent.change(screen.getByLabelText('P001 상품명'), { target: { value: '연필 세트' } });
    fireEvent.change(screen.getByLabelText('P001 가격'), { target: { value: '900' } });
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
        body: JSON.stringify({ name: '연필 세트', price: 900, stock: 19, isActive: true, category: '문구', sortOrder: 1 }),
      });
    });

    expect(await screen.findByText('S001 저장 완료')).toBeTruthy();
    expect(await screen.findByText('P001 저장 완료')).toBeTruthy();
  });

  it('creates new student and product rows through POST APIs', async () => {
    render(<AdminManagePage />);

    await screen.findByDisplayValue('김민준');

    fireEvent.change(screen.getByLabelText('새 학생 ID'), { target: { value: 'S002' } });
    fireEvent.change(screen.getByLabelText('새 학생 이름'), { target: { value: '이서연' } });
    fireEvent.change(screen.getByLabelText('새 학생 번호'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '새 학생 추가' }));

    fireEvent.change(screen.getByLabelText('새 상품 ID'), { target: { value: 'P002' } });
    fireEvent.change(screen.getByLabelText('새 상품명'), { target: { value: '지우개' } });
    fireEvent.change(screen.getByLabelText('새 상품 가격'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('새 상품 재고'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('새 상품 카테고리'), { target: { value: '문구' } });
    fireEvent.change(screen.getByLabelText('새 상품 정렬'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: '새 상품 추가' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: 'S002', name: '이서연', number: 2, balance: 0, status: 'ACTIVE' }),
      });
      expect(fetch).toHaveBeenCalledWith('/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: 'P002', name: '지우개', price: 500, stock: 10, isActive: true, category: '문구', sortOrder: 2 }),
      });
    });

    expect(await screen.findByText('S002 추가 완료')).toBeTruthy();
    expect(await screen.findByText('P002 추가 완료')).toBeTruthy();
  });
});
