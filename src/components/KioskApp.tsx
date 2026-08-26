'use client';

import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createCartPricingPreview } from '@/domain/checkout';
import { calculatePromotionPrice } from '@/domain/promotions';
import type { CartItem, CheckoutLineSnapshot, Product, Promotion, Student } from '@/domain/types';
import { checkoutPreviewMatchesCart, parseCheckoutPreviewResponse, parseCheckoutSuccessResponse, type CheckoutPreviewPayload, type CheckoutSuccessPayload } from '@/lib/checkoutSnapshotClient';
import { getFontFamilyCss, type FontFamily } from '@/lib/fontSettings';
import { effectivePromotionsForProduct, parsePromotionListResponse, promotionBadgeLabel } from '@/lib/promotionClient';
import { QrScanner } from './QrScanner';
import { PromotionPills } from './promotions/PromotionPills';
import { normalizeThemeColor, themeStyles, type ThemeColor, type ThemeStyles } from './uiTheme';

type PaymentStep = 'checkout' | 'processing' | 'failure' | 'complete';

type PaymentResult = CheckoutSuccessPayload & {
  studentNumber?: number;
};

type ApiError = {
  error?: string;
  message?: string;
  code?: string;
  currentBalance?: number;
  requiredAmount?: number;
  latestPricing?: unknown;
};

type FailureState = {
  title: string;
  message: string;
  detail?: string;
};

type KioskSettings = { currencyUnit?: string; appTitle?: string; themeColor?: ThemeColor; fontFamily?: FontFamily; qrManualInputEnabled?: boolean };

type ProductFilter = { kind: 'all' } | { kind: 'promotion' } | { kind: 'category'; category: string };

function isApiError(payload: unknown): payload is ApiError {
  return Boolean(payload && typeof payload === 'object' && ('error' in payload || 'message' in payload));
}

function formatCurrency(amount: number, unit: string) {
  return `${amount.toLocaleString()}${unit}`;
}

