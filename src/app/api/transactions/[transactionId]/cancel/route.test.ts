import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { cancelTransaction } from '@/server/sheetsRepository';
import { POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ cancelTransaction: vi.fn() }));

describe('POST /api/transactions/[transactionId]/cancel', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('returns 401 without creating a store or cancelling when unauthorized', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', { method: 'POST' });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR-1' }) });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(cancelTransaction).not.toHaveBeenCalled();
  });

  it('returns the repository result after cancelling the decoded transaction ID', async () => {
    const store = {};
    const result = {
      cancelledTransaction: { transactionId: 'TR 1', status: 'CANCELLED' },
      reversalTransaction: { transactionId: 'CANCEL-TR-1', status: 'CANCEL_REVERSAL' },
    };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(cancelTransaction).mockResolvedValue(result as never);
    const request = new Request('http://localhost/api/transactions/TR%201/cancel', { method: 'POST' });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR%201' }) });

    expect(response.status).toBe(200);
    expect(cancelTransaction).toHaveBeenCalledWith(store, 'TR 1');
    await expect(response.json()).resolves.toEqual(result);
  });

  it('returns a repository error message with status 400', async () => {
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(cancelTransaction).mockRejectedValue(new Error('이미 취소된 거래입니다.'));
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', { method: 'POST' });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR-1' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '이미 취소된 거래입니다.' });
  });
});
