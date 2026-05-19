import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskApp } from './KioskApp';

const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 20, isActive: true, category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 15, isActive: true, category: '문구', sortOrder: 2 },
];

const studentBefore = { studentId: 'S001', name: '김민준', number: 1, balance: 3500, status: 'ACTIVE' };

function expectPageText(text: string) {
  expect(document.body.textContent?.replace(/\s+/g, ' ')).toContain(text);
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('KioskApp', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api/products') {
          return jsonResponse(products);
        }

        if (url === '/api/students/S001') {
          return jsonResponse(studentBefore);
        }

        if (url === '/api/checkout' && init?.method === 'POST') {
          return jsonResponse({
            ok: true,
            transactionId: 'T-TEST-UI',
            studentId: 'S001',
            studentName: '김민준',
            totalAmount: 300,
            balanceBefore: 3500,
            balanceAfter: 3200,
            items: [{ productId: 'P001', name: '연필', price: 300, quantity: 1, subtotal: 300 }],
          });
        }

        return jsonResponse({ error: 'not found' }, { status: 404 });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('starts on a full-screen shop page with separate product and cart blocks plus a small admin settings button', async () => {
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '상품 목록' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '장바구니' })).toBeTruthy();
    expect(screen.getByText('연필')).toBeTruthy();
    expect(screen.getByText('선택한 상품이 없습니다.')).toBeTruthy();

    const adminLink = screen.getByRole('link', { name: '관리자 설정' });
    expect(adminLink.getAttribute('href')).toBe('/admin/settings');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('h-screen');
    expect(container.querySelector('[data-testid="product-scroll-block"]')?.className).toContain('overflow-y-auto');
    expect(container.querySelector('[data-testid="cart-scroll-block"]')?.className).toContain('overflow-y-auto');
  });

  it('moves from cart to checkout page, opens QR payment popup, and completes payment after QR recognition', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '연필 300원 담기' }));
    expectPageText('총 300원');

    fireEvent.click(screen.getByRole('button', { name: '결제 화면으로' }));
    expect(await screen.findByRole('heading', { name: '결제 확인' })).toBeTruthy();
    expect(screen.getByText('연필 × 1')).toBeTruthy();
    expectPageText('합계 300원');

    fireEvent.click(screen.getByRole('button', { name: 'QR로 결제하기' }));
    expect(await screen.findByRole('dialog', { name: 'QR 결제' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }] }),
      });
    });

    expect(await screen.findByRole('heading', { name: '결제 완료' })).toBeTruthy();
    expect(screen.getByText('김민준 · 1번')).toBeTruthy();
    expectPageText('결제 금액 300원');
    expectPageText('현재 잔액 3,200원');

    fireEvent.click(screen.getByRole('button', { name: '처음으로' }));
    expect(await screen.findByRole('heading', { name: '상품 목록' })).toBeTruthy();
    expect(screen.getByText('선택한 상품이 없습니다.')).toBeTruthy();
  });
});
