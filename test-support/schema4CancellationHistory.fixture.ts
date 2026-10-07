// Synthetic-only checkout/cancellation pairs. Never load private capture values.
import { syntheticAdminGrid, adminGridWire, setAdminCell } from './schema4AdminHistory.fixture';
export { adminGridWire as cancellationGridWire, setAdminCell as setCancellationCell };
export function syntheticCancellationGrid(): Record<string, string[][]> {
  const tables = syntheticAdminGrid();
  const headers = tables.Transactions[0];
  const original = (id: string, before: number) => ({
    transactionId: id, timestamp: '2026-01-01T02:00:00.000Z', studentId: 'synthetic-student', studentName: 'Synthetic Person',
    items: JSON.stringify([{ productId: 'synthetic-product', name: 'Synthetic Product', price: 3, quantity: 2, subtotal: 6,
      regularUnitPrice: 3, regularTotal: 6, totalQuantity: 2, paidQuantity: 2, freeQuantity: 0,
      finalTotal: 6, totalDiscount: 0, adjustments: [], appliedPromotions: [] }]),
    totalAmount: '6', balanceBefore: String(before), balanceAfter: String(before - 6), status: 'CANCELLED', operator: 'kiosk',
  });
  const reversal = (id: string, suffix: string, before: number) => ({
    transactionId: `CANCEL-${suffix}`, timestamp: '2026-01-01T03:00:00.000Z', studentId: 'synthetic-student', studentName: 'Synthetic Person',
    items: JSON.stringify([{ productId: `CANCEL-${id}`, name: '거래 취소', price: -6, quantity: 1, subtotal: -6 }]),
    totalAmount: '-6', balanceBefore: String(before), balanceAfter: String(before + 6), status: 'CANCEL_REVERSAL', operator: `cancel:${id}`,
  });
  for (const record of [original('synthetic-checkout-one', 40), original('synthetic-checkout-two', 34),
    reversal('synthetic-checkout-one', 'opaque-one', 20), reversal('synthetic-checkout-two', 'opaque-two', 26)]) {
    tables.Transactions.push(headers.map(key => record[key as keyof typeof record]));
  }
  return tables;
}
