import { calculatePromotionPrice } from './promotions';
import type {
  CartItem,
  CheckoutLineItem,
  CheckoutLineSnapshot,
  Product,
  Promotion,
  PromotionAdjustment,
  Student,
  VoucherAdjustment,
} from './types';

export type CartPricingPreviewInput = {
  products: Product[];
  cartItems: CartItem[];
  promotions?: Promotion[];
  /** 교환권 used, per product: each pays for one unit at the product's price (up to the line's total). */
  vouchers?: Readonly<Record<string, number>>;
  now?: Date;
};

export type CheckoutPreviewInput = CartPricingPreviewInput & {
  student: Student;
};

export type CartPricingPreviewSuccess = {
  ok: true;
  totalAmount: number;
  items: CheckoutLineSnapshot[];
};

export type CartPricingPreviewFailure =
  | {
      ok: false;
      code: 'PRODUCT_NOT_FOUND';
      message: string;
      productId: string;
    }
  | {
      ok: false;
      code: 'PRODUCT_INACTIVE';
      message: string;
      productId: string;
    }
  | {
      ok: false;
      code: 'INSUFFICIENT_STOCK';
      message: string;
      productId: string;
      requestedQuantity: number;
      currentStock: number;
    }
  | {
      ok: false;
      code: 'PRICING_FAILED';
      message: string;
      productId: string;
      pricingCode: string;
      promotionId?: string | null;
    }
  | {
      ok: false;
      code: 'INVALID_QUANTITY';
      message: string;
      productId: string;
    }
  | {
      ok: false;
      code: 'ARITHMETIC_OVERFLOW';
      message: string;
      productId?: string;
    }
  | {
      ok: false;
      code: 'EMPTY_CART' | 'INVALID_CART' | 'INVALID_PRODUCTS' | 'INVALID_PROMOTIONS' | 'INVALID_VOUCHERS';
      message: string;
    };

export type CartPricingPreviewResult = CartPricingPreviewSuccess | CartPricingPreviewFailure;

export function checkoutPricingMatches(
  expected: CartPricingPreviewSuccess,
  authoritative: CartPricingPreviewSuccess,
): boolean {
  return JSON.stringify(pricingComparisonValue(expected)) === JSON.stringify(pricingComparisonValue(authoritative));
}

function pricingComparisonValue(pricing: CartPricingPreviewSuccess) {
  return {
    totalAmount: pricing.totalAmount,
    items: pricing.items.map((item) => ({
      productId: item.productId,
      name: item.name,
      price: item.price,
      quantity: item.quantity,
      subtotal: item.subtotal,
      regularUnitPrice: item.regularUnitPrice,
      regularTotal: item.regularTotal,
      totalQuantity: item.totalQuantity,
      paidQuantity: item.paidQuantity,
      freeQuantity: item.freeQuantity,
      finalTotal: item.finalTotal,
      totalDiscount: item.totalDiscount,
      adjustments: item.adjustments.map((adjustment) => (adjustment.type === 'VOUCHER' ? {
        type: adjustment.type,
        beforeAmount: adjustment.beforeAmount,
        afterAmount: adjustment.afterAmount,
        discountAmount: adjustment.discountAmount,
        voucherCount: adjustment.voucherCount,
      } : {
        promotionId: adjustment.promotionId,
        type: adjustment.type,
        beforeAmount: adjustment.beforeAmount,
        afterAmount: adjustment.afterAmount,
        discountAmount: adjustment.discountAmount,
        ...('freeQuantity' in adjustment ? { freeQuantity: adjustment.freeQuantity } : {}),
      })),
      appliedPromotions: item.appliedPromotions.map((promotion) => ({
        promotionId: promotion.promotionId,
        name: promotion.name,
        description: promotion.description,
        type: promotion.type,
        productIds: [...promotion.productIds],
        startsAt: promotion.startsAt,
        endsAt: promotion.endsAt,
        isActive: promotion.isActive,
        sortOrder: promotion.sortOrder,
        createdAt: promotion.createdAt,
        updatedAt: promotion.updatedAt,
        schemaVersion: promotion.schemaVersion,
        ...(promotion.type === 'N_PLUS_ONE' ? { buyQuantity: promotion.buyQuantity, freeQuantity: promotion.freeQuantity } : {}),
        ...(promotion.type === 'PROMOTIONAL_PRICE' ? { promotionalUnitPrice: promotion.promotionalUnitPrice } : {}),
        ...(promotion.type === 'PERCENT_DISCOUNT' ? { percent: promotion.percent } : {}),
        ...(promotion.type === 'FIXED_DISCOUNT' ? { discountAmount: promotion.discountAmount } : {}),
      })),
    })),
  };
}

