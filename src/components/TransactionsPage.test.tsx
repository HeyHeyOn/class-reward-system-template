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
    items: [{ productId: 'P002', name: '지우개', price: 500, quantity: 1, subtotal: 500 }],
    totalAmount: 500,
    balanceBefore: 1200,
    balanceAfter: 700,
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
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows cancel buttons only for completed payments and marks cancelled rows', async () => {
    render(<TransactionsPage />);

    expect(await screen.findByText('김민준')).toBeTruthy();
    expect(screen.getByText('취소됨')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'T001 결제 취소' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'T002 결제 취소' })).toBeNull();
  });

  it('cancels a completed transaction and updates the row status', async () => {
    render(<TransactionsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'T001 결제 취소' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/transactions/T001/cancel', { method: 'POST' });
    });
    expect(await screen.findAllByText('취소됨')).toHaveLength(2);
  });
});
