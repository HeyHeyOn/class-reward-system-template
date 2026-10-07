import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TransactionsPage } from './TransactionsPage';

const transaction = (id: string) => ({ transactionId: id, timestamp: '2026-10-07T00:00:00.000Z',
  studentId: 'S1', studentName: '김학생', items: [{ productId: 'P1', name: '연필', price: 1, quantity: 1, subtotal: 1 },
    { productId: 'P2', name: '지우개', price: 1, quantity: 1, subtotal: 1 }],
  totalAmount: 2, balanceBefore: 10, balanceAfter: 8, status: 'COMPLETED', operator: 'kiosk' });
const page = (id: string, nextCursor: string | null = null, count = 101) => ({ transactions: [transaction(id)], nextCursor,
  totals: { count, income: 500, expense: 200 } });
const json = (body: unknown) => Response.json(body);

beforeEach(() => {
  window.history.replaceState({}, '', '/c/test-class/admin');
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => '30000000-0000-4000-8000-000000000001') });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

it('requests bounded class pages, replaces rows on navigation and sends filters with a fresh cursor', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/settings')) return json({ currencyUnit: '별' });
    expect(url.pathname).toBe('/api/c/test-class/transactions');
    expect(url.searchParams.get('paged')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('50');
    return json(url.searchParams.get('direction') === 'income' ? page('INCOME', null, 12)
      : url.searchParams.has('cursor') ? page('SECOND') : page('FIRST', 'next-page'));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<TransactionsPage />);
  expect(await screen.findByTestId('transaction-row-FIRST')).toBeTruthy();
  expect(screen.getByText('101건')).toBeTruthy();
  expect(screen.getByText('+500별')).toBeTruthy();
  expect(screen.getByTestId('transaction-row-FIRST').textContent).toContain('연필, 지우개');
  fireEvent.click(screen.getByRole('button', { name: '다음 거래' }));
  expect(await screen.findByTestId('transaction-row-SECOND')).toBeTruthy();
  expect(screen.queryByTestId('transaction-row-FIRST')).toBeNull();
  expect(screen.getByText('2페이지')).toBeTruthy();
  expect((screen.getByRole('button', { name: '다음 거래' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '수입' }));
  expect(await screen.findByTestId('transaction-row-INCOME')).toBeTruthy();
  expect(screen.getByText('1페이지')).toBeTruthy();
  expect(screen.getByText('12건')).toBeTruthy();
  const request = fetcher.mock.calls.map(([url]) => new URL(String(url), 'https://example.test'))
    .filter((url) => url.pathname.endsWith('/transactions')).at(-1)!;
  expect(request.searchParams.get('direction')).toBe('income');
  expect(request.searchParams.has('cursor')).toBe(false);
  fireEvent.change(screen.getByRole('searchbox', { name: '거래 검색' }), { target: { value: '연필' } });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => new URL(String(url), 'https://example.test').searchParams.get('query') === '연필')).toBe(true));
  fireEvent.change(screen.getByLabelText('거래 시작일'), { target: { value: '2026-10-01' } });
  await waitFor(() => expect(fetcher.mock.calls.some(([url]) => new URL(String(url), 'https://example.test').searchParams.get('from') === '2026-10-01')).toBe(true));
});

it('ignores a slow earlier page after the filter changes', async () => {
  let resolveFirst!: (response: Response) => void;
  const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/settings')) return json({ currencyUnit: '원' });
    return url.searchParams.get('from') ? json(page('CURRENT', null, 1)) : first;
  }));
  render(<TransactionsPage />);
  fireEvent.change(await screen.findByLabelText('거래 시작일'), { target: { value: '2026-10-01' } });
  expect(await screen.findByTestId('transaction-row-CURRENT')).toBeTruthy();
  resolveFirst(json(page('STALE')));
  await waitFor(() => expect(screen.queryByTestId('transaction-row-STALE')).toBeNull());
  expect(screen.getByText('1건')).toBeTruthy();
});

