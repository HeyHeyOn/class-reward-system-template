import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/domain/types';
import type { StudentTaskProjectionDto } from '@/server/studentTaskProjection';
import { projectStudentBankTasks, projectStudentBankTransactions } from './studentBankViews';

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    transactionId: 'T', timestamp: '2026-10-06T01:00:00.000Z', studentId: 'S001', studentName: '김민준',
    items: [], totalAmount: 0, balanceBefore: 100, balanceAfter: 100, status: 'COMPLETED', operator: 'kiosk',
    ...overrides,
  };
}

describe('projectStudentBankTransactions', () => {
  it('labels every kind, signs amounts and keeps only the allowlisted fields', () => {
    const rows = projectStudentBankTransactions([
      transaction({ transactionId: 'buy', items: [{ productId: 'P1', name: '연필', price: 3, quantity: 2, subtotal: 6 }, { productId: 'P2', name: '지우개', price: 2, quantity: 1, subtotal: 2 }], totalAmount: 8, balanceBefore: 100, balanceAfter: 92 }),
      transaction({ transactionId: 'reward', status: 'TASK_REWARD', operator: 'bank-task-completion', totalAmount: 5, balanceBefore: 92, balanceAfter: 97 }),
      transaction({ transactionId: 'grant', status: 'ADMIN_ADJUSTMENT', operator: 'admin', balanceBefore: 97, balanceAfter: 117 }),
      transaction({ transactionId: 'deduct', status: 'ADMIN_ADJUSTMENT', operator: 'admin', balanceBefore: 117, balanceAfter: 107 }),
      transaction({ transactionId: 'cancelled-buy', status: 'CANCELLED', cancelledAt: '2026-10-06T02:00:00.000Z', items: [{ productId: 'P1', name: '연필', price: 3, quantity: 1, subtotal: 3 }], totalAmount: 3, balanceBefore: 107, balanceAfter: 104 }),
      transaction({ transactionId: 'reversal', status: 'CANCEL_REVERSAL', operator: 'admin-cancellation', balanceBefore: 104, balanceAfter: 107 }),
      transaction({ transactionId: 'legacy-in', status: 'LEGACY', operator: 'sheet', balanceBefore: 107, balanceAfter: 110 }),
      transaction({ transactionId: 'legacy-out', status: 'LEGACY', operator: 'sheet', balanceBefore: 110, balanceAfter: 101 }),
      transaction({ transactionId: 'someone-else', studentId: 'S002' }),
    ], 'S001');

    expect(rows).toEqual([
      { transactionId: 'buy', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'PURCHASE', detail: '연필 ×2, 지우개', amount: -8, balanceAfter: 92, cancelled: false },
      { transactionId: 'reward', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'TASK_REWARD', amount: 5, balanceAfter: 97, cancelled: false },
      { transactionId: 'grant', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'TEACHER_GRANT', amount: 20, balanceAfter: 117, cancelled: false },
      { transactionId: 'deduct', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'TEACHER_DEDUCT', amount: -10, balanceAfter: 107, cancelled: false },
      { transactionId: 'cancelled-buy', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'PURCHASE', detail: '연필', amount: -3, balanceAfter: 104, cancelled: true, cancelledAt: '2026-10-06T02:00:00.000Z' },
      { transactionId: 'reversal', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'CANCELLATION', amount: 3, balanceAfter: 107, cancelled: false },
      { transactionId: 'legacy-in', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'DEPOSIT', amount: 3, balanceAfter: 110, cancelled: false },
      { transactionId: 'legacy-out', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'WITHDRAWAL', amount: -9, balanceAfter: 101, cancelled: false },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/operator|studentName|kiosk/);
  });

  it('keeps a cancelled reward recognisable as a task reward', () => {
    const [row] = projectStudentBankTransactions([
      transaction({ transactionId: 'r', status: 'CANCELLED', operator: 'bank-task-completion', balanceBefore: 0, balanceAfter: 5, cancelledAt: '2026-10-06T03:00:00.000Z' }),
    ], 'S001');
    expect(row).toMatchObject({ kind: 'TASK_REWARD', cancelled: true, amount: 5 });
  });
});

function task(overrides: Partial<StudentTaskProjectionDto> & { stage: StudentTaskProjectionDto['studentStatus']['stage'] }): StudentTaskProjectionDto {
  const { stage, ...rest } = overrides;
  return {
    taskId: 'T', title: '과제', description: '설명', reward: 5, sortOrder: 1,
    studentStatus: { studentId: 'S001', assigned: stage !== 'UNASSIGNED', completed: stage === 'COMPLETED', ready: stage === 'READY', stage },
    ...rest,
  };
}

describe('projectStudentBankTasks', () => {
  const now = '2026-10-06T01:00:00.000Z';

  it('drops 미부여, orders 완료 가능 → 미완료 → 완료 and explains unmet gates', () => {
    const tasks = projectStudentBankTasks([
      task({ taskId: 'done', stage: 'COMPLETED', sortOrder: 0 }),
      task({ taskId: 'hidden', stage: 'UNASSIGNED', title: '보이면 안 되는 과제' }),
      task({ taskId: 'waiting', stage: 'PENDING', sortOrder: 0 }),
      task({ taskId: 'locked', stage: 'READY', sortOrder: 0, prerequisiteTaskId: 'first', prerequisiteTitle: '첫 과제', prerequisiteStatus: 'REQUIRED' }),
      task({ taskId: 'ready-2', stage: 'READY', sortOrder: 2 }),
      task({ taskId: 'ready-1', stage: 'READY', sortOrder: 1, dueAt: '2026-10-07T00:00:00.000Z', recurrence: { type: 'DAILY', time: '09:00' } }),
      task({ taskId: 'unavailable', stage: 'READY', sortOrder: 3, prerequisiteTitle: '사라진 과제', prerequisiteStatus: 'UNAVAILABLE' }),
      task({ taskId: 'upcoming', stage: 'READY', sortOrder: 4, availableFrom: '2026-10-08T00:00:00.000Z' }),
    ], now);

    expect(tasks.map((entry) => [entry.taskId, entry.stage, entry.completable])).toEqual([
      ['ready-1', 'READY', true],
      ['ready-2', 'READY', true],
      ['locked', 'READY', false],
      ['unavailable', 'READY', false],
      ['upcoming', 'READY', false],
      ['waiting', 'PENDING', false],
      ['done', 'COMPLETED', false],
    ]);
    expect(tasks.find((entry) => entry.taskId === 'locked')?.blockedReason).toBe("먼저 '첫 과제' 과제를 완료해야 해요.");
    expect(tasks.find((entry) => entry.taskId === 'unavailable')?.blockedReason).toContain('선생님께');
    expect(tasks.find((entry) => entry.taskId === 'upcoming')?.blockedReason).toBe('아직 시작 전이에요.');
    expect(tasks.find((entry) => entry.taskId === 'ready-1')).toEqual({
      taskId: 'ready-1', title: '과제', description: '설명', reward: 5, stage: 'READY', completable: true,
      dueAt: '2026-10-07T00:00:00.000Z', recurrence: { type: 'DAILY', time: '09:00' },
    });
    expect(JSON.stringify(tasks)).not.toContain('보이면 안 되는 과제');
    expect(JSON.stringify(tasks)).not.toContain('studentStatus');
  });
});
