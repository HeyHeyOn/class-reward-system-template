import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskApp } from './KioskApp';

const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 20, isActive: true, imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 15, isActive: true, category: '문구', sortOrder: 2 },
  { productId: 'P003', name: '마이쮸', price: 100, stock: 8, isActive: true, category: '간식', sortOrder: 3 },
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

        if (url === '/api/settings') {
          return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '햇살반 매점', themeColor: 'pink', source: 'runtime' });
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

    expect(await screen.findByRole('heading', { name: '햇살반 매점' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '상품 목록' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '장바구니 (0)' })).toBeTruthy();
    expect(screen.getByText('연필')).toBeTruthy();
    expect(screen.getByRole('img', { name: '연필 이미지' }).getAttribute('src')).toBe('https://example.com/pencil.png');
    expect(screen.getByText('선택한 상품이 없습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '새로고침' })).toBeTruthy();
    expect(screen.queryByText('시트 연동')).toBeNull();

    expect(screen.queryByRole('link', { name: '관리자 설정' })).toBeNull();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('h-screen');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-pink-50');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('overflow-hidden');
    expect(container.querySelector('[data-testid="kiosk-main-grid"]')?.className).toContain('grid-rows-[minmax(0,2fr)_minmax(0,1fr)]');
    expect(container.querySelector('[data-testid="kiosk-main-grid"]')?.className).toContain('landscape:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]');
    expect(container.querySelector('[data-testid="product-grid"]')?.className).toContain('grid-cols-3');
    expect(container.querySelector('[data-testid="product-scroll-block"]')?.className).toContain('overflow-y-auto');
    expect(container.querySelector('[data-testid="cart-scroll-block"]')?.className).toContain('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    expect(screen.getByRole('heading', { name: '장바구니 (1)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '연필 수량 줄이기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '연필 수량 늘리기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '비우기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'QR 결제' })).toBeTruthy();
    const decreaseButton = screen.getByRole('button', { name: '연필 수량 줄이기' });
    const increaseButton = screen.getByRole('button', { name: '연필 수량 늘리기' });
    expect(decreaseButton.className).toBe(increaseButton.className);
  });


  it('builds category tabs beside the product heading and filters the product grid', async () => {
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('button', { name: '전체' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '문구' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '간식' })).toBeTruthy();
    const tabs = container.querySelector('[data-testid="category-tabs"]');
    expect(tabs?.className).toContain('flex-1');
    expect(tabs?.className).toContain('overflow-x-auto');
    expect(tabs?.className).toContain('whitespace-nowrap');

    fireEvent.click(screen.getByRole('button', { name: '간식' }));
    expect(screen.getByText('마이쮸')).toBeTruthy();
    expect(screen.queryByText('연필')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '전체' }));
    expect(screen.getByText('연필')).toBeTruthy();
  });

  it('shows a loading dialog until products and settings are loaded', async () => {
    let resolveProducts!: () => void;
    const productGate = new Promise<void>((resolve) => { resolveProducts = resolve; });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return productGate.then(() => jsonResponse(products));
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', themeColor: 'white', source: 'runtime' });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    const { container } = render(<KioskApp />);

    expect(screen.getByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '상품 목록' })).toBeNull();
    resolveProducts();
    expect(await screen.findByRole('heading', { name: '학급 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-slate-100');
  });

  it('applies the new navy theme from settings', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '남색 매점', themeColor: 'navy', source: 'runtime' }));
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '남색 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-blue-950');
  });

  it('applies softer pastel theme classes from settings on the kiosk', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '분홍 매점', themeColor: 'pink', source: 'runtime' }));
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '분홍 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-pink-50');
    expect(screen.getByRole('button', { name: '전체' }).className).toContain('bg-pink-200');
    expect(screen.getByRole('button', { name: '전체' }).className).not.toContain('bg-pink-500');
  });

  it('uses a soft yellow, balanced green, and darker black kiosk shell when selected', async () => {
    for (const [themeColor, expectedShell, rejectedShell] of [
      ['yellow', 'bg-yellow-50', 'bg-yellow-100'],
      ['green', 'bg-green-50', 'bg-lime-50'],
      ['black', 'bg-slate-900', 'bg-slate-100'],
    ] as const) {
      cleanup();
      vi.mocked(fetch).mockReset();
      vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
      vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: `${themeColor} 매점`, themeColor, source: 'runtime' }));

      const { container } = render(<KioskApp />);

      expect(await screen.findByRole('heading', { name: `${themeColor} 매점` })).toBeTruthy();
      const shellClass = container.querySelector('[data-testid="kiosk-shell"]')?.className ?? '';
      expect(shellClass).toContain(expectedShell);
      expect(shellClass).not.toContain(rejectedShell);
    }
  });

  it('reloads products and settings from the title refresh button', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/products', { cache: 'no-store' });
      expect(fetch).toHaveBeenCalledWith('/api/settings', { cache: 'no-store' });
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/products')).toHaveLength(2);
    });
  });

  it('keeps the main kiosk visible while checkout, processing, and complete steps appear as popups', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    expectPageText('총 결제 금액300별');

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

    const completeDialog = await screen.findByRole('dialog', { name: '결제 완료' });
    expect(completeDialog).toBeTruthy();
    expect(screen.getByText('결제가 완료되었습니다.')).toBeTruthy();
    expect(screen.getByText('결제자: 김민준')).toBeTruthy();
    expect(within(completeDialog).getAllByText('총 결제 금액')).toHaveLength(1);
    expectPageText('결제 후 잔액3,200별');

    fireEvent.click(screen.getByRole('button', { name: '처음으로' }));
    expect(await screen.findByRole('heading', { name: '장바구니 (0)' })).toBeTruthy();
  });

  it('shows a payment failure popup when QR is invalid', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));

    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));

    expect(await screen.findByRole('dialog', { name: '결제 실패' })).toBeTruthy();
    expect(screen.getByText('잘못된 QR 코드입니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('recovers from malformed QR/student lookup errors instead of staying on the processing popup', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', source: 'runtime' }));
    vi.mocked(fetch).mockImplementationOnce(async () => {
      throw new SyntaxError('Unexpected token < in JSON');
    });

    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'BROKEN-QR' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));

    expect(await screen.findByRole('dialog', { name: '결제 실패' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '결제 중' })).toBeNull();
    expect(screen.getByText('잘못된 QR 코드입니다.')).toBeTruthy();
  });

  it('uses responsive kiosk layout classes for small screens and keeps the total/payment area aligned', async () => {
    const { container } = render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('h-screen');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-pink-50');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('overflow-hidden');
    expect(container.querySelector('[data-testid="kiosk-content"]')?.className).toContain('h-full');
    expect(container.querySelector('[data-testid="kiosk-title"]')?.className).toContain('text-[clamp(');
    expect(container.querySelector('[data-testid="products-panel"]')?.className).toContain('text-[clamp(');
    expect(container.querySelector('[data-testid="cart-panel"]')?.className).toContain('text-[clamp(');
    expect(container.querySelector('[data-testid="product-card"]')?.className).toContain('text-[clamp(');
    expect(container.querySelector('[data-testid="product-card-footer"]')?.className).toContain('flex-row');
    expect(container.querySelector('[data-testid="product-card-stock"]')?.className).toContain('whitespace-nowrap');
    expect(container.querySelector('[data-testid="checkout-total-bar"]')?.className).toContain('text-[clamp(');
    expect(container.querySelector('[data-testid="checkout-total-bar"]')?.className).toContain('sm:flex-row');
    expect(container.querySelector('[data-testid="checkout-button"]')?.className).toContain('text-[clamp(');
    expect(container.querySelector('[data-testid="checkout-button"]')?.className).toContain('sm:w-auto');
  });

  it('keeps cart item names visible while controls sit near the middle-right and subtotal can wrap when long', async () => {
    const { container } = render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));

    const cartRow = container.querySelector('[data-testid="cart-item-row"]');
    const cartName = container.querySelector('[data-testid="cart-item-name"]');
    const quantityControls = container.querySelector('[data-testid="cart-quantity-controls"]');
    const subtotal = container.querySelector('[data-testid="cart-item-subtotal"]');

    expect(cartRow?.className).toContain('grid-cols-[minmax(0,2fr)_auto_minmax(3.5rem,1fr)]');
    expect(cartRow?.className).toContain('landscape:grid-cols-[minmax(0,2fr)_auto_minmax(3.5rem,1fr)]');
    expect(cartName?.className).toContain('min-w-0');
    expect(quantityControls?.className).toContain('justify-self-center');
    expect(quantityControls?.className).not.toContain('justify-self-start');
    expect(quantityControls?.className).toContain('z-10');
    expect(subtotal?.className).toContain('break-words');
    expect(subtotal?.className).not.toContain('truncate');
    const decreaseButton = screen.getByRole('button', { name: '연필 수량 줄이기' });
    const increaseButton = screen.getByRole('button', { name: '연필 수량 늘리기' });
    expect(decreaseButton.className).toBe(increaseButton.className);
    expect(increaseButton.className).toContain('w-[clamp(2rem,5vw,2.25rem)]');
    expect(increaseButton.className).not.toContain('min-w-10');
    expect(increaseButton.className).toContain('touch-manipulation');
  });
});
