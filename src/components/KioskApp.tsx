'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import type { CartItem, Product, Student } from '@/domain/types';
import { QrScanner } from './QrScanner';

type PaymentStep = 'checkout' | 'processing' | 'failure' | 'complete';

type CheckoutSuccess = {
  ok: true;
  transactionId: string;
  studentId: string;
  studentName: string;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
};

type PaymentResult = CheckoutSuccess & {
  studentNumber?: number;
};

type ApiError = {
  error?: string;
  message?: string;
  code?: string;
  currentBalance?: number;
  requiredAmount?: number;
};

type FailureState = {
  title: string;
  message: string;
  detail?: string;
};

type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple';

type KioskSettings = { currencyUnit?: string; appTitle?: string; themeColor?: ThemeColor };

const THEME_STYLES: Record<ThemeColor, { shell: string; accentText: string; accentBg: string; lightBg: string; hoverBg: string; ring: string }> = {
  blue: { shell: 'bg-sky-100', accentText: 'text-sky-700', accentBg: 'bg-sky-500', lightBg: 'bg-sky-100', hoverBg: 'hover:bg-sky-400', ring: 'focus:ring-sky-300' },
  pink: { shell: 'bg-pink-100', accentText: 'text-pink-700', accentBg: 'bg-pink-500', lightBg: 'bg-pink-100', hoverBg: 'hover:bg-pink-400', ring: 'focus:ring-pink-300' },
  yellow: { shell: 'bg-yellow-100', accentText: 'text-yellow-700', accentBg: 'bg-yellow-400', lightBg: 'bg-yellow-100', hoverBg: 'hover:bg-yellow-300', ring: 'focus:ring-yellow-300' },
  green: { shell: 'bg-green-100', accentText: 'text-green-700', accentBg: 'bg-green-500', lightBg: 'bg-green-100', hoverBg: 'hover:bg-green-400', ring: 'focus:ring-green-300' },
  purple: { shell: 'bg-purple-100', accentText: 'text-purple-700', accentBg: 'bg-purple-500', lightBg: 'bg-purple-100', hoverBg: 'hover:bg-purple-400', ring: 'focus:ring-purple-300' },
};

function normalizeThemeColor(value: unknown): ThemeColor {
  return value === 'pink' || value === 'yellow' || value === 'green' || value === 'purple' ? value : 'blue';
}

function isApiError(payload: unknown): payload is ApiError {
  return Boolean(payload && typeof payload === 'object' && ('error' in payload || 'message' in payload));
}

function formatCurrency(amount: number, unit: string) {
  return `${amount.toLocaleString()}${unit}`;
}

