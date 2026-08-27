import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KioskApp } from './KioskApp';
import { contrastRatio, THEME_PALETTES, type ThemeColor } from './uiTheme';

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
    vi.useRealTimers();
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
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain('--theme-shell: #FAEDED');
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
    expect(screen.getByRole('button', { name: '행사' })).toBeTruthy();
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

  it('orders 전체, virtual 행사, then real categories without colliding with a real 행사 category', async () => {
    const collisionProducts = [
      products[0],
      { ...products[1], category: '행사', name: '행사 카테고리 상품' },
      products[2],
    ];
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(collisionProducts);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') return jsonResponse([percent]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container } = render(<KioskApp />);

    const tabs = await screen.findByTestId('category-tabs');
    expect(within(tabs).getAllByRole('button').map((button) => button.textContent)).toEqual(['전체', '행사', '문구', '행사 카테고리', '간식']);
    expect(within(tabs).getByRole('button', { name: '행사' })).toBeTruthy();
    expect(within(tabs).getByRole('button', { name: '카테고리 행사' })).toBeTruthy();

    fireEvent.click(within(tabs).getByRole('button', { name: '행사' }));
    expect(screen.getByText('연필')).toBeTruthy();
    expect(screen.queryByText('행사 카테고리 상품')).toBeNull();
    expect(container.querySelector('[data-testid="product-grid"]')?.textContent).not.toContain('마이쮸');

    fireEvent.click(within(tabs).getByRole('button', { name: '카테고리 행사' }));
    expect(screen.getByText('행사 카테고리 상품')).toBeTruthy();
    expect(screen.queryByText('연필')).toBeNull();
  });

  it('keeps the virtual promotion filter selected across refreshes', async () => {
    let productLoads = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') {
        productLoads += 1;
        return jsonResponse(productLoads === 1 ? products : products.map((product) => ({ ...product, category: '새 분류' })));
      }
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') return jsonResponse([percent]);
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<KioskApp />);

    const promotionTab = await screen.findByRole('button', { name: '행사' });
    fireEvent.click(promotionTab);
    expect(promotionTab.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    await waitFor(() => expect(productLoads).toBe(2));
    expect(screen.getByRole('button', { name: '행사' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('연필')).toBeTruthy();
  });

  it('uses the calibrated clock for promotion expiry and shows a promotion-filter empty state', async () => {
    const expiring = { ...percent, startsAt: '2090-01-01T00:00:00.000Z', endsAt: '2090-02-01T00:00:00.000Z' };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') return jsonResponse([expiring], { headers: { 'x-server-now': expiring.endsAt } });
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<KioskApp />);

    fireEvent.click(await screen.findByRole('button', { name: '행사' }));
    expect(screen.getByText('진행 중인 행사 상품이 없습니다.')).toBeTruthy();
    expect(screen.queryByText('연필')).toBeNull();
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
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain('--theme-shell: #FCFCFC');
    expect(container.querySelector('[data-testid="products-panel"]')?.className).toContain('border-[var(--theme-border)]');
  });

  it('applies the new navy theme from settings', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '남색 매점', themeColor: 'navy', qrManualInputEnabled: true, source: 'runtime' }));
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '남색 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain('--theme-shell: #111A2E');
    expect(container.querySelector('[data-testid="products-panel"]')?.className).toContain('bg-[var(--theme-surface)]');
    expect(screen.getByRole('button', { name: '전체' }).className).toContain('bg-[var(--theme-accent-solid)]');
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.className).not.toContain('bg-[#8F97CF]');
  });

  it('keeps black kiosk theme cart action buttons readable on dark local backgrounds', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '검정 매점', themeColor: 'black', qrManualInputEnabled: true, source: 'runtime' }));
    render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '검정 매점' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '연필 300별 담기' }));
    expect(screen.getByRole('button', { name: '비우기' }).className).toContain('bg-[var(--theme-accent-soft)]');
    expect(screen.getByRole('button', { name: '비우기' }).className).toContain('text-[var(--theme-accent-text)]');
    expect(screen.getByText('재고 20').className).toContain('text-[var(--theme-accent-text)]');
    expect(screen.getByRole('button', { name: 'QR 결제' }).className).toContain('bg-[var(--theme-accent-solid)]');
    expect(screen.getByRole('button', { name: 'QR 결제' }).className).toContain('text-[var(--theme-accent-on-solid)]');
    expect(screen.getAllByTestId('product-card')[0].className).toContain('bg-[var(--theme-content-card)]');
    expect(screen.getByTestId('cart-item-row').className).toContain('bg-[var(--theme-surface-raised)]');
    for (const button of [
      screen.getByRole('button', { name: '연필 수량 줄이기' }),
      screen.getByRole('button', { name: '연필 수량 늘리기' }),
    ]) {
      expect(button.className).toContain('bg-[var(--theme-accent-soft)]');
      expect(button.className).toContain('text-[var(--theme-accent-text)]');
      expect(button.className).not.toContain('bg-[var(--theme-accent-solid)]');
    }
  });

  it('keeps white-theme cart quantity controls distinct from the cart row', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ currencyUnit: '별', appTitle: '흰색 매점', themeColor: 'white' }));
    render(<KioskApp />);

    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    const decreaseButton = screen.getByRole('button', { name: '연필 수량 줄이기' });
    const increaseButton = screen.getByRole('button', { name: '연필 수량 늘리기' });
    for (const button of [decreaseButton, increaseButton]) {
      expect(button.className).toContain('bg-[var(--theme-accent-solid)]');
      expect(button.className).toContain('text-[var(--theme-accent-on-solid)]');
      expect(button.className).not.toContain('bg-[var(--theme-accent-soft)]');
    }
    const cartRow = screen.getByTestId('cart-item-row');
    expect(cartRow.className).toContain('bg-[var(--theme-content-card)]');
    expect(cartRow.className).not.toContain('bg-[var(--theme-surface-raised)]');
    expect(contrastRatio(THEME_PALETTES.white.accentSolid, THEME_PALETTES.white.contentCard)).toBeGreaterThanOrEqual(3);
  });

  it('applies softer pastel theme classes from settings on the kiosk', async () => {
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
    vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: '분홍 매점', themeColor: 'pink', qrManualInputEnabled: true, source: 'runtime' }));
    const { container } = render(<KioskApp />);

    expect(await screen.findByRole('heading', { name: '분홍 매점' })).toBeTruthy();
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain('--theme-shell: #FAEDED');
    expect(screen.getByRole('button', { name: '전체' }).className).toContain('bg-[var(--theme-accent-solid)]');
    expect(screen.getByRole('button', { name: '전체' }).className).not.toContain('bg-pink-500');
  });

  it('applies paired semantic hover foreground and background classes to hoverable controls', async () => {
    render(<KioskApp />);
    await screen.findByRole('heading', { name: '햇살반 매점' });
    for (const control of [screen.getByRole('button', { name: '새로고침' }), screen.getByRole('button', { name: 'QR 결제' })]) {
      expect(control.className).toContain('hover:bg-[var(--theme-hover)]');
      expect(control.className).toContain('hover:text-[var(--theme-hover-text)]');
    }
  });

  it('uses a soft yellow, balanced green, and darker black kiosk shell when selected', async () => {
    for (const [themeColor, expectedShell, rejectedShell] of [
      ['yellow', '#FCFAE6', 'bg-yellow-100'],
      ['green', '#DCF5C9', 'bg-green-50'],
      ['black', '#1F1F1F', 'bg-slate-100'],
    ] as const) {
      cleanup();
      vi.mocked(fetch).mockReset();
      vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse(products));
      vi.mocked(fetch).mockImplementationOnce(async () => jsonResponse({ spreadsheetId: 'sheet-123', currencyUnit: '별', appTitle: `${themeColor} 매점`, themeColor, source: 'runtime' }));

      const { container } = render(<KioskApp />);

      expect(await screen.findByRole('heading', { name: `${themeColor} 매점` })).toBeTruthy();
      const shell = container.querySelector('[data-testid="kiosk-shell"]');
      const shellClass = shell?.className ?? '';
      expect(shell?.getAttribute('style')).toContain(`--theme-shell: ${expectedShell}`);
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
    expect(screen.getByRole('heading', { name: '상품 목록', hidden: true })).toBeTruthy();
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
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain('--theme-shell: #FAEDED');
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

    const card = await screen.findByRole('button', { name: /연필 270별 담기/ });
    expect(within(card).getByText('2+1')).toBeTruthy();
    expect(within(card).getByText('할인')).toBeTruthy();
    const imageOverlay = within(card).getByLabelText('연필 행사');
    expect(imageOverlay.className).toContain('absolute');
    expect(imageOverlay.className).toContain('top-1');
    expect(imageOverlay.className).not.toContain('bottom-');
    expect(within(card).getByText('할인').className).toContain('text-[clamp(0.62rem,2.4vw,1.125rem)]');
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

    const card = await screen.findByRole('button', { name: /연필 270별 담기/ });
    expect(within(card).getByText('할인')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === '/api/checkout/preview')).toBe(false);
  });

  it('does not let an older overlapping refresh recalibrate the clock after a newer refresh wins', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2090-01-15T00:00:00.000Z'));
    const windowedPercent = {
      ...percent,
      startsAt: '2090-01-01T00:00:00.000Z',
      endsAt: '2090-02-01T00:00:00.000Z',
    };
    let promotionLoads = 0;
    let releaseOlderRefresh!: () => void;
    const olderRefreshGate = new Promise<void>((resolve) => { releaseOlderRefresh = resolve; });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') {
        promotionLoads += 1;
        if (promotionLoads === 1) return jsonResponse([windowedPercent], { headers: { 'x-server-now': '2090-01-15T00:00:00.000Z' } });
        if (promotionLoads === 2) {
          return olderRefreshGate.then(() => jsonResponse([windowedPercent], { headers: { 'x-server-now': '2090-03-01T00:00:00.000Z' } }));
        }
        return jsonResponse([windowedPercent], { headers: { 'x-server-now': '2090-01-20T00:00:00.000Z' } });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<KioskApp />);
    expect(await screen.findByRole('button', { name: /연필 270별 담기/ })).toBeTruthy();
    const refreshButton = screen.getByRole('button', { name: '새로고침' });
    act(() => {
      refreshButton.click();
      refreshButton.click();
    });
    await waitFor(() => expect(promotionLoads).toBe(3));
    expect(screen.getByRole('button', { name: /연필 270별 담기/ })).toBeTruthy();

    await act(async () => { releaseOlderRefresh(); });
    await act(async () => { vi.advanceTimersByTime(60_000); });

    expect(screen.getByRole('button', { name: /연필 270별 담기/ })).toBeTruthy();
    expect(within(screen.getByRole('button', { name: /연필 270별 담기/ })).getByText('할인')).toBeTruthy();
    vi.useRealTimers();
  });

  it.each(['black', 'navy'] as const)('renders muted %s-theme kiosk and modal text with semantic AA colors', async (themeColor) => {
    let resolveStudent!: () => void;
    const studentGate = new Promise<void>((resolve) => { resolveStudent = resolve; });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', appTitle: `${themeColor} 매점`, themeColor, qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([percent]);
      if (url === '/api/students/S001') return studentGate.then(() => jsonResponse(studentBefore));
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    const { container } = render(<KioskApp />);
    const palette = THEME_PALETTES[themeColor as ThemeColor];
    const expectSemanticMuted = (element: HTMLElement, background: string) => {
      expect(element.className).toContain('text-[var(--theme-muted-text)]');
      expect(element.className).not.toMatch(/text-slate-(500|600|700)/);
      expect(contrastRatio(palette.mutedText, background)).toBeGreaterThanOrEqual(4.5);
    };

    const card = await screen.findByRole('button', { name: /연필 270별 담기/ });
    expectSemanticMuted(within(card).getByLabelText('정상 가격 300별'), palette.surfaceRaised);
    expectSemanticMuted(screen.getByText('선택한 상품이 없습니다.'), palette.surfaceRaised);
    expectSemanticMuted(within(screen.getByTestId('checkout-total-bar')).getByText('확인 중'), palette.surfaceRaised);

    fireEvent.click(card);
    const cartRow = screen.getByTestId('cart-item-row');
    expectSemanticMuted(within(cartRow).getByLabelText('정상 합계 300별'), palette.surfaceRaised);
    expectSemanticMuted(within(screen.getByTestId('checkout-total-bar')).getByLabelText('정상 총액 300별'), palette.surfaceRaised);
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    const checkoutDialog = await screen.findByRole('dialog', { name: '결제 확인' });
    expectSemanticMuted(within(checkoutDialog).getByText('300별'), palette.surfaceRaised);
    fireEvent.change(within(checkoutDialog).getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(within(checkoutDialog).getByRole('button', { name: 'QR 값으로 결제하기' }));
    const processingDialog = await screen.findByRole('dialog', { name: '결제 중' });
    expectSemanticMuted(within(processingDialog).getByText('학급 화폐 잔액과 재고를 확인하고 있습니다.'), palette.surface);
    expect(container.querySelector('[data-testid="kiosk-shell"]')?.getAttribute('style')).toContain(`--theme-muted-text: ${palette.mutedText}`);
    resolveStudent();
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

  it('adopts an in-flight 409 quote after the local promotion boundary and reconfirms that server quote', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2090-01-01T00:00:00.000Z'));
    const expiring = { ...percent, startsAt: '2089-01-01T00:00:00.000Z', endsAt: '2090-01-01T00:00:30.000Z' };
    const original = regularPreview([{ productId: 'P001', quantity: 1 }]).items[0];
    const latestPricing = { ok: true, totalAmount: 250, items: [{ ...original, price: 250, regularUnitPrice: 250, regularTotal: 250, subtotal: 250, finalTotal: 250 }] };
    let resolveFirstCheckout!: () => void;
    const firstCheckoutGate = new Promise<void>((resolve) => { resolveFirstCheckout = resolve; });
    let checkoutCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([expiring], { headers: { 'x-server-now': '2090-01-01T00:00:00.000Z' } });
      if (url === '/api/students/S001') return jsonResponse(studentBefore);
      if (url === '/api/checkout' && init?.method === 'POST') {
        checkoutCalls += 1;
        if (checkoutCalls === 1) {
          return firstCheckoutGate.then(() => jsonResponse({ code: 'PRICE_CHANGED', message: '가격이 변경되었습니다.', latestPricing }, { status: 409 }));
        }
        return jsonResponse({ code: 'PRICE_CHANGED', message: '서버가 다시 확인했습니다.', latestPricing }, { status: 409 });
      }
      return jsonResponse({}, { status: 404 });
    });

    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: /연필 270별 담기/ }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    await waitFor(() => expect(checkoutCalls).toBe(1));

    await act(async () => { vi.advanceTimersByTime(60_000); });
    resolveFirstCheckout();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('가격이 변경되었습니다.');
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('250별');
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    expect(within(await screen.findByRole('dialog', { name: '결제 확인' })).getAllByText('250별')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    await waitFor(() => expect(checkoutCalls).toBe(2));
    const checkoutRequests = vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === '/api/checkout');
    expect(JSON.parse(String(checkoutRequests[1][1]?.body)).expectedPricing).toEqual(latestPricing);
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

  it('includes visual promotion labels and full promotion names in the product card accessible name', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/promotions/active') return jsonResponse([nPlusOne, percent]);
      return jsonResponse({}, { status: 404 });
    });
    render(<KioskApp />);
    expect(await screen.findByRole('button', {
      name: '연필 270별 담기, 행사: 2+1 (연필 2+1), 할인 (10% 할인)',
    })).toBeTruthy();
  });

  it('does not resurrect a confirmed quote after changing away from and back to the same cart', async () => {
    const original = regularPreview([{ productId: 'P001', quantity: 1 }]).items[0];
    const latestPricing = { ok: true, totalAmount: 250, items: [{ ...original, price: 250, regularUnitPrice: 250, regularTotal: 250, subtotal: 250, finalTotal: 250 }] };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([]);
      if (url === '/api/students/S001') return jsonResponse(studentBefore);
      if (url === '/api/checkout') return jsonResponse({ code: 'PRICE_CHANGED', message: '가격이 변경되었습니다.', latestPricing }, { status: 409 });
      return jsonResponse({}, { status: 404 });
    });
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    await waitFor(() => expect(screen.getByTestId('checkout-total-bar').textContent).toContain('250별'));
    fireEvent.click(screen.getByRole('button', { name: '연필 수량 늘리기' }));
    fireEvent.click(screen.getByRole('button', { name: '연필 수량 줄이기' }));
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('300별');
    expect(screen.getByTestId('checkout-total-bar').textContent).not.toContain('250별');
  });

  it('keeps a newer server quote only while the local temporal pricing fingerprint is unchanged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2090-01-01T00:00:00.000Z'));
    const expiring = { ...percent, startsAt: '2089-01-01T00:00:00.000Z', endsAt: '2090-01-01T00:01:30.000Z' };
    const original = regularPreview([{ productId: 'P001', quantity: 1 }]).items[0];
    const latestPricing = { ok: true, totalAmount: 250, items: [{ ...original, price: 250, regularUnitPrice: 250, regularTotal: 250, subtotal: 250, finalTotal: 250 }] };
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([expiring], { headers: { 'x-server-now': '2090-01-01T00:00:00.000Z' } });
      if (url === '/api/students/S001') return jsonResponse(studentBefore);
      if (url === '/api/checkout') return jsonResponse({ code: 'PRICE_CHANGED', message: '가격이 변경되었습니다.', latestPricing }, { status: 409 });
      return jsonResponse({}, { status: 404 });
    });
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: /연필 270별 담기/ }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    await waitFor(() => expect(screen.getByTestId('checkout-total-bar').textContent).toContain('250별'));
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('250별');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByTestId('checkout-total-bar').textContent).toContain('300별');
    expect(screen.getByTestId('checkout-total-bar').textContent).not.toContain('250별');
  });

  it('uses accessible modal action colors with normal-text contrast', async () => {
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    const cancel = await screen.findByRole('button', { name: '결제 취소' });
    const submit = screen.getByRole('button', { name: 'QR 값으로 결제하기' });
    expect(cancel.className).toContain('bg-rose-700');
    expect(submit.className).toContain('bg-sky-700');
    expect(contrastRatio('#FFFFFF', '#BE123C')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#FFFFFF', '#0369A1')).toBeGreaterThanOrEqual(4.5);
  });

  it('moves focus into the modal, traps Tab, closes with Escape, restores focus, and hides the kiosk', async () => {
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    const trigger = screen.getByRole('button', { name: 'QR 결제' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: '결제 확인' });
    expect(within(dialog).getByRole('button', { name: '결제 취소' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'QR 값으로 결제하기' })).toBeTruthy();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByTestId('kiosk-content').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('kiosk-content').hasAttribute('inert')).toBe(true);
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
      .filter((element) => !(element instanceof HTMLInputElement && element.type === 'hidden'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByTestId('kiosk-content').hasAttribute('aria-hidden')).toBe(false);
  });

  it('does not allow Escape cancellation while payment is processing', async () => {
    let resolveStudent!: () => void;
    const studentGate = new Promise<void>((resolve) => { resolveStudent = resolve; });
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/products') return jsonResponse(products);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별', qrManualInputEnabled: true });
      if (url === '/api/promotions/active') return jsonResponse([]);
      if (url === '/api/students/S001') return studentGate.then(() => jsonResponse(studentBefore));
      return jsonResponse({}, { status: 404 });
    });
    render(<KioskApp />);
    fireEvent.click(await screen.findByRole('button', { name: '연필 300별 담기' }));
    fireEvent.click(screen.getByRole('button', { name: 'QR 결제' }));
    fireEvent.change(screen.getByLabelText('QR 값 직접 입력'), { target: { value: 'S001' } });
    fireEvent.click(screen.getByRole('button', { name: 'QR 값으로 결제하기' }));
    const processing = await screen.findByRole('dialog', { name: '결제 중' });
    fireEvent.keyDown(processing, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '결제 중' })).toBeTruthy();
    resolveStudent();
  });
});
