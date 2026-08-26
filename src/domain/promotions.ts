import type { Promotion } from './types';

type PromotionPriceInput = {
  productId: string;
  quantity: number;
  regularUnitPrice: number;
  now: Date;
  promotions: Promotion[];
};

type PromotionAdjustment = {
  promotionId: string;
  type: Promotion['type'];
  beforeAmount: number;
  afterAmount: number;
  discountAmount: number;
  freeQuantity?: number;
};

const PROMOTION_STAGE: Record<Promotion['type'], number> = {
  N_PLUS_ONE: 0,
  PROMOTIONAL_PRICE: 1,
  PERCENT_DISCOUNT: 2,
  FIXED_DISCOUNT: 3,
};

export function calculatePromotionPrice({
  productId,
  quantity,
  regularUnitPrice,
  now,
  promotions,
}: PromotionPriceInput) {
  if (!Number.isFinite(now.getTime())) {
    return {
      ok: false as const,
      code: 'INVALID_NOW' as const,
      message: '가격 계산 시각이 올바르지 않습니다.',
    };
  }

  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    return {
      ok: false as const,
      code: 'INVALID_QUANTITY' as const,
      message: '상품 수량은 1개 이상이어야 합니다.',
    };
  }

  if (!Number.isSafeInteger(regularUnitPrice) || regularUnitPrice < 0) {
    return {
      ok: false as const,
      code: 'INVALID_REGULAR_PRICE' as const,
      message: '정상 단가는 0원 이상의 정수여야 합니다.',
    };
  }

  const malformedTargetingPromotion = promotions.find((promotion) => (
    promotion.isActive && !Array.isArray(promotion.productIds)
  ));
  if (malformedTargetingPromotion) {
    return invalidPromotionResult(malformedTargetingPromotion.promotionId);
  }

  const relevantPromotions = promotions.filter((promotion) => (
    promotion.isActive && promotion.productIds.includes(productId)
  ));
  const invalidWindowPromotion = relevantPromotions.find((promotion) => !hasValidPromotionWindow(promotion));
  if (invalidWindowPromotion) {
    return invalidPromotionResult(invalidWindowPromotion.promotionId);
  }

  const activePromotions = relevantPromotions
    .filter((promotion) => isPromotionActiveAt(promotion, now));
  const invalidPromotion = activePromotions.find((promotion) => !isValidPromotion(promotion));
  if (invalidPromotion) {
    return invalidPromotionResult(invalidPromotion.promotionId);
  }
  const increasingPricePromotion = activePromotions.find((promotion) => (
    promotion.type === 'PROMOTIONAL_PRICE'
    && promotion.promotionalUnitPrice > regularUnitPrice
  ));
  if (increasingPricePromotion) {
    return invalidPromotionResult(increasingPricePromotion.promotionId);
  }
  const duplicatePromotionId = findDuplicatePromotionId(activePromotions);
  if (duplicatePromotionId) {
    return {
      ok: false as const,
      code: 'DUPLICATE_PROMOTION_ID' as const,
      message: '중복된 행사 ID가 있습니다.',
      promotionId: duplicatePromotionId,
    };
  }
  activePromotions.sort(comparePromotions);
  const adjustments: PromotionAdjustment[] = [];
  const appliedPromotions: Promotion[] = [];
  const regularTotal = regularUnitPrice * quantity;
  if (!isSafeMoney(regularTotal)) return arithmeticOverflowResult();
  let paidQuantity = quantity;
  let freeQuantity = 0;
  let currentAmount = regularTotal;

  for (const promotion of activePromotions) {
    const beforeAmount = currentAmount;
    let addedFreeQuantity: number | undefined;

    switch (promotion.type) {
      case 'N_PLUS_ONE': {
        const groupSize = promotion.buyQuantity + promotion.freeQuantity;
        if (!Number.isSafeInteger(groupSize)) return arithmeticOverflowResult();
        addedFreeQuantity = groupSize > 0
          ? Math.floor(paidQuantity / groupSize) * promotion.freeQuantity
          : 0;
        paidQuantity -= addedFreeQuantity;
        freeQuantity += addedFreeQuantity;
        currentAmount = regularUnitPrice * paidQuantity;
        break;
      }
      case 'PROMOTIONAL_PRICE':
        currentAmount = Math.min(currentAmount, promotion.promotionalUnitPrice * paidQuantity);
        break;
      case 'PERCENT_DISCOUNT': {
        const discountedAmount = applyPercentDiscount(currentAmount, promotion.percent);
        if (discountedAmount === null) return arithmeticOverflowResult();
        currentAmount = discountedAmount;
        break;
      }
      case 'FIXED_DISCOUNT': {
        const fixedDiscountTotal = promotion.discountAmount * paidQuantity;
        if (!isSafeMoney(fixedDiscountTotal)) return arithmeticOverflowResult();
        currentAmount = Math.max(0, currentAmount - fixedDiscountTotal);
        break;
      }
    }

    if (!isSafeMoney(currentAmount)) return arithmeticOverflowResult();

    if (currentAmount === beforeAmount && !addedFreeQuantity) continue;
    adjustments.push({
      promotionId: promotion.promotionId,
      type: promotion.type,
      beforeAmount,
      afterAmount: currentAmount,
      discountAmount: beforeAmount - currentAmount,
      ...(addedFreeQuantity ? { freeQuantity: addedFreeQuantity } : {}),
    });
    appliedPromotions.push(Object.freeze({
      ...promotion,
      productIds: Object.freeze([...promotion.productIds]),
    }) as Promotion);
  }

  return {
    ok: true as const,
    productId,
    totalQuantity: quantity,
    paidQuantity,
    freeQuantity,
    regularTotal,
    finalAmount: currentAmount,
    totalDiscount: regularTotal - currentAmount,
    adjustments,
    appliedPromotions: Object.freeze(appliedPromotions),
  };
}

