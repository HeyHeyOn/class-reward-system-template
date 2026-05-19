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

        if (url === '/api/students/WRONG') {
          return jsonResponse({ error: '잘못된 QR 코드입니다.' }, { status: 404 });
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

  it('renders a reference-style kiosk main screen with product cards, cart controls, clear button, and QR payment button', async () => {
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '학급 매점' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '상품 목록' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '장바구니 (0)' })).toBeTruthy();
    expect(screen.getByText('연필')).toBeTruthy();
    expect(screen.getByText('선택한 상품이 없습니다.')).toBeTruthy();

    const adminLink = screen.getByRole('link', { name: '관리자 설정' });
    expect(adminLink.getAttribute('href')).toBe('/admin/settings');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('h-screen');
    expect(container.querySelector('[data-testid="product-scroll-block"]')?.className).toContain('overflow-y-auto');
    expect(container.querySelector('[data-testid="cart-scroll-block"]')?.className).toContain('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: '연필 300원 담기' }));
    expect(screen.getByRole('heading', { name: '장바구니 (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '연필 수량 줄이기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '연필 수량 늘리기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '비우기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'QR 결제' })).toBeTruthy();
  });

  it('keeps the main kiosk visible while checkout, processing, and complete steps appear as popups', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300원 담기' }));
    expectPageText('총 결제 금액300원');

    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    expect(await screen.findByRole('dialog', { name: '결제 확인' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '상품 목록' })).toBeTruthy();
    expect(screen.getByText('결제하려면 카메라에 QR 코드를 인식해주세요.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    expect(await screen.findByRole('dialog', { name: '결제 중' })).toBeTruthy();

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }] }),
      });
    });

    expect(await screen.findByRole('dialog', { name: '결제 완료' })).toBeTruthy();
    expect(screen.getByText('결제가 완료되었습니다.')).toBeTruthy();
    expect(screen.getByText('결제자: 김민준')).toBeTruthy();
    expectPageText('결제 후 잔액3,200원');

    fireEvent.click(screen.getByRole('button', { name: '처음으로' }));
    expect(await screen.findByRole('heading', { name: '장바구니 (0)' })).toBeTruthy();
  });

  it('shows a payment failure popup when QR is invalid', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300원 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));

    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));

    expect(await screen.findByRole('dialog', { name: '결제 실패' })).toBeTruthy();
    expect(screen.getByText('잘못된 QR 코드입니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });
});
