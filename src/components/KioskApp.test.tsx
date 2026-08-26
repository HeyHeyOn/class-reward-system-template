import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskApp } from './KioskApp';

const products = [
  { productId: 'P001', name: '연필', price: 300, stock: 20, isActive: true, imageUrl: 'https://example.com/pencil.png', category: '문구', sortOrder: 1 },
  { productId: 'P002', name: '지우개', price: 500, stock: 15, isActive: true, category: '문구', sortOrder: 2 },
  { productId: 'P003', name: '마이쮸', price: 100, stock: 8, isActive: true, category: '간식', sortOrder: 3 },
];

const studentBefore = { studentId: 'S001', name: '김민준', number: 1, balance: 3500, status: 'ACTIVE' };
const promotionBase = {
  description: '', productIds: ['P001'], startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
  isActive: true, sortOrder: 1, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 3,
};
const nPlusOne = { ...promotionBase, promotionId: 'N21', name: '연필 2+1', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1 };
const percent = { ...promotionBase, promotionId: 'P10', name: '10% 할인', type: 'PERCENT_DISCOUNT', percent: 10, sortOrder: 2 };

function regularPreview(items: Array<{ productId: string; quantity: number }>) {
  const snapshots = items.map((item) => {
    const product = products.find((candidate) => candidate.productId === item.productId)!;
    const total = product.price * item.quantity;
    return { productId: item.productId, name: product.name, price: product.price, quantity: item.quantity, subtotal: total,
      regularUnitPrice: product.price, regularTotal: total, totalQuantity: item.quantity, paidQuantity: item.quantity,
      freeQuantity: 0, finalTotal: total, totalDiscount: 0, adjustments: [], appliedPromotions: [] };
  });
  return { ok: true, totalAmount: snapshots.reduce((sum, item) => sum + item.finalTotal, 0), items: snapshots };
}

