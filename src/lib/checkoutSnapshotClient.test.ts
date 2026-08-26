import { describe, expect, it } from 'vitest';
import { checkoutPreviewMatchesCart, parseCheckoutPreviewResponse, parseCheckoutSuccessResponse } from './checkoutSnapshotClient';

const promotion = {
  promotionId: 'N21', name: '2+1', description: '', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1,
  productIds: ['P001'], startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2099-01-01T00:00:00.000Z',
  isActive: true, sortOrder: 1, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', schemaVersion: 3,
};
const item = {
  productId: 'P001', name: '연필', price: 300, quantity: 3, subtotal: 600,
  regularUnitPrice: 300, regularTotal: 900, totalQuantity: 3, paidQuantity: 2, freeQuantity: 1,
  finalTotal: 600, totalDiscount: 300,
  adjustments: [{ promotionId: 'N21', type: 'N_PLUS_ONE', beforeAmount: 900, afterAmount: 600, discountAmount: 300, freeQuantity: 1 }],
  appliedPromotions: [promotion],
};

describe('checkoutSnapshotClient', () => {
  it('accepts internally consistent complete preview snapshots', () => {
    expect(parseCheckoutPreviewResponse({ ok: true, totalAmount: 600, items: [item] })).toEqual({ ok: true, totalAmount: 600, items: [item] });
  });

  it('requires preview products and total quantities to exactly match the requested cart', () => {
    const preview = parseCheckoutPreviewResponse({ ok: true, totalAmount: 600, items: [item] })!;
    expect(checkoutPreviewMatchesCart(preview, [{ productId: 'P001', quantity: 3 }])).toBe(true);
    expect(checkoutPreviewMatchesCart(preview, [])).toBe(false);
    expect(checkoutPreviewMatchesCart(preview, [{ productId: 'P002', quantity: 3 }])).toBe(false);
    expect(checkoutPreviewMatchesCart(preview, [{ productId: 'P001', quantity: 2 }])).toBe(false);
    expect(checkoutPreviewMatchesCart({ ...preview, items: [preview.items[0], preview.items[0]] }, [{ productId: 'P001', quantity: 3 }])).toBe(false);
  });

  it.each([
    ['missing snapshots', { ok: true, totalAmount: 600 }],
    ['wrong total', { ok: true, totalAmount: 601, items: [item] }],
    ['broken aliases', { ok: true, totalAmount: 600, items: [{ ...item, subtotal: 601 }] }],
    ['broken quantities', { ok: true, totalAmount: 600, items: [{ ...item, paidQuantity: 3 }] }],
    ['broken discount', { ok: true, totalAmount: 600, items: [{ ...item, totalDiscount: 1 }] }],
    ['malformed promotion snapshot', { ok: true, totalAmount: 600, items: [{ ...item, appliedPromotions: [{ ...promotion, schemaVersion: 2 }] }] }],
    ['adjustment/promotion type mismatch', { ok: true, totalAmount: 600, items: [{ ...item, adjustments: [{ ...item.adjustments[0], type: 'PERCENT_DISCOUNT' }] }] }],
    ['promotion targeting another product', { ok: true, totalAmount: 600, items: [{ ...item, appliedPromotions: [{ ...promotion, productIds: ['P002'] }] }] }],
    ['free quantity on a non-N+1 adjustment', { ok: true, totalAmount: 600, items: [{ ...item, adjustments: [{ ...item.adjustments[0], type: 'PERCENT_DISCOUNT' }], appliedPromotions: [{ ...promotion, type: 'PERCENT_DISCOUNT', percent: 10, buyQuantity: undefined, freeQuantity: undefined }] }] }],
    ['promotion without a paired adjustment', { ok: true, totalAmount: 900, items: [{ ...item, quantity: 3, subtotal: 900, paidQuantity: 3, freeQuantity: 0, finalTotal: 900, totalDiscount: 0, adjustments: [], appliedPromotions: [promotion] }] }],
  ])('rejects %s', (_label, value) => {
    expect(parseCheckoutPreviewResponse(value)).toBeNull();
  });

  it('strictly parses checkout metadata plus authoritative items', () => {
    expect(parseCheckoutSuccessResponse({
      ok: true, transactionId: 'T1', studentId: 'S1', studentName: '민준', totalAmount: 600,
      balanceBefore: 1000, balanceAfter: 400, items: [item],
    })).toMatchObject({ transactionId: 'T1', totalAmount: 600, items: [item] });
    expect(parseCheckoutSuccessResponse({
      ok: true, transactionId: 'T1', studentId: 'S1', studentName: '민준', totalAmount: 600,
      balanceBefore: 1000, balanceAfter: 400,
    })).toBeNull();
  });
});
