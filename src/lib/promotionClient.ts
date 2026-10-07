import type { Promotion } from '@/domain/types';
import { type BudgetContext, trimBudgetString, uniqueBudgetStrings, equalBudgetValue } from './boundedWork';
import { createBoundedParserProjection, registeredBoundedKeys } from './boundedJson';

const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TYPE_FIELDS = ['buyQuantity', 'freeQuantity', 'promotionalUnitPrice', 'percent', 'discountAmount'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCanonicalIso(value: unknown, budget?: BudgetContext): value is string {
  if (typeof value !== 'string') return false;
  budget?.spend(1 + Math.ceil(value.length / 256));
  const matches = CANONICAL_ISO.test(value); budget?.check();
  if (!matches) return false;
  budget?.reserve({ nodes: 1, structuralBytes: 16 });
  budget?.spend(1 + Math.ceil(value.length / 256));
  const date = new Date(value); budget?.check();
  budget?.spend();
  const finite = Number.isFinite(date.getTime()); budget?.check();
  if (!finite) return false;
  budget?.reserveString(24); budget?.spend();
  const iso = date.toISOString(); budget?.check();
  budget?.spend(1 + Math.ceil(value.length / 256));
  return iso === value;
}
function parseEpoch(value: string, budget?: BudgetContext): number {
  budget?.spend(1 + Math.ceil(value.length / 256));
  const result = Date.parse(value); budget?.check(); return result;
}

export function parsePromotionResponse(value: unknown, budget?: BudgetContext): Promotion | null {
  budget?.spend();
  if (budget && value !== null && typeof value === 'object') registeredBoundedKeys(value, budget);
  if (!isRecord(value) || typeof value.promotionId !== 'string' || !trimBudgetString(value.promotionId, budget)
    || typeof value.name !== 'string' || !trimBudgetString(value.name, budget) || typeof value.description !== 'string'
    || !Array.isArray(value.productIds) || !value.productIds.every((id) => { budget?.spend(); return typeof id === 'string' && Boolean(trimBudgetString(id, budget)); })
    || !uniqueBudgetStrings(value.productIds, budget)
    || !isCanonicalIso(value.startsAt, budget) || !isCanonicalIso(value.endsAt, budget) || parseEpoch(value.startsAt, budget) >= parseEpoch(value.endsAt, budget)
    || typeof value.isActive !== 'boolean' || !Number.isSafeInteger(value.sortOrder)
    || !isCanonicalIso(value.createdAt, budget) || !isCanonicalIso(value.updatedAt, budget) || value.schemaVersion !== 3) return null;

  // The guarded branch projects directly from the certified source after all
  // validation. Do not create an unreserved intermediate common/spread object.
  const common: Omit<Promotion, 'type'> = budget ? value as unknown as Omit<Promotion, 'type'> : {
    promotionId: value.promotionId, name: value.name, description: value.description,
    productIds: [...value.productIds] as string[], startsAt: value.startsAt, endsAt: value.endsAt,
    isActive: value.isActive, sortOrder: value.sortOrder as number, createdAt: value.createdAt,
    updatedAt: value.updatedAt, schemaVersion: 3,
  };
  const hasUnexpectedTypeField = (...allowed: (typeof TYPE_FIELDS)[number][]) =>
    TYPE_FIELDS.some((field) => { budget?.spend(); return !allowed.some((key) => { budget?.spend(); return key === field; }) && field in value; });
  if (equalBudgetValue(value.type, 'N_PLUS_ONE', budget) && Number.isSafeInteger(value.buyQuantity) && (value.buyQuantity as number) >= 1
    && Number.isSafeInteger(value.freeQuantity) && (value.freeQuantity as number) >= 1
    && !hasUnexpectedTypeField('buyQuantity', 'freeQuantity')) {
    return budget ? createBoundedParserProjection('promotion', () => value, budget) as unknown as Promotion
      : { ...common, type: value.type, buyQuantity: value.buyQuantity as number, freeQuantity: value.freeQuantity as number };
  }
  if (equalBudgetValue(value.type, 'PROMOTIONAL_PRICE', budget) && Number.isSafeInteger(value.promotionalUnitPrice)
    && (value.promotionalUnitPrice as number) >= 0 && !hasUnexpectedTypeField('promotionalUnitPrice')) {
    return budget ? createBoundedParserProjection('promotion', () => value, budget) as unknown as Promotion
      : { ...common, type: value.type, promotionalUnitPrice: value.promotionalUnitPrice as number };
  }
  if (equalBudgetValue(value.type, 'PERCENT_DISCOUNT', budget) && typeof value.percent === 'number' && Number.isFinite(value.percent)
    && value.percent > 0 && value.percent <= 100 && !hasUnexpectedTypeField('percent')) {
    return budget ? createBoundedParserProjection('promotion', () => value, budget) as unknown as Promotion
      : { ...common, type: value.type, percent: value.percent };
  }
  if (equalBudgetValue(value.type, 'FIXED_DISCOUNT', budget) && Number.isSafeInteger(value.discountAmount)
    && (value.discountAmount as number) >= 1 && !hasUnexpectedTypeField('discountAmount')) {
    return budget ? createBoundedParserProjection('promotion', () => value, budget) as unknown as Promotion
      : { ...common, type: value.type, discountAmount: value.discountAmount as number };
  }
  return null;
}

export function parsePromotionListResponse(value: unknown): Promotion[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((item) => parsePromotionResponse(item));
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
  void currencyUnit;
  return promotion.type === 'N_PLUS_ONE'
    ? `${promotion.buyQuantity}+${promotion.freeQuantity}`
    : '할인';
}
