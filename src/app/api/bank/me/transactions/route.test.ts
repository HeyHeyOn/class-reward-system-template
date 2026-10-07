// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/domain/types';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { createStudentBankSession, sealStudentBankSession, STUDENT_BANK_SESSION_COOKIE } from '@/server/studentBankSession';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { GET } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredStudentBank', () => ({ createConfiguredStudentBankReader: vi.fn(), STUDENT_BANK_TRANSACTION_LIMIT: 100 }));

const TENANT: TenantRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'class-a', displayName: 'A', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const SECRET = 'transactions-test-secret-long-enough-123';
const confirmStudent = vi.fn();
const getTransactions = vi.fn();

function cookieFor(studentId: string, tenantId = TENANT.id) {
  const scope = { tenantId, cookiePath: '/api/c/class-a/bank' };
  return `${STUDENT_BANK_SESSION_COOKIE}=${sealStudentBankSession(createStudentBankSession(scope, studentId), { AUTH_SECRET: SECRET })}`;
}

function call(url: string, cookie?: string) {
  return runWithTrustedTenantRequestContext({ tenant: TENANT }, () => GET(new Request(url, cookie ? { headers: { cookie } } : undefined)));
}

const rows: Transaction[] = [
  { transactionId: 'T2', timestamp: '2026-10-06T02:00:00.000Z', studentId: 'S001', studentName: '김민준', items: [], totalAmount: 5, balanceBefore: 92, balanceAfter: 97, status: 'TASK_REWARD', operator: 'bank-task-completion' },
  { transactionId: 'T1', timestamp: '2026-10-06T01:00:00.000Z', studentId: 'S001', studentName: '김민준', items: [{ productId: 'P1', name: '연필', price: 4, quantity: 2, subtotal: 8 }], totalAmount: 8, balanceBefore: 100, balanceAfter: 92, status: 'COMPLETED', operator: 'kiosk' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  confirmStudent.mockImplementation(async (studentId: string) => ({ status: 'FOUND', student: { studentId, name: '김민준', balance: 97, status: 'ACTIVE' } }));
  getTransactions.mockResolvedValue(rows);
  vi.mocked(createConfiguredStudentBankReader).mockResolvedValue({ confirmStudent, getTransactions });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /api/bank/me/transactions', () => {
  it('returns the session student\'s own history newest first with readable kinds', async () => {
    const response = await call('https://example.test/api/bank/me/transactions', cookieFor('S001'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      balance: 97,
      limit: 100,
      transactions: [
        { transactionId: 'T2', occurredAt: '2026-10-06T02:00:00.000Z', kind: 'TASK_REWARD', amount: 5, balanceAfter: 97, cancelled: false },
        { transactionId: 'T1', occurredAt: '2026-10-06T01:00:00.000Z', kind: 'PURCHASE', detail: '연필 ×2', amount: -8, balanceAfter: 92, cancelled: false },
      ],
    });
    expect(getTransactions).toHaveBeenCalledWith('S001');
  });

  it('ignores any student named by the client and uses only the session identity', async () => {
    const response = await call('https://example.test/api/bank/me/transactions?studentId=S999&studentQr=S999', cookieFor('S001'));
    expect(response.status).toBe(200);
    expect(confirmStudent).toHaveBeenCalledWith('S001');
    expect(getTransactions).toHaveBeenCalledWith('S001');
    expect(confirmStudent).not.toHaveBeenCalledWith('S999');
  });

  it('requires a session, and refuses a cookie of another class', async () => {
    expect((await call('https://example.test/api/bank/me/transactions?studentId=S001')).status).toBe(401);
    expect((await call('https://example.test/api/bank/me/transactions', cookieFor('S001', '22222222-2222-4222-8222-222222222222'))).status).toBe(401);
    expect(createConfiguredStudentBankReader).not.toHaveBeenCalled();
  });

  it('logs out a deactivated student before reading any history', async () => {
    confirmStudent.mockResolvedValue({ status: 'INACTIVE' });
    const response = await call('https://example.test/api/bank/me/transactions', cookieFor('S001'));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it('hides provider errors behind a retryable friendly message', async () => {
    getTransactions.mockRejectedValue(new Error('relation "transactions" does not exist'));
    const response = await call('https://example.test/api/bank/me/transactions', cookieFor('S001'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'BANK_DATA_UNAVAILABLE', retryable: true });
    expect(JSON.stringify(body)).not.toContain('relation');
  });
});