function invalidPromotionResult(promotionId: unknown) {
  return {
    ok: false as const,
    code: 'INVALID_PROMOTION' as const,
    message: '행사 설정이 올바르지 않습니다.',
    promotionId: typeof promotionId === 'string' && promotionId.length > 0 ? promotionId : null,
  };
}

function arithmeticOverflowResult() {
  return {
    ok: false as const,
    code: 'ARITHMETIC_OVERFLOW' as const,
    message: '행사 가격 계산 범위를 초과했습니다.',
  };
}

function isSafeMoney(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function applyPercentDiscount(amount: number, percent: number): number | null {
  const { numerator, denominator } = decimalFraction(percent);
  const hundred = BigInt(100);
  const divisor = hundred * denominator;
  const discounted = (BigInt(amount) * (divisor - numerator)) / divisor;
  if (discounted > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(discounted);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const [coefficient, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText);
  const [whole, fraction = ''] = coefficient.split('.');
  let numerator = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - exponent;
  if (scale <= 0) {
    numerator *= powerOfTen(-scale);
    return { numerator, denominator: BigInt(1) };
  }
  return { numerator, denominator: powerOfTen(scale) };
}

function powerOfTen(exponent: number): bigint {
  return BigInt(10) ** BigInt(exponent);
}

function hasValidPromotionWindow(promotion: Promotion): boolean {
  const startsAt = new Date(promotion.startsAt).getTime();
  const endsAt = new Date(promotion.endsAt).getTime();
  return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt <= endsAt;
}

function isPromotionActiveAt(promotion: Promotion, now: Date): boolean {
  const startsAt = new Date(promotion.startsAt).getTime();
  const endsAt = new Date(promotion.endsAt).getTime();
  const currentTime = now.getTime();
  return startsAt <= currentTime && currentTime <= endsAt;
}

function isValidPromotion(promotion: Promotion): boolean {
  const startsAt = new Date(promotion.startsAt).getTime();
  const endsAt = new Date(promotion.endsAt).getTime();
  const createdAt = new Date(promotion.createdAt).getTime();
  const updatedAt = new Date(promotion.updatedAt).getTime();
  if (typeof promotion.promotionId !== 'string' || promotion.promotionId.length === 0) return false;
  if (typeof promotion.name !== 'string' || promotion.name.length === 0 || typeof promotion.description !== 'string') return false;
  if (!Array.isArray(promotion.productIds) || !promotion.productIds.every((id) => typeof id === 'string' && id.length > 0)) return false;
  if (typeof promotion.isActive !== 'boolean') return false;
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt > endsAt) return false;
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return false;
  if (!Number.isSafeInteger(promotion.sortOrder) || !Number.isSafeInteger(promotion.schemaVersion) || promotion.schemaVersion < 1) return false;

  switch (promotion.type) {
    case 'N_PLUS_ONE':
      return Number.isSafeInteger(promotion.buyQuantity) && promotion.buyQuantity >= 1
        && Number.isSafeInteger(promotion.freeQuantity) && promotion.freeQuantity >= 1;
    case 'PROMOTIONAL_PRICE':
      return Number.isSafeInteger(promotion.promotionalUnitPrice) && promotion.promotionalUnitPrice >= 0;
    case 'PERCENT_DISCOUNT':
      return Number.isFinite(promotion.percent) && promotion.percent > 0 && promotion.percent <= 100;
    case 'FIXED_DISCOUNT':
      return Number.isSafeInteger(promotion.discountAmount) && promotion.discountAmount > 0;
  }
}

function findDuplicatePromotionId(promotions: Promotion[]): string | null {
  const seen = new Set<string>();
  for (const promotion of promotions) {
    if (seen.has(promotion.promotionId)) return promotion.promotionId;
    seen.add(promotion.promotionId);
  }
  return null;
}

function comparePromotions(left: Promotion, right: Promotion): number {
  return PROMOTION_STAGE[left.type] - PROMOTION_STAGE[right.type]
    || left.sortOrder - right.sortOrder
    || comparePromotionIds(left.promotionId, right.promotionId);
}

function comparePromotionIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
