import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionsPage } from './TransactionsPage';

const transactions = [
  {
    transactionId: 'T001',
    timestamp: '2026-05-21T00:00:00.000Z',
    studentId: 'S001',
    studentName: '김민준',
    items: [{ productId: 'P001', name: '연필', price: 300, quantity: 2, subtotal: 600 }],
    totalAmount: 600,
    balanceBefore: 3500,
    balanceAfter: 2900,
    status: 'COMPLETED',
    operator: 'kiosk',
  },
  {
    transactionId: 'T002',
    timestamp: '2026-05-21T01:00:00.000Z',
    studentId: 'S002',
    studentName: '이서연',
    items: [{ productId: 'P002', name: '과제 보상', price: -500, quantity: 1, subtotal: -500 }],
    totalAmount: -500,
    balanceBefore: 1200,
    balanceAfter: 1700,
    status: 'TASK_REWARD',
    operator: 'bank',
  },
  {
    transactionId: 'T003',
    timestamp: '2026-05-21T02:00:00.000Z',
    studentId: 'S003',
    studentName: '박도윤',
    items: [{ productId: 'P003', name: '지우개', price: 500, quantity: 1, subtotal: 500 }],
    totalAmount: 500,
    balanceBefore: 1000,
    balanceAfter: 500,
    status: 'CANCELLED',
    operator: 'kiosk',
  },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TransactionsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') {
        return jsonResponse({ ...transactions[0], status: 'CANCELLED' });
      }
      if (url === '/api/transactions/T002/cancel' && init?.method === 'POST') {
        return jsonResponse({ ...transactions[1], status: 'CANCELLED' });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('uses transaction wording, signed student-perspective amounts, and income/expense/cancel colors', async () => {
    const { container } = render(<TransactionsPage />);

    expect(await screen.findByRole('heading', { name: '거래 내역 확인' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '최근 거래' })).toBeTruthy();
    expect(screen.getByText('-600별')).toBeTruthy();
    expect(screen.getByText('+500별')).toBeTruthy();
    expect(container.querySelector('[data-testid="transaction-row-T001"]')?.className).toContain('bg-sky-50');
    expect(container.querySelector('[data-testid="transaction-row-T002"]')?.className).toContain('bg-rose-50');
    expect(container.querySelector('[data-testid="transaction-row-T003"]')?.className).toContain('bg-slate-100');
    expect(screen.getByRole('button', { name: 'T001 거래 취소' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'T002 거래 취소' })).toBeTruthy();
    expect(screen.queryByText(/결제/)).toBeNull();
  });

  it('cancels income and expense transactions and updates the row status', async () => {
    render(<TransactionsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'T002 거래 취소' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/transactions/T002/cancel', { method: 'POST' });
    });
    expect(await screen.findAllByText('취소됨')).toHaveLength(2);
  });
});
