import { describe, expect, it } from 'vitest';
import { createCheckoutPreview } from '@/domain/checkout';
import type { Product, Promotion, Student } from '@/domain/types';

const activeStudent: Student = {
  studentId: 'S001',
  name: '김민준',
  balance: 3500,
  status: 'ACTIVE',
};

const products: Product[] = [
  {
    productId: 'P001',
    name: '연필',
    price: 300,
    stock: 20,
    isActive: true,
    category: '문구',
    sortOrder: 1,
  },
  {
    productId: 'P002',
    name: '지우개',
    price: 500,
    stock: 1,
    isActive: true,
    category: '문구',
    sortOrder: 2,
  },
  {
    productId: 'P003',
    name: '판매중지상품',
    price: 700,
    stock: 10,
    isActive: false,
    sortOrder: 3,
  },
];

const promotionBase = {
  description: '',
  productIds: ['P001'],
  startsAt: '2026-08-01T00:00:00.000Z',
  endsAt: '2026-09-01T00:00:00.000Z',
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
};

const stackedPromotions: Promotion[] = [
  {
    ...promotionBase,
    promotionId: 'PERCENT-10', name: '10% 할인', type: 'PERCENT_DISCOUNT', percent: 10, sortOrder: 1,
  },
  {
    ...promotionBase,
    promotionId: 'TWO-PLUS-ONE', name: '2+1', type: 'N_PLUS_ONE', buyQuantity: 2, freeQuantity: 1, sortOrder: 1,
  },
];

