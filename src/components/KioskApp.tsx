'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { CartItem, Product, Student } from '@/domain/types';
import { QrScanner } from './QrScanner';

type KioskScreen = 'shop' | 'checkout' | 'complete';

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

type ApiError = { error?: string; message?: string };

function isApiError(payload: unknown): payload is ApiError {
  return Boolean(payload && typeof payload === 'object' && ('error' in payload || 'message' in payload));
}

export function KioskApp() {
  const [screen, setScreen] = useState<KioskScreen>('shop');
  const [products, setProducts] = useState<Product[]>([]);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [manualQrValue, setManualQrValue] = useState('');
  const [message, setMessage] = useState('');
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [isLoadingStudent, setIsLoadingStudent] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [isQrPaymentOpen, setIsQrPaymentOpen] = useState(false);
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(null);

  useEffect(() => {
    let ignore = false;

    async function loadProducts() {
      setIsLoadingProducts(true);
      const response = await fetch('/api/products', { cache: 'no-store' });
      const payload = (await response.json()) as Product[] | ApiError;

      if (!response.ok || !Array.isArray(payload)) {
        throw new Error('상품 정보를 불러오지 못했습니다.');
      }

      if (!ignore) {
        setProducts(payload);
      }
    }

    loadProducts()
      .catch((error) => {
        if (!ignore) setMessage(error instanceof Error ? error.message : '상품 정보를 불러오지 못했습니다.');
      })
      .finally(() => {
        if (!ignore) setIsLoadingProducts(false);
      });

    return () => {
      ignore = true;
    };
  }, []);

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
  const totalQuantity = cartDetails.reduce((sum, item) => sum + item.quantity, 0);

  async function completeCheckoutWithQrValue(qrValue: string) {
    const studentId = qrValue.trim();

    if (!studentId) {
      setMessage('QR 값 또는 학생 ID를 입력해 주세요.');
      return;
    }

    if (cartItems.length === 0) {
      setMessage('장바구니가 비어 있습니다.');
      return;
    }

    setIsLoadingStudent(true);
    setIsCheckingOut(true);
    setMessage('');

    try {
      const studentResponse = await fetch(`/api/students/${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const studentPayload = (await studentResponse.json()) as Student | ApiError;

      if (!studentResponse.ok || isApiError(studentPayload)) {
        setMessage(
          isApiError(studentPayload)
            ? studentPayload.error || '학생 정보를 불러오지 못했습니다.'
            : '학생 정보를 불러오지 못했습니다.',
        );
        return;
      }

      const checkoutResponse = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: studentPayload.studentId, items: cartItems }),
      });
      const checkoutPayload = (await checkoutResponse.json()) as CheckoutSuccess | ApiError;

      if (!checkoutResponse.ok || !('ok' in checkoutPayload) || checkoutPayload.ok !== true) {
        setMessage(
          ('message' in checkoutPayload && checkoutPayload.message) ||
            ('error' in checkoutPayload && checkoutPayload.error) ||
            '결제에 실패했습니다.',
        );
        return;
      }

      setProducts((currentProducts) =>
        currentProducts.map((product) => {
          const cartItem = cartItems.find((item) => item.productId === product.productId);
          return cartItem ? { ...product, stock: product.stock - cartItem.quantity } : product;
        }),
      );
      setPaymentResult({ ...checkoutPayload, studentNumber: studentPayload.number });
      setCartItems([]);
      setManualQrValue('');
      setIsQrPaymentOpen(false);
      setScreen('complete');
    } finally {
      setIsLoadingStudent(false);
      setIsCheckingOut(false);
    }
  }

  function handleManualQrSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void completeCheckoutWithQrValue(manualQrValue);
  }

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

  function goToCheckout() {
    if (cartItems.length === 0) {
      setMessage('장바구니가 비어 있습니다.');
      return;
    }

    setMessage('');
    setScreen('checkout');
  }

  function resetToShop() {
    setScreen('shop');
    setPaymentResult(null);
    setCartItems([]);
    setManualQrValue('');
    setMessage('');
  }

  return (
    <main data-testid="kiosk-shell" className="h-screen overflow-hidden bg-[#f6f1e8] text-slate-950">
      {screen === 'shop' ? (
        <section className="relative mx-auto flex h-full w-full max-w-7xl flex-col gap-5 px-5 py-5 lg:px-8">
          <header className="flex items-center justify-between rounded-[1.75rem] bg-white/90 px-5 py-4 shadow-sm ring-1 ring-black/5">
            <div>
              <p className="text-xs font-bold tracking-[0.28em] text-amber-700">CLASS STORE</p>
              <h1 className="text-3xl font-black tracking-tight md:text-5xl">학급 매점</h1>
            </div>
            <a
              href="/admin/settings"
              aria-label="관리자 설정"
              title="관리자 설정"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-950 text-xl text-white shadow-lg transition hover:bg-slate-800"
            >
              ⚙
            </a>
          </header>

          <section className="flex min-h-0 flex-[3] flex-col rounded-[2rem] bg-white p-5 shadow-sm ring-1 ring-black/5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-black">상품 목록</h2>
              <p className="rounded-full bg-amber-100 px-3 py-1 text-sm font-bold text-amber-800">
                {isLoadingProducts ? '불러오는 중' : 'Google Sheets 연동'}
              </p>
            </div>
            <div data-testid="product-scroll-block" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-2">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {products.map((product) => (
                  <button
                    key={product.productId}
                    onClick={() => addToCart(product.productId)}
                    disabled={!product.isActive || product.stock <= 0}
                    aria-label={`${product.name} ${product.price.toLocaleString()}원 담기`}
                    className="min-h-36 rounded-[1.5rem] bg-slate-950 p-5 text-left text-white shadow-lg transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500"
                  >
                    <p className="text-sm font-bold text-amber-200">{product.category || '기타'}</p>
                    <p className="mt-2 text-3xl font-black">{product.name}</p>
                    <div className="mt-5 flex items-end justify-between gap-3">
                      <p className="text-2xl font-black text-amber-300">{product.price.toLocaleString()}원</p>
                      <p className="rounded-full bg-white/10 px-3 py-1 text-sm font-bold">재고 {product.stock}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-[2] flex-col rounded-[2rem] bg-slate-950 p-5 text-white shadow-xl">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-2xl font-black">장바구니</h2>
              <p className="text-sm font-bold text-slate-300">{totalQuantity}개 · 총 {totalAmount.toLocaleString()}원</p>
            </div>

            <div data-testid="cart-scroll-block" className="mt-4 min-h-0 flex-1 overflow-y-auto pr-2">
              {cartDetails.length === 0 ? (
                <div className="flex h-full min-h-28 items-center justify-center rounded-[1.5rem] border-2 border-dashed border-white/15 bg-white/5 p-6 text-slate-300">
                  선택한 상품이 없습니다.
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {cartDetails.map((item) => (
                    <div key={item.productId} className="flex items-center justify-between gap-3 rounded-[1.25rem] bg-white p-4 text-slate-950">
                      <div>
                        <p className="text-lg font-black">{item.name} × {item.quantity}</p>
                        <p className="text-sm font-bold text-slate-500">
                          {item.price.toLocaleString()}원 · 소계 {item.subtotal.toLocaleString()}원
                        </p>
                      </div>
                      <button
                        onClick={() => removeFromCart(item.productId)}
                        className="rounded-full bg-slate-100 px-4 py-2 text-sm font-black text-slate-700 hover:bg-slate-200"
                      >
                        빼기
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {message ? <p className="mt-3 rounded-2xl bg-amber-100 p-3 font-bold text-amber-900">{message}</p> : null}

            <button
              onClick={goToCheckout}
              disabled={cartItems.length === 0}
              className="mt-4 w-full rounded-[1.25rem] bg-emerald-500 py-4 text-xl font-black text-white shadow-lg transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-500"
            >
              결제 화면으로
            </button>
          </section>
        </section>
      ) : null}

      {screen === 'checkout' ? (
        <section className="mx-auto flex h-full w-full max-w-5xl flex-col px-5 py-6 lg:px-8">
          <header className="flex items-center justify-between gap-4">
            <button onClick={() => setScreen('shop')} className="rounded-full bg-white px-5 py-3 font-black shadow-sm ring-1 ring-black/5">
              ← 상품으로
            </button>
            <a
              href="/admin/settings"
              aria-label="관리자 설정"
              className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-950 text-xl text-white shadow-lg"
            >
              ⚙
            </a>
          </header>

          <div className="mt-6 flex min-h-0 flex-1 flex-col rounded-[2rem] bg-white p-7 shadow-xl ring-1 ring-black/5">
            <h1 className="text-4xl font-black">결제 확인</h1>
            <p className="mt-2 text-slate-600">장바구니 내용을 확인한 뒤 QR로 결제합니다.</p>

            <div className="mt-6 min-h-0 flex-1 overflow-y-auto rounded-[1.5rem] bg-slate-50 p-4">
              <div className="space-y-3">
                {cartDetails.map((item) => (
                  <div key={item.productId} className="flex items-center justify-between rounded-2xl bg-white p-4 shadow-sm">
                    <div>
                      <p className="text-xl font-black">{item.name} × {item.quantity}</p>
                      <p className="text-sm font-bold text-slate-500">단가 {item.price.toLocaleString()}원</p>
                    </div>
                    <p className="text-xl font-black">{item.subtotal.toLocaleString()}원</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-5 rounded-[1.5rem] bg-slate-950 p-5 text-white">
              <p className="text-right text-3xl font-black">합계 {totalAmount.toLocaleString()}원</p>
            </div>

            {message ? <p className="mt-4 rounded-2xl bg-amber-100 p-3 font-bold text-amber-900">{message}</p> : null}

            <button
              onClick={() => {
                setMessage('');
                setIsQrPaymentOpen(true);
              }}
              disabled={cartItems.length === 0 || isCheckingOut}
              className="mt-5 w-full rounded-[1.5rem] bg-emerald-500 py-5 text-2xl font-black text-white shadow-lg transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              QR로 결제하기
            </button>
          </div>

          {isQrPaymentOpen ? (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
              <section
                role="dialog"
                aria-modal="true"
                aria-label="QR 결제"
                className="w-full max-w-2xl rounded-[2rem] bg-slate-950 p-6 text-white shadow-2xl"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-3xl font-black">QR 결제</h2>
                    <p className="mt-2 text-slate-300">학생 QR을 카메라에 보여 주세요. 인식되면 자동으로 결제됩니다.</p>
                  </div>
                  <button
                    onClick={() => setIsQrPaymentOpen(false)}
                    className="rounded-full bg-white/10 px-4 py-2 font-black text-white hover:bg-white/20"
                  >
                    닫기
                  </button>
                </div>

                <div className="mt-5 flex flex-col items-center gap-4">
                  <QrScanner onScan={completeCheckoutWithQrValue} />
                  <form onSubmit={handleManualQrSubmit} className="flex w-full flex-col gap-3 rounded-[1.5rem] bg-white/10 p-4 md:flex-row">
                    <label className="sr-only" htmlFor="manual-qr-value">
                      QR 값 직접 입력
                    </label>
                    <input
                      id="manual-qr-value"
                      value={manualQrValue}
                      onChange={(event) => setManualQrValue(event.target.value)}
                      placeholder="예: S001"
                      className="min-w-0 flex-1 rounded-2xl border border-white/20 bg-white px-4 py-4 text-lg font-bold text-slate-950 outline-none focus:border-amber-300"
                    />
                    <button
                      type="submit"
                      disabled={isLoadingStudent || isCheckingOut}
                      className="rounded-2xl bg-amber-300 px-6 py-4 text-lg font-black text-slate-950 shadow-lg transition hover:bg-amber-200 disabled:cursor-wait disabled:bg-slate-300"
                    >
                      {isLoadingStudent || isCheckingOut ? '결제 중...' : 'QR 값으로 결제하기'}
                    </button>
                  </form>
                </div>
              </section>
            </div>
          ) : null}
        </section>
      ) : null}

      {screen === 'complete' && paymentResult ? (
        <section className="mx-auto flex h-full w-full max-w-4xl items-center justify-center px-5 py-6">
          <div className="w-full rounded-[2.5rem] bg-white p-8 text-center shadow-2xl ring-1 ring-black/5">
            <p className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-4xl">✓</p>
            <h1 className="mt-6 text-5xl font-black">결제 완료</h1>
            <p className="mt-3 text-lg text-slate-600">학급 화폐 결제가 정상 처리되었습니다.</p>

            <div className="mt-8 grid gap-4 rounded-[2rem] bg-slate-50 p-5 text-left md:grid-cols-3">
              <div className="rounded-[1.5rem] bg-white p-5 shadow-sm">
                <p className="text-sm font-bold text-slate-500">결제자</p>
                <p className="mt-2 text-2xl font-black">
                  {paymentResult.studentName}
                  {paymentResult.studentNumber ? ` · ${paymentResult.studentNumber}번` : ''}
                </p>
              </div>
              <div className="rounded-[1.5rem] bg-white p-5 shadow-sm">
                <p className="text-sm font-bold text-slate-500">결제 금액</p>
                <p className="mt-2 text-2xl font-black text-emerald-700">결제 금액 {paymentResult.totalAmount.toLocaleString()}원</p>
              </div>
              <div className="rounded-[1.5rem] bg-white p-5 shadow-sm">
                <p className="text-sm font-bold text-slate-500">현재 잔액</p>
                <p className="mt-2 text-2xl font-black text-amber-700">현재 잔액 {paymentResult.balanceAfter.toLocaleString()}원</p>
              </div>
            </div>

            <button
              onClick={resetToShop}
              className="mt-8 w-full rounded-[1.5rem] bg-slate-950 py-5 text-2xl font-black text-white shadow-lg transition hover:bg-slate-800"
            >
              처음으로
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
