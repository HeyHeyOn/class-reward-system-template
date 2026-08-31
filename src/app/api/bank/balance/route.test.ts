import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredBankReader } from '@/server/repositories/configuredBank';
import { GET } from './route';

vi.mock('@/server/repositories/configuredBank', () => ({ createConfiguredBankReader: vi.fn() }));

const student = { studentId: 'S1', name: '학생', balance: 123, status: 'ACTIVE' as const };
const transactions = Array.from({ length: 11 }, (_, index) => ({
  transactionId: `T${index}`, timestamp: '2026-09-01T00:00:00.000Z',
  studentId: index === 10 ? 'OTHER' : 'S1', studentName: '학생', items: [],
  totalAmount: index, balanceBefore: index, balanceAfter: index,
  status: 'COMPLETED', operator: 'test',
}));

describe('GET /api/bank/balance', () => {
  const getBalance = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createConfiguredBankReader).mockResolvedValue({ getBalance, confirmStudent: vi.fn() });
  });

  it('returns the exact existing balance DTO from the configured bank reader', async () => {
    getBalance.mockResolvedValue({ student, transactions });
    const response = await GET(new Request('http://localhost/api/bank/balance?studentId=%20S1%20'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      studentId: 'S1', name: '학생', balance: 123, transactions: transactions.slice(0, 10),
    });
    expect(getBalance).toHaveBeenCalledWith('S1');
  });

  it('preserves validation before selecting a backend', async () => {
    const response = await GET(new Request('http://localhost/api/bank/balance'));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '학생 QR을 인식해 주세요.' });
    expect(createConfiguredBankReader).not.toHaveBeenCalled();
  });

  it.each([
    [null], [{ ...student, status: 'INACTIVE' as const }],
  ])('preserves the existing 404 for missing or inactive students', async (studentResult) => {
    getBalance.mockResolvedValue({ student: studentResult, transactions: [] });
    const response = await GET(new Request('http://localhost/api/bank/balance?studentId=S1'));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: '학생 정보를 찾을 수 없습니다.' });
  });

  it('preserves the existing provider error response without fallback', async () => {
    getBalance.mockRejectedValue(new Error('database unavailable'));
    const response = await GET(new Request('http://localhost/api/bank/balance?studentId=S1'));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'database unavailable' });
  });
});
