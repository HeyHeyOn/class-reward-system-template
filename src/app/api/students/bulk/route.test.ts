import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredAdminAdjustmentCommand } from '@/server/repositories/configuredAdminAdjustment';
import { PATCH } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/repositories/configuredAdminAdjustment', () => ({
  createConfiguredAdminAdjustmentCommand: vi.fn(),
}));

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

  it('checks authorization before parsing the body or opening configured authority', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const json = vi.fn(() => { throw new Error('must not parse'); });
    const unauthorized = new Request('http://localhost/api/students/bulk', { method: 'PATCH' });
    Object.defineProperty(unauthorized, 'json', { value: json });

    const response = await PATCH(unauthorized);

    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(createConfiguredAdminAdjustmentCommand).not.toHaveBeenCalled();
  });

  it('delegates the exact Request and four-field input while preserving the public response', async () => {
    const adjust = vi.fn(async () => ({
      ok: true,
      operationId,
      adjustedAt: '2026-09-01T00:00:00.000Z',
      mode: 'add' as const,
      amount: 10,
      students: [{
        studentId: 'S001', studentName: 'Student', balanceBefore: 10,
        balanceAfter: 20, delta: 10, transactionId: 'transaction-id',
      }],
    }));
    vi.mocked(createConfiguredAdminAdjustmentCommand).mockResolvedValue({ adjust });
    const exactRequest = request({ studentIds: [' S001 '], mode: 'add', amount: 10, operationId });

    const response = await PATCH(exactRequest);

    expect(response.status).toBe(200);
    expect(createConfiguredAdminAdjustmentCommand).toHaveBeenCalledWith(exactRequest);
    expect(adjust).toHaveBeenCalledWith({
      studentIds: [' S001 '], mode: 'add', amount: 10, operationId,
    });
    await expect(response.json()).resolves.toEqual([{ studentId: 'S001', balance: 20 }]);
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
  ])('rejects %s before configured authority', async (_label, body, headers) => {
    const response = await PATCH(request(body, headers));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '올바른 학생 재화 수정 요청이 아닙니다.' });
    expect(createConfiguredAdminAdjustmentCommand).not.toHaveBeenCalled();
  });

  it('does not leak configured authority or provider error details', async () => {
    vi.mocked(createConfiguredAdminAdjustmentCommand).mockRejectedValue(
      new Error('postgres tenant secret collision'),
    );

    const response = await PATCH(request({ studentIds: ['S001'], mode: 'set', amount: 0, operationId }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: '학생 재화를 일괄 수정하지 못했습니다.' });
  });
});
