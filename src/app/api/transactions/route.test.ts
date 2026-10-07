import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { getTransactions } from '@/server/sheetsRepository';
import { createConfiguredTransactionReader } from '@/server/repositories/configuredTransactions';
import { GET } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(),
  unauthorizedAdminResponse: vi.fn(() => Response.json({ error: 'unauthorized' }, { status: 401 })),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ getTransactions: vi.fn() }));
vi.mock('@/server/repositories/configuredTransactions', () => ({
  createConfiguredTransactionReader: vi.fn(),
}));

describe('GET /api/transactions configured authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('rejects unauthorized requests without resolving either provider', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await GET(new Request('https://example.test/api/transactions?studentId=S1'));
    expect(response.status).toBe(401);
    expect(unauthorizedAdminResponse).toHaveBeenCalledOnce();
    expect(createConfiguredTransactionReader).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('returns the configured transaction DTOs without provider-specific access', async () => {
    const rows = [{
      transactionId: 'T1', timestamp: '2026-01-01T00:00:00.000Z', studentId: 'S1',
      studentName: '학생', items: [], totalAmount: 0, balanceBefore: 1, balanceAfter: 1,
      status: 'COMPLETED', operator: 'admin',
    }];
    const reader = { getTransactions: vi.fn(async () => rows) };
    vi.mocked(createConfiguredTransactionReader).mockResolvedValue(reader as never);

    const response = await GET(new Request('https://example.test/api/transactions?studentId=S1&page=2'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(rows);
    expect(reader.getTransactions).toHaveBeenCalledOnce();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it('preserves the existing raw Error message and generic non-Error 500 semantics', async () => {
    vi.mocked(createConfiguredTransactionReader).mockResolvedValueOnce({
      getTransactions: vi.fn(async () => { throw new Error('database unavailable'); }),
    } as never);
    const errorResponse = await GET(new Request('https://example.test/api/transactions'));
    expect(errorResponse.status).toBe(500);
    await expect(errorResponse.json()).resolves.toEqual({ error: 'database unavailable' });

    vi.mocked(createConfiguredTransactionReader).mockRejectedValueOnce('failure');
    const genericResponse = await GET(new Request('https://example.test/api/transactions'));
    expect(genericResponse.status).toBe(500);
    await expect(genericResponse.json()).resolves.toEqual({ error: '결제 내역을 불러오지 못했습니다.' });
  });

  it('uses the bounded reader only for the explicit page contract', async () => {
    const page = { transactions: [], nextCursor: null, totals: { count: 0, income: 0, expense: 0 } };
    const getTransactionPage = vi.fn(async () => page);
    const getTransactions = vi.fn();
    vi.mocked(createConfiguredTransactionReader).mockResolvedValue({ getTransactionPage, getTransactions });
    const response = await GET(new Request('https://example.test/api/transactions?paged=1&limit=25&studentId=S1&direction=income&from=2026-10-01'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual(page);
    expect(getTransactionPage).toHaveBeenCalledWith({ limit: 25, studentId: 'S1', direction: 'income', from: '2026-10-01', through: '', query: '', cursor: null });
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it.each(['limit=101', 'limit=0', 'direction=other', 'from=2026-02-30', 'from=2026-10-03&through=2026-10-01', 'limit=1&limit=2'])('rejects invalid page bounds %s before resolving a provider', async (query) => {
    const response = await GET(new Request(`https://example.test/api/transactions?paged=1&${query}`));
    expect(response.status).toBe(400);
    expect(createConfiguredTransactionReader).not.toHaveBeenCalled();
  });

  it('adapts existing Sheets readers for optional pages without changing the legacy endpoint', async () => {
    const rows = ['B', 'A', 'C'].map((transactionId) => ({ transactionId, timestamp: '2026-10-07T00:00:00.000Z',
      studentId: 'S1', studentName: '학생', items: [], totalAmount: 1, balanceBefore: 1, balanceAfter: 2, status: 'COMPLETED', operator: 'admin' }));
    vi.mocked(createConfiguredTransactionReader).mockResolvedValue({ getTransactions: vi.fn(async () => rows) });
    const first = await (await GET(new Request('https://example.test/api/transactions?paged=1&limit=1'))).json();
    expect(first.transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(['A']);
    expect(first.totals).toEqual({ count: 3, income: 3, expense: 0 });
    const second = await (await GET(new Request(`https://example.test/api/transactions?paged=1&limit=1&cursor=${first.nextCursor}`))).json();
    expect(second.transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(['B']);
  });
});
