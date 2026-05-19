'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { CartItem, Product, Student } from '@/domain/types';
import { QrScanner } from './QrScanner';

type CheckoutSuccess = {
  ok: true;
  transactionId: string;
  studentId: string;
  studentName: string;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
};

type ApiError = { error?: string; message?: string };

function isApiError(payload: unknown): payload is ApiError {
  return Boolean(payload && typeof payload === 'object' && ('error' in payload || 'message' in payload));
}

export function KioskApp() {
  const [products, setProducts] = useState<Product[]>([]);
  const [student, setStudent] = useState<Student | null>(null);
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [manualQrValue, setManualQrValue] = useState('');
  const [message, setMessage] = useState('');
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [isLoadingStudent, setIsLoadingStudent] = useState(false);
  const [isCheckingOut, setIsCheckingOut] = useState(false);

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
          subtotal: product.price * item.quantity,
        };
      })
      .filter((item): item is CartItem & { name: string; price: number; subtotal: number } => Boolean(item));
  }, [cartItems, products]);

  const totalAmount = cartDetails.reduce((sum, item) => sum + item.subtotal, 0);

  async function loadStudentByQrValue(qrValue: string) {
    const studentId = qrValue.trim();

    if (!studentId) {
      setMessage('QR 값 또는 학생 ID를 입력해 주세요.');
      return;
    }

    setIsLoadingStudent(true);
    setMessage('');

    try {
      const response = await fetch(`/api/students/${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const payload = (await response.json()) as Student | ApiError;

      if (!response.ok || isApiError(payload)) {
        setMessage(isApiError(payload) ? payload.error || '학생 정보를 불러오지 못했습니다.' : '학생 정보를 불러오지 못했습니다.');
        return;
      }

      setStudent(payload);
      setCartItems([]);
      setManualQrValue('');
      setMessage(`${payload.name} 학생 정보를 불러왔습니다.`);
    } finally {
      setIsLoadingStudent(false);
    }
  }

  function handleManualQrSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadStudentByQrValue(manualQrValue);
  }

  function addToCart(productId: string) {
    setMessage('');
    setCartItems((currentItems) => {
      const existing = currentItems.find((item) => item.productId === productId);

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

  async function handleCheckout() {
    if (!student) {
      setMessage('먼저 학생을 불러와 주세요.');
      return;
    }

    if (cartItems.length === 0) {
      setMessage('장바구니가 비어 있습니다.');
      return;
    }

    setIsCheckingOut(true);
    setMessage('');

    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ studentId: student.studentId, items: cartItems }),
      });
      const payload = (await response.json()) as CheckoutSuccess | ApiError;

      if (!response.ok || !('ok' in payload) || payload.ok !== true) {
        setMessage(('message' in payload && payload.message) || ('error' in payload && payload.error) || '결제에 실패했습니다.');
        return;
      }

      setStudent((currentStudent) =>
        currentStudent ? { ...currentStudent, balance: payload.balanceAfter } : currentStudent,
      );
      setProducts((currentProducts) =>
        currentProducts.map((product) => {
          const cartItem = cartItems.find((item) => item.productId === product.productId);
          return cartItem ? { ...product, stock: product.stock - cartItem.quantity } : product;
        }),
      );
      setCartItems([]);
      setMessage(`결제 완료: ${payload.totalAmount.toLocaleString()}원`);
    } finally {
      setIsCheckingOut(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f1e8] text-slate-950">
      <section className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-10">
        <header className="flex flex-col gap-4 rounded-[2rem] bg-white/85 p-6 shadow-sm ring-1 ring-black/5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-bold tracking-[0.3em] text-amber-700">CLASS STORE</p>
            <h1 className="mt-2 text-4xl font-black tracking-tight md:text-6xl">학급 매점</h1>
            <p className="mt-3 text-lg text-slate-600">QR을 찍고, 상품을 담고, 학급 화폐로 결제합니다.</p>
          </div>
          <div className="flex flex-col gap-3 rounded-3xl bg-slate-950 px-6 py-4 text-white shadow-lg">
            <div>
              <p className="text-sm text-slate-300">현재 모드</p>
              <p className="text-2xl font-black">실제 시트 연동</p>
            </div>
            <a href="/admin/settings" className="rounded-full bg-amber-300 px-4 py-2 text-center font-black text-slate-950">
              관리자 설정
            </a>
          </div>
        </header>

        <div className="grid flex-1 gap-8 lg:grid-cols-[1fr_420px]">
          <section className="rounded-[2rem] bg-slate-950 p-6 text-white shadow-xl">
            <div className="flex h-full min-h-[520px] flex-col items-center justify-center rounded-[1.5rem] border-4 border-dashed border-white/20 bg-white/5 p-8 text-center">
              <h2 className="text-4xl font-black">QR 코드를 보여 주세요</h2>
              <p className="mt-4 max-w-xl text-lg text-slate-300">
                카메라 권한을 허용하면 학생 QR을 자동으로 읽습니다. 카메라가 없으면 아래 입력칸에 QR 값을 넣어도 됩니다.
              </p>

              <div className="mt-8 flex w-full flex-col items-center gap-5">
                <QrScanner onScan={loadStudentByQrValue} />
                <form onSubmit={handleManualQrSubmit} className="flex w-full max-w-xl flex-col gap-3 rounded-[2rem] bg-white/10 p-4 md:flex-row">
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
                    disabled={isLoadingStudent}
                    className="rounded-2xl bg-amber-300 px-6 py-4 text-lg font-black text-slate-950 shadow-lg transition hover:bg-amber-200 disabled:cursor-wait disabled:bg-slate-300"
                  >
                    {isLoadingStudent ? '불러오는 중...' : 'QR 값으로 학생 불러오기'}
                  </button>
                </form>
              </div>
            </div>
          </section>

          <aside className="flex flex-col gap-6">
            <section className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
              <p className="text-sm font-bold text-slate-500">학생 정보</p>
              <div className="mt-4 rounded-3xl bg-amber-50 p-5">
                {student ? (
                  <>
                    <p className="text-2xl font-black">{student.name} · {student.number}번</p>
                    <p className="mt-2 text-slate-600">현재 잔액</p>
                    <p className="text-5xl font-black text-amber-700">{student.balance.toLocaleString()}</p>
                  </>
                ) : (
                  <p className="text-lg font-bold text-slate-500">학생을 먼저 불러와 주세요.</p>
                )}
              </div>
            </section>

            <section className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
              <div className="flex items-center justify-between">
                <p className="text-xl font-black">상품 목록</p>
                <p className="text-sm text-slate-500">{isLoadingProducts ? '불러오는 중' : 'Google Sheets 연동'}</p>
              </div>
              <div className="mt-4 grid gap-3">
                {products.map((product) => (
                  <div key={product.productId} className="flex items-center justify-between rounded-2xl bg-slate-50 p-4">
                    <div>
                      <p className="font-black">{product.name}</p>
                      <p className="text-sm text-slate-500">
                        {product.category || '기타'} · 재고 {product.stock}
                      </p>
                    </div>
                    <button
                      onClick={() => addToCart(product.productId)}
                      disabled={!product.isActive || product.stock <= 0}
                      aria-label={`${product.name} ${product.price.toLocaleString()}원 담기`}
                      className="rounded-full bg-slate-950 px-4 py-2 font-bold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      {product.price.toLocaleString()}원
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[2rem] bg-white p-6 shadow-sm ring-1 ring-black/5">
              <p className="text-xl font-black">장바구니</p>
              {cartDetails.length === 0 ? (
                <div className="mt-4 rounded-2xl bg-slate-100 p-4 text-slate-500">선택한 상품이 없습니다.</div>
              ) : (
                <div className="mt-4 space-y-3">
                  {cartDetails.map((item) => (
                    <div key={item.productId} className="flex items-center justify-between rounded-2xl bg-slate-100 p-4">
                      <div>
                        <p className="font-black">{item.name} × {item.quantity}</p>
                        <p className="text-sm text-slate-500">{item.subtotal.toLocaleString()}원</p>
                      </div>
                      <button
                        onClick={() => removeFromCart(item.productId)}
                        className="rounded-full bg-white px-3 py-2 text-sm font-black text-slate-700"
                      >
                        빼기
                      </button>
                    </div>
                  ))}
                  <p className="text-right text-2xl font-black">총 {totalAmount.toLocaleString()}원</p>
                </div>
              )}

              {message ? <p className="mt-4 rounded-2xl bg-amber-50 p-3 font-bold text-amber-800">{message}</p> : null}

              <button
                onClick={handleCheckout}
                disabled={isCheckingOut || cartItems.length === 0}
                className="mt-4 w-full rounded-2xl bg-emerald-500 py-4 text-xl font-black text-white shadow-lg transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                {isCheckingOut ? '결제 중...' : '결제하기'}
              </button>
            </section>
          </aside>
        </div>
      </section>
    </main>
  );
}
