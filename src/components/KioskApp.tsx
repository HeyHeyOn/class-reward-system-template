'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { calculatePromotionPrice } from '@/domain/promotions';
import type { CartItem, CheckoutLineSnapshot, Product, Promotion, Student } from '@/domain/types';
import { checkoutPreviewMatchesCart, parseCheckoutPreviewResponse, parseCheckoutSuccessResponse, type CheckoutPreviewPayload, type CheckoutSuccessPayload } from '@/lib/checkoutSnapshotClient';
import { getFontFamilyCss, type FontFamily } from '@/lib/fontSettings';
import { effectivePromotionsForProduct, parsePromotionListResponse, promotionBadgeLabel } from '@/lib/promotionClient';
import { QrScanner } from './QrScanner';

type PaymentStep = 'checkout' | 'processing' | 'failure' | 'complete';

type PaymentResult = CheckoutSuccessPayload & {
  studentNumber?: number;
};

type PreviewState =
  | { status: 'empty' }
  | { status: 'loading'; cartKey: string }
  | { status: 'error'; cartKey: string; message: string }
  | { status: 'success'; cartKey: string; payload: CheckoutPreviewPayload };

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

type ThemeColor = 'blue' | 'pink' | 'yellow' | 'green' | 'purple' | 'white' | 'black' | 'navy';

type KioskSettings = { currencyUnit?: string; appTitle?: string; themeColor?: ThemeColor; fontFamily?: FontFamily; qrManualInputEnabled?: boolean };

const THEME_STYLES: Record<ThemeColor, { shell: string; accentText: string; accentBg: string; selectedText: string; lightBg: string; lightText: string; hoverBg: string; ring: string }> = {
  blue: { shell: 'bg-[#EDF5FA]', accentText: 'text-[#365F78]', accentBg: 'bg-[#B8D0E0]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#EDF5FA]', lightText: 'text-slate-700', hoverBg: 'hover:bg-[#D8E9F2]', ring: 'focus:ring-[#B8D0E0]' },
  pink: { shell: 'bg-[#FAEDED]', accentText: 'text-[#8F5555]', accentBg: 'bg-[#F0C7C7]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#FAEDED]', lightText: 'text-slate-700', hoverBg: 'hover:bg-[#F4DADA]', ring: 'focus:ring-[#F0C7C7]' },
  yellow: { shell: 'bg-[#FCFAE6]', accentText: 'text-[#766D1E]', accentBg: 'bg-[#F5EDA6]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#FCFAE6]', lightText: 'text-slate-700', hoverBg: 'hover:bg-[#F8F2BF]', ring: 'focus:ring-[#F5EDA6]' },
  green: { shell: 'bg-[#DCF5C9]', accentText: 'text-[#4F7138]', accentBg: 'bg-[#A5C78B]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#DCF5C9]', lightText: 'text-slate-700', hoverBg: 'hover:bg-[#C3E5AE]', ring: 'focus:ring-[#A5C78B]' },
  purple: { shell: 'bg-[#F7EDFC]', accentText: 'text-[#76518A]', accentBg: 'bg-[#BB99CC]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#F7EDFC]', lightText: 'text-slate-700', hoverBg: 'hover:bg-[#E8D6F0]', ring: 'focus:ring-[#BB99CC]' },
  white: { shell: 'bg-[#FCFCFC]', accentText: 'text-[#1F1F1F]', accentBg: 'bg-[#1F1F1F]', selectedText: 'text-[#FCFCFC]', lightBg: 'bg-white', lightText: 'text-[#1F1F1F]', hoverBg: 'hover:bg-[#2B2B2B]', ring: 'focus:ring-[#1F1F1F]' },
  black: { shell: 'bg-[#1F1F1F]', accentText: 'text-[#FCFCFC]', accentBg: 'bg-[#FCFCFC]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#2B2B2B]', lightText: 'text-[#FCFCFC]', hoverBg: 'hover:bg-white', ring: 'focus:ring-[#FCFCFC]' },
  navy: { shell: 'bg-[#DCE8F4]', accentText: 'text-[#2F5D82]', accentBg: 'bg-[#7FA6C7]', selectedText: 'text-[#1F1F1F]', lightBg: 'bg-[#EEF5FA]', lightText: 'text-slate-700', hoverBg: 'hover:bg-[#C8DCEC]', ring: 'focus:ring-[#7FA6C7]' },
};

