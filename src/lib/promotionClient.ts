import type { Promotion } from '@/domain/types';

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TYPE_FIELDS = ['buyQuantity', 'freeQuantity', 'promotionalUnitPrice', 'percent', 'discountAmount'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !CANONICAL_ISO.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

export function parsePromotionResponse(value: unknown): Promotion | null {
  if (!isRecord(value) || typeof value.promotionId !== 'string' || !value.promotionId.trim()
    || typeof value.name !== 'string' || !value.name.trim() || typeof value.description !== 'string'
    || !Array.isArray(value.productIds) || !value.productIds.every((id) => typeof id === 'string' && Boolean(id.trim()))
    || new Set(value.productIds).size !== value.productIds.length
    || !isCanonicalIso(value.startsAt) || !isCanonicalIso(value.endsAt) || Date.parse(value.startsAt) >= Date.parse(value.endsAt)
    || typeof value.isActive !== 'boolean' || !Number.isSafeInteger(value.sortOrder)
    || !isCanonicalIso(value.createdAt) || !isCanonicalIso(value.updatedAt) || value.schemaVersion !== 3) return null;

  const common = {
    promotionId: value.promotionId, name: value.name, description: value.description,
    productIds: [...value.productIds] as string[], startsAt: value.startsAt, endsAt: value.endsAt,
    isActive: value.isActive, sortOrder: value.sortOrder as number, createdAt: value.createdAt,
    updatedAt: value.updatedAt, schemaVersion: 3,
  };
  const hasUnexpectedTypeField = (...allowed: (typeof TYPE_FIELDS)[number][]) =>
    TYPE_FIELDS.some((field) => !allowed.includes(field) && field in value);
  if (value.type === 'N_PLUS_ONE' && Number.isSafeInteger(value.buyQuantity) && (value.buyQuantity as number) >= 1
    && Number.isSafeInteger(value.freeQuantity) && (value.freeQuantity as number) >= 1
    && !hasUnexpectedTypeField('buyQuantity', 'freeQuantity')) {
    return { ...common, type: value.type, buyQuantity: value.buyQuantity as number, freeQuantity: value.freeQuantity as number };
  }
  if (value.type === 'PROMOTIONAL_PRICE' && Number.isSafeInteger(value.promotionalUnitPrice)
    && (value.promotionalUnitPrice as number) >= 0 && !hasUnexpectedTypeField('promotionalUnitPrice')) {
    return { ...common, type: value.type, promotionalUnitPrice: value.promotionalUnitPrice as number };
  }
  if (value.type === 'PERCENT_DISCOUNT' && typeof value.percent === 'number' && Number.isFinite(value.percent)
    && value.percent > 0 && value.percent <= 100 && !hasUnexpectedTypeField('percent')) {
    return { ...common, type: value.type, percent: value.percent };
  }
  if (value.type === 'FIXED_DISCOUNT' && Number.isSafeInteger(value.discountAmount)
    && (value.discountAmount as number) >= 1 && !hasUnexpectedTypeField('discountAmount')) {
    return { ...common, type: value.type, discountAmount: value.discountAmount as number };
  }
  return null;
}

export function parsePromotionListResponse(value: unknown): Promotion[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map(parsePromotionResponse);
  if (!parsed.every((promotion): promotion is Promotion => promotion !== null)) return null;
  return new Set(parsed.map((promotion) => promotion.promotionId)).size === parsed.length ? parsed : null;
}

export function comparePromotionDisplayOrder(
  left: Pick<Promotion, 'sortOrder' | 'promotionId'>,
  right: Pick<Promotion, 'sortOrder' | 'promotionId'>,
): number {
  return left.sortOrder - right.sortOrder
    || (left.promotionId < right.promotionId ? -1 : left.promotionId > right.promotionId ? 1 : 0);
}

export function effectivePromotionsForProduct(
  promotions: Promotion[], productId: string, now: Date,
): Promotion[] {
  const epoch = now.getTime();
  if (!Number.isFinite(epoch)) return [];
  return promotions.filter((promotion) => promotion.isActive
    && promotion.productIds.includes(productId)
    && Date.parse(promotion.startsAt) <= epoch
    && epoch < Date.parse(promotion.endsAt))
    .sort(comparePromotionDisplayOrder);
}

export function promotionBadgeLabel(promotion: Promotion, currencyUnit: string): string {
  switch (promotion.type) {
    case 'N_PLUS_ONE': return `${promotion.buyQuantity}+${promotion.freeQuantity}`;
    case 'PROMOTIONAL_PRICE': return `${promotion.promotionalUnitPrice.toLocaleString('ko-KR')}${currencyUnit}`;
    case 'PERCENT_DISCOUNT': return `-${promotion.percent}%`;
    case 'FIXED_DISCOUNT': return `-${promotion.discountAmount.toLocaleString('ko-KR')}${currencyUnit}`;
  }
}
