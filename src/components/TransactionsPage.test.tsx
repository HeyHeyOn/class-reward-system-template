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
    cancelledAt: '2026-05-21T02:30:00.000Z',
  },
  {
    transactionId: 'CANCEL-T003',
    timestamp: '2026-05-21T02:30:00.000Z',
    studentId: 'S003',
    studentName: '박도윤',
    items: [{ productId: 'CANCEL-T003', name: '거래 취소', price: -500, quantity: 1, subtotal: -500 }],
    totalAmount: -500,
    balanceBefore: 500,
    balanceAfter: 1000,
    status: 'CANCEL_REVERSAL',
    operator: 'cancel:T003',
  },
];

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    status: init?.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferredResponse(payload: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((res) => { resolve = res; });
  return { resolve, response: gate.then(() => jsonResponse(payload)) };
}

describe('TransactionsPage', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '30000000-0000-4000-8000-000000000001') });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') {
        return jsonResponse({
          cancelledTransaction: { ...transactions[0], status: 'CANCELLED', cancelledAt: '2026-05-21T03:00:00.000Z' },
          reversalTransaction: {
            transactionId: 'CANCEL-T001',
            timestamp: '2026-05-21T03:00:00.000Z',
            studentId: 'S001',
            studentName: '김민준',
            items: [{ productId: 'CANCEL-T001', name: '거래 취소', price: -600, quantity: 1, subtotal: -600 }],
            totalAmount: -600,
            balanceBefore: 2900,
            balanceAfter: 3500,
            status: 'CANCEL_REVERSAL',
            operator: 'cancel:T001',
          },
        });
      }
      if (url === '/api/transactions/T002/cancel' && init?.method === 'POST') {
        return jsonResponse({
          cancelledTransaction: { ...transactions[1], status: 'CANCELLED', cancelledAt: '2026-05-21T03:05:00.000Z' },
          reversalTransaction: {
            transactionId: 'CANCEL-T002',
            timestamp: '2026-05-21T03:05:00.000Z',
            studentId: 'S002',
            studentName: '이서연',
            items: [{ productId: 'CANCEL-T002', name: '거래 취소', price: 500, quantity: 1, subtotal: 500 }],
            totalAmount: 500,
            balanceBefore: 1700,
            balanceAfter: 1200,
            status: 'CANCEL_REVERSAL',
            operator: 'cancel:T002',
          },
        });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('uses transaction wording, signed student-perspective amounts, filter tabs, and income/expense/cancel colors', async () => {
    const { container } = render(<TransactionsPage />);

    expect(await screen.findByRole('heading', { name: '거래 내역 확인' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '거래 내역 (4)' })).toBeTruthy();
    expect(screen.queryByText('거래 건수')).toBeNull();
    expect(screen.queryByText('순 지출')).toBeNull();
    expect(screen.queryByText('화폐 단위')).toBeNull();
    expect(screen.getByRole('button', { name: '전체' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '수입' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '지출' })).toBeTruthy();
    expect(screen.getByText('-600별')).toBeTruthy();
    expect(screen.getAllByText('+500별').length).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="transaction-row-T001"]')?.className).toContain('bg-sky-50');
    expect(container.querySelector('[data-testid="transaction-row-T002"]')?.className).toContain('bg-rose-50');
    expect(container.querySelector('[data-testid="transaction-row-T003"]')?.className).toContain('bg-slate-100');
    expect(container.querySelector('[data-testid="transaction-row-CANCEL-T003"]')?.className).toContain('bg-rose-50');
    expect(screen.getByTestId('transaction-amount-T003').className).toContain('text-sky-700');
    expect(screen.getByTestId('transaction-amount-T003').className).not.toContain('line-through');
    expect(screen.getByTestId('transaction-cancelled-label-T003').className).toContain('rounded-xl');
    expect(screen.getByTestId('transaction-cancelled-label-T003').className).toContain('text-xs');
    expect(screen.getByText(/취소 일시:/).textContent).toContain('2026. 5. 21. 11시 30분 0초');
    expect(screen.getAllByText('+500별').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'T001 거래 취소' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'T002 거래 취소' })).toBeTruthy();
    expect(screen.queryByText(/결제/)).toBeNull();
  });

  it('filters transaction rows by all, income, and expense tabs', async () => {
    render(<TransactionsPage />);

    expect(await screen.findByRole('heading', { name: '거래 내역 (4)' })).toBeTruthy();
    expect(screen.getByTestId('transaction-row-T001')).toBeTruthy();
    expect(screen.getByTestId('transaction-row-T002')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '수입' }));
    expect(await screen.findByRole('heading', { name: '거래 내역 (2)' })).toBeTruthy();
    expect(screen.queryByTestId('transaction-row-T001')).toBeNull();
    expect(screen.getByTestId('transaction-row-T002')).toBeTruthy();
    expect(screen.getByTestId('transaction-row-CANCEL-T003')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '지출' }));
    expect(await screen.findByRole('heading', { name: '거래 내역 (2)' })).toBeTruthy();
    expect(screen.getByTestId('transaction-row-T001')).toBeTruthy();
    expect(screen.queryByTestId('transaction-row-T002')).toBeNull();
    expect(screen.getByTestId('transaction-row-T003')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '전체' }));
    expect(await screen.findByRole('heading', { name: '거래 내역 (4)' })).toBeTruthy();
  });

  it('shows loading popups while cancelling and refreshing transactions', async () => {
    const cancelDeferred = deferredResponse({
      cancelledTransaction: { ...transactions[0], status: 'CANCELLED', cancelledAt: '2026-05-21T03:00:00.000Z' },
      reversalTransaction: {
        transactionId: 'CANCEL-T001',
        timestamp: '2026-05-21T03:00:00.000Z',
        studentId: 'S001',
        studentName: '김민준',
        items: [{ productId: 'CANCEL-T001', name: '거래 취소', price: -600, quantity: 1, subtotal: -600 }],
        totalAmount: -600,
        balanceBefore: 2900,
        balanceAfter: 3500,
        status: 'CANCEL_REVERSAL',
        operator: 'cancel:T001',
      },
    });
    let transactionFetchCount = 0;
    const refreshDeferred = deferredResponse([transactions[1]]);
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) {
        transactionFetchCount += 1;
        return transactionFetchCount === 1 ? jsonResponse(transactions) : refreshDeferred.response;
      }
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') return cancelDeferred.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<TransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'T001 거래 취소' }));
    expect(await screen.findByRole('dialog', { name: '거래 취소 중' })).toBeTruthy();
    expect(screen.getByText('거래를 취소하는 중입니다.')).toBeTruthy();
    cancelDeferred.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '거래 취소 중' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: '거래 내역 새로고침' }));
    expect(await screen.findByRole('dialog', { name: '새로고침 중' })).toBeTruthy();
    expect(screen.getByText('새로고침하는 중입니다.')).toBeTruthy();
    refreshDeferred.resolve();
    expect(await screen.findByRole('heading', { name: '거래 내역 (1)' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새로고침 중' })).toBeNull());
  });

  it('cancels income and expense transactions and updates the row status', async () => {
    render(<TransactionsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'T002 거래 취소' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/transactions/T002/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }),
      });
    });
    expect(await screen.findAllByText('취소됨')).toHaveLength(2);
    await waitFor(() => expect(screen.getAllByText((_, element) => element?.textContent === '거래 취소 × 1').length).toBeGreaterThan(0));
    expect(screen.getAllByText('-500별').length).toBeGreaterThan(0);
  });

  it('describes current-balance inverse effects and task reset without the old wording', async () => {
    render(<TransactionsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'T002 거래 취소' }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('현재 잔액에서 보상 금액을 회수'));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('과제 완료도 함께 취소'));
    expect(confirm).not.toHaveBeenLastCalledWith(expect.stringContaining('이전 잔액'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'T001 거래 취소' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'T001 거래 취소' }));
    expect(confirm).toHaveBeenLastCalledWith(expect.stringContaining('현재 잔액에 반대 거래 효과'));
    expect(confirm).not.toHaveBeenLastCalledWith(expect.stringContaining('이전 잔액'));
  });

  it('surfaces a safe server integrity error instead of a generic cancellation failure', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T002/cancel' && init?.method === 'POST') {
        return jsonResponse({ error: '과제 완료 기록 무결성을 확인할 수 없어 취소하지 않았습니다.' }, { status: 409 });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });
    render(<TransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'T002 거래 취소' }));
    expect(await screen.findByText('과제 완료 기록 무결성을 확인할 수 없어 취소하지 않았습니다.')).toBeTruthy();
    expect(screen.queryByText('거래를 취소하지 못했습니다.')).toBeNull();
  });

  it('globally suppresses a second row cancellation while another destructive request is pending', async () => {
    const first = deferredResponse({
      cancelledTransaction: { ...transactions[0], status: 'CANCELLED' },
      reversalTransaction: { ...transactions[0], transactionId: 'CANCEL-T001', status: 'CANCEL_REVERSAL' },
    });
    const second = deferredResponse({
      cancelledTransaction: { ...transactions[1], status: 'CANCELLED' },
      reversalTransaction: { ...transactions[1], transactionId: 'CANCEL-T002', status: 'CANCEL_REVERSAL' },
    });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') return first.response;
      if (url === '/api/transactions/T002/cancel' && init?.method === 'POST') return second.response;
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<TransactionsPage />);
    const firstButton = await screen.findByRole('button', { name: 'T001 거래 취소' });
    const secondButton = screen.getByRole('button', { name: 'T002 거래 취소' });
    fireEvent.click(firstButton);
    fireEvent.click(secondButton);

    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/cancel'))).toHaveLength(1);
    expect((secondButton as HTMLButtonElement).disabled).toBe(true);
    expect(await screen.findByRole('dialog', { name: '거래 취소 중' })).toBeTruthy();
    first.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '거래 취소 중' })).toBeNull());
  });

  it('rejects a lone transaction response, retains its operation ID, and applies a later full pair', async () => {
    let cancellationCalls = 0;
    const cancelled = { ...transactions[0], status: 'CANCELLED', cancelledAt: '2026-05-21T03:00:00.000Z' };
    const reversal = {
      ...transactions[0], transactionId: 'CANCEL-T001', status: 'CANCEL_REVERSAL',
      timestamp: '2026-05-21T03:00:00.000Z', balanceBefore: 2900, balanceAfter: 3500,
    };
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') {
        cancellationCalls += 1;
        return cancellationCalls === 1
          ? jsonResponse(cancelled)
          : jsonResponse({ cancelledTransaction: cancelled, reversalTransaction: reversal });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<TransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'T001 거래 취소' }));
    expect(await screen.findByText('거래를 취소하지 못했습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'T001 거래 취소' })).toBeTruthy();
    expect(screen.queryByTestId('transaction-row-CANCEL-T001')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'T001 거래 취소' }));
    expect(await screen.findByTestId('transaction-row-CANCEL-T001')).toBeTruthy();
    expect(screen.getByTestId('transaction-cancelled-label-T001')).toBeTruthy();
    const requests = fetchMock.mock.calls.filter(([url]) => String(url).includes('/cancel'));
    expect(requests[0][1]?.body).toBe(requests[1][1]?.body);
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
  });

  it.each([
    ['empty pair members', { cancelledTransaction: {}, reversalTransaction: {} }],
    ['mismatched original ID', {
      cancelledTransaction: { ...transactions[0], transactionId: 'T002', status: 'CANCELLED' },
      reversalTransaction: { ...transactions[0], transactionId: 'CANCEL-T001', status: 'CANCEL_REVERSAL' },
    }],
    ['wrong pair statuses', {
      cancelledTransaction: { ...transactions[0], status: 'COMPLETED' },
      reversalTransaction: { ...transactions[0], transactionId: 'CANCEL-T001', status: 'COMPLETED' },
    }],
  ])('fails closed for %s without mutating the transaction list', async (_label, responseBody) => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') {
        return jsonResponse(responseBody);
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<TransactionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'T001 거래 취소' }));

    expect(await screen.findByText('거래를 취소하지 못했습니다.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'T001 거래 취소' })).toBeTruthy();
    expect(screen.queryByTestId('transaction-row-CANCEL-T001')).toBeNull();
    expect(screen.getByTestId('transaction-row-T001')).toBeTruthy();
  });

  it('synchronously suppresses duplicate clicks and reuses the operation ID after a failed retry', async () => {
    let cancellationCalls = 0;
    const firstFailure = deferredResponse({ error: 'temporary' });
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/transactions' && !init?.method) return jsonResponse(transactions);
      if (url === '/api/settings') return jsonResponse({ currencyUnit: '별' });
      if (url === '/api/transactions/T001/cancel' && init?.method === 'POST') {
        cancellationCalls += 1;
        if (cancellationCalls === 1) {
          return firstFailure.response.then(() => jsonResponse({ error: 'temporary' }, { status: 503 }));
        }
        return jsonResponse({
          cancelledTransaction: { ...transactions[0], status: 'CANCELLED' },
          reversalTransaction: { ...transactions[0], transactionId: 'CANCEL-T001', status: 'CANCEL_REVERSAL' },
        });
      }
      return jsonResponse({ error: 'not found' }, { status: 404 });
    });

    render(<TransactionsPage />);
    const button = await screen.findByRole('button', { name: 'T001 거래 취소' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(cancellationCalls).toBe(1);
    firstFailure.resolve();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '거래 취소 중' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'T001 거래 취소' }));
    await waitFor(() => expect(cancellationCalls).toBe(2));
    const cancellationRequests = fetchMock.mock.calls.filter(([url]) => String(url).includes('/cancel'));
    expect(cancellationRequests[0][1]?.body).toBe(cancellationRequests[1][1]?.body);
    expect(crypto.randomUUID).toHaveBeenCalledOnce();
  });
});