function promotionAccessibleSummary(promotions: Promotion[], currencyUnit: string): string {
  const nPlusOne = promotions
    .filter((promotion) => promotion.type === 'N_PLUS_ONE')
    .map((promotion) => `${promotionBadgeLabel(promotion, currencyUnit)} (${promotion.name})`);
  const discounts = promotions.filter((promotion) => promotion.type !== 'N_PLUS_ONE');
  if (discounts.length > 0) nPlusOne.push(`할인 (${discounts.map((promotion) => promotion.name).join(' · ')})`);
  return nPlusOne.length > 0 ? `, 행사: ${nPlusOne.join(', ')}` : '';
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
  const [selectedFilter, setSelectedFilter] = useState<ProductFilter>({ kind: 'all' });
  const [loadError, setLoadError] = useState('');
  const [confirmedServerPricing, setConfirmedServerPricing] = useState<{
    cartKey: string;
    localFingerprint: string;
    payload: CheckoutPreviewPayload;
  } | null>(null);
  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const serverClockOffsetRef = useRef(0);
  const cartGenerationRef = useRef(0);
  const pricingContextRef = useRef<{ cartKey: string; localFingerprint: string; cartItems: CartItem[] }>({
    cartKey: '[]',
    localFingerprint: 'null',
    cartItems: [],
  });

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

      const serverNow = promotionResponse.headers.get('x-server-now');
      const serverEpoch = serverNow ? Date.parse(serverNow) : Number.NaN;

      if (!mountedRef.current || loadGenerationRef.current !== generation || options.shouldApply?.() === false) return;
      if (Number.isFinite(serverEpoch)) serverClockOffsetRef.current = serverEpoch - Date.now();
      setProducts(payload as Product[]);
      setPromotions(parsedPromotions);
      cartGenerationRef.current += 1;
      setConfirmedServerPricing(null);
      setRenderClock(new Date(Date.now() + serverClockOffsetRef.current));
      setSelectedFilter((current) => current.kind !== 'category'
        || (payload as Product[]).some((product) => (product.category || '기타') === current.category)
        ? current
        : { kind: 'all' });
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
    const interval = window.setInterval(() => setRenderClock(new Date(Date.now() + serverClockOffsetRef.current)), 60_000);
    return () => {
      ignore = true;
      mountedRef.current = false;
      loadGenerationRef.current += 1;
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

  const cartKey = useMemo(() => JSON.stringify(cartItems), [cartItems]);
  const localPricing = useMemo(() => cartItems.length === 0 ? null : createCartPricingPreview({
    products,
    cartItems,
    promotions,
    now: renderClock,
  }), [cartItems, products, promotions, renderClock]);
  const localPricingFingerprint = JSON.stringify(localPricing?.ok ? localPricing : null);
  useLayoutEffect(() => {
    pricingContextRef.current = { cartKey, localFingerprint: localPricingFingerprint, cartItems };
  }, [cartItems, cartKey, localPricingFingerprint]);

  const productPricing = useMemo(() => new Map(products.map((product) => {
    const effective = effectivePromotionsForProduct(promotions, product.productId, renderClock);
    const pricing = calculatePromotionPrice({
      productId: product.productId, quantity: 1, regularUnitPrice: product.price,
      now: renderClock, promotions,
    });
    return [product.productId, { effective, pricing }] as const;
  })), [products, promotions, renderClock]);
  const pricingError = [...productPricing.values()].some(({ pricing }) => !pricing.ok) || Boolean(localPricing && !localPricing.ok);
  const currentPreview = confirmedServerPricing?.cartKey === cartKey
    && confirmedServerPricing.localFingerprint === localPricingFingerprint
    ? confirmedServerPricing.payload
    : localPricing?.ok ? localPricing : null;
  const totalAmount = currentPreview?.totalAmount ?? null;
  const regularAggregate = currentPreview?.items.reduce((sum, item) => sum + item.regularTotal, 0) ?? null;
  const totalSavings = currentPreview?.items.reduce((sum, item) => sum + item.totalDiscount, 0) ?? 0;
  const filters = useMemo<ProductFilter[]>(() => [
    { kind: 'all' },
    { kind: 'promotion' },
    ...Array.from(new Set(products.map((product) => product.category || '기타')))
      .map((category) => ({ kind: 'category', category }) as const),
  ], [products]);
  const filteredProducts = useMemo(() => {
    const categoryProducts = selectedFilter.kind === 'all'
      ? products
      : selectedFilter.kind === 'promotion'
        ? products.filter((product) => effectivePromotionsForProduct(promotions, product.productId, renderClock).length > 0)
        : products.filter((product) => (product.category || '기타') === selectedFilter.category);
    return [...categoryProducts].sort((a, b) => {
      const aSoldOut = a.stock <= 0;
      const bSoldOut = b.stock <= 0;
      if (aSoldOut !== bSoldOut) return aSoldOut ? 1 : -1;
      return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    });
  }, [products, promotions, renderClock, selectedFilter]);
  const theme = themeStyles(themeColor);
  const fontFamilyCss = getFontFamilyCss(fontFamily);
  const fontFamilyStyle = fontFamilyCss ? { fontFamily: fontFamilyCss } : {};

  if (isLoadingProducts) {
    return <LoadingScreen title="시트 정보 불러오는 중" message="매점 상품과 테마 설정을 불러오는 중입니다." />;
  }

  const quantityButtonClass = `relative z-10 flex h-[clamp(2rem,5vw,2.25rem)] w-[clamp(2rem,5vw,2.25rem)] shrink-0 touch-manipulation items-center justify-center rounded-lg ${theme.accentSoft} text-[clamp(1rem,2.8vw,1.25rem)] font-black ${theme.accentText}`;

  function addToCart(productId: string) {
    cartGenerationRef.current += 1;
    setConfirmedServerPricing(null);
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
    cartGenerationRef.current += 1;
    setConfirmedServerPricing(null);
    setCartItems((currentItems) =>
      currentItems.flatMap((item) => {
        if (item.productId !== productId) return [item];
        if (item.quantity <= 1) return [];
        return [{ ...item, quantity: item.quantity - 1 }];
      }),
    );
  }

  function clearCart() {
    cartGenerationRef.current += 1;
    setConfirmedServerPricing(null);
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

    if (!currentPreview) {
      setFailure({ title: '결제 실패', message: '결제 금액을 계산하지 못했습니다.' });
      setPaymentStep('failure');
      return;
    }

    setIsCheckingOut(true);
    setFailure(null);
    setPaymentStep('processing');
    const checkoutCartGeneration = cartGenerationRef.current;
    const checkoutCartKey = cartKey;

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
        body: JSON.stringify({ studentId: studentPayload.studentId, items: cartItems, expectedPricing: currentPreview }),
      });
      const checkoutRaw: unknown = await checkoutResponse.json().catch(() => null);
      const checkoutPayload = checkoutResponse.ok ? parseCheckoutSuccessResponse(checkoutRaw) : null;

      if (!checkoutPayload) {
        const errorPayload = isApiError(checkoutRaw) ? checkoutRaw : {};
        if (checkoutResponse.status === 409 && errorPayload.code === 'PRICE_CHANGED') {
          const latestPricing = parseCheckoutPreviewResponse(errorPayload.latestPricing);
          const currentPricingContext = pricingContextRef.current;
          if (latestPricing
            && cartGenerationRef.current === checkoutCartGeneration
            && currentPricingContext.cartKey === checkoutCartKey
            && checkoutPreviewMatchesCart(latestPricing, currentPricingContext.cartItems)) {
            setConfirmedServerPricing({
              cartKey: currentPricingContext.cartKey,
              localFingerprint: currentPricingContext.localFingerprint,
              payload: latestPricing,
            });
            setMessage(errorPayload.message || '상품 가격 또는 행사가 변경되었습니다. 최신 금액을 확인해 주세요.');
            setManualQrValue('');
            setPaymentStep(null);
            return;
          }
        }
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
    cartGenerationRef.current += 1;
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
    <main data-testid="kiosk-shell" style={{ ...theme.variables, ...fontFamilyStyle }} className={`h-screen overflow-hidden ${theme.shell} ${theme.text} p-2 sm:p-3`}>
      <section
        data-testid="kiosk-content"
        aria-hidden={paymentStep ? true : undefined}
        inert={paymentStep ? true : undefined}
        className="mx-auto grid h-full w-full max-w-[1240px] grid-rows-[auto_minmax(0,1fr)] gap-2 sm:gap-3"
      >
        <header className={`relative grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center rounded-[1.25rem] border ${theme.border} ${theme.surface} px-2 py-2 text-center text-[clamp(0.75rem,2.6vw,1rem)] shadow-sm sm:grid-cols-[3rem_minmax(0,1fr)_3rem] sm:rounded-[1.75rem] sm:px-4 sm:py-4`}>
          <div aria-hidden="true" />
          <h1 data-testid="kiosk-title" className="min-w-0 truncate text-[clamp(1.25rem,6vw,3rem)] font-black leading-tight tracking-tight">{appTitle}</h1>
          <button type="button" onClick={() => void loadProducts()} aria-label="새로고침" className={`flex h-9 w-9 items-center justify-center justify-self-end rounded-full ${theme.accentSoft} text-[clamp(1rem,3vw,1.25rem)] font-black ${theme.accentText} transition ${theme.hover} ${theme.hoverText} sm:h-10 sm:w-10`}>↻</button>
        </header>

        <div data-testid="kiosk-main-grid" className="grid min-h-0 grid-rows-[minmax(0,2fr)_minmax(0,1fr)] gap-2 landscape:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] landscape:grid-rows-1 sm:gap-3">
          <section data-testid="products-panel" className={`flex min-h-0 flex-col rounded-[1.25rem] border ${theme.border} ${theme.surface} p-2 text-[clamp(0.68rem,2.1vw,1rem)] shadow-sm sm:rounded-[1.75rem] sm:p-4 lg:min-h-0`}>
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <h2 className="shrink-0 text-[clamp(1rem,4vw,1.5rem)] font-black leading-tight">상품 목록</h2>
            <div data-testid="category-tabs" className="flex min-w-0 flex-1 shrink gap-1 overflow-x-auto whitespace-nowrap pb-1 sm:gap-2">
            {filters.map((filter) => {
              const categoryCollision = filter.kind === 'category' && filter.category === '행사';
              const label = filter.kind === 'all' ? '전체' : filter.kind === 'promotion' ? '행사' : categoryCollision ? '행사 카테고리' : filter.category;
              const selected = filter.kind === selectedFilter.kind
                && (filter.kind !== 'category' || (selectedFilter.kind === 'category' && filter.category === selectedFilter.category));
              const accessibleLabel = filter.kind === 'category' && filter.category === '행사' ? '카테고리 행사' : label;
              return (
              <button
                key={filter.kind === 'category' ? `category:${filter.category}` : filter.kind}
                type="button"
                aria-label={accessibleLabel}
                aria-pressed={selected}
                onClick={() => setSelectedFilter(filter)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[clamp(0.62rem,2.1vw,0.875rem)] font-black transition sm:px-3 ${theme.hover} ${theme.hoverText} ${selected ? `${theme.accentSolid} ${theme.accentOnSolid}` : `${theme.accentSoft} ${theme.accentText}`}`}
              >
                {label}
              </button>
              );
            })}
            </div>
            {isLoadingProducts ? <p className={`shrink-0 rounded-full ${theme.accentSoft} px-2 py-0.5 text-[clamp(0.62rem,2.2vw,0.875rem)] font-black ${theme.accentText} sm:px-3 sm:py-1`}>불러오는 중</p> : null}
          </div>

          <div data-testid="product-scroll-block" className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 sm:mt-2">
            <div data-testid="product-grid" className="grid grid-cols-3 gap-1.5 sm:gap-2 md:gap-3">
              {selectedFilter.kind === 'promotion' && filteredProducts.length === 0 ? (
                <p className={`col-span-3 rounded-xl border border-dashed ${theme.border} ${theme.surfaceRaised} p-6 text-center font-black ${theme.mutedText}`}>진행 중인 행사 상품이 없습니다.</p>
              ) : null}
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
                  aria-label={`${product.name} ${formatCurrency(displayPrice, currencyUnit)} 담기${promotionAccessibleSummary(cardPromotion?.effective ?? [], currencyUnit)}`}
                  data-testid="product-card"
                  className={`rounded-[0.8rem] border ${theme.border} ${theme.surfaceRaised} p-1 text-left text-[clamp(0.62rem,2vw,1rem)] shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:cursor-not-allowed sm:rounded-[0.9rem] sm:p-3 ${isSoldOut ? 'brightness-75 grayscale disabled:opacity-75' : 'disabled:opacity-50'}`}
                >
                  <p className="truncate text-[clamp(0.55rem,1.8vw,0.75rem)] font-black">{product.category || '기타'}</p>
                  <div className={`relative mt-1 flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md ${theme.accentSoft} text-[clamp(1.5rem,8vw,3rem)] sm:mt-2`}>
                    {product.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={product.imageUrl} alt={`${product.name} 이미지`} className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src="/class-reward-system-icon.png" alt={`${product.name} 기본 이미지`} className="h-full w-full object-contain p-2 sm:p-3" />
                    )}
                    <PromotionPills
                      promotions={cardPromotion?.effective ?? []}
                      currencyUnit={currencyUnit}
                      ariaLabel={`${product.name} 행사`}
                      className="absolute left-1 top-1 z-10 max-w-[calc(100%-0.5rem)]"
                      pillClassName={`${theme.accentSolid} ${theme.accentOnSolid}`}
                    />
                  </div>
                  <p className="mt-1 truncate text-[clamp(0.62rem,2.4vw,1.125rem)] font-black leading-tight sm:mt-2">{product.name}</p>
                  <div data-testid="product-card-footer" className="mt-1 flex flex-row items-end justify-between gap-1 sm:gap-2">
                    <div className="min-w-0 leading-tight">
                      {cardPrice?.ok && cardPrice.finalAmount < product.price ? <p className={`text-[clamp(0.5rem,1.7vw,0.75rem)] font-bold ${theme.mutedText} line-through`} aria-label={`정상 가격 ${formatCurrency(product.price, currencyUnit)}`}>{formatCurrency(product.price, currencyUnit)}</p> : null}
                      <p className={`truncate text-[clamp(0.62rem,2.3vw,1.25rem)] font-black ${cardPrice?.ok && cardPrice.finalAmount < product.price ? theme.accentText : ''}`}>{formatCurrency(displayPrice, currencyUnit)}</p>
                    </div>
                    <p data-testid="product-card-stock" className={`shrink-0 whitespace-nowrap rounded-full ${theme.accentSoft} px-1 py-0.5 text-[clamp(0.55rem,1.8vw,0.75rem)] font-black leading-tight ${theme.accentText} sm:px-2 sm:py-1`}>재고 {product.stock}</p>
                  </div>
                </button>
                );
              })}
            </div>
          </div>
          </section>

          <section data-testid="cart-panel" className={`flex min-h-0 flex-col rounded-[1.25rem] border ${theme.border} ${theme.surface} p-2 text-[clamp(0.68rem,2.1vw,1rem)] shadow-sm sm:rounded-[1.75rem] sm:p-4 lg:min-h-0`}>
          <div className="flex items-center justify-between gap-2 sm:gap-3">
            <h2 className="text-[clamp(1rem,4vw,1.5rem)] font-black leading-tight">장바구니 ({cartDetails.length})</h2>
            <button
              onClick={clearCart}
              disabled={cartItems.length === 0}
              className={`rounded-xl ${theme.accentSoft} px-2 py-1.5 text-[clamp(0.75rem,2.6vw,1rem)] font-black ${theme.accentText} disabled:cursor-not-allowed disabled:opacity-40 sm:px-3 sm:py-2`}
            >
              비우기
            </button>
          </div>

          <div data-testid="cart-scroll-block" className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1 sm:mt-3">
            {cartDetails.length === 0 ? (
              <div className={`flex h-full min-h-12 items-center justify-center rounded-xl border border-dashed ${theme.border} ${theme.surfaceRaised} text-[clamp(0.75rem,2.8vw,1rem)] ${theme.mutedText} sm:min-h-16`}>
                선택한 상품이 없습니다.
              </div>
            ) : (
              <div className="space-y-2">
                {cartDetails.map((item) => {
                  const snapshot = currentPreview?.items.find((candidate) => candidate.productId === item.productId);
                  return (
                  <div key={item.productId} data-testid="cart-item-row" className={`grid grid-cols-[minmax(0,2fr)_auto_minmax(3.5rem,1fr)] items-center gap-x-2 gap-y-1 rounded-xl border ${theme.border} ${theme.surfaceRaised} px-2 py-1.5 text-[clamp(0.68rem,2.2vw,1rem)] shadow-sm landscape:grid-cols-[minmax(0,2fr)_auto_minmax(3.5rem,1fr)] sm:gap-x-3 sm:px-3 sm:py-2`}>
                    <div className="flex min-w-0 items-center gap-1">
                      <PromotionPills
                        promotions={productPricing.get(item.productId)?.effective ?? []}
                        currencyUnit={currencyUnit}
                        ariaLabel={`${item.name} 행사`}
                        className="shrink-0 flex-nowrap"
                        pillClassName={`${theme.accentSolid} ${theme.accentOnSolid}`}
                      />
                      <p data-testid="cart-item-name" className="min-w-0 truncate text-[clamp(0.75rem,2.8vw,1.125rem)] font-black leading-tight">{snapshot?.name ?? item.name}</p>
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
                      {snapshot ? <>{snapshot.totalDiscount > 0 ? <p className={`text-xs ${theme.mutedText} line-through`} aria-label={`정상 합계 ${formatCurrency(snapshot.regularTotal, currencyUnit)}`}>{formatCurrency(snapshot.regularTotal, currencyUnit)}</p> : null}<p className={snapshot.totalDiscount > 0 ? theme.accentText : ''}>{formatCurrency(snapshot.finalTotal, currencyUnit)}</p></> : <span aria-hidden="true">—</span>}
                    </div>
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {message || pricingError ? <p role="alert" className="mt-2 rounded-xl bg-amber-100 p-2 text-[clamp(0.7rem,2.4vw,0.875rem)] font-bold text-amber-900">{pricingError ? '행사 가격 설정이 올바르지 않아 결제할 수 없습니다.' : message}</p> : null}

          <div data-testid="checkout-total-bar" className={`mt-2 flex flex-col gap-2 rounded-xl border ${theme.border} ${theme.surfaceRaised} p-2 text-[clamp(0.7rem,2.4vw,1rem)] shadow-sm sm:mt-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:p-3`}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 sm:block">
              <p className="text-[clamp(0.8rem,2.8vw,1.25rem)] font-black leading-tight">총 결제 금액</p>
              {totalAmount === null ? <p className={`text-sm font-bold ${theme.mutedText}`}>확인 중</p> : <>
                {totalSavings > 0 && regularAggregate !== null ? <p className={`text-sm font-bold ${theme.mutedText} line-through`} aria-label={`정상 총액 ${formatCurrency(regularAggregate, currencyUnit)}`}>{formatCurrency(regularAggregate, currencyUnit)}</p> : null}
                <p className={`text-[clamp(1.2rem,5vw,1.875rem)] font-black leading-tight ${theme.accentText}`}>{formatCurrency(totalAmount, currencyUnit)}</p>
              </>}
            </div>
            <button
              data-testid="checkout-button"
              onClick={openCheckout}
              disabled={cartItems.length === 0 || !currentPreview || pricingError || Boolean(loadError)}
              className={`w-full rounded-xl ${theme.accentSolid} px-4 py-2.5 text-[clamp(1rem,4vw,1.5rem)] font-black ${theme.accentOnSolid} shadow-sm transition ${theme.hover} ${theme.hoverText} disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto sm:min-w-44 sm:px-6 sm:py-3`}
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
  const theme = themeStyles(themeColor);
  const dialogLabel = step === 'checkout' ? '결제 확인' : step === 'processing' ? '결제 중' : step === 'failure' ? '결제 실패' : '결제 완료';
  const dialogRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const focusableElements = useCallback(() => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  ) ?? []).filter((element) => !element.hasAttribute('hidden')
    && element.getAttribute('aria-hidden') !== 'true'
    && !(element instanceof HTMLInputElement && element.type === 'hidden')), []);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => restoreFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    const focusable = focusableElements();
    (focusable[0] ?? dialogRef.current)?.focus();
  }, [focusableElements, step]);

  function handleDialogKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      if (!isCheckingOut && (step === 'checkout' || step === 'failure')) {
        event.preventDefault();
        onCancel();
      }
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/65 p-3 sm:p-4">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className={`max-h-[calc(100vh-1.5rem)] w-full max-w-[720px] overflow-y-auto rounded-[1.5rem] border ${theme.border} ${theme.surface} ${theme.text} p-4 shadow-2xl sm:max-h-[calc(100vh-2rem)] sm:rounded-[1.75rem] md:p-5`}
      >
        {step === 'checkout' ? (
          <>
            <h2 className="text-2xl font-black sm:text-3xl">결제 확인</h2>
            <CartSummary cartDetails={cartDetails} totalAmount={totalAmount} accent={theme.accentText} theme={theme} currencyUnit={currencyUnit} />
            <div className="mt-5 grid gap-5 md:grid-cols-[1fr_180px] md:items-center">
              <div className="rounded-[1.5rem] bg-black p-3">
                <QrScanner onScan={onScan} />
              </div>
              <div className="text-center md:text-left">
                <p className={`text-xl font-black leading-tight ${theme.accentText} sm:text-2xl`}>결제하려면 카메라에 QR 코드를 인식해주세요.</p>
                <button onClick={onCancel} className="mt-5 w-full rounded-xl bg-rose-700 py-3 text-xl font-black text-white">
                  결제 취소
                </button>
              </div>
            </div>
            {qrManualInputEnabled ? (
              <form onSubmit={onManualQrSubmit} className={`mt-4 flex flex-col gap-2 rounded-xl ${theme.surfaceRaised} p-3 sm:flex-row`}>
                <label className="sr-only" htmlFor="manual-qr-value">
                  QR 값 직접 입력
                </label>
                <input
                  id="manual-qr-value"
                  value={manualQrValue}
                  onChange={(event) => setManualQrValue(event.target.value)}
                  placeholder="카메라가 안 되면 예: S001"
                  className={`min-w-0 flex-1 rounded-xl border ${theme.border} ${theme.input} ${theme.text} px-4 py-3 text-lg font-bold outline-none focus:ring-2 ${theme.ring}`}
                />
                <button type="submit" disabled={isCheckingOut} className="rounded-xl bg-sky-700 px-5 py-3 text-lg font-black text-white disabled:bg-slate-300">
                  QR 값으로 결제하기
                </button>
              </form>
            ) : (
              <p className={`mt-4 rounded-xl ${theme.surfaceRaised} p-3 text-center text-sm font-black ${theme.mutedText}`}>QR 직접 입력은 시스템 설정에서 차단되어 있습니다. 카메라로 학생 QR을 인식해 주세요.</p>
            )}
          </>
        ) : null}

        {step === 'processing' ? (
          <div className="py-16 text-center">
            <div className="mx-auto h-16 w-16 animate-spin rounded-full border-8 border-slate-200 border-t-sky-500" />
            <h2 className="mt-8 text-4xl font-black">결제 중</h2>
            <p className={`mt-3 text-xl font-bold ${theme.mutedText}`}>학급 화폐 잔액과 재고를 확인하고 있습니다.</p>
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
              <button onClick={onRetry} className="flex-1 rounded-xl bg-sky-700 py-4 text-xl font-black text-white">
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
            <CartSummary cartDetails={completedCartDetails} totalAmount={paymentResult.totalAmount} accent={theme.text} theme={theme} showTotal={false} currencyUnit={currencyUnit} />
            <div className="mt-5 space-y-3 text-left">
              <div className={`flex items-center justify-between rounded-xl border ${theme.border} ${theme.surfaceRaised} p-4 shadow-sm`}>
                <p className="text-2xl font-black">총 결제 금액</p>
                <p className="text-3xl font-black">{formatCurrency(paymentResult.totalAmount, currencyUnit)}</p>
              </div>
              <div className={`flex items-center justify-between rounded-xl border ${theme.border} ${theme.surfaceRaised} p-4 shadow-sm`}>
                <p className="text-2xl font-black">결제 후 잔액</p>
                <p className={`text-3xl font-black ${theme.accentText}`}>{formatCurrency(paymentResult.balanceAfter, currencyUnit)}</p>
              </div>
            </div>
            <button onClick={onReset} className={`mt-7 rounded-xl ${theme.accentSolid} px-12 py-4 text-4xl font-black ${theme.accentOnSolid} shadow-sm`}>
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
  theme,
  showTotal = true,
  currencyUnit,
}: {
  cartDetails: CheckoutLineSnapshot[];
  totalAmount: number;
  accent: string;
  theme: ThemeStyles;
  showTotal?: boolean;
  currencyUnit: string;
}) {
  return (
    <div className="mt-4 space-y-3">
      {cartDetails.map((item) => (
        <div key={item.productId} className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-xl border ${theme.border} ${theme.surfaceRaised} px-3 py-3 shadow-sm sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4 sm:px-4`}>
          <p className="truncate text-lg font-black sm:text-xl">{item.name}</p>
          <p className="text-right text-lg font-black sm:text-left sm:text-xl">× {item.totalQuantity}</p>
          <div className="col-span-2 text-right sm:col-span-1 sm:w-32"><p className="text-lg font-black sm:text-xl">{formatCurrency(item.finalTotal, currencyUnit)}</p>{item.totalDiscount > 0 ? <p className={`text-sm ${theme.mutedText} line-through`}>{formatCurrency(item.regularTotal, currencyUnit)}</p> : null}</div>
        </div>
      ))}
      {showTotal ? (
        <div className={`mt-5 flex flex-col gap-1 rounded-xl border ${theme.border} ${theme.surfaceRaised} p-4 text-right shadow-sm sm:flex-row sm:items-center sm:justify-between sm:text-left`}>
          <p className="text-xl font-black sm:text-2xl">총 결제 금액</p>
          <p className={`text-3xl font-black sm:text-4xl ${accent}`}>{formatCurrency(totalAmount, currencyUnit)}</p>
        </div>
      ) : null}
    </div>
  );
}