describe('createCheckoutPreview', () => {
  it('calculates total amount and balance after checkout for valid cart items', () => {
    const result = createCheckoutPreview({
      student: activeStudent,
      products,
      cartItems: [
        { productId: 'P001', quantity: 2 },
        { productId: 'P002', quantity: 1 },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected checkout preview to succeed');
    expect(result.totalAmount).toBe(1100);
    expect(result.balanceBefore).toBe(3500);
    expect(result.balanceAfter).toBe(2400);
    expect(result.items).toEqual([
      {
        productId: 'P001', name: '연필', price: 300, quantity: 2, subtotal: 600,
        regularUnitPrice: 300, regularTotal: 600, totalQuantity: 2,
        paidQuantity: 2, freeQuantity: 0, finalTotal: 600, totalDiscount: 0,
        adjustments: [], appliedPromotions: [],
      },
      {
        productId: 'P002', name: '지우개', price: 500, quantity: 1, subtotal: 500,
        regularUnitPrice: 500, regularTotal: 500, totalQuantity: 1,
        paidQuantity: 1, freeQuantity: 0, finalTotal: 500, totalDiscount: 0,
        adjustments: [], appliedPromotions: [],
      },
    ]);
  });

  it('rejects checkout when student balance is insufficient', () => {
    const result = createCheckoutPreview({
      student: { ...activeStudent, balance: 500 },
      products,
      cartItems: [{ productId: 'P001', quantity: 2 }],
    });

    expect(result).toEqual({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      message: '잔액이 부족합니다.',
      currentBalance: 500,
      requiredAmount: 600,
    });
  });

  it('rejects checkout for a student with a negative admin-adjusted balance', () => {
    const result = createCheckoutPreview({
      student: { ...activeStudent, balance: -1 },
      products,
      cartItems: [{ productId: 'P001', quantity: 1 }],
    });

    expect(result).toEqual({
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      message: '잔액이 부족합니다.',
      currentBalance: -1,
      requiredAmount: 300,
    });
  });

  it('rejects checkout when requested quantity exceeds stock', () => {
    const result = createCheckoutPreview({
      student: activeStudent,
      products,
      cartItems: [{ productId: 'P002', quantity: 2 }],
    });

    expect(result).toEqual({
      ok: false,
      code: 'INSUFFICIENT_STOCK',
      message: '재고가 부족합니다.',
      productId: 'P002',
      requestedQuantity: 2,
      currentStock: 1,
    });
  });

  it('rejects inactive products', () => {
    const result = createCheckoutPreview({
      student: activeStudent,
      products,
      cartItems: [{ productId: 'P003', quantity: 1 }],
    });

    expect(result).toEqual({
      ok: false,
      code: 'PRODUCT_INACTIVE',
      message: '판매 중지된 상품입니다.',
      productId: 'P003',
    });
  });

  it('snapshots stacked promotion pricing with total-received N+1 quantities', () => {
    const result = createCheckoutPreview({
      student: activeStudent,
      products,
      cartItems: [{ productId: 'P001', quantity: 3 }],
      promotions: stackedPromotions,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected checkout preview to succeed');
    expect(result.items[0]).toMatchObject({
      price: 300,
      quantity: 3,
      subtotal: 540,
      regularUnitPrice: 300,
      regularTotal: 900,
      totalQuantity: 3,
      paidQuantity: 2,
      freeQuantity: 1,
      finalTotal: 540,
      totalDiscount: 360,
      adjustments: [
        { promotionId: 'TWO-PLUS-ONE', type: 'N_PLUS_ONE', beforeAmount: 900, afterAmount: 600, discountAmount: 300, freeQuantity: 1 },
        { promotionId: 'PERCENT-10', type: 'PERCENT_DISCOUNT', beforeAmount: 600, afterAmount: 540, discountAmount: 60 },
      ],
    });
    expect(result.items[0].appliedPromotions.map(({ promotionId }) => promotionId)).toEqual([
      'TWO-PLUS-ONE', 'PERCENT-10',
    ]);
  });

  it('checks and subtracts the discounted final total from the balance', () => {
    const result = createCheckoutPreview({
      student: { ...activeStudent, balance: 540 }, products,
      cartItems: [{ productId: 'P001', quantity: 3 }],
      promotions: stackedPromotions,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result).toMatchObject({ ok: true, totalAmount: 540, balanceBefore: 540, balanceAfter: 0 });
  });

  it('checks stock against total received quantity instead of paid quantity', () => {
    const result = createCheckoutPreview({
      student: activeStudent,
      products: [{ ...products[0], stock: 2 }],
      cartItems: [{ productId: 'P001', quantity: 3 }],
      promotions: stackedPromotions,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result).toEqual({
      ok: false, code: 'INSUFFICIENT_STOCK', message: '재고가 부족합니다.',
      productId: 'P001', requestedQuantity: 3, currentStock: 2,
    });
  });

  it('aggregates duplicate product IDs safely in first-seen order', () => {
    const result = createCheckoutPreview({
      student: { ...activeStudent, balance: 10_000 }, products,
      cartItems: [
        { productId: 'P002', quantity: 1 },
        { productId: 'P001', quantity: 1 },
        { productId: 'P001', quantity: 2 },
      ],
      promotions: stackedPromotions,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected checkout preview to succeed');
    expect(result.items.map(({ productId, totalQuantity }) => [productId, totalQuantity])).toEqual([
      ['P002', 1], ['P001', 3],
    ]);
  });

  it('returns an explicit product-scoped pricing failure without partial success', () => {
    const malformedPromotion = { ...stackedPromotions[0], percent: 200 } as Promotion;
    const result = createCheckoutPreview({
      student: activeStudent, products,
      cartItems: [{ productId: 'P001', quantity: 1 }],
      promotions: [malformedPromotion],
      now: new Date('2026-08-15T00:00:00.000Z'),
    });

    expect(result).toEqual({
      ok: false,
      code: 'PRICING_FAILED',
      productId: 'P001',
      pricingCode: 'INVALID_PROMOTION',
      message: '행사 설정이 올바르지 않습니다.',
      promotionId: 'PERCENT-10',
    });
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid runtime quantity %s', (quantity) => {
    expect(createCheckoutPreview({
      student: activeStudent, products,
      cartItems: [{ productId: 'P001', quantity }],
    })).toEqual({
      ok: false, code: 'INVALID_QUANTITY', message: '상품 수량은 1개 이상이어야 합니다.', productId: 'P001',
    });
  });

  it('rejects duplicate quantity addition overflow', () => {
    expect(createCheckoutPreview({
      student: activeStudent, products,
      cartItems: [
        { productId: 'P001', quantity: Number.MAX_SAFE_INTEGER },
        { productId: 'P001', quantity: 1 },
      ],
    })).toEqual({
      ok: false, code: 'ARITHMETIC_OVERFLOW', message: '결제 금액 계산 범위를 초과했습니다.', productId: 'P001',
    });
  });

  it('rejects an empty or malformed cart explicitly', () => {
    expect(createCheckoutPreview({ student: activeStudent, products, cartItems: [] })).toEqual({
      ok: false, code: 'EMPTY_CART', message: '장바구니가 비어 있습니다.',
    });
    expect(createCheckoutPreview({
      student: activeStudent, products, cartItems: null as unknown as [],
    })).toEqual({ ok: false, code: 'INVALID_CART', message: '장바구니가 올바르지 않습니다.' });
  });

  it('rejects malformed runtime student and product records without throwing', () => {
    expect(createCheckoutPreview({
      student: null as unknown as Student, products,
      cartItems: [{ productId: 'P001', quantity: 1 }],
    })).toEqual({ ok: false, code: 'INVALID_STUDENT', message: '학생 정보가 올바르지 않습니다.' });
    expect(createCheckoutPreview({
      student: { ...activeStudent, studentId: ' ', name: ' ' }, products,
      cartItems: [{ productId: 'P001', quantity: 1 }],
    })).toEqual({ ok: false, code: 'INVALID_STUDENT', message: '학생 정보가 올바르지 않습니다.' });

    for (const malformedProducts of [
      [null],
      [{ ...products[0], stock: Number.NaN }],
      [{ ...products[0], price: Number.NaN }],
      [products[0], { ...products[0] }],
      [{ ...products[0], productId: ' ' }],
      [{ ...products[0], name: ' ' }],
    ]) {
      expect(createCheckoutPreview({
        student: activeStudent,
        products: malformedProducts as Product[],
        cartItems: [{ productId: 'P001', quantity: 1 }],
      })).toEqual({ ok: false, code: 'INVALID_PRODUCTS', message: '상품 목록이 올바르지 않습니다.' });
    }
  });

  it('returns explicit failures for malformed runtime now and promotion entries', () => {
    expect(createCheckoutPreview({
      student: activeStudent, products,
      cartItems: [{ productId: 'P001', quantity: 1 }],
      now: 'not-a-date' as unknown as Date,
    })).toEqual({
      ok: false, code: 'PRICING_FAILED', productId: 'P001', pricingCode: 'INVALID_NOW',
      message: '가격 계산 시각이 올바르지 않습니다.',
    });

    expect(createCheckoutPreview({
      student: activeStudent, products,
      cartItems: [{ productId: 'P001', quantity: 1 }],
      promotions: [null as unknown as Promotion],
    })).toEqual({ ok: false, code: 'INVALID_PROMOTIONS', message: '행사 목록이 올바르지 않습니다.' });
  });

  it('returns immutable snapshots detached from promotion inputs', () => {
    const mutablePromotions = structuredClone(stackedPromotions);
    const result = createCheckoutPreview({
      student: activeStudent, products,
      cartItems: [{ productId: 'P001', quantity: 3 }],
      promotions: mutablePromotions,
      now: new Date('2026-08-15T00:00:00.000Z'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected checkout preview to succeed');
    const line = result.items[0];

    mutablePromotions[0].name = '변경됨';
    mutablePromotions[0].productIds.push('P999');
    expect(line.appliedPromotions[1].name).toBe('10% 할인');
    expect(line.appliedPromotions[1].productIds).toEqual(['P001']);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(line)).toBe(true);
    expect(Object.isFrozen(line.adjustments)).toBe(true);
    expect(Object.isFrozen(line.adjustments[0])).toBe(true);
    expect(Object.isFrozen(line.appliedPromotions)).toBe(true);
    expect(Object.isFrozen(line.appliedPromotions[0])).toBe(true);
    expect(Object.isFrozen(line.appliedPromotions[0].productIds)).toBe(true);
  });
});
