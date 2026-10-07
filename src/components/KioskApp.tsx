'use client';

import styles from './classroom.module.css';

import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createCartPricingPreview } from '@/domain/checkout';
import { calculatePromotionPrice } from '@/domain/promotions';
import type { CartItem, CheckoutLineSnapshot, Product, Promotion, Student } from '@/domain/types';
import { checkoutPreviewMatchesCart, parseCheckoutPreviewResponse, parseCheckoutSuccessResponse, type CheckoutPreviewPayload, type CheckoutSuccessPayload } from '@/lib/checkoutSnapshotClient';
import { getFontFamilyCss, type FontFamily } from '@/lib/fontSettings';
import { effectivePromotionsForProduct, parsePromotionListResponse, promotionBadgeLabel } from '@/lib/promotionClient';
import { tenantFetch } from '@/lib/tenantApiPath';
import { QrScanner } from './QrScanner';
import { PromotionPills } from './promotions/PromotionPills';
import { normalizeThemeColor, themeStyles, type ThemeColor, type ThemeStyles } from './uiTheme';
import { Icon } from './ui';

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
  uncertain?: boolean;
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
  const checkoutOperationRef = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const checkoutInFlightRef = useRef(false);

  const loadProducts = useCallback(async (options: { shouldApply?: () => boolean } = {}) => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoadingProducts(true);
    setLoadError('');
    try {
      const [productResponse, settingsResponse, promotionResponse] = await Promise.all([
        tenantFetch('/api/products', { cache: 'no-store' }),
        tenantFetch('/api/settings', { cache: 'no-store' }),
        tenantFetch('/api/promotions/active', { cache: 'no-store' }),
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
    void Promise.resolve().then(() => {
      if (!ignore) return loadProducts({ shouldApply: () => !ignore });
    });
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

  const quantityButtonClass = 'relative z-10 flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)] transition-colors hover:bg-[var(--theme-accent-soft)]';

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
    checkoutOperationRef.current = null;
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
    if (checkoutInFlightRef.current) return;

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

    checkoutInFlightRef.current = true;
    setIsCheckingOut(true);
    setFailure(null);
    setPaymentStep('processing');
    const checkoutCartGeneration = cartGenerationRef.current;
    const checkoutCartKey = cartKey;
    let checkoutSubmitted = false;

    try {
      const studentResponse = await tenantFetch(`/api/students/${encodeURIComponent(studentId)}`, { cache: 'no-store' });
      const studentPayload = (await studentResponse.json()) as Student | ApiError;

      if (!studentResponse.ok || isApiError(studentPayload)) {
        setFailure({
          title: '결제 실패',
          message: isApiError(studentPayload) ? studentPayload.error || '잘못된 QR 코드입니다.' : '잘못된 QR 코드입니다.',
        });
        setPaymentStep('failure');
        return;
      }

      const checkoutBody = JSON.stringify({
        operationId: checkoutOperationId(studentPayload.studentId, cartItems, currentPreview),
        studentId,
        items: cartItems,
        expectedPricing: currentPreview,
      });
      checkoutSubmitted = true;
      const checkoutResponse = await tenantFetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: checkoutBody,
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
            checkoutOperationRef.current = null;
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
      checkoutOperationRef.current = null;
      setCompletedCartDetails(checkoutPayload.items);
      setCartItems([]);
      setManualQrValue('');
      setPaymentStep('complete');
    } catch {
      setFailure(checkoutSubmitted ? {
        title: '결제 상태 확인 필요',
        message: '결제 응답을 받지 못해 처리 여부를 확인할 수 없습니다.',
        detail: '이미 처리되었을 수 있으니 거래 내역과 잔액을 먼저 확인하고, 별도의 새 결제를 하지 마세요.',
        uncertain: true,
      } : {
        title: '결제 실패',
        message: '학생 정보를 확인하지 못했습니다. 결제는 요청되지 않았습니다.',
      });
      setPaymentStep('failure');
    } finally {
      checkoutInFlightRef.current = false;
      setIsCheckingOut(false);
    }
  }

  function handleManualQrSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void completeCheckoutWithQrValue(manualQrValue);
  }

  function resetToShop() {
    cartGenerationRef.current += 1;
    checkoutOperationRef.current = null;
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

  function checkoutOperationId(
    studentId: string,
    items: CartItem[],
    expectedPricing: CheckoutPreviewPayload,
  ): string {
    const fingerprint = JSON.stringify({ studentId, items, expectedPricing });
    if (checkoutOperationRef.current?.fingerprint === fingerprint) {
      return checkoutOperationRef.current.operationId;
    }
    const operationId = crypto.randomUUID();
    checkoutOperationRef.current = { fingerprint, operationId };
    return operationId;
  }

  return (
    <main data-testid="kiosk-shell" data-theme={themeColor} style={{ ...theme.variables, ...fontFamilyStyle }} className={`${styles.kiosk} h-[100dvh] overflow-hidden bg-[var(--theme-shell)] text-[var(--theme-text)]`}>
      <section
        data-testid="kiosk-content"
        aria-hidden={paymentStep ? true : undefined}
        inert={paymentStep ? true : undefined}
        className="mx-auto grid h-full w-full max-w-[1320px] grid-rows-[auto_minmax(0,1fr)] gap-3 p-3 sm:gap-4 sm:p-5"
      >
        <header className={`${styles.kioskHeader} flex items-center gap-3`}>
          <span aria-hidden="true" className={styles.brandMark} />
          <h1 data-testid="kiosk-title" className="min-w-0 flex-1 truncate text-[clamp(1.35rem,4.5vw,2.25rem)] font-black leading-tight tracking-[-0.035em]">{appTitle}</h1>
          <button type="button" onClick={() => void loadProducts()} aria-label="새로고침"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-muted-text)] shadow-[var(--crs-shadow-sm)] transition-colors hover:text-[var(--theme-text)]">
            <Icon name="refresh" size={19} />
          </button>
        </header>

        <div data-testid="kiosk-main-grid" className="grid min-h-0 grid-rows-[minmax(0,1.7fr)_minmax(0,1fr)] gap-3 landscape:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] landscape:grid-rows-1 sm:gap-4">
          <section data-testid="products-panel" className="flex min-h-0 flex-col">
            <div className="flex min-w-0 items-center gap-3">
              <h2 className="sr-only">상품 목록</h2>
              <div data-testid="category-tabs" className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto whitespace-nowrap pb-1 [scrollbar-width:none]">
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
                      className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[15px] font-bold transition-colors ${selected
                        ? 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow-sm)]'
                        : 'border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]'}`}
                    >
                      {filter.kind === 'promotion' ? <Icon name="sparkle" size={15} /> : null}
                      {label}
                    </button>
                  );
                })}
              </div>
              {isLoadingProducts ? <p className="shrink-0 text-[13px] font-semibold text-[var(--theme-muted-text)]">불러오는 중</p> : null}
            </div>

            <div data-testid="product-scroll-block" className="mt-3 min-h-0 flex-1 overflow-y-auto pb-2 pr-0.5">
              <div data-testid="product-grid" className="grid grid-cols-3 gap-2.5 sm:gap-3 md:grid-cols-4 landscape:grid-cols-3 lg:landscape:grid-cols-4">
                {selectedFilter.kind === 'promotion' && filteredProducts.length === 0 ? (
                  <p className="col-span-full rounded-[18px] border border-dashed border-[var(--crs-line-strong)] p-10 text-center text-[15px] font-semibold text-[var(--theme-muted-text)]">진행 중인 행사 상품이 없습니다.</p>
                ) : null}
                {filteredProducts.map((product) => {
                  const isSoldOut = product.stock <= 0;
                  const cardPromotion = productPricing.get(product.productId);
                  const cardPrice = cardPromotion?.pricing;
                  const displayPrice = cardPrice?.ok ? cardPrice.finalAmount : product.price;
                  const cardPricingFailed = !cardPrice?.ok;
                  const discounted = Boolean(cardPrice?.ok && cardPrice.finalAmount < product.price);
                  const inCart = cartItems.find((item) => item.productId === product.productId)?.quantity ?? 0;
                  return (
                    <button
                      key={product.productId}
                      onClick={() => addToCart(product.productId)}
                      disabled={!product.isActive || isSoldOut || cardPricingFailed || Boolean(loadError)}
                      aria-label={`${product.name} ${formatCurrency(displayPrice, currencyUnit)} 담기${promotionAccessibleSummary(cardPromotion?.effective ?? [], currencyUnit)}`}
                      data-testid="product-card"
                      className={`group relative flex min-w-0 flex-col rounded-[18px] border bg-[var(--theme-surface)] p-2 text-left shadow-[var(--crs-shadow-sm)] transition-[transform,box-shadow,border-color] duration-150 active:scale-[0.98] disabled:cursor-not-allowed sm:p-2.5 ${inCart ? 'border-[var(--theme-accent-text)] ring-2 ring-[color-mix(in_srgb,var(--theme-accent-text)_22%,transparent)]' : 'border-[var(--crs-line)] hover:-translate-y-0.5 hover:shadow-[var(--crs-shadow)]'} ${isSoldOut ? 'grayscale disabled:opacity-60' : 'disabled:opacity-50'}`}
                    >
                      <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-[13px] bg-[var(--crs-subtle-hover)]">
                        {product.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={product.imageUrl} loading="lazy" decoding="async" alt={`${product.name} 이미지`} className="h-full w-full object-cover" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src="/class-reward-system-icon.png" data-placeholder="" alt={`${product.name} 기본 이미지`} className="h-full w-full object-contain p-[24%]" />
                        )}
                        <PromotionPills
                          promotions={cardPromotion?.effective ?? []}
                          currencyUnit={currencyUnit}
                          ariaLabel={`${product.name} 행사`}
                          className="absolute left-1.5 top-1.5 z-10 max-w-[calc(100%-0.75rem)]"
                          pillClassName="bg-[var(--crs-danger-solid)] text-white"
                        />
                        {isSoldOut ? <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-[clamp(0.8rem,2.6vw,1.1rem)] font-black text-white">품절</span> : null}
                        {inCart ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 flex h-7 min-w-7 items-center justify-center rounded-full bg-[var(--theme-accent-solid)] px-2 text-sm font-black text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow)]">{inCart}</span> : null}
                      </div>
                      <div className="mt-2 min-w-0 px-0.5">
                        <p className="truncate text-[11px] font-semibold text-[var(--theme-muted-text)] sm:text-xs">{product.category || '기타'}</p>
                        <p className="truncate text-[clamp(0.8rem,2.3vw,1.05rem)] font-bold leading-snug">{product.name}</p>
                        <div data-testid="product-card-footer" className="mt-1 flex flex-wrap items-end justify-between gap-x-2">
                          <div className="min-w-0 leading-tight">
                            {discounted ? <p className="text-[11px] font-semibold text-[var(--theme-muted-text)] line-through sm:text-xs" aria-label={`정상 가격 ${formatCurrency(product.price, currencyUnit)}`}>{formatCurrency(product.price, currencyUnit)}</p> : null}
                            <p className={`truncate text-[clamp(0.9rem,2.6vw,1.25rem)] font-black tabular-nums ${discounted ? 'text-[var(--crs-danger-text)]' : ''}`}>{formatCurrency(displayPrice, currencyUnit)}</p>
                          </div>
                          <p data-testid="product-card-stock" className="shrink-0 whitespace-nowrap text-[11px] font-semibold text-[var(--theme-muted-text)] sm:text-xs">재고 {product.stock}</p>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section data-testid="cart-panel" className="flex min-h-0 flex-col rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-3 shadow-[var(--crs-shadow)] sm:p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-[clamp(1.05rem,3vw,1.3rem)] font-black tracking-[-0.02em]">
                <Icon name="cart" size={20} />장바구니
                <span className="sr-only">({cartDetails.length})</span>
                {cartDetails.length ? <span aria-hidden="true" className="rounded-full bg-[var(--theme-accent-soft)] px-2 py-0.5 text-[13px] font-black text-[var(--theme-accent-text)]">{cartDetails.length}</span> : null}
              </h2>
              <button
                onClick={clearCart}
                disabled={cartItems.length === 0}
                className="rounded-full px-3 py-1.5 text-[13px] font-bold text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                비우기
              </button>
            </div>

            <div data-testid="cart-scroll-block" className="mt-3 min-h-0 flex-1 overflow-y-auto">
              {cartDetails.length === 0 ? (
                <div className="flex h-full min-h-16 flex-col items-center justify-center gap-2 rounded-[16px] bg-[var(--crs-subtle)] p-4 text-center text-[clamp(0.8rem,2.6vw,0.95rem)] font-semibold text-[var(--theme-muted-text)]">
                  <Icon name="cart" size={24} className="hidden opacity-50 sm:block" />
                  선택한 상품이 없습니다.
                </div>
              ) : (
                <div className="divide-y divide-[var(--crs-line)]">
                  {cartDetails.map((item) => {
                    const snapshot = currentPreview?.items.find((candidate) => candidate.productId === item.productId);
                    return (
                      <div key={item.productId} data-testid="cart-item-row" className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 py-2.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <PromotionPills
                            promotions={productPricing.get(item.productId)?.effective ?? []}
                            currencyUnit={currencyUnit}
                            ariaLabel={`${item.name} 행사`}
                            className="shrink-0 flex-nowrap"
                            pillClassName="bg-[var(--crs-danger-solid)] text-white"
                          />
                          <p data-testid="cart-item-name" className="min-w-0 truncate text-[clamp(0.9rem,2.6vw,1.05rem)] font-bold leading-tight">{snapshot?.name ?? item.name}</p>
                        </div>
                        <div data-testid="cart-item-subtotal" className="row-span-2 min-w-0 text-right text-[clamp(0.95rem,2.8vw,1.1rem)] font-black leading-tight tabular-nums">
                          {snapshot ? <>{snapshot.totalDiscount > 0 ? <p className="text-xs font-semibold text-[var(--theme-muted-text)] line-through" aria-label={`정상 합계 ${formatCurrency(snapshot.regularTotal, currencyUnit)}`}>{formatCurrency(snapshot.regularTotal, currencyUnit)}</p> : null}<p className={snapshot.totalDiscount > 0 ? 'text-[var(--crs-danger-text)]' : ''}>{formatCurrency(snapshot.finalTotal, currencyUnit)}</p></> : <span aria-hidden="true">—</span>}
                        </div>
                        <div data-testid="cart-quantity-controls" className="relative z-10 flex w-fit items-center rounded-full bg-[var(--crs-subtle-hover)] p-0.5">
                          <button aria-label={`${item.name} 수량 줄이기`} onClick={() => removeFromCart(item.productId)} className={quantityButtonClass}>
                            <Icon name="minus" size={16} strokeWidth={2.4} />
                          </button>
                          <span className="w-8 text-center text-[15px] font-black tabular-nums">{item.quantity}</span>
                          <button aria-label={`${item.name} 수량 늘리기`} onClick={() => addToCart(item.productId)} className={quantityButtonClass}>
                            <Icon name="plus" size={16} strokeWidth={2.4} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {message || pricingError ? <p role="alert" className="mt-2 rounded-[12px] bg-[var(--crs-warning-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--crs-warning-text)]">{pricingError ? '행사 가격 설정이 올바르지 않아 결제할 수 없습니다.' : message}</p> : null}

            <div data-testid="checkout-total-bar" className="mt-3 flex items-center gap-3 border-t border-[var(--crs-line)] pt-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold text-[var(--theme-muted-text)]">총 결제 금액</p>
                {cartItems.length === 0 ? <p className="truncate text-[clamp(1.4rem,4.5vw,1.9rem)] font-black leading-tight tracking-[-0.03em] tabular-nums text-[var(--theme-muted-text)]">{formatCurrency(0, currencyUnit)}</p> : totalAmount === null ? <p className="text-sm font-semibold text-[var(--theme-muted-text)]">확인 중</p> : <>
                  {totalSavings > 0 && regularAggregate !== null ? <p className="text-xs font-semibold text-[var(--theme-muted-text)] line-through" aria-label={`정상 총액 ${formatCurrency(regularAggregate, currencyUnit)}`}>{formatCurrency(regularAggregate, currencyUnit)}</p> : null}
                  <p className="truncate text-[clamp(1.4rem,4.5vw,1.9rem)] font-black leading-tight tracking-[-0.03em] tabular-nums">{formatCurrency(totalAmount, currencyUnit)}</p>
                </>}
              </div>
              <button
                data-testid="checkout-button"
                onClick={openCheckout}
                disabled={cartItems.length === 0 || !currentPreview || pricingError || Boolean(loadError)}
                className="inline-flex h-14 shrink-0 items-center justify-center gap-2 rounded-[16px] bg-[var(--theme-accent-solid)] px-6 text-[clamp(1.05rem,3vw,1.3rem)] font-black text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow)] transition-colors hover:bg-[var(--theme-hover)] hover:text-[var(--theme-hover-text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                <Icon name="qr" size={20} />
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
    <main style={themeStyles('white').variables} className="flex min-h-screen items-center justify-center bg-[var(--theme-shell)] p-4 text-[var(--theme-text)]">
      <section role="dialog" aria-modal="true" aria-label={title} className="flex w-full max-w-sm flex-col items-center rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-6 py-8 text-center shadow-[var(--crs-shadow)]">
        <div className="h-9 w-9 animate-spin rounded-full border-[3px] border-[var(--crs-line-strong)] border-t-[var(--theme-accent-text)]" aria-hidden="true" />
        <h1 className="mt-5 text-lg font-black tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{message}</p>
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
  const dialogLabel = step === 'checkout' ? '결제 확인' : step === 'processing' ? '결제 중' : step === 'failure' ? failure?.title || '결제 실패' : '결제 완료';
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
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-[rgb(15_23_42/0.5)] backdrop-blur-[3px] sm:items-center sm:p-4">
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        className="max-h-[100dvh] w-full max-w-[760px] overflow-y-auto rounded-t-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-5 text-[var(--theme-text)] shadow-[var(--crs-shadow-lg)] outline-none [animation:crs-pop-in_.2s_ease-out] sm:max-h-[calc(100dvh-2rem)] sm:rounded-[26px] sm:p-7"
      >
        {step === 'checkout' ? (
          <>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[26px] font-black tracking-[-0.035em]">결제 확인</h2>
                <p className="mt-1 text-sm text-[var(--theme-muted-text)]">학생 QR을 카메라에 비추면 바로 결제됩니다.</p>
              </div>
              <button onClick={onCancel} aria-label="결제 창 닫기" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)]"><Icon name="close" size={20} /></button>
            </div>
            <div className="mt-5 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="overflow-hidden rounded-[20px] border border-[var(--crs-line)] bg-white">
                <QrScanner onScan={onScan} />
              </div>
              <div className="flex min-w-0 flex-col">
                <CartSummary cartDetails={cartDetails} totalAmount={totalAmount} accent="" theme={theme} currencyUnit={currencyUnit} />
                <button onClick={onCancel} className="mt-auto w-full rounded-[14px] border border-[var(--crs-line-strong)] py-3.5 text-[17px] font-bold text-[var(--theme-text)] transition-colors hover:bg-[var(--crs-subtle-hover)]">
                  결제 취소
                </button>
              </div>
            </div>
            {qrManualInputEnabled ? (
              <form onSubmit={onManualQrSubmit} className="mt-4 flex flex-col gap-2 rounded-[16px] bg-[var(--crs-subtle)] p-3 sm:flex-row">
                <label className="sr-only" htmlFor="manual-qr-value">
                  QR 값 직접 입력
                </label>
                <input
                  id="manual-qr-value"
                  value={manualQrValue}
                  onChange={(event) => setManualQrValue(event.target.value)}
                  placeholder="카메라가 안 되면 예: S001"
                  className="h-12 min-w-0 flex-1 rounded-[12px] border border-[var(--crs-line-strong)] bg-[var(--theme-input)] px-4 text-base font-semibold text-[var(--theme-text)] outline-none focus:border-[var(--theme-focus-ring)] focus:ring-[3px] focus:ring-[color-mix(in_srgb,var(--theme-focus-ring)_18%,transparent)]"
                />
                <button type="submit" disabled={isCheckingOut} className="h-12 rounded-[12px] bg-[var(--theme-accent-solid)] px-5 text-base font-black text-[var(--theme-accent-on-solid)] disabled:opacity-40">
                  QR 값으로 결제하기
                </button>
              </form>
            ) : (
              <p className="mt-4 flex items-center justify-center gap-2 rounded-[14px] bg-[var(--crs-subtle)] px-4 py-3 text-center text-[13px] font-semibold text-[var(--theme-muted-text)]"><Icon name="lock" size={15} />QR 직접 입력은 시스템 설정에서 차단되어 있습니다. 카메라로 학생 QR을 인식해 주세요.</p>
            )}
          </>
        ) : null}

        {step === 'processing' ? (
          <div className="py-14 text-center">
            <div className="mx-auto h-14 w-14 animate-spin rounded-full border-[5px] border-[var(--crs-line-strong)] border-t-[var(--theme-accent-text)]" />
            <h2 className="mt-7 text-[30px] font-black tracking-[-0.035em]">결제 중</h2>
            <p className="mt-2 text-lg font-semibold text-[var(--theme-muted-text)]">학급 화폐 잔액과 재고를 확인하고 있습니다.</p>
          </div>
        ) : null}

        {step === 'failure' ? (
          <div className="py-6 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]"><Icon name="alert" size={36} strokeWidth={2} /></div>
            <h2 className="mt-5 text-[30px] font-black tracking-[-0.035em]">{failure?.title || '결제 실패'}</h2>
            <p className="mt-3 text-xl font-bold text-[var(--crs-danger-text)]">{failure?.message || '결제에 실패했습니다.'}</p>
            {failure?.detail ? <p className="mt-2 text-lg font-semibold text-[var(--theme-muted-text)]">{failure.detail}</p> : null}
            <div className="mt-8 flex gap-3">
              <button onClick={onCancel} className="h-14 flex-1 rounded-[16px] border border-[var(--crs-line-strong)] text-lg font-bold">
                {failure?.uncertain ? '닫기' : '결제 취소'}
              </button>
              <button onClick={onRetry} className="h-14 flex-1 rounded-[16px] bg-[var(--theme-accent-solid)] text-lg font-black text-[var(--theme-accent-on-solid)]">
                다시 시도
              </button>
            </div>
          </div>
        ) : null}

        {step === 'complete' && paymentResult ? (
          <div className="py-2 text-center">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]"><Icon name="check" size={40} strokeWidth={2.4} /></div>
            <h2 className="mt-5 text-[30px] font-black tracking-[-0.035em]">결제가 완료되었습니다.</h2>
            <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-1 text-[15px] font-semibold text-[var(--theme-muted-text)]">
              <p>결제자: {paymentResult.studentName}</p>
              <p>결제 일시: {new Date().toLocaleString('ko-KR', { hour12: false })}</p>
            </div>
            <div className="mt-5 text-left">
              <CartSummary cartDetails={completedCartDetails} totalAmount={paymentResult.totalAmount} accent="" theme={theme} showTotal={false} currencyUnit={currencyUnit} />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-left">
              <div className="rounded-[16px] bg-[var(--crs-subtle)] p-4">
                <p className="text-sm font-semibold text-[var(--theme-muted-text)]">총 결제 금액</p>
                <p className="mt-1 text-[26px] font-black tabular-nums tracking-[-0.03em]">{formatCurrency(paymentResult.totalAmount, currencyUnit)}</p>
              </div>
              <div className="rounded-[16px] bg-[var(--theme-accent-soft)] p-4">
                <p className="text-sm font-semibold text-[var(--theme-accent-text)]">결제 후 잔액</p>
                <p className="mt-1 text-[26px] font-black tabular-nums tracking-[-0.03em] text-[var(--theme-accent-text)]">{formatCurrency(paymentResult.balanceAfter, currencyUnit)}</p>
              </div>
            </div>
            <button onClick={onReset} className="mt-6 h-16 w-full rounded-[18px] bg-[var(--theme-accent-solid)] text-2xl font-black text-[var(--theme-accent-on-solid)] shadow-[var(--crs-shadow)]">
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
    <div className="mb-4">
      <div className="divide-y divide-[var(--crs-line)] rounded-[16px] border border-[var(--crs-line)] px-4">
        {cartDetails.map((item) => (
          <div key={item.productId} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 py-3">
            <p className="truncate text-base font-bold">{item.name}</p>
            <p className="text-sm font-semibold tabular-nums text-[var(--theme-muted-text)]">× {item.totalQuantity}</p>
            <div className="min-w-20 text-right"><p className="text-base font-black tabular-nums">{formatCurrency(item.finalTotal, currencyUnit)}</p>{item.totalDiscount > 0 ? <p className="text-xs text-[var(--theme-muted-text)] line-through">{formatCurrency(item.regularTotal, currencyUnit)}</p> : null}</div>
          </div>
        ))}
      </div>
      {showTotal ? (
        <div className="mt-3 flex items-baseline justify-between gap-3 px-1">
          <p className="text-base font-bold">총 결제 금액</p>
          <p className="text-[28px] font-black tabular-nums tracking-[-0.03em]">{formatCurrency(totalAmount, currencyUnit)}</p>
        </div>
      ) : null}
    </div>
  );
}