export function KioskApp() {
  const [products, setProducts] = useState<Product[]>([]);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [manualQrValue, setManualQrValue] = useState('');
  const [message, setMessage] = useState('');
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [paymentStep, setPaymentStep] = useState<PaymentStep | null>(null);
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(null);
  const [completedCartDetails, setCompletedCartDetails] = useState<CartDetail[]>([]);
  const [failure, setFailure] = useState<FailureState | null>(null);
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [appTitle, setAppTitle] = useState('학급 매점');
  const [themeColor, setThemeColor] = useState<ThemeColor>('blue');
  const [selectedCategory, setSelectedCategory] = useState('전체');

  const loadProducts = useCallback(async (options: { shouldApply?: () => boolean } = {}) => {
    setIsLoadingProducts(true);
    try {
      const [productResponse, settingsResponse] = await Promise.all([
        fetch('/api/products', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
      ]);
      const payload = (await productResponse.json()) as Product[] | ApiError;
      const settings = await settingsResponse.json().catch(() => null) as KioskSettings | null;

      if (!productResponse.ok || !Array.isArray(payload)) {
        throw new Error('상품 정보를 불러오지 못했습니다.');
      }

      if (options.shouldApply?.() === false) return;
      setProducts(payload);
      setSelectedCategory((current) => current === '전체' || payload.some((product) => (product.category || '기타') === current) ? current : '전체');
      if (settings?.currencyUnit) setCurrencyUnit(settings.currencyUnit);
      if (settings?.appTitle) setAppTitle(settings.appTitle);
      setThemeColor(normalizeThemeColor(settings?.themeColor));
      setMessage('');
    } catch (error) {
      if (options.shouldApply?.() !== false) setMessage(error instanceof Error ? error.message : '상품 정보를 불러오지 못했습니다.');
    } finally {
      if (options.shouldApply?.() !== false) setIsLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    void Promise.resolve().then(() => loadProducts({ shouldApply: () => !ignore }));
    return () => {
      ignore = true;
    };
  }, [loadProducts]);

  const cartDetails = useMemo(() => {
    return cartItems
      .map((item) => {
        const product = products.find((candidate) => candidate.productId === item.productId);
        if (!product) return null;

        return {
          ...item,
          name: product.name,
          price: product.price,
          stock: product.stock,
          subtotal: product.price * item.quantity,
        };
      })
      .filter((item): item is CartItem & { name: string; price: number; stock: number; subtotal: number } => Boolean(item));
  }, [cartItems, products]);

  const totalAmount = cartDetails.reduce((sum, item) => sum + item.subtotal, 0);
  const categories = useMemo(() => ['전체', ...Array.from(new Set(products.map((product) => product.category || '기타')))], [products]);
  const filteredProducts = selectedCategory === '전체' ? products : products.filter((product) => (product.category || '기타') === selectedCategory);
  const theme = THEME_STYLES[themeColor];
  const quantityButtonClass = `flex h-[clamp(1.5rem,5vw,2rem)] w-[clamp(1.5rem,5vw,2rem)] shrink-0 items-center justify-center rounded-md ${theme.lightBg} text-[clamp(1rem,3vw,1.25rem)] font-black ${theme.accentText}`;

  function addToCart(productId: string) {
    setMessage('');
    setCartItems((currentItems) => {
      const product = products.find((candidate) => candidate.productId === productId);
      if (!product || !product.isActive || product.stock <= 0) return currentItems;

      const existing = currentItems.find((item) => item.productId === productId);
      const currentQuantity = existing?.quantity ?? 0;
      if (currentQuantity >= product.stock) {
        setMessage('재고보다 많이 담을 수 없습니다.');
        return currentItems;
      }

      if (existing) {
        return currentItems.map((item) =>
          item.productId === productId ? { ...item, quantity: item.quantity + 1 } : item,
        );
      }

      return [...currentItems, { productId, quantity: 1 }];
    });
  }

  function removeFromCart(productId: string) {
    setCartItems((currentItems) =>
      currentItems.flatMap((item) => {
        if (item.productId !== productId) return [item];
        if (item.quantity <= 1) return [];
        return [{ ...item, quantity: item.quantity - 1 }];
      }),
    );
  }

  function clearCart() {
    setCartItems([]);
    setMessage('');
  }

  function openCheckout() {
    if (cartItems.length === 0) {
      setMessage('장바구니가 비어 있습니다.');
      return;
    }

    setFailure(null);
    setPaymentResult(null);
    setManualQrValue('');
    setPaymentStep('checkout');
  }

  async function completeCheckoutWithQrValue(qrValue: string) {
    if (isCheckingOut) return;

    const studentId = qrValue.trim();

    if (!studentId) {
      setFailure({ title: '결제 실패', message: '잘못된 QR 코드입니다.' });
      setPaymentStep('failure');
      return;
    }

    if (cartItems.length === 0) {
      setFailure({ title: '결제 실패', message: '장바구니가 비어 있습니다.' });
      setPaymentStep('failure');
      return;
    }

    setIsCheckingOut(true);
    setFailure(null);
    setPaymentStep('processing');

    try {
      const studentResponse = await fetch(`/api/students/${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const studentPayload = (await studentResponse.json()) as Student | ApiError;

      if (!studentResponse.ok || isApiError(studentPayload)) {
        setFailure({
          title: '결제 실패',
          message: isApiError(studentPayload) ? studentPayload.error || '잘못된 QR 코드입니다.' : '잘못된 QR 코드입니다.',
        });
        setPaymentStep('failure');
        return;
      }

      const checkoutResponse = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: studentPayload.studentId, items: cartItems }),
      });
      const checkoutPayload = (await checkoutResponse.json()) as CheckoutSuccess | ApiError;

      if (!checkoutResponse.ok || !('ok' in checkoutPayload) || checkoutPayload.ok !== true) {
        const errorMessage =
          ('message' in checkoutPayload && checkoutPayload.message) ||
          ('error' in checkoutPayload && checkoutPayload.error) ||
          '결제에 실패했습니다.';
        const detail =
          'currentBalance' in checkoutPayload && typeof checkoutPayload.currentBalance === 'number'
            ? `현재 잔액: ${formatCurrency(checkoutPayload.currentBalance, currencyUnit)}`
            : undefined;

        setFailure({ title: '결제 실패', message: errorMessage, detail });
        setPaymentStep('failure');
        return;
      }

      setProducts((currentProducts) =>
        currentProducts.map((product) => {
          const cartItem = cartItems.find((item) => item.productId === product.productId);
          return cartItem ? { ...product, stock: product.stock - cartItem.quantity } : product;
        }),
      );
      setPaymentResult({ ...checkoutPayload, studentNumber: studentPayload.number });
      setCompletedCartDetails(cartDetails);
      setCartItems([]);
      setManualQrValue('');
      setPaymentStep('complete');
    } catch {
      setFailure({ title: '결제 실패', message: '잘못된 QR 코드입니다.' });
      setPaymentStep('failure');
    } finally {
      setIsCheckingOut(false);
    }
  }

  function handleManualQrSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void completeCheckoutWithQrValue(manualQrValue);
  }

  function resetToShop() {
    setPaymentStep(null);
    setPaymentResult(null);
    setCompletedCartDetails([]);
    setFailure(null);
    setManualQrValue('');
    setMessage('');
    setCartItems([]);
  }

  function retryPayment() {
    setFailure(null);
    setManualQrValue('');
    setPaymentStep('checkout');
  }

  return (
    <main data-testid="kiosk-shell" className={`h-screen overflow-hidden ${theme.shell} p-2 text-slate-950 sm:p-3`}>
      <section data-testid="kiosk-content" className="mx-auto grid h-full w-full max-w-[1240px] grid-rows-[auto_minmax(0,1fr)] gap-2 sm:gap-3">
        <header className="relative grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center rounded-[1.25rem] border border-slate-300/70 bg-white px-2 py-2 text-center text-[clamp(0.75rem,2.6vw,1rem)] shadow-sm sm:grid-cols-[3rem_minmax(0,1fr)_3rem] sm:rounded-[1.75rem] sm:px-4 sm:py-4">
          <div aria-hidden="true" />
          <h1 data-testid="kiosk-title" className="min-w-0 truncate text-[clamp(1.25rem,6vw,3rem)] font-black leading-tight tracking-tight">{appTitle}</h1>
          <button type="button" onClick={() => void loadProducts()} aria-label="새로고침" className={`flex h-9 w-9 items-center justify-center justify-self-end rounded-full ${theme.lightBg} text-[clamp(1rem,3vw,1.25rem)] font-black ${theme.accentText} transition ${theme.hoverBg} sm:h-10 sm:w-10`}>↻</button>
        </header>

        <div data-testid="kiosk-main-grid" className="grid min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,1fr)] gap-2 landscape:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] landscape:grid-rows-1 sm:gap-3">
          <section data-testid="products-panel" className="flex min-h-0 flex-col rounded-[1.25rem] border border-slate-300/70 bg-white/85 p-2 text-[clamp(0.68rem,2.1vw,1rem)] shadow-sm sm:rounded-[1.75rem] sm:p-4 lg:min-h-0">
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <h2 className="text-[clamp(1rem,4vw,1.5rem)] font-black leading-tight">상품 목록</h2>
            {isLoadingProducts ? <p className={`rounded-full ${theme.lightBg} px-2 py-0.5 text-[clamp(0.62rem,2.2vw,0.875rem)] font-black ${theme.accentText} sm:px-3 sm:py-1`}>불러오는 중</p> : null}
          </div>

          <div data-testid="category-tabs" className="mt-2 flex shrink-0 gap-1 overflow-x-auto pb-1 sm:gap-2">
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[clamp(0.62rem,2.1vw,0.875rem)] font-black transition sm:px-3 ${selectedCategory === category ? `${theme.accentBg} text-white` : `${theme.lightBg} ${theme.accentText}`}`}
              >
                {category}
              </button>
            ))}
          </div>

          <div data-testid="product-scroll-block" className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 sm:mt-2">
            <div data-testid="product-grid" className="grid grid-cols-3 gap-1.5 sm:gap-2 md:gap-3">
              {filteredProducts.map((product) => (
                <button
                  key={product.productId}
                  onClick={() => addToCart(product.productId)}
                  disabled={!product.isActive || product.stock <= 0}
                  aria-label={`${product.name} ${formatCurrency(product.price, currencyUnit)} 담기`}
                  data-testid="product-card"
                  className="rounded-[0.8rem] border border-slate-300 bg-white p-1 text-left text-[clamp(0.62rem,2vw,1rem)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50 sm:rounded-[0.9rem] sm:p-3"
                >
                  <p className="truncate text-[clamp(0.55rem,1.8vw,0.75rem)] font-black">{product.category || '기타'}</p>
                  <div className="mt-1 flex aspect-[4/3] items-center justify-center rounded-md bg-slate-200 text-[clamp(1.5rem,8vw,3rem)] text-white sm:mt-2">
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.imageUrl} alt={`${product.name} 이미지`} className="h-full w-full object-cover" />
                    ) : (
                      <span aria-hidden="true">▵</span>
                    )}
                  </div>
                  <p className="mt-1 truncate text-[clamp(0.62rem,2.4vw,1.125rem)] font-black leading-tight sm:mt-2">{product.name}</p>
                  <div data-testid="product-card-footer" className="mt-1 flex flex-row items-end justify-between gap-1 sm:gap-2">
                    <p className="min-w-0 truncate text-[clamp(0.62rem,2.3vw,1.25rem)] font-black leading-tight">{formatCurrency(product.price, currencyUnit)}</p>
                    <p data-testid="product-card-stock" className={`shrink-0 whitespace-nowrap rounded-full ${theme.lightBg} px-1 py-0.5 text-[clamp(0.55rem,1.8vw,0.75rem)] font-black leading-tight text-slate-700 sm:px-2 sm:py-1`}>재고 {product.stock}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
          </section>

          <section data-testid="cart-panel" className="flex min-h-0 flex-col rounded-[1.25rem] border border-slate-300/70 bg-white/90 p-2 text-[clamp(0.68rem,2.1vw,1rem)] shadow-sm sm:rounded-[1.75rem] sm:p-4 lg:min-h-0">
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <h2 className="text-[clamp(1rem,4vw,1.5rem)] font-black leading-tight">장바구니 ({cartDetails.length})</h2>
            <button
              onClick={clearCart}
              disabled={cartItems.length === 0}
              className={`rounded-xl ${theme.lightBg} px-2 py-1.5 text-[clamp(0.75rem,2.6vw,1rem)] font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:py-2`}
            >
              비우기
            </button>
          </div>

          <div data-testid="cart-scroll-block" className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1 sm:mt-3">
            {cartDetails.length === 0 ? (
              <div className="flex h-full min-h-12 items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white text-[clamp(0.75rem,2.8vw,1rem)] text-slate-500 sm:min-h-16">
                선택한 상품이 없습니다.
              </div>
            ) : (
              <div className="space-y-2">
                {cartDetails.map((item) => (
                  <div key={item.productId} data-testid="cart-item-row" className="grid grid-cols-[minmax(0,3fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-[clamp(0.68rem,2.2vw,1rem)] shadow-sm sm:grid-cols-[minmax(0,3fr)_minmax(0,1fr)_auto] sm:gap-x-3 sm:px-3 sm:py-2">
                    <p data-testid="cart-item-name" className="min-w-0 truncate text-[clamp(0.75rem,2.8vw,1.125rem)] font-black leading-tight">{item.name}</p>
                    <div data-testid="cart-quantity-controls" className="flex justify-self-start items-center gap-1 landscape:justify-self-start sm:gap-2">
                      <button
                        aria-label={`${item.name} 수량 줄이기`}
                        onClick={() => removeFromCart(item.productId)}
                        className={quantityButtonClass}
                      >
                        −
                      </button>
                      <span className="w-[clamp(1.25rem,4vw,1.75rem)] text-center text-[clamp(0.85rem,2.8vw,1.125rem)] font-black">{item.quantity}</span>
                      <button
                        aria-label={`${item.name} 수량 늘리기`}
                        onClick={() => addToCart(item.productId)}
                        className={quantityButtonClass}
                      >
                        +
                      </button>
                    </div>
                    <p className="col-span-2 text-right text-[clamp(0.75rem,2.8vw,1.125rem)] font-black leading-tight sm:col-span-1 sm:w-20 md:w-24">{formatCurrency(item.subtotal, currencyUnit)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {message ? <p className="mt-2 rounded-xl bg-amber-100 p-2 text-[clamp(0.7rem,2.4vw,0.875rem)] font-bold text-amber-900">{message}</p> : null}

          <div data-testid="checkout-total-bar" className="mt-2 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2 text-[clamp(0.7rem,2.4vw,1rem)] shadow-sm sm:mt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 sm:block">
              <p className="text-[clamp(0.8rem,2.8vw,1.25rem)] font-black leading-tight">총 결제 금액</p>
              <p className={`text-[clamp(1.2rem,5vw,1.875rem)] font-black leading-tight ${theme.accentText}`}>{formatCurrency(totalAmount, currencyUnit)}</p>
            </div>
            <button
              data-testid="checkout-button"
              onClick={openCheckout}
              disabled={cartItems.length === 0}
              className={`w-full rounded-xl ${theme.accentBg} px-4 py-2.5 text-[clamp(1rem,4vw,1.5rem)] font-black text-white shadow-sm transition ${theme.hoverBg} disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto sm:min-w-44 sm:px-6 sm:py-3`}
            >
              QR 결제
            </button>
          </div>
          </section>
        </div>
      </section>

      {paymentStep ? (
        <PaymentModal
          step={paymentStep}
          cartDetails={cartDetails}
          totalAmount={totalAmount}
          manualQrValue={manualQrValue}
          setManualQrValue={setManualQrValue}
          onManualQrSubmit={handleManualQrSubmit}
          onScan={completeCheckoutWithQrValue}
          onCancel={() => setPaymentStep(null)}
          onRetry={retryPayment}
          onReset={resetToShop}
          isCheckingOut={isCheckingOut}
          paymentResult={paymentResult}
          completedCartDetails={completedCartDetails}
          failure={failure}
          currencyUnit={currencyUnit}
          themeColor={themeColor}
        />
      ) : null}
    </main>
  );
}

type CartDetail = CartItem & { name: string; price: number; stock: number; subtotal: number };

type PaymentModalProps = {
  step: PaymentStep;
  cartDetails: CartDetail[];
  totalAmount: number;
  manualQrValue: string;
  setManualQrValue: (value: string) => void;
  onManualQrSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onScan: (decodedText: string) => void;
  onCancel: () => void;
  onRetry: () => void;
  onReset: () => void;
  isCheckingOut: boolean;
  paymentResult: PaymentResult | null;
  completedCartDetails: CartDetail[];
  failure: FailureState | null;
  currencyUnit: string;
  themeColor: ThemeColor;
};

function PaymentModal({
  step,
  cartDetails,
  totalAmount,
  manualQrValue,
  setManualQrValue,
  onManualQrSubmit,
  onScan,
  onCancel,
  onRetry,
  onReset,
  isCheckingOut,
  paymentResult,
  completedCartDetails,
  failure,
  currencyUnit,
  themeColor,
}: PaymentModalProps) {
  const theme = THEME_STYLES[themeColor];
  const dialogLabel = step === 'checkout' ? '결제 확인' : step === 'processing' ? '결제 중' : step === 'failure' ? '결제 실패' : '결제 완료';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/65 p-3 sm:p-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        className="max-h-[calc(100vh-1.5rem)] w-full max-w-[720px] overflow-y-auto rounded-[1.5rem] bg-white p-4 shadow-2xl sm:max-h-[calc(100vh-2rem)] sm:rounded-[1.75rem] md:p-5"
      >
        {step === 'checkout' ? (
          <>
            <h2 className="text-2xl font-black sm:text-3xl">결제 확인</h2>
            <CartSummary cartDetails={cartDetails} totalAmount={totalAmount} accent={theme.accentText} currencyUnit={currencyUnit} />
            <div className="mt-5 grid gap-5 md:grid-cols-[1fr_180px] md:items-center">
              <div className="rounded-[1.5rem] bg-black p-3">
                <QrScanner onScan={onScan} />
              </div>
              <div className="text-center md:text-left">
                <p className={`text-xl font-black leading-tight ${theme.accentText} sm:text-2xl`}>결제하려면 카메라에 QR 코드를 인식해주세요.</p>
                <button onClick={onCancel} className="mt-5 w-full rounded-xl bg-rose-400 py-3 text-xl font-black text-white">
                  결제 취소
                </button>
              </div>
            </div>
            <form onSubmit={onManualQrSubmit} className="mt-4 flex flex-col gap-2 rounded-xl bg-slate-100 p-3 sm:flex-row">
              <label className="sr-only" htmlFor="manual-qr-value">
                QR 값 직접 입력
              </label>
              <input
                id="manual-qr-value"
                value={manualQrValue}
                onChange={(event) => setManualQrValue(event.target.value)}
                placeholder="카메라가 안 되면 예: S001"
                className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg font-bold outline-none focus:border-sky-400"
              />
              <button type="submit" disabled={isCheckingOut} className="rounded-xl bg-sky-500 px-5 py-3 text-lg font-black text-white disabled:bg-slate-300">
                QR 값으로 결제하기
              </button>
            </form>
          </>
        ) : null}

        {step === 'processing' ? (
          <div className="py-16 text-center">
            <div className="mx-auto h-16 w-16 animate-spin rounded-full border-8 border-slate-200 border-t-sky-500" />
            <h2 className="mt-8 text-4xl font-black">결제 중</h2>
            <p className="mt-3 text-xl font-bold text-slate-500">학급 화폐 잔액과 재고를 확인하고 있습니다.</p>
          </div>
        ) : null}

        {step === 'failure' ? (
          <div className="py-8 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-rose-100 text-5xl text-rose-500">!</div>
            <h2 className="mt-6 text-4xl font-black">결제 실패</h2>
            <p className="mt-4 text-2xl font-black text-rose-500">{failure?.message || '결제에 실패했습니다.'}</p>
            {failure?.detail ? <p className="mt-2 text-xl font-black text-rose-400">{failure.detail}</p> : null}
            <div className="mt-8 flex gap-3">
              <button onClick={onCancel} className="flex-1 rounded-xl bg-slate-200 py-4 text-xl font-black text-slate-700">
                결제 취소
              </button>
              <button onClick={onRetry} className="flex-1 rounded-xl bg-sky-500 py-4 text-xl font-black text-white">
                다시 시도
              </button>
            </div>
          </div>
        ) : null}

        {step === 'complete' && paymentResult ? (
          <div className="py-4 text-center">
            <h2 className="text-4xl font-black">결제가 완료되었습니다.</h2>
            <div className="mt-6 flex justify-between gap-4 text-lg font-bold">
              <p>결제 일시: {new Date().toLocaleString('ko-KR', { hour12: false })}</p>
              <p>결제자: {paymentResult.studentName}</p>
            </div>
            <CartSummary cartDetails={completedCartDetails} totalAmount={paymentResult.totalAmount} accent="text-slate-950" showTotal={false} currencyUnit={currencyUnit} />
            <div className="mt-5 space-y-3 text-left">
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-2xl font-black">총 결제 금액</p>
                <p className="text-3xl font-black">{formatCurrency(paymentResult.totalAmount, currencyUnit)}</p>
              </div>
              <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-2xl font-black">결제 후 잔액</p>
                <p className={`text-3xl font-black ${theme.accentText}`}>{formatCurrency(paymentResult.balanceAfter, currencyUnit)}</p>
              </div>
            </div>
            <button onClick={onReset} className={`mt-7 rounded-xl ${theme.accentBg} px-12 py-4 text-4xl font-black text-white shadow-sm`}>
              처음으로
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function CartSummary({
  cartDetails,
  totalAmount,
  accent,
  showTotal = true,
  currencyUnit,
}: {
  cartDetails: CartDetail[];
  totalAmount: number;
  accent: string;
  showTotal?: boolean;
  currencyUnit: string;
}) {
  return (
    <div className="mt-4 space-y-3">
      {cartDetails.map((item) => (
        <div key={item.productId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4 sm:px-4">
          <p className="truncate text-lg font-black sm:text-xl">{item.name}</p>
          <p className="text-lg font-black sm:text-xl">× {item.quantity}</p>
          <p className="col-span-2 text-right text-lg font-black sm:col-span-1 sm:w-28 sm:text-xl">{formatCurrency(item.subtotal, currencyUnit)}</p>
        </div>
      ))}
      {showTotal ? (
        <div className="mt-5 flex flex-col gap-1 rounded-xl border border-slate-200 bg-white p-4 text-right shadow-sm sm:flex-row sm:items-center sm:justify-between sm:text-left">
          <p className="text-xl font-black sm:text-2xl">총 결제 금액</p>
          <p className={`text-3xl font-black sm:text-4xl ${accent}`}>{formatCurrency(totalAmount, currencyUnit)}</p>
        </div>
      ) : null}
    </div>
  );
}