type CheckoutPreviewSuccess = CartPricingPreviewSuccess & {
  balanceBefore: number;
  balanceAfter: number;
};

type CheckoutPreviewFailure =
  | CartPricingPreviewFailure
  | {
      ok: false;
      code: 'INSUFFICIENT_BALANCE';
      message: string;
      currentBalance: number;
      requiredAmount: number;
    }
  | {
      ok: false;
      code: 'INVALID_STUDENT';
      message: string;
    };

export type CheckoutPreviewResult = CheckoutPreviewSuccess | CheckoutPreviewFailure;

export function createCheckoutPreview(input: CheckoutPreviewInput): CheckoutPreviewResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_CART', message: '장바구니가 올바르지 않습니다.' };
  }
  const { student, products, cartItems, promotions = [], vouchers, now = new Date() } = input;
  if (!isValidStudent(student)) {
    return { ok: false, code: 'INVALID_STUDENT', message: '학생 정보가 올바르지 않습니다.' };
  }

  const pricing = createCartPricingPreview({ products, cartItems, promotions, vouchers, now });
  if (!pricing.ok) return pricing;

  if (!Number.isSafeInteger(student.balance)) return arithmeticOverflow();
  if (student.balance < pricing.totalAmount) {
    return {
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      message: '잔액이 부족합니다.',
      currentBalance: student.balance,
      requiredAmount: pricing.totalAmount,
    };
  }

  const balanceAfter = student.balance - pricing.totalAmount;
  if (!Number.isSafeInteger(balanceAfter)) return arithmeticOverflow();

  return Object.freeze({
    ok: true,
    totalAmount: pricing.totalAmount,
    balanceBefore: student.balance,
    balanceAfter,
    items: pricing.items,
  });
}

export function createCartPricingPreview(input: CartPricingPreviewInput): CartPricingPreviewResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_CART', message: '장바구니가 올바르지 않습니다.' };
  }
  const { products, cartItems, promotions = [], vouchers = {}, now = new Date() } = input;
  if (!Array.isArray(cartItems)) {
    return { ok: false, code: 'INVALID_CART', message: '장바구니가 올바르지 않습니다.' };
  }
  if (cartItems.length === 0) {
    return { ok: false, code: 'EMPTY_CART', message: '장바구니가 비어 있습니다.' };
  }
  if (!isValidProductList(products)) {
    return { ok: false, code: 'INVALID_PRODUCTS', message: '상품 목록이 올바르지 않습니다.' };
  }
  if (!Array.isArray(promotions) || promotions.some((promotion) => (
    !promotion || typeof promotion !== 'object' || Array.isArray(promotion)
  ))) {
    return { ok: false, code: 'INVALID_PROMOTIONS', message: '행사 목록이 올바르지 않습니다.' };
  }

  const normalizedItems = normalizeCartItems(cartItems);
  if (!normalizedItems.ok) return normalizedItems;
  const voucherCounts = normalizeVouchers(vouchers, normalizedItems.items);
  if (!voucherCounts) {
    return { ok: false, code: 'INVALID_VOUCHERS', message: '교환권은 장바구니에 담은 상품 개수만큼만 쓸 수 있습니다.' };
  }

  const productMap = new Map(products.map((product) => [product.productId, product]));
  const items: CheckoutLineSnapshot[] = [];
  let totalAmount = 0;

  for (const cartItem of normalizedItems.items) {
    const product = productMap.get(cartItem.productId);

    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: '상품을 찾을 수 없습니다.',
        productId: cartItem.productId,
      };
    }

    if (!product.isActive) {
      return {
        ok: false,
        code: 'PRODUCT_INACTIVE',
        message: '판매 중지된 상품입니다.',
        productId: product.productId,
      };
    }

    if (cartItem.quantity > product.stock) {
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        message: '재고가 부족합니다.',
        productId: product.productId,
        requestedQuantity: cartItem.quantity,
        currentStock: product.stock,
      };
    }

    const pricing = calculatePromotionPrice({
      productId: product.productId,
      quantity: cartItem.quantity,
      regularUnitPrice: product.price,
      now,
      promotions,
    });
    if (!pricing.ok) {
      return {
        ok: false,
        code: 'PRICING_FAILED',
        productId: product.productId,
        pricingCode: pricing.code,
        message: pricing.message,
        ...('promotionId' in pricing ? { promotionId: pricing.promotionId } : {}),
      };
    }

    const nextTotal = totalAmount + pricing.finalAmount;
    if (!Number.isSafeInteger(nextTotal)) return arithmeticOverflow(product.productId);
    totalAmount = nextTotal;

    const adjustments = Object.freeze(pricing.adjustments.map(cloneAdjustment));
    const appliedPromotions = Object.freeze(pricing.appliedPromotions.map(clonePromotion));
    items.push(Object.freeze({
      productId: product.productId,
      name: product.name,
      price: product.price,
      quantity: pricing.totalQuantity,
      subtotal: pricing.finalAmount,
      regularUnitPrice: product.price,
      regularTotal: pricing.regularTotal,
      totalQuantity: pricing.totalQuantity,
      paidQuantity: pricing.paidQuantity,
      freeQuantity: pricing.freeQuantity,
      finalTotal: pricing.finalAmount,
      totalDiscount: pricing.totalDiscount,
      adjustments,
      appliedPromotions,
    }));
  }

  const pricing: CartPricingPreviewSuccess = Object.freeze({
    ok: true,
    totalAmount,
    items: Object.freeze(items) as CheckoutLineSnapshot[],
  });
  return voucherCounts.size > 0 ? applyCheckoutVouchers(pricing, Object.fromEntries(voucherCounts)) : pricing;
}

