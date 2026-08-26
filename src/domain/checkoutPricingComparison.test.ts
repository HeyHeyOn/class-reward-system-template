import { describe, expect, it } from 'vitest';
import { checkoutPricingMatches } from './checkout';
import type { Promotion } from './types';

const promotionBase = {
  name: '행사', description: '', productIds: ['P001'], startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z', isActive: true, sortOrder: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', schemaVersion: 3,
};
const nPlusOne: Promotion = {
  ...promotionBase, promotionId: 'N21', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1,
};
const percent: Promotion = {
  ...promotionBase, promotionId: 'P10', type: 'PERCENT_DISCOUNT', percent: 10, sortOrder: 2,
};
const expected = {
  ok: true as const,
  totalAmount: 540,
  items: [{
    productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 540,
    regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2, freeQuantity: 1,
    finalTotal: 540, totalDiscount: 360,
    adjustments: [
      { promotionId: 'N21', type: 'N_PLUS_ONE' as const, beforeAmount: 900, afterAmount: 600, discountAmount: 300, freeQuantity: 1 },
      { promotionId: 'P10', type: 'PERCENT_DISCOUNT' as const, beforeAmount: 600, afterAmount: 540, discountAmount: 60 },
    ],
    appliedPromotions: [nPlusOne, percent],
  }],
};

describe('checkoutPricingMatches', () => {
  it('accepts an exact quote and rejects product/order, quantity, amount, adjustment, and promotion changes', () => {
    expect(checkoutPricingMatches(expected, structuredClone(expected))).toBe(true);
    expect(checkoutPricingMatches(expected, { ...expected, items: [...expected.items, { ...expected.items[0], productId: 'P002' }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], totalQuantity: 2 }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, totalAmount: 541 })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], adjustments: [{ ...expected.items[0].adjustments[0], promotionId: 'OTHER' }, expected.items[0].adjustments[1]] }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], adjustments: [{ ...expected.items[0].adjustments[0], type: 'PERCENT_DISCOUNT' }, expected.items[0].adjustments[1]] }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], adjustments: [...expected.items[0].adjustments].reverse() }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], appliedPromotions: [{ ...nPlusOne, promotionId: 'OTHER' }, percent] }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], appliedPromotions: [{ ...nPlusOne, type: 'PERCENT_DISCOUNT', percent: 10 }, percent] }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], appliedPromotions: [percent, nPlusOne] }] })).toBe(false);
    expect(checkoutPricingMatches(expected, { ...expected, items: [{ ...expected.items[0], appliedPromotions: [{ ...nPlusOne, endsAt: '2026-08-15T00:00:00.000Z' }, percent] }] })).toBe(false);
  });
});