function normalizeThemeColor(value: unknown): ThemeColor {
  return value === 'blue' || value === 'pink' || value === 'yellow' || value === 'green' || value === 'purple' || value === 'white' || value === 'black' || value === 'navy' ? value : 'white';
}

function isApiError(payload: unknown): payload is ApiError {
  return Boolean(payload && typeof payload === 'object' && ('error' in payload || 'message' in payload));
}

function formatCurrency(amount: number, unit: string) {
  return `${amount.toLocaleString()}${unit}`;
}

export function KioskApp() {
  const [products, setProducts] = useState<Product[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [renderClock, setRenderClock] = useState(() => new Date());
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [manualQrValue, setManualQrValue] = useState('');
  const [message, setMessage] = useState('');
  const [isLoadingProducts, setIsLoadingProducts] = useState(true);
  const [isCheckingOut, setIsCheckingOut] = useState(false);
  const [paymentStep, setPaymentStep] = useState<PaymentStep | null>(null);
  const [paymentResult, setPaymentResult] = useState<PaymentResult | null>(null);
  const [completedCartDetails, setCompletedCartDetails] = useState<CheckoutLineSnapshot[]>([]);
  const [failure, setFailure] = useState<FailureState | null>(null);
  const [currencyUnit, setCurrencyUnit] = useState('원');
  const [appTitle, setAppTitle] = useState('학급 매점');
  const [themeColor, setThemeColor] = useState<ThemeColor>('white');
  const [fontFamily, setFontFamily] = useState<FontFamily>('default');
  const [qrManualInputEnabled, setQrManualInputEnabled] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('전체');
  const [loadError, setLoadError] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ status: 'empty' });
  const [previewRetry, setPreviewRetry] = useState(0);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const previewGenerationRef = useRef(0);

  const loadProducts = useCallback(async (options: { shouldApply?: () => boolean } = {}) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoadingProducts(true);
    setLoadError('');
    try {
      const [productResponse, settingsResponse, promotionResponse] = await Promise.all([
        fetch('/api/products', { cache: 'no-store' }),
        fetch('/api/settings', { cache: 'no-store' }),
        fetch('/api/promotions/active', { cache: 'no-store' }),
      ]);
      const payload: unknown = await productResponse.json();
      const settings = await settingsResponse.json().catch(() => null) as KioskSettings | null;
      const promotionPayload: unknown = await promotionResponse.json().catch(() => null);

      if (!productResponse.ok || !Array.isArray(payload)) {
        throw new Error('상품 정보를 불러오지 못했습니다.');
      }
      const parsedPromotions = parsePromotionListResponse(promotionPayload);
      if (!promotionResponse.ok || !parsedPromotions) throw new Error('행사 정보를 불러오지 못했습니다.');

      if (!mountedRef.current || loadGenerationRef.current !== generation || options.shouldApply?.() === false) return;
      setProducts(payload as Product[]);
      setPromotions(parsedPromotions);
      setRenderClock((current) => new Date(Math.max(Date.now(), current.getTime() + 1)));
      setSelectedCategory((current) => current === '전체' || (payload as Product[]).some((product) => (product.category || '기타') === current) ? current : '전체');
      if (settings?.currencyUnit) setCurrencyUnit(settings.currencyUnit);
      if (settings?.appTitle) setAppTitle(settings.appTitle);
      setThemeColor(normalizeThemeColor(settings?.themeColor));
      setFontFamily(settings?.fontFamily ?? 'default');
      setQrManualInputEnabled(Boolean(settings?.qrManualInputEnabled));
      setMessage('');
    } catch (error) {
      if (mountedRef.current && loadGenerationRef.current === generation && options.shouldApply?.() !== false) {
        const nextError = error instanceof Error ? error.message : '상품 정보를 불러오지 못했습니다.';
        setLoadError(nextError);
        setMessage(nextError);
      }
    } finally {
      if (mountedRef.current && loadGenerationRef.current === generation && options.shouldApply?.() !== false) setIsLoadingProducts(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    mountedRef.current = true;
    void Promise.resolve().then(() => loadProducts({ shouldApply: () => !ignore }));
    const interval = window.setInterval(() => setRenderClock(new Date()), 60_000);
    return () => {
      ignore = true;
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      previewGenerationRef.current += 1;
      window.clearInterval(interval);
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

  const cartKey = useMemo(() => JSON.stringify({ items: cartItems, pricingClock: renderClock.toISOString() }), [cartItems, renderClock]);
  useEffect(() => {
    const generation = previewGenerationRef.current + 1;
    previewGenerationRef.current = generation;
    if (cartItems.length === 0) {
      void Promise.resolve().then(() => {
        if (mountedRef.current && previewGenerationRef.current === generation) {
          setPreview({ status: 'empty' });
        }
      });
      return;
    }
    const controller = new AbortController();
    const requestedItems = cartItems.map((item) => ({ ...item }));
    const requestedKey = cartKey;
    void (async () => {
      await Promise.resolve();
      if (!mountedRef.current || previewGenerationRef.current !== generation) return;
      setPreview({ status: 'loading', cartKey: requestedKey });
      try {
        const response = await fetch('/api/checkout/preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: requestedItems }), signal: controller.signal,
        });
        const payload: unknown = await response.json().catch(() => null);
        const parsed = response.ok ? parseCheckoutPreviewResponse(payload) : null;
        if (!parsed || !checkoutPreviewMatchesCart(parsed, requestedItems)) throw new Error('결제 금액을 확인하지 못했습니다.');
        if (mountedRef.current && previewGenerationRef.current === generation) {
          setPreview({ status: 'success', cartKey: requestedKey, payload: parsed });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (mountedRef.current && previewGenerationRef.current === generation) {
          setPreview({ status: 'error', cartKey: requestedKey, message: error instanceof Error ? error.message : '결제 금액을 확인하지 못했습니다.' });
        }
      }
    })();
    return () => controller.abort();
  }, [cartItems, cartKey, previewRetry]);

  const productPricing = useMemo(() => new Map(products.map((product) => {
    const effective = effectivePromotionsForProduct(promotions, product.productId, renderClock);
    const pricing = calculatePromotionPrice({
      productId: product.productId, quantity: 1, regularUnitPrice: product.price,
      now: renderClock, promotions,
    });
    return [product.productId, { effective, pricing }] as const;
  })), [products, promotions, renderClock]);
  const pricingError = [...productPricing.values()].some(({ pricing }) => !pricing.ok);
  const currentPreview = preview.status === 'success' && preview.cartKey === cartKey ? preview.payload : null;
  const totalAmount = currentPreview?.totalAmount ?? null;
  const regularAggregate = currentPreview?.items.reduce((sum, item) => sum + item.regularTotal, 0) ?? null;
  const totalSavings = currentPreview?.items.reduce((sum, item) => sum + item.totalDiscount, 0) ?? 0;
  const categories = useMemo(() => ['전체', ...Array.from(new Set(products.map((product) => product.category || '기타')))], [products]);
  const filteredProducts = useMemo(() => {
    const categoryProducts = selectedCategory === '전체' ? products : products.filter((product) => (product.category || '기타') === selectedCategory);
    return [...categoryProducts].sort((a, b) => {
      const aSoldOut = a.stock <= 0;
      const bSoldOut = b.stock <= 0;
      if (aSoldOut !== bSoldOut) return aSoldOut ? 1 : -1;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    });
  }, [products, selectedCategory]);
  const theme = THEME_STYLES[themeColor];
  const fontFamilyCss = getFontFamilyCss(fontFamily);
  const fontFamilyStyle = fontFamilyCss ? { fontFamily: fontFamilyCss } : undefined;

  if (isLoadingProducts) {
    return <LoadingScreen title="시트 정보 불러오는 중" message="매점 상품과 테마 설정을 불러오는 중입니다." />;
  }

  const quantityButtonClass = `relative z-10 flex h-[clamp(2rem,5vw,2.25rem)] w-[clamp(2rem,5vw,2.25rem)] shrink-0 touch-manipulation items-center justify-center rounded-lg ${theme.lightBg} text-[clamp(1rem,2.8vw,1.25rem)] font-black ${theme.accentText}`;

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
    if (!currentPreview || pricingError || loadError) {
      setMessage('결제 금액 확인이 완료된 뒤 다시 시도해 주세요.');
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
      const checkoutRaw: unknown = await checkoutResponse.json().catch(() => null);
      const checkoutPayload = checkoutResponse.ok ? parseCheckoutSuccessResponse(checkoutRaw) : null;

      if (!checkoutPayload) {
        const errorPayload = isApiError(checkoutRaw) ? checkoutRaw : {};
        const errorMessage = errorPayload.message || errorPayload.error || '결제에 실패했습니다.';
        const detail =
          typeof errorPayload.currentBalance === 'number'
            ? `현재 잔액: ${formatCurrency(errorPayload.currentBalance, currencyUnit)}`
            : undefined;

        setFailure({ title: '결제 실패', message: errorMessage, detail });
        setPaymentStep('failure');
        return;
      }

      setProducts((currentProducts) =>
        currentProducts.map((product) => {
          const completedItem = checkoutPayload.items.find((item) => item.productId === product.productId);
          return completedItem ? { ...product, stock: product.stock - completedItem.totalQuantity } : product;
        }),
      );
      setPaymentResult(checkoutPayload);
      setCompletedCartDetails(checkoutPayload.items);
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
    <main data-testid="kiosk-shell" style={fontFamilyStyle} className={`h-screen overflow-hidden ${theme.shell} p-2 text-slate-950 sm:p-3`}>
      <section data-testid="kiosk-content" className="mx-auto grid h-full w-full max-w-[1240px] grid-rows-[auto_minmax(0,1fr)] gap-2 sm:gap-3">
        <header className="relative grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center rounded-[1.25rem] border border-slate-300/70 bg-white px-2 py-2 text-center text-[clamp(0.75rem,2.6vw,1rem)] shadow-sm sm:grid-cols-[3rem_minmax(0,1fr)_3rem] sm:rounded-[1.75rem] sm:px-4 sm:py-4">
          <div aria-hidden="true" />
          <h1 data-testid="kiosk-title" className="min-w-0 truncate text-[clamp(1.25rem,6vw,3rem)] font-black leading-tight tracking-tight">{appTitle}</h1>
          <button type="button" onClick={() => void loadProducts()} aria-label="새로고침" className={`flex h-9 w-9 items-center justify-center justify-self-end rounded-full ${theme.lightBg} text-[clamp(1rem,3vw,1.25rem)] font-black ${theme.accentText} transition ${theme.hoverBg} sm:h-10 sm:w-10`}>↻</button>
        </header>

        <div data-testid="kiosk-main-grid" className="grid min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,1fr)] gap-2 landscape:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] landscape:grid-rows-1 sm:gap-3">
          <section data-testid="products-panel" className="flex min-h-0 flex-col rounded-[1.25rem] border border-slate-300/70 bg-white/85 p-2 text-[clamp(0.68rem,2.1vw,1rem)] shadow-sm sm:rounded-[1.75rem] sm:p-4 lg:min-h-0">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <h2 className="shrink-0 text-[clamp(1rem,4vw,1.5rem)] font-black leading-tight">상품 목록</h2>
            <div data-testid="category-tabs" className="flex min-w-0 flex-1 shrink gap-1 overflow-x-auto whitespace-nowrap pb-1 sm:gap-2">
            {categories.map((category) => (
              <button
                key={category}
                type="button"
                onClick={() => setSelectedCategory(category)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[clamp(0.62rem,2.1vw,0.875rem)] font-black transition sm:px-3 ${selectedCategory === category ? `${theme.accentBg} ${theme.selectedText}` : `${theme.lightBg} ${theme.accentText}`}`}
              >
                {category}
              </button>
            ))}
            </div>
            {isLoadingProducts ? <p className={`shrink-0 rounded-full ${theme.lightBg} px-2 py-0.5 text-[clamp(0.62rem,2.2vw,0.875rem)] font-black ${theme.accentText} sm:px-3 sm:py-1`}>불러오는 중</p> : null}
          </div>

          <div data-testid="product-scroll-block" className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 sm:mt-2">
            <div data-testid="product-grid" className="grid grid-cols-3 gap-1.5 sm:gap-2 md:gap-3">
              {filteredProducts.map((product) => {
                const isSoldOut = product.stock <= 0;
                const cardPromotion = productPricing.get(product.productId);
                const cardPrice = cardPromotion?.pricing;
                const displayPrice = cardPrice?.ok ? cardPrice.finalAmount : product.price;
                const cardPricingFailed = !cardPrice?.ok;
                return (
                <button
                  key={product.productId}
                  onClick={() => addToCart(product.productId)}
                  disabled={!product.isActive || isSoldOut || cardPricingFailed || Boolean(loadError)}
                  aria-label={`${product.name} ${formatCurrency(displayPrice, currencyUnit)} 담기`}
                  data-testid="product-card"
                  className={`rounded-[0.8rem] border border-slate-300 bg-white p-1 text-left text-[clamp(0.62rem,2vw,1rem)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed sm:rounded-[0.9rem] sm:p-3 ${isSoldOut ? 'brightness-75 grayscale disabled:opacity-75' : 'disabled:opacity-50'}`}
                >
                  <p className="truncate text-[clamp(0.55rem,1.8vw,0.75rem)] font-black">{product.category || '기타'}</p>
                  <div className="mt-1 flex aspect-[4/3] items-center justify-center rounded-md bg-slate-200 text-[clamp(1.5rem,8vw,3rem)] text-white sm:mt-2">
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.imageUrl} alt={`${product.name} 이미지`} className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src="/class-reward-system-icon.png" alt={`${product.name} 기본 이미지`} className="h-full w-full object-contain p-2 sm:p-3" />
                    )}
                  </div>
                  <p className="mt-1 truncate text-[clamp(0.62rem,2.4vw,1.125rem)] font-black leading-tight sm:mt-2">{product.name}</p>
                  {cardPromotion?.effective.length ? <div className="mt-1 flex flex-wrap gap-1" aria-label={`${product.name} 행사`}>
                    {cardPromotion.effective.map((promotion) => <span key={promotion.promotionId} className={`rounded-full ${theme.lightBg} px-1.5 py-0.5 text-[clamp(0.5rem,1.6vw,0.7rem)] font-black ${theme.accentText}`}>{promotionBadgeLabel(promotion, currencyUnit)}</span>)}
                  </div> : null}
                  <div data-testid="product-card-footer" className="mt-1 flex flex-row items-end justify-between gap-1 sm:gap-2">
                    <div className="min-w-0 leading-tight">
                      {cardPrice?.ok && cardPrice.finalAmount < product.price ? <p className="text-[clamp(0.5rem,1.7vw,0.75rem)] font-bold text-slate-500 line-through" aria-label={`정상 가격 ${formatCurrency(product.price, currencyUnit)}`}>{formatCurrency(product.price, currencyUnit)}</p> : null}
                      <p className={`truncate text-[clamp(0.62rem,2.3vw,1.25rem)] font-black ${cardPrice?.ok && cardPrice.finalAmount < product.price ? theme.accentText : ''}`}>{formatCurrency(displayPrice, currencyUnit)}</p>
                    </div>
                    <p data-testid="product-card-stock" className={`shrink-0 whitespace-nowrap rounded-full ${theme.lightBg} px-1 py-0.5 text-[clamp(0.55rem,1.8vw,0.75rem)] font-black leading-tight ${theme.lightText} sm:px-2 sm:py-1`}>재고 {product.stock}</p>
                  </div>
                </button>
                );
              })}
            </div>
          </div>
          </section>

          <section data-testid="cart-panel" className="flex min-h-0 flex-col rounded-[1.25rem] border border-slate-300/70 bg-white/90 p-2 text-[clamp(0.68rem,2.1vw,1rem)] shadow-sm sm:rounded-[1.75rem] sm:p-4 lg:min-h-0">
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <h2 className="text-[clamp(1rem,4vw,1.5rem)] font-black leading-tight">장바구니 ({cartDetails.length})</h2>
            <button
              onClick={clearCart}
              disabled={cartItems.length === 0}
              className={`rounded-xl ${theme.lightBg} px-2 py-1.5 text-[clamp(0.75rem,2.6vw,1rem)] font-black ${theme.lightText} disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:py-2`}
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
                {cartDetails.map((item) => {
                  const snapshot = currentPreview?.items.find((candidate) => candidate.productId === item.productId);
                  return (
                  <div key={item.productId} data-testid="cart-item-row" className="grid grid-cols-[minmax(0,2fr)_auto_minmax(3.5rem,1fr)] items-center gap-x-2 gap-y-1 rounded-xl border border-slate-200 bg-white px-2 py-1.5 text-[clamp(0.68rem,2.2vw,1rem)] shadow-sm landscape:grid-cols-[minmax(0,2fr)_auto_minmax(3.5rem,1fr)] sm:gap-x-3 sm:px-3 sm:py-2">
                    <div className="min-w-0">
                      <p data-testid="cart-item-name" className="min-w-0 truncate text-[clamp(0.75rem,2.8vw,1.125rem)] font-black leading-tight">{snapshot?.name ?? item.name}</p>
                      {snapshot ? <>
                        <p className="text-[clamp(0.58rem,1.8vw,0.75rem)] font-bold text-slate-600">유료 {snapshot.paidQuantity}개{snapshot.freeQuantity > 0 ? ` · 무료 ${snapshot.freeQuantity}개` : ''}</p>
                        <div className="flex flex-wrap gap-1">{snapshot.adjustments.map((adjustment, index) => <span data-testid="cart-adjustment" key={`${adjustment.promotionId}-${index}`} className="rounded bg-slate-100 px-1 py-0.5 text-[clamp(0.5rem,1.6vw,0.68rem)] font-bold">{promotionBadgeLabel(snapshot.appliedPromotions[index], currencyUnit)} · {formatCurrency(adjustment.beforeAmount, currencyUnit)}→{formatCurrency(adjustment.afterAmount, currencyUnit)}</span>)}</div>
                      </> : null}
                    </div>
                    <div data-testid="cart-quantity-controls" className="relative z-10 flex justify-self-center items-center gap-1 sm:gap-1.5">
                      <button
                        aria-label={`${item.name} 수량 줄이기`}
                        onClick={() => removeFromCart(item.productId)}
                        className={quantityButtonClass}
                      >
                        −
                      </button>
                      <span className="w-[clamp(1rem,3vw,1.5rem)] text-center text-[clamp(0.85rem,2.8vw,1.125rem)] font-black">{item.quantity}</span>
                      <button
                        aria-label={`${item.name} 수량 늘리기`}
                        onClick={() => addToCart(item.productId)}
                        className={quantityButtonClass}
                      >
                        +
                      </button>
                    </div>
                    <div data-testid="cart-item-subtotal" className="min-w-0 break-words text-right text-[clamp(0.75rem,2.8vw,1.125rem)] font-black leading-tight justify-self-end">
                      {snapshot ? <>{snapshot.totalDiscount > 0 ? <p className="text-xs text-slate-500 line-through" aria-label={`정상 합계 ${formatCurrency(snapshot.regularTotal, currencyUnit)}`}>{formatCurrency(snapshot.regularTotal, currencyUnit)}</p> : null}<p className={snapshot.totalDiscount > 0 ? theme.accentText : ''}>{formatCurrency(snapshot.finalTotal, currencyUnit)}</p></> : <span aria-hidden="true">—</span>}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {message || pricingError ? <p role={loadError || pricingError ? 'alert' : undefined} className="mt-2 rounded-xl bg-amber-100 p-2 text-[clamp(0.7rem,2.4vw,0.875rem)] font-bold text-amber-900">{pricingError ? '행사 가격 설정이 올바르지 않아 결제할 수 없습니다.' : message}</p> : null}
          {cartItems.length > 0 && preview.status === 'loading' ? <p role="status" aria-label="결제 금액 계산 중" className="mt-2 rounded-xl bg-sky-50 p-2 text-sm font-bold text-sky-800">결제 금액을 계산하는 중입니다.</p> : null}
          {cartItems.length > 0 && preview.status === 'error' ? <div role="alert" className="mt-2 rounded-xl bg-rose-100 p-2 text-sm font-bold text-rose-800"><p>{preview.message}</p><button type="button" className="mt-1 rounded bg-white px-2 py-1" onClick={() => setPreviewRetry((value) => value + 1)}>결제 금액 다시 계산</button></div> : null}

          <div data-testid="checkout-total-bar" className="mt-2 flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2 text-[clamp(0.7rem,2.4vw,1rem)] shadow-sm sm:mt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 sm:block">
              <p className="text-[clamp(0.8rem,2.8vw,1.25rem)] font-black leading-tight">총 결제 금액</p>
              {totalAmount === null ? <p className="text-sm font-bold text-slate-500">확인 중</p> : <>
                {totalSavings > 0 && regularAggregate !== null ? <p className="text-sm font-bold text-slate-500 line-through" aria-label={`정상 총액 ${formatCurrency(regularAggregate, currencyUnit)}`}>{formatCurrency(regularAggregate, currencyUnit)}</p> : null}
                <p className={`text-[clamp(1.2rem,5vw,1.875rem)] font-black leading-tight ${theme.accentText}`}>{formatCurrency(totalAmount, currencyUnit)}</p>
                {totalSavings > 0 ? <p className="text-xs font-black text-emerald-700">총 절약 {formatCurrency(totalSavings, currencyUnit)}</p> : null}
              </>}
            </div>
            <button
              data-testid="checkout-button"
              onClick={openCheckout}
              disabled={cartItems.length === 0 || !currentPreview || pricingError || Boolean(loadError)}
              className={`w-full rounded-xl ${theme.accentBg} px-4 py-2.5 text-[clamp(1rem,4vw,1.5rem)] font-black ${theme.selectedText} shadow-sm transition ${theme.hoverBg} disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto sm:min-w-44 sm:px-6 sm:py-3`}
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
          cartDetails={currentPreview?.items ?? []}
          totalAmount={currentPreview?.totalAmount ?? 0}
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
          qrManualInputEnabled={qrManualInputEnabled}
        />
      ) : null}
    </main>
  );
}

function LoadingScreen({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4 text-slate-950">
      <section role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-2xl bg-white p-6 text-center shadow-2xl">
        <div className="mx-auto h-12 w-12 animate-spin rounded-full border-4 border-slate-200 border-t-slate-950" aria-hidden="true" />
        <h1 className="mt-4 text-2xl font-black">{title}</h1>
        <p className="mt-2 rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-600">{message}</p>
      </section>
    </main>
  );
}

type PaymentModalProps = {
  step: PaymentStep;
  cartDetails: CheckoutLineSnapshot[];
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
  completedCartDetails: CheckoutLineSnapshot[];
  failure: FailureState | null;
  currencyUnit: string;
  themeColor: ThemeColor;
  qrManualInputEnabled: boolean;
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
  qrManualInputEnabled,
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
            {qrManualInputEnabled ? (
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
            ) : (
              <p className="mt-4 rounded-xl bg-slate-100 p-3 text-center text-sm font-black text-slate-600">QR 직접 입력은 시스템 설정에서 차단되어 있습니다. 카메라로 학생 QR을 인식해 주세요.</p>
            )}
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
            <button onClick={onReset} className={`mt-7 rounded-xl ${theme.accentBg} px-12 py-4 text-4xl font-black ${theme.selectedText} shadow-sm`}>
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
  cartDetails: CheckoutLineSnapshot[];
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
          <div className="text-right sm:text-left"><p className="text-lg font-black sm:text-xl">× {item.totalQuantity}</p><p className="text-xs font-bold text-slate-500">유료 {item.paidQuantity}개{item.freeQuantity > 0 ? ` · 무료 ${item.freeQuantity}개` : ''}</p></div>
          <div className="col-span-2 text-right sm:col-span-1 sm:w-32"><p className="text-lg font-black sm:text-xl">{formatCurrency(item.finalTotal, currencyUnit)}</p>{item.totalDiscount > 0 ? <p className="text-sm text-slate-500 line-through">{formatCurrency(item.regularTotal, currencyUnit)}</p> : null}</div>
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
