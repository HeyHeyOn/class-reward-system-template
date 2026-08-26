import { describe, expect, it } from 'vitest';
import { calculatePromotionPrice } from '@/domain/promotions';
import type { Promotion } from '@/domain/types';

const activeTwoPlusOne: Promotion = {
  promotionId: 'PROMO-2PLUS1',
  name: '연필 2+1',
  description: '연필 세 개를 고르면 한 개 무료',
  type: 'N_PLUS_ONE',
  buyQuantity: 2,
  freeQuantity: 1,
  productIds: ['P001'],
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-08-31T23:59:59.999Z',
  isActive: true,
  sortOrder: 10,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
};

describe('calculatePromotionPrice', () => {
  it('treats cart quantity as total received quantity for N+1 promotions', () => {
    const result = calculatePromotionPrice({
      productId: 'P001',
      quantity: 3,
      regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [activeTwoPlusOne],
    });

    expect(result).toMatchObject({
      ok: true,
      productId: 'P001',
      totalQuantity: 3,
      paidQuantity: 2,
      freeQuantity: 1,
      regularTotal: 3_000,
      finalAmount: 2_000,
      totalDiscount: 1_000,
      adjustments: [
        {
          promotionId: 'PROMO-2PLUS1',
          type: 'N_PLUS_ONE',
          beforeAmount: 3_000,
          afterAmount: 2_000,
          discountAmount: 1_000,
          freeQuantity: 1,
        },
      ],
      appliedPromotions: [
        {
          promotionId: 'PROMO-2PLUS1',
          name: '연필 2+1',
          type: 'N_PLUS_ONE',
          sortOrder: 10,
        },
      ],
    });
    if (!result.ok) throw new Error('expected promotion price calculation to succeed');
    expect(result.appliedPromotions).toEqual([activeTwoPlusOne]);
    expect(Object.isFrozen(result.appliedPromotions)).toBe(true);
    expect(Object.isFrozen(result.appliedPromotions[0])).toBe(true);
    expect(Object.isFrozen(result.appliedPromotions[0].productIds)).toBe(true);
  });

  it('rejects an invalid calculation time', () => {
    expect(calculatePromotionPrice({
      productId: 'P001', quantity: 1, regularUnitPrice: 1_000,
      now: new Date('invalid'), promotions: [activeTwoPlusOne],
    })).toEqual({
      ok: false,
      code: 'INVALID_NOW',
      message: '가격 계산 시각이 올바르지 않습니다.',
    });
  });

  it('rejects a non-positive total received quantity', () => {
    expect(calculatePromotionPrice({
      productId: 'P001',
      quantity: 0,
      regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [activeTwoPlusOne],
    })).toEqual({
      ok: false,
      code: 'INVALID_QUANTITY',
      message: '상품 수량은 1개 이상이어야 합니다.',
    });
  });

  it('rejects an invalid regular unit price', () => {
    expect(calculatePromotionPrice({
      productId: 'P001',
      quantity: 1,
      regularUnitPrice: -1,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [],
    })).toEqual({
      ok: false,
      code: 'INVALID_REGULAR_PRICE',
      message: '정상 단가는 0원 이상의 정수여야 합니다.',
    });
  });

  it('floors percent discounts exactly without floating-point one-won errors', () => {
    const tenPercent: Promotion = {
      promotionId: 'PERCENT-10', name: '10% 할인', description: '', type: 'PERCENT_DISCOUNT', percent: 10,
      productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
      isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
    };

    expect(calculatePromotionPrice({
      productId: 'P001', quantity: 1, regularUnitPrice: Number.MAX_SAFE_INTEGER,
      now: new Date('2026-08-15T00:00:00.000Z'), promotions: [tenPercent],
    })).toMatchObject({
      ok: true,
      finalAmount: 8_106_479_329_266_891,
    });
  });

  it('returns an explicit failure when a monetary intermediate exceeds safe integer range', () => {
    expect(calculatePromotionPrice({
      productId: 'P001',
      quantity: Number.MAX_SAFE_INTEGER,
      regularUnitPrice: 2,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [],
    })).toEqual({
      ok: false,
      code: 'ARITHMETIC_OVERFLOW',
      message: '행사 가격 계산 범위를 초과했습니다.',
    });
  });

  it('returns an explicit failure for a malformed active runtime row', () => {
    const malformed = {
      ...activeTwoPlusOne,
      productIds: undefined,
    } as unknown as Promotion;

    expect(calculatePromotionPrice({
      productId: 'P001',
      quantity: 1,
      regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [malformed],
    })).toEqual({
      ok: false,
      code: 'INVALID_PROMOTION',
      message: '행사 설정이 올바르지 않습니다.',
      promotionId: 'PROMO-2PLUS1',
    });
  });

  it('rejects an active runtime row with an invalid promotion identifier', () => {
    const malformed = {
      ...activeTwoPlusOne,
      promotionId: 123,
    } as unknown as Promotion;

    expect(calculatePromotionPrice({
      productId: 'P001',
      quantity: 3,
      regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [malformed],
    })).toEqual({
      ok: false,
      code: 'INVALID_PROMOTION',
      message: '행사 설정이 올바르지 않습니다.',
      promotionId: null,
    });
  });

  it('rejects a malformed active promotion instead of producing a negative price', () => {
    const malformed: Promotion = {
      promotionId: 'BAD-PERCENT', name: '잘못된 할인', description: '', type: 'PERCENT_DISCOUNT', percent: 150,
      productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
      isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
    };

    expect(calculatePromotionPrice({
      productId: 'P001',
      quantity: 1,
      regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [malformed],
    })).toEqual({
      ok: false,
      code: 'INVALID_PROMOTION',
      message: '행사 설정이 올바르지 않습니다.',
      promotionId: 'BAD-PERCENT',
    });
  });

  it('rejects duplicate active promotion identifiers before applying rules', () => {
    expect(calculatePromotionPrice({
      productId: 'P001', quantity: 6, regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions: [activeTwoPlusOne, { ...activeTwoPlusOne }],
    })).toEqual({
      ok: false,
      code: 'DUPLICATE_PROMOTION_ID',
      message: '중복된 행사 ID가 있습니다.',
      promotionId: 'PROMO-2PLUS1',
    });
  });

  it('rejects a promotional price above the regular unit price', () => {
    const increasingPrice: Promotion = {
      promotionId: 'PRICE-HIGH', name: '잘못된 행사가', description: '', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 200,
      productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
      isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
    };

    expect(calculatePromotionPrice({
      productId: 'P001', quantity: 1, regularUnitPrice: 100,
      now: new Date('2026-08-15T00:00:00.000Z'), promotions: [increasingPrice],
    })).toEqual({
      ok: false,
      code: 'INVALID_PROMOTION',
      message: '행사 설정이 올바르지 않습니다.',
      promotionId: 'PRICE-HIGH',
    });
  });

  it('never raises the amount when multiple promotional prices are stacked', () => {
    const lower: Promotion = {
      promotionId: 'PRICE-LOW', name: '80원', description: '', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 80,
      productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
      isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
    };
    const higherLater: Promotion = {
      ...lower,
      promotionId: 'PRICE-HIGHER-LATER',
      name: '90원',
      promotionalUnitPrice: 90,
      sortOrder: 2,
    };

    const result = calculatePromotionPrice({
      productId: 'P001', quantity: 1, regularUnitPrice: 100,
      now: new Date('2026-08-15T00:00:00.000Z'), promotions: [higherLater, lower],
    });

    expect(result).toMatchObject({ ok: true, finalAmount: 80, totalDiscount: 20 });
    if (!result.ok) throw new Error('expected promotion price calculation to succeed');
    expect(result.adjustments.map((adjustment) => adjustment.promotionId)).toEqual(['PRICE-LOW']);
  });

  it('ignores an expired targeted promotion even when its obsolete rule value is malformed', () => {
    const expiredMalformed: Promotion = {
      promotionId: 'EXPIRED-BAD', name: '지난 할인', description: '', type: 'PERCENT_DISCOUNT', percent: 150,
      productIds: ['P001'], startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-07-31T23:59:59.999Z',
      isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
    };

    expect(calculatePromotionPrice({
      productId: 'P001', quantity: 1, regularUnitPrice: 1_000,
      now: new Date('2026-08-15T00:00:00.000Z'), promotions: [expiredMalformed],
    })).toMatchObject({
      ok: true,
      finalAmount: 1_000,
      adjustments: [],
      appliedPromotions: [],
    });
  });

  it('uses deterministic code-unit promotion ID ordering when priorities tie', () => {
    const decomposed: Promotion = {
      promotionId: 'PROMO-e\u0301', name: '90원', description: '', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 90,
      productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
      isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
    };
    const composed: Promotion = {
      ...decomposed,
      promotionId: 'PROMO-é',
      name: '80원',
      promotionalUnitPrice: 80,
    };
    const calculate = (promotions: Promotion[]) => calculatePromotionPrice({
      productId: 'P001', quantity: 1, regularUnitPrice: 100,
      now: new Date('2026-08-15T00:00:00.000Z'), promotions,
    });

    const forward = calculate([decomposed, composed]);
    const reversed = calculate([composed, decomposed]);

    expect(forward).toMatchObject({ ok: true, finalAmount: 80 });
    expect(reversed).toMatchObject({ ok: true, finalAmount: 80 });
  });

  it('applies stacked promotions by stage and administrator priority regardless of input order', () => {
    const promotions: Promotion[] = [
      {
        promotionId: 'FIXED-1', name: '5원 할인', description: '', type: 'FIXED_DISCOUNT', discountAmount: 5,
        productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
        isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
      },
      {
        promotionId: 'PERCENT-B', name: '33% 할인', description: '', type: 'PERCENT_DISCOUNT', percent: 33,
        productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
        isActive: true, sortOrder: 2, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
      },
      {
        promotionId: 'PRICE-1', name: '51원 행사 가격', description: '', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 51,
        productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
        isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
      },
      activeTwoPlusOne,
      {
        promotionId: 'PERCENT-A', name: '10% 할인', description: '', type: 'PERCENT_DISCOUNT', percent: 10,
        productIds: ['P001'], startsAt: activeTwoPlusOne.startsAt, endsAt: activeTwoPlusOne.endsAt,
        isActive: true, sortOrder: 1, createdAt: activeTwoPlusOne.createdAt, updatedAt: activeTwoPlusOne.updatedAt, schemaVersion: 1,
      },
    ];

    const result = calculatePromotionPrice({
      productId: 'P001',
      quantity: 3,
      regularUnitPrice: 100,
      now: new Date('2026-08-15T00:00:00.000Z'),
      promotions,
    });

    expect(result).toMatchObject({
      ok: true,
      paidQuantity: 2,
      freeQuantity: 1,
      regularTotal: 300,
      finalAmount: 50,
      totalDiscount: 250,
    });
    if (!result.ok) throw new Error('expected promotion price calculation to succeed');
    expect(result.adjustments.map((adjustment) => [adjustment.type, adjustment.promotionId, adjustment.afterAmount])).toEqual([
      ['N_PLUS_ONE', 'PROMO-2PLUS1', 200],
      ['PROMOTIONAL_PRICE', 'PRICE-1', 102],
      ['PERCENT_DISCOUNT', 'PERCENT-A', 91],
      ['PERCENT_DISCOUNT', 'PERCENT-B', 60],
      ['FIXED_DISCOUNT', 'FIXED-1', 50],
    ]);
  });
});
