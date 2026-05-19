import type { CartItem, CheckoutLineItem, Product, Student } from './types';

type CheckoutPreviewInput = {
  student: Student;
  products: Product[];
  cartItems: CartItem[];
};

type CheckoutPreviewSuccess = {
  ok: true;
  totalAmount: number;
  balanceBefore: number;
  balanceAfter: number;
  items: CheckoutLineItem[];
};

type CheckoutPreviewFailure =
  | {
      ok: false;
      code: 'PRODUCT_NOT_FOUND';
      message: string;
      productId: string;
    }
  | {
      ok: false;
      code: 'PRODUCT_INACTIVE';
      message: string;
      productId: string;
    }
  | {
      ok: false;
      code: 'INSUFFICIENT_STOCK';
      message: string;
      productId: string;
      requestedQuantity: number;
      currentStock: number;
    }
  | {
      ok: false;
      code: 'INSUFFICIENT_BALANCE';
      message: string;
      currentBalance: number;
      requiredAmount: number;
    };

export type CheckoutPreviewResult = CheckoutPreviewSuccess | CheckoutPreviewFailure;

export function createCheckoutPreview({
  student,
  products,
  cartItems,
}: CheckoutPreviewInput): CheckoutPreviewResult {
  const productMap = new Map(products.map((product) => [product.productId, product]));
  const items: CheckoutLineItem[] = [];

  for (const cartItem of cartItems) {
    const product = productMap.get(cartItem.productId);

    if (!product) {
      return {
        ok: false,
        code: 'PRODUCT_NOT_FOUND',
        message: '상품을 찾을 수 없습니다.',
        productId: cartItem.productId,
      };
    }

    if (!product.isActive) {
      return {
        ok: false,
        code: 'PRODUCT_INACTIVE',
        message: '판매 중지된 상품입니다.',
        productId: product.productId,
      };
    }

    if (cartItem.quantity > product.stock) {
      return {
        ok: false,
        code: 'INSUFFICIENT_STOCK',
        message: '재고가 부족합니다.',
        productId: product.productId,
        requestedQuantity: cartItem.quantity,
        currentStock: product.stock,
      };
    }

    items.push({
      productId: product.productId,
      name: product.name,
      price: product.price,
      quantity: cartItem.quantity,
      subtotal: product.price * cartItem.quantity,
    });
  }

  const totalAmount = items.reduce((sum, item) => sum + item.subtotal, 0);

  if (student.balance < totalAmount) {
    return {
      ok: false,
      code: 'INSUFFICIENT_BALANCE',
      message: '잔액이 부족합니다.',
      currentBalance: student.balance,
      requiredAmount: totalAmount,
    };
  }

  return {
    ok: true,
    totalAmount,
    balanceBefore: student.balance,
    balanceAfter: student.balance - totalAmount,
    items,
  };
}
