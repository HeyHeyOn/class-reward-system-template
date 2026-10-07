// Synthetic-only fixture. No private capture values or recovered authority.
import { createHash } from 'node:crypto';
import { syntheticCancellationGrid, cancellationGridWire, setCancellationCell } from './schema4CancellationHistory.fixture';
export { cancellationGridWire as adjustmentGridWire, setCancellationCell as setAdjustmentCell };
export const adjustmentOperations = [
  '70000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000004',
];
export const adjustmentCommands = [
  { mode: 'subtract', amount: 40 }, { mode: 'add', amount: 40 },
  { mode: 'add', amount: 6 }, { mode: 'subtract', amount: 2 },
] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function syntheticAdjustmentGrid(): Record<string, string[][]> {
  const tables = syntheticCancellationGrid();
  tables.Adjustments = [['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator']];
  let before = 32;
  adjustmentCommands.forEach(({ mode, amount }, index) => {
    const studentId = 'synthetic-student', studentName = 'Synthetic Person';
    const total = mode === 'add' ? -amount : amount, after = before - total;
    const payload = hash(JSON.stringify({ studentIds: [studentId], mode, amount }));
    const row = {
      transactionId: `ADMIN-${adjustmentOperations[index]}-${payload}-${hash(studentId).slice(0, 12)}`,
      timestamp: `2026-01-01T0${index + 4}:00:00.000Z`, studentId, studentName,
      items: JSON.stringify([{ productId: `ADMIN-${mode.toUpperCase()}`, name: mode === 'add' ? '관리자 지급' : '관리자 회수',
        price: total, quantity: 1, subtotal: total }]),
      totalAmount: String(total), balanceBefore: String(before), balanceAfter: String(after), status: 'ADMIN_ADJUSTMENT', operator: 'admin',
    };
    tables.Transactions.push(tables.Transactions[0].map(key => row[key as keyof typeof row]));
    before = after;
  });
  tables.Students[1][2] = String(before);
  return tables;
}
