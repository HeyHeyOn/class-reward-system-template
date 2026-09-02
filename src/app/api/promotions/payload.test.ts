import { describe, expect, it } from 'vitest';
import { parsePatchPromotionPayload, PromotionPayloadError } from './payload';

const operationId = 'aaaaaaaa-1111-4111-8111-111111111111';
const common = { operationId, expectedPromotionVersion: 4, name: '행사', description: '설명',
  startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-10-01T00:00:00.000Z',
  isActive: true, sortOrder: 3, type: 'FIXED_DISCOUNT' as const, discountAmount: 100,
  productIds: [' P2 ', 'P1'] };

describe('parsePatchPromotionPayload', () => {
  it('derives an exact activation command payload', () => {
    expect(parsePatchPromotionPayload({ operationId, expectedPromotionVersion: 4, isActive: false }))
      .toEqual({ kind: 'activation', operationId, expectedPromotionVersion: 4, isActive: false });
  });

  it('derives a definition payload and preserves normalized target order', () => {
    expect(parsePatchPromotionPayload(common)).toEqual({ kind: 'definition', operationId,
      expectedPromotionVersion: 4, definition: { name: '행사', description: '설명',
        startsAt: common.startsAt, endsAt: common.endsAt, isActive: true, sortOrder: 3,
        type: 'FIXED_DISCOUNT', discountAmount: 100 }, productIds: ['P2', 'P1'] });
  });

  it.each([
    {}, { operationId, expectedPromotionVersion: 4, isActive: false, extra: true },
    { operationId: operationId.toUpperCase(), expectedPromotionVersion: 4, isActive: false },
    { operationId: ` ${operationId}`, expectedPromotionVersion: 4, isActive: false },
    { operationId, expectedPromotionVersion: 0, isActive: false },
    { operationId, expectedPromotionVersion: Number.MAX_SAFE_INTEGER, isActive: false },
  ])('rejects malformed exact payload %#', (value) => {
    expect(() => parsePatchPromotionPayload(value)).toThrow(PromotionPayloadError);
  });

  it('rejects accessors without invoking them', () => {
    let calls = 0;
    const value = { operationId, expectedPromotionVersion: 4, isActive: false };
    Object.defineProperty(value, 'isActive', { enumerable: true, get() { calls += 1; return false; } });
    expect(() => parsePatchPromotionPayload(value)).toThrow(PromotionPayloadError);
    expect(calls).toBe(0);
  });
});