it('refreshes the current page and matching totals after cancellation without inserting an out-of-page reversal', async () => {
  let cancelled = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/settings')) return json({ currencyUnit: '원' });
    if (init?.method === 'POST') {
      cancelled = true;
      return json({ cancelledTransaction: { ...transaction('SECOND'), status: 'CANCELLED' },
        reversalTransaction: { ...transaction('REVERSAL'), status: 'CANCEL_REVERSAL' } });
    }
    if (!url.searchParams.has('cursor')) return json(page('FIRST', 'next-page'));
    return json(cancelled ? { transactions: [{ ...transaction('SECOND'), status: 'CANCELLED' }], nextCursor: null,
      totals: { count: 102, income: 500, expense: 198 } } : page('SECOND'));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<TransactionsPage />);
  await screen.findByTestId('transaction-row-FIRST');
  fireEvent.click(screen.getByRole('button', { name: '다음 거래' }));
  fireEvent.click(await screen.findByRole('button', { name: 'SECOND 거래 취소' }));
  fireEvent.click(screen.getByRole('button', { name: '거래 취소 확정' }));
  expect(await screen.findByText('102건')).toBeTruthy();
  expect(screen.getByTestId('transaction-cancelled-label-SECOND')).toBeTruthy();
  expect(screen.queryByTestId('transaction-row-REVERSAL')).toBeNull();
  expect(screen.getByText('2페이지')).toBeTruthy();
});

it('holds a pending search debounce while confirming and cancelling, then loads the requested filter', async () => {
  let complete!: (response: Response) => void;
  const cancellation = new Promise<Response>((resolve) => { complete = resolve; });
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/settings')) return json({ currencyUnit: '원' });
    if (init?.method === 'POST') return cancellation;
    return json(page(url.searchParams.get('query') ? 'FILTERED' : 'FIRST'));
  });
  vi.stubGlobal('fetch', fetcher);
  render(<TransactionsPage />);
  const cancel = await screen.findByRole('button', { name: 'FIRST 거래 취소' });
  fireEvent.change(screen.getByRole('searchbox', { name: '거래 검색' }), { target: { value: '연필' } });
  fireEvent.click(cancel);
  fireEvent.click(screen.getByRole('button', { name: '거래 취소 확정' }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  expect(fetcher.mock.calls.some(([url]) => new URL(String(url), 'https://example.test').searchParams.get('query') === '연필')).toBe(false);
  complete(json({ cancelledTransaction: { ...transaction('FIRST'), status: 'CANCELLED' },
    reversalTransaction: { ...transaction('REVERSAL'), status: 'CANCEL_REVERSAL' } }));
  expect(await screen.findByTestId('transaction-row-FILTERED')).toBeTruthy();
  expect(screen.queryByTestId('transaction-row-FIRST')).toBeNull();
});

it('ignores a failed manual refresh after newer filter results have arrived', async () => {
  let rejectRefresh!: (error: Error) => void;
  const refresh = new Promise<Response>((_resolve, reject) => { rejectRefresh = reject; });
  let reads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://example.test');
    if (url.pathname.endsWith('/settings')) return json({ currencyUnit: '원' });
    if (url.searchParams.get('from')) return json(page('CURRENT'));
    return ++reads === 1 ? json(page('FIRST')) : refresh;
  }));
  render(<TransactionsPage />);
  await screen.findByTestId('transaction-row-FIRST');
  fireEvent.click(screen.getByRole('button', { name: '거래 내역 새로고침' }));
  fireEvent.change(screen.getByLabelText('거래 시작일'), { target: { value: '2026-10-01' } });
  expect(await screen.findByTestId('transaction-row-CURRENT')).toBeTruthy();
  await act(async () => { rejectRefresh(new Error('stale refresh failure')); });
  expect(screen.queryByText('stale refresh failure')).toBeNull();
  expect(screen.getByTestId('transaction-row-CURRENT')).toBeTruthy();
});
