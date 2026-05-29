import { describe, expect, it } from 'vitest';
import { createCheckoutPreview } from '@/domain/checkout';
import type { Product, Student } from '@/domain/types';

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
      { productId: 'P001', name: '연필', price: 300, quantity: 2, subtotal: 600 },
      { productId: 'P002', name: '지우개', price: 500, quantity: 1, subtotal: 500 },
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
});