function expectPageText(text: string) {
  expect(document.body.textContent?.replace(/\s+/g, ' ')).toContain(text);
}

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(init?.headers)) },
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
          return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '햇살반 매점', themeColor: 'pink', fontFamily: 'school-safe-notice', qrManualInputEnabled: true, source: 'runtime' });
        }

        if (url === '/api/promotions/active') return jsonResponse([]);

        if (url === '/api/checkout/preview' && init?.method === 'POST') {
          return jsonResponse(regularPreview(JSON.parse(String(init.body)).items));
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
            items: regularPreview([{ productId: 'P001', quantity: 1 }]).items,
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
    const fallbackLogo = screen.getByRole('img', { name: '지우개 기본 이미지' });
    expect(fallbackLogo.getAttribute('src')).toBe('/class-reward-system-icon.png');
    expect(screen.queryByText('▵')).toBeNull();
    expect(screen.getByText('선택한 상품이 없습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '새로고침' })).toBeTruthy();
    expect(screen.queryByText('시트 연동')).toBeNull();

    expect(screen.queryByRole('link', { name: '관리자 설정' })).toBeNull();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('h-screen');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-[#FAEDED]');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain('SchoolSafeNotice');
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


  it('moves sold-out products to the bottom and visually dims them', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') {
        return jsonResponse([
          { productId: 'P001', name: '품절 연필', price: 300, stock: 0, isActive: true, category: '문구', sortOrder: 1 },
          { productId: 'P002', name: '판매 지우개', price: 500, stock: 5, isActive: true, category: '문구', sortOrder: 2 },
          { productId: 'P003', name: '판매 마이쮸', price: 100, stock: 8, isActive: true, category: '간식', sortOrder: 3 },
        ]);
      }
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '햇살반 매점', themeColor: 'pink', qrManualInputEnabled: true, source: 'runtime' });
      if (url === '/api/promotions/active') return jsonResponse([]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    const { container } = render(<KioskApp />);

    expect(await screen.findByText('품절 연필')).toBeTruthy();
    const productCards = screen.getAllByTestId('product-card');
    expect(productCards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('판매 지우개'),
      expect.stringContaining('판매 마이쮸'),
      expect.stringContaining('품절 연필'),
    ]);
    expect(productCards[2].className).toContain('brightness-75');
    expect(productCards[2].className).toContain('grayscale');
    expect(productCards[2].className).toContain('disabled:opacity-75');
    expect(container.querySelector('[data-testid="product-grid"]')?.textContent?.lastIndexOf('품절 연필')).toBeGreaterThan(
      container.querySelector('[data-testid="product-grid"]')?.textContent?.lastIndexOf('판매 마이쮸') ?? -1,
    );
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
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '학급 매점', themeColor: 'white', qrManualInputEnabled: true, source: 'runtime' });
      if (url === '/api/promotions/active') return jsonResponse([]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    const { container } = render(<KioskApp />);

    expect(screen.getByRole('dialog', { name: '시트 정보 불러오는 중' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '상품 목록' })).toBeNull();
    resolveProducts();
    expect(await screen.findByRole('heading', { name: '학급 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-[#FCFCFC]');
  });

  it('applies the new navy theme from settings', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '남색 매점', themeColor: 'navy', qrManualInputEnabled: true, source: 'runtime' }));
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '남색 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-[#DCE8F4]');
    expect(screen.getByRole('button', { name: '전체' }).className).toContain('bg-[#7FA6C7]');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).not.toContain('bg-[#8F97CF]');
  });

  it('keeps black kiosk theme cart action buttons readable on dark local backgrounds', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '검정 매점', themeColor: 'black', qrManualInputEnabled: true, source: 'runtime' }));
    render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '검정 매점' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    expect(screen.getByRole('button', { name: '비우기' }).className).toContain('bg-[#2B2B2B]');
    expect(screen.getByRole('button', { name: '비우기' }).className).toContain('text-[#FCFCFC]');
    expect(screen.getByText('재고 20').className).toContain('text-[#FCFCFC]');
    expect(screen.getByRole('button', { name: 'QR 결제' }).className).toContain('bg-[#FCFCFC]');
    expect(screen.getByRole('button', { name: 'QR 결제' }).className).toContain('text-[#1F1F1F]');
  });

  it('applies softer pastel theme classes from settings on the kiosk', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '분홍 매점', themeColor: 'pink', qrManualInputEnabled: true, source: 'runtime' }));
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '분홍 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-[#FAEDED]');
    expect(screen.getByRole('button', { name: '전체' }).className).toContain('bg-[#F0C7C7]');
    expect(screen.getByRole('button', { name: '전체' }).className).not.toContain('bg-pink-500');
  });

  it('uses a soft yellow, balanced green, and darker black kiosk shell when selected', async () => {
    for (const [themeColor, expectedShell, rejectedShell] of [
      ['yellow', 'bg-[#FCFAE6]', 'bg-yellow-100'],
      ['green', 'bg-[#DCF5C9]', 'bg-green-50'],
      ['black', 'bg-[#1F1F1F]', 'bg-slate-100'],
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

  it('never requests checkout previews when the cart changes or storefront refreshes', async () => {
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: '연필 수량 늘리기' }));
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('600별');

    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/products')).toHaveLength(2));
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/checkout/preview')).toBe(false);
  });

  it('keeps the main kiosk visible while checkout, processing, and complete steps appear as popups', async () => {
    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    await waitFor(() => expect(screen.getByTestId('checkout-total-bar').textContent).toContain('300별'));

    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    expect(await screen.findByRole('dialog', { name: '결제 확인' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '상품 목록' })).toBeTruthy();
    expect(screen.getByText('결제하려면 카메라에 QR 코드를 인식해주세요.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    expect(await screen.findByRole('dialog', { name: '결제 중' })).toBeTruthy();

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/checkout')).toBe(true));
    const checkoutCall = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === '/api/checkout')!;
    expect(JSON.parse(String(checkoutCall[1]?.body))).toEqual({
      studentId: 'S001', items: [{ productId: 'P001', quantity: 1 }],
      expectedPricing: regularPreview([{ productId: 'P001', quantity: 1 }]),
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
    await waitFor(() => expect(screen.getByRole('button', { name: 'QR 결제' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));

    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'WRONG' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));

    expect(await screen.findByRole('dialog', { name: '결제 실패' })).toBeTruthy();
    expect(screen.getByText('잘못된 QR 코드입니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '다시 시도' })).toBeTruthy();
  });

  it('recovers from malformed QR/student lookup errors instead of staying on the processing popup', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', qrManualInputEnabled: true, source: 'runtime' });
      if (url === '/api/promotions/active') return jsonResponse([]);
      if (url === '/api/checkout/preview' && init?.method === 'POST') return jsonResponse(regularPreview(JSON.parse(String(init.body)).items));
      if (url === '/api/students/BROKEN-QR') throw new SyntaxError('Unexpected token < in JSON');
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<KioskApp />);

    expect(await screen.findByText('연필')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'QR 결제' })).toHaveProperty('disabled', false));
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
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).toContain('bg-[#FAEDED]');
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

  it('renders themed image-overlay promotion pills and simplified instant stacked cart pricing', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: '행사 매점', themeColor: 'white' });
      if (url === '/api/promotions/active') return jsonResponse([percent, nPlusOne]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<KioskApp />);

    const card = await screen.findByRole('button', { name: '연필 270별 담기' });
    expect(within(card).getByText('2+1')).toBeTruthy();
    expect(within(card).getByText('-10%')).toBeTruthy();
    const imageOverlay = within(card).getByLabelText('연필 행사');
    expect(imageOverlay.className).toContain('absolute');
    expect(imageOverlay.className).toContain('bottom-');
    expect(within(card).getByText('300별').className).toContain('line-through');
    expect(within(card).getByText('270별')).toBeTruthy();
    fireEvent.click(card);
    expect(within(screen.getByTestId('cart-item-row')).getByText('2+1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 수량 늘리기' }));
    fireEvent.click(screen.getByRole('button', { name: '연필 수량 늘리기' }));

    const cartRow = screen.getByTestId('cart-item-row');
    expect(within(cartRow).getByLabelText('연필 행사')).toBeTruthy();
    expect(within(cartRow).getByText('900별').className).toContain('line-through');
    expect(within(cartRow).getByText('540별')).toBeTruthy();
    expect(within(cartRow).queryByText(/유료|무료|→/)).toBeNull();
    expect(screen.queryByText(/총 절약/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/checkout/preview')).toBe(false);
  });

  it('calibrates promotion windows from the initial active-promotion response server clock', async () => {
    const futurePercent = {
      ...percent,
      startsAt: '2090-01-01T00:00:00.000Z',
      endsAt: '2090-02-01T00:00:00.000Z',
    };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') {
        return jsonResponse([futurePercent], { headers: { 'x-server-now': '2090-01-15T00:00:00.000Z' } });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<KioskApp />);

    const card = await screen.findByRole('button', { name: '연필 270별 담기' });
    expect(within(card).getByText('-10%')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/checkout/preview')).toBe(false);
  });

  it('fails closed when active promotions are malformed', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') return jsonResponse([{ ...percent, schemaVersion: 2 }]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<KioskApp />);
    expect((await screen.findByRole('alert')).textContent).toContain('행사 정보를 불러오지 못했습니다.');
    expect(screen.getByRole('button', { name: 'QR 결제' })).toHaveProperty('disabled', true);
  });

  it('updates rows and total synchronously and opens QR without a network pricing gate', async () => {
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: '연필 수량 늘리기' }));
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('600별');
    expect(screen.getByTestId('checkout-total-bar').textContent).not.toContain('300별');
    expect(screen.getByRole('button', { name: 'QR 결제' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    expect(screen.getByRole('dialog', { name: '결제 확인' })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/checkout/preview')).toBe(false);
  });

  it('applies a validated 409 latest quote, exits checkout, and requires explicit reconfirmation', async () => {
    const latestPricing = {
      ok: true, totalAmount: 250,
      items: [{ productId: 'P001', name: '연필', price: 250, quantity: 1, subtotal: 250,
        regularUnitPrice: 250, regularTotal: 250, totalQuantity: 1, paidQuantity: 1, freeQuantity: 0,
        finalTotal: 250, totalDiscount: 0, adjustments: [], appliedPromotions: [] }],
    };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([]);
      if (url === '/api/students/S001') return jsonResponse(studentBefore);
      if (url === '/api/checkout') return jsonResponse({ ok: false, code: 'PRICE_CHANGED', message: '가격이 변경되었습니다.', latestPricing }, { status: 409 });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('가격이 변경되었습니다.');
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('250별');
    expect(screen.getByRole('button', { name: 'QR 결제' })).toHaveProperty('disabled', false);
  });

  it('uses commit snapshots and total for completion and stock even when they differ from preview', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([]);
      if (url === '/api/checkout/preview') return jsonResponse(regularPreview([{ productId: 'P001', quantity: 1 }]));
      if (url === '/api/students/S001') return jsonResponse(studentBefore);
      if (url === '/api/checkout' && init?.method === 'POST') return jsonResponse({
        ok: true, transactionId: 'T2', studentId: 'S001', studentName: '김민준', totalAmount: 500,
        balanceBefore: 3500, balanceAfter: 3000,
        items: [{ productId: 'P001', name: '서버 연필', price: 500, quantity: 2, subtotal: 500,
          regularUnitPrice: 500, regularTotal: 1000, totalQuantity: 2, paidQuantity: 1, freeQuantity: 1,
          finalTotal: 500, totalDiscount: 500,
          adjustments: [{ promotionId: 'N21', type: 'N_PLUS_ONE', beforeAmount: 1000, afterAmount: 500, discountAmount: 500, freeQuantity: 1 }],
          appliedPromotions: [nPlusOne] }],
      });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'QR 결제' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(await screen.findByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    const complete = await screen.findByRole('dialog', { name: '결제 완료' });
    expect(within(complete).getByText('서버 연필')).toBeTruthy();
    expect(within(complete).getAllByText('500별').length).toBeGreaterThan(0);
    expect(screen.getByText('재고 18')).toBeTruthy();
  });
});
