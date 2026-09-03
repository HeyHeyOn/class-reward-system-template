import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredTransactionCancellation } from '@/server/repositories/configuredTransactionCancellation';
import { POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/repositories/configuredTransactionCancellation', () => ({
  createConfiguredTransactionCancellation: vi.fn(),
}));

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
    expect(createConfiguredTransactionCancellation).not.toHaveBeenCalled();
  });

  it('returns the configured authority result after Next supplies the decoded transaction ID', async () => {
    const result = {
      cancelledTransaction: { transactionId: 'TR 1', status: 'CANCELLED' },
      reversalTransaction: { transactionId: 'CANCEL-TR-1', status: 'CANCEL_REVERSAL' },
    };
    const cancel = vi.fn(async () => result as never);
    vi.mocked(createConfiguredTransactionCancellation).mockResolvedValue({ cancel });
    const request = new Request('http://localhost/api/transactions/TR%201/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }),
    });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR 1' }) });

    expect(response.status).toBe(200);
    expect(createConfiguredTransactionCancellation).toHaveBeenCalledWith(request);
    expect(cancel).toHaveBeenCalledWith({
      transactionId: 'TR 1', operationId: '30000000-0000-4000-8000-000000000001',
    });
    await expect(response.json()).resolves.toEqual(result);
  });

  it('preserves percent sequences in the transaction ID already decoded by Next', async () => {
    const transactionId = 'TASK-LOGICAL-TC-BANK-T008-legacy%253AT008%257Cr4-INITIAL';
    const result = {
      cancelledTransaction: { transactionId, status: 'CANCELLED' },
      reversalTransaction: { transactionId: 'CANCEL-OP-1', status: 'CANCEL_REVERSAL' },
    };
    const cancel = vi.fn(async () => result as never);
    vi.mocked(createConfiguredTransactionCancellation).mockResolvedValue({ cancel });
    const request = new Request(`http://localhost/api/transactions/${encodeURIComponent(transactionId)}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }),
    });

    const response = await POST(request, { params: Promise.resolve({ transactionId }) });

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith({
      transactionId, operationId: '30000000-0000-4000-8000-000000000001',
    });
    await expect(response.json()).resolves.toEqual(result);
  });

  it.each([
    ['provider credential detail', 'unexpected', 'provider credential detail'],
    ['취소할 수 없는 거래입니다.', 'transaction-not-cancellable', null],
    ['과제 완료 기록 스냅샷이 손상되어 취소하지 않았습니다.', 'task-completion-snapshot-invalid', null],
    ['과제 완료 RESET 기록의 무결성을 확인할 수 없어 취소하지 않았습니다.', 'task-reset-integrity-unverifiable', null],
    ['과제 완료 RESET 기록의 무결성이 일치하지 않아 취소하지 않았습니다.', 'task-reset-integrity-mismatch', null],
    ['거래 취소 기록의 무결성이 일치하지 않아 수동 조정이 필요합니다.', 'cancellation-record-integrity-mismatch', null],
    ['Cancellation restoration requires safe integer values', 'restoration-values-unsafe', null],
    ['Safe integer overflow: 안전한 정수 범위를 벗어났습니다.', 'safe-integer-overflow', null],
    [
      '거래 상품을 찾을 수 없어 수동 조정이 필요합니다: product-secret-id-901',
      'transaction-product-missing',
      'product-secret-id-901',
    ],
    [
      'TaskCompletions 템플릿/스키마를 업데이트해 주세요. 필수 컬럼이 없습니다: oauthTokenSecret',
      'task-completions-schema-invalid',
      'oauthTokenSecret',
    ],
    ['Transactions 시트에 필수 컬럼이 없습니다: passwordHash', 'transactions-schema-invalid', 'passwordHash'],
    ['Students 시트에 필수 컬럼이 없습니다: guardianAccessToken', 'students-schema-invalid', 'guardianAccessToken'],
    ['Products 시트에 필수 컬럼이 없습니다: privateSupplierId', 'products-schema-invalid', 'privateSupplierId'],
  ])('returns a safe error while logging a safe operator reason for %s', async (detail, reason, sensitiveSuffix) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(createConfiguredTransactionCancellation).mockResolvedValue({
      cancel: vi.fn(async () => { throw new Error(detail); }),
    });
    const request = new Request('http://localhost/api/transactions/TR-1/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId: '30000000-0000-4000-8000-000000000001' }),
    });

    const response = await POST(request, { params: Promise.resolve({ transactionId: 'TR-1' }) });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '거래를 취소하지 못했습니다.' });
    expect(consoleError).toHaveBeenCalledWith('transaction_cancellation_failed', { reason });
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain('TR-1');
    expect(logged).not.toContain(detail);
    if (sensitiveSuffix) expect(logged).not.toContain(sensitiveSuffix);
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
    expect(createConfiguredTransactionCancellation).not.toHaveBeenCalled();
  });
});