/**
 * Applies 교환권 to a priced cart: on each line, after its promotions, `count` × the regular unit price
 * comes off (never below 0). The kiosk applies them to the quote it shows; the checkout recomputes the
 * same from the 교환권 it locks.
 */
export function applyCheckoutVouchers(
  pricing: CartPricingPreviewSuccess,
  vouchers: Readonly<Record<string, number>>,
): CartPricingPreviewResult {
  const counts = normalizeVouchers(vouchers, pricing.items.map((item) => ({ productId: item.productId, quantity: item.totalQuantity })));
  if (!counts || pricing.items.some((item) => counts.has(item.productId) && item.adjustments.some((adjustment) => adjustment.type === 'VOUCHER'))) {
    return { ok: false, code: 'INVALID_VOUCHERS', message: '교환권은 장바구니에 담은 상품 개수만큼만 쓸 수 있습니다.' };
  }
  let totalAmount = 0;
  const items: CheckoutLineSnapshot[] = [];
  for (const item of pricing.items) {
    const voucherCount = counts.get(item.productId) ?? 0;
    let line = item;
    if (voucherCount > 0) {
      const voucherValue = voucherCount * item.regularUnitPrice;
      if (!Number.isSafeInteger(voucherValue)) return arithmeticOverflow(item.productId);
      const discountAmount = Math.min(voucherValue, item.finalTotal);
      const voucher: VoucherAdjustment = Object.freeze({
        type: 'VOUCHER', beforeAmount: item.finalTotal, afterAmount: item.finalTotal - discountAmount, discountAmount, voucherCount,
      });
      line = Object.freeze({
        ...item,
        subtotal: voucher.afterAmount,
        finalTotal: voucher.afterAmount,
        totalDiscount: item.totalDiscount + discountAmount,
        adjustments: Object.freeze([...item.adjustments, voucher]),
      });
    }
    totalAmount += line.finalTotal;
    if (!Number.isSafeInteger(totalAmount)) return arithmeticOverflow(item.productId);
    items.push(line);
  }
  return Object.freeze({ ok: true, totalAmount, items: Object.freeze(items) as CheckoutLineSnapshot[] });
}

/** How many 교환권 a checkout line used (0 for lines without any, including history from before them). */
export function lineVoucherCount(item: CheckoutLineItem | CheckoutLineSnapshot): number {
  const adjustments = 'adjustments' in item && Array.isArray(item.adjustments) ? item.adjustments : [];
  const voucher = adjustments.find((adjustment): adjustment is VoucherAdjustment => adjustment.type === 'VOUCHER');
  return voucher?.voucherCount ?? 0;
}

