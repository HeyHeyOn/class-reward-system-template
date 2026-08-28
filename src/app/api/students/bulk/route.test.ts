import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { bulkAdjustStudentBalances } from '@/server/sheetsRepository';
import { PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: vi.fn() }));
vi.mock('@/server/sheetsRepository', () => ({ bulkAdjustStudentBalances: vi.fn() }));

const operationId = 'a0000000-0000-4000-8000-000000000001';

function request(body: unknown, headers: HeadersInit = { 'Content-Type': 'application/json' }) {
  return new Request('http://localhost/api/students/bulk', {
    method: 'PATCH',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('PATCH /api/students/bulk', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
  });

  it('checks authorization before parsing the body or creating a store', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const json = vi.fn(() => { throw new Error('must not parse'); });
    const unauthorized = new Request('http://localhost/api/students/bulk', { method: 'PATCH' });
    Object.defineProperty(unauthorized, 'json', { value: json });

    const response = await PATCH(unauthorized);

    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('passes the exact browser-owned payload and operation ID to the Sheets repository', async () => {
    const store = {};
    const result = [{ studentId: 'S001', balance: 20 }];
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(bulkAdjustStudentBalances).mockResolvedValue(result);

    const response = await PATCH(request({ studentIds: [' S001 '], mode: 'add', amount: 10, operationId }));

    expect(response.status).toBe(200);
    expect(bulkAdjustStudentBalances).toHaveBeenCalledWith(store, {
      studentIds: [' S001 '], mode: 'add', amount: 10, operationId,
    });
    await expect(response.json()).resolves.toEqual(result);
  });

  it.each([
    ['missing JSON content type', { studentIds: ['S001'], mode: 'add', amount: 1, operationId }, {}],
    ['malformed JSON', '{', { 'Content-Type': 'application/json' }],
    ['missing operation ID', { studentIds: ['S001'], mode: 'add', amount: 1 }, undefined],
    ['uppercase UUID', { studentIds: ['S001'], mode: 'add', amount: 1, operationId: operationId.toUpperCase() }, undefined],
    ['blank student ID', { studentIds: [' '], mode: 'add', amount: 1, operationId }, undefined],
    ['wrong mode', { studentIds: ['S001'], mode: 'multiply', amount: 1, operationId }, undefined],
    ['unsafe amount', { studentIds: ['S001'], mode: 'add', amount: Number.MAX_SAFE_INTEGER + 1, operationId }, undefined],
    ['expanded tenant body', { studentIds: ['S001'], mode: 'add', amount: 1, operationId, tenantId: 'forbidden' }, undefined],
    ['expanded hash body', { studentIds: ['S001'], mode: 'add', amount: 1, operationId, operationPayloadHash: 'forbidden' }, undefined],
  ])('rejects %s before store access', async (_label, body, headers) => {
    const response = await PATCH(request(body, headers));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '올바른 학생 재화 수정 요청이 아닙니다.' });
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(bulkAdjustStudentBalances).not.toHaveBeenCalled();
  });

  it('does not leak repository or provider error details', async () => {
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue({} as never);
    vi.mocked(bulkAdjustStudentBalances).mockRejectedValue(new Error('spreadsheet tenant secret collision'));

    const response = await PATCH(request({ studentIds: ['S001'], mode: 'set', amount: 0, operationId }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '학생 재화를 일괄 수정하지 못했습니다.' });
  });
});
