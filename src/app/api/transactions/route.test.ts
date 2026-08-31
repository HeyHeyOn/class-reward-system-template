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
});