import { describe, expect, it } from 'vitest';
import type { Promotion } from '@/domain/types';
import {
  comparePromotionDisplayOrder,
  effectivePromotionsForProduct,
  parsePromotionListResponse,
  promotionBadgeLabel,
} from './promotionClient';

const base = {
  description: '', productIds: ['P001'], startsAt: '2026-08-01T00:00:00.000Z', endsAt: '2026-09-01T00:00:00.000Z',
  isActive: true, sortOrder: 1, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z', schemaVersion: 3,
};
const nPlusOne: Promotion = { ...base, promotionId: 'N21', name: '2+1', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1 };
const percent: Promotion = { ...base, promotionId: 'P10', name: '10%', type: 'PERCENT_DISCOUNT', percent: 10 };

 describe('promotionClient', () => {
  it('strictly parses schema-v3 promotion lists and rejects duplicate IDs', () => {
    expect(parsePromotionListResponse([nPlusOne, percent])).toEqual([nPlusOne, percent]);
    expect(parsePromotionListResponse([{ ...percent, schemaVersion: 2 }])).toBeNull();
    expect(parsePromotionListResponse([percent, { ...percent }])).toBeNull();
  });

  it('uses start-inclusive/end-exclusive windows and deterministic sortOrder/UTF-16 ordering', () => {
    expect(effectivePromotionsForProduct([nPlusOne], 'P001', new Date(base.startsAt))).toEqual([nPlusOne]);
    expect(effectivePromotionsForProduct([nPlusOne], 'P001', new Date(base.endsAt))).toEqual([]);
    expect([
      { ...percent, promotionId: '😀', sortOrder: 1 },
      { ...percent, promotionId: 'Z', sortOrder: 1 },
    ].sort(comparePromotionDisplayOrder).map((item) => item.promotionId)).toEqual(['Z', '😀']);
  });

  it('keeps N+1 badges and projects every other promotion to 할인', () => {
    expect(promotionBadgeLabel(nPlusOne, '별')).toBe('2+1');
    expect(promotionBadgeLabel({ ...base, promotionId: 'PRICE', name: '가격', type: 'PROMOTIONAL_PRICE', promotionalUnitPrice: 250 }, '별')).toBe('할인');
    expect(promotionBadgeLabel(percent, '별')).toBe('할인');
    expect(promotionBadgeLabel({ ...base, promotionId: 'FIX', name: '정액', type: 'FIXED_DISCOUNT', discountAmount: 50 }, '별')).toBe('할인');
  });
});
