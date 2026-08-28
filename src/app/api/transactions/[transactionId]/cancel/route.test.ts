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
    const request = new Request('http://localhost/api/transactions/TR%201/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }),
    });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR%201' }) });

    expect(response.status).toBe(200);
    expect(cancelTransaction).toHaveBeenCalledWith(store, 'TR 1', '30000000-0000-4000-8000-000000000001');
    await expect(response.json()).resolves.toEqual(result);
  });

  it.each([
    'provider credential detail',
    '취소할 수 없는 거래입니다.',
  ])('returns a safe error without leaking repository detail: %s', async (detail) => {
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(cancelTransaction).mockRejectedValue(new Error(detail));
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }),
    });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR-1' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '거래를 취소하지 못했습니다.' });
  });

  it.each([
    ['missing JSON content type', { body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }) }],
    ['malformed JSON', { headers: { 'Content-Type': 'application/json' }, body: '{' }],
    ['missing operation ID', { headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['noncanonical operation ID', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: 'A0000000-0000-4000-8000-000000000001' }) }],
    ['expanded body', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001', tenantId: 'forbidden' }) }],
  ])('rejects %s before creating a store', async (_label, init) => {
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', { method: 'POST', ...init });
    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR-1' }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '올바른 취소 요청이 아닙니다.' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(cancelTransaction).not.toHaveBeenCalled();
  });
});