/** The same quote without its 교환권 (the kiosk keeps a server quote this way to apply 교환권 again). */
export function removeCheckoutVouchers(pricing: CartPricingPreviewSuccess): CartPricingPreviewSuccess {
  let totalAmount = 0;
  const items = pricing.items.map((item) => {
    const voucher = item.adjustments.find((adjustment): adjustment is VoucherAdjustment => adjustment.type === 'VOUCHER');
    const line = voucher ? Object.freeze({
      ...item,
      subtotal: voucher.beforeAmount,
      finalTotal: voucher.beforeAmount,
      totalDiscount: item.totalDiscount - voucher.discountAmount,
      adjustments: Object.freeze(item.adjustments.filter((adjustment) => adjustment.type !== 'VOUCHER')),
    }) : item;
    totalAmount += line.finalTotal;
    return line;
  });
  return Object.freeze({ ok: true, totalAmount, items: Object.freeze(items) as CheckoutLineSnapshot[] });
}

function normalizeCartItems(cartItems: CartItem[]):
  | { ok: true; items: CartItem[] }
  | CartPricingPreviewFailure {
  const quantities = new Map<string, number>();

  for (const cartItem of cartItems) {
    if (!cartItem || typeof cartItem !== 'object' || typeof cartItem.productId !== 'string' || cartItem.productId.length === 0) {
      return { ok: false, code: 'INVALID_CART', message: '장바구니가 올바르지 않습니다.' };
    }
    if (!Number.isSafeInteger(cartItem.quantity) || cartItem.quantity < 1) {
      return {
        ok: false,
        code: 'INVALID_QUANTITY',
        message: '상품 수량은 1개 이상이어야 합니다.',
        productId: cartItem.productId,
      };
    }

    const quantity = (quantities.get(cartItem.productId) ?? 0) + cartItem.quantity;
    if (!Number.isSafeInteger(quantity)) return arithmeticOverflow(cartItem.productId);
    quantities.set(cartItem.productId, quantity);
  }

  return {
    ok: true,
    items: [...quantities].map(([productId, quantity]) => ({ productId, quantity })),
  };
}

/** 교환권 counts per cart product: positive whole numbers, at most the units in the cart. */
function normalizeVouchers(vouchers: unknown, items: readonly CartItem[]): Map<string, number> | null {
  if (!vouchers || typeof vouchers !== 'object' || Array.isArray(vouchers)) return null;
  const quantities = new Map(items.map((item) => [item.productId, item.quantity]));
  const counts = new Map<string, number>();
  for (const [productId, count] of Object.entries(vouchers as Record<string, unknown>)) {
    const quantity = quantities.get(productId);
    if (quantity === undefined || !Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > quantity) return null;
    counts.set(productId, count as number);
  }
  return counts;
}

function isValidStudent(value: unknown): value is Student {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const student = value as Partial<Student>;
  return typeof student.studentId === 'string' && student.studentId.trim().length > 0
    && typeof student.name === 'string' && student.name.trim().length > 0
    && Number.isSafeInteger(student.balance)
    && (student.status === 'ACTIVE' || student.status === 'INACTIVE');
}

function isValidProductList(value: unknown): value is Product[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const product = entry as Partial<Product>;
    if (typeof product.productId !== 'string' || product.productId.trim().length === 0
      || ids.has(product.productId)
      || typeof product.name !== 'string' || product.name.trim().length === 0
      || !Number.isSafeInteger(product.price) || product.price! < 0
      || !Number.isSafeInteger(product.stock) || product.stock! < 0
      || typeof product.isActive !== 'boolean'
      || !Number.isSafeInteger(product.sortOrder)
      || (product.imageUrl !== undefined && typeof product.imageUrl !== 'string')
      || (product.category !== undefined && typeof product.category !== 'string')) {
      return false;
    }
    ids.add(product.productId);
  }
  return true;
}

function cloneAdjustment(adjustment: PromotionAdjustment): PromotionAdjustment {
  return Object.freeze({ ...adjustment });
}

function clonePromotion(promotion: Promotion): Promotion {
  return Object.freeze({
    ...promotion,
    productIds: Object.freeze([...promotion.productIds]),
  }) as Promotion;
}

function arithmeticOverflow(productId?: string): Extract<CheckoutPreviewFailure, { code: 'ARITHMETIC_OVERFLOW' }> {
  return {
    ok: false,
    code: 'ARITHMETIC_OVERFLOW',
    message: '결제 금액 계산 범위를 초과했습니다.',
    ...(productId === undefined ? {} : { productId }),
  };
}
