import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { updateStudentDetailsBatchWithBalanceTransactions } from '@/server/sheetsRepository';
import { PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({
  deleteStudentsBatch: vi.fn(),
  updateStudentDetailsBatchWithBalanceTransactions: vi.fn(),
}));

const operationId = 'a0000000-0000-4000-8000-000000000001';
const students = [
  { studentId: 'S001', name: '학생 1', balance: 15, status: 'ACTIVE' },
  { studentId: 'S002', name: '학생 2', balance: 5, status: 'INACTIVE' },
];

function request(body: unknown) {
  return new Request('https://example.test/api/students/batch', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PATCH /api/students/batch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({ marker: 'store' } as never);
    vi.mocked(updateStudentDetailsBatchWithBalanceTransactions).mockResolvedValue(students as never);
  });

  it('requires one canonical operation ID and delegates balance-aware list saving', async () => {
    const exactRequest = request({ operationId, students });
    const response = await PATCH(exactRequest);

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(exactRequest);
    expect(updateStudentDetailsBatchWithBalanceTransactions).toHaveBeenCalledWith(
      { marker: 'store' }, students, operationId,
    );
    await expect(response.json()).resolves.toEqual(students);
  });

  it.each([
    ['missing operation ID', { students }],
    ['uppercase operation ID', { operationId: operationId.toUpperCase(), students }],
    ['expanded body', { operationId, students, tenantId: 'forbidden' }],
    ['expanded student object', { operationId, students: [{ ...students[0], tenantId: 'forbidden' }] }],
  ])('rejects %s before opening Sheets', async (_label, body) => {
    const response = await PATCH(request(body));
    expect(response.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(updateStudentDetailsBatchWithBalanceTransactions).not.toHaveBeenCalled();
  });
});
