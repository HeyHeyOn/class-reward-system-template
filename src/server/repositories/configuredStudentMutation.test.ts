// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantId } from './contracts';
const mocks = vi.hoisted(() => ({ sheets: vi.fn(), batch: vi.fn(), updateBatch: vi.fn(), commands: vi.fn(), transaction: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: mocks.sheets }));
vi.mock('@/server/sheetsRepository', () => ({ updateStudentDetailsBatchWithBalanceTransactions: mocks.batch }));
vi.mock('@/server/db/transaction', () => ({ withTenantTransaction: mocks.transaction }));
vi.mock('./database/studentCommands', async (original) => ({ ...await original<object>(), createDatabaseStudentCommands: mocks.commands }));
import { createConfiguredStudentMutation } from './configuredStudentMutation';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

const tenantId = 'd0500000-0000-4000-8000-000000000001' as TenantId;
const row = { studentId: 'S1', name: 'Name', balance: 91, status: 'ACTIVE' as const, expectedStudentVersion: 2, expectedAccountVersion: 3 };
const body = { operationId: 'd0500000-0000-4000-8000-000000000011', students: [row] };
function scoped<T>(callback: () => T, lifecycle: 'ACTIVE' | 'DRAFT' = 'ACTIVE') {
  return runWithTrustedTenantRequestContext({ tenant: { id: tenantId, slug: 'd05-a', displayName: 'A', timezone: 'Asia/Seoul', lifecycle } }, callback);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.commands.mockReturnValue({ updateBatch: mocks.updateBatch });
  mocks.updateBatch.mockResolvedValue({ students: [{ ...row, studentVersionAfter: 3, accountVersionAfter: 4 }] });
  mocks.sheets.mockResolvedValue({ marker: 'sheets' });
});
afterEach(() => vi.unstubAllEnvs());

describe('D05 configured student mutation', () => {
  it('uses only trusted tenant authority and projects committed versions without a second read', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    const result = await scoped(async () => (await createConfiguredStudentMutation()).updateBatch(body));
    expect(mocks.commands).toHaveBeenCalledWith({ tenantId, runTenantTransaction: mocks.transaction });
    expect(mocks.updateBatch).toHaveBeenCalledWith(body);
    expect(result).toEqual([{ studentId: 'S1', name: 'Name', balance: 91, status: 'ACTIVE', studentVersion: 3, accountVersion: 4 }]);
    expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('retains the versionless Sheets batch including omitted balance and exact request', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const request = new Request('http://localhost/api/students/batch');
    const legacy = { operationId: body.operationId, students: [{ studentId: 'S1', name: 'Name', status: 'INACTIVE' }] };
    mocks.batch.mockResolvedValue([{ studentId: 'S1', name: 'Name', status: 'INACTIVE', balance: 100 }]);
    expect(await (await createConfiguredStudentMutation(request)).updateBatch(legacy)).toHaveLength(1);
    expect(mocks.sheets).toHaveBeenCalledWith(request);
    expect(mocks.batch).toHaveBeenCalledWith({ marker: 'sheets' }, legacy.students, body.operationId);
    expect(mocks.commands).not.toHaveBeenCalled();
  });
  it.each([
    ['missing version', { ...body, students: [{ ...row, expectedAccountVersion: undefined }] }],
    ['coerced version', { ...body, students: [{ ...row, expectedStudentVersion: '2' }] }],
    ['tenant injection', { ...body, tenantId }],
    ['uppercase ID', { ...body, operationId: body.operationId.toUpperCase() }],
    ['partial PG row', { ...body, students: [{ ...row, balance: undefined }] }],
  ])('rejects %s before commands or Google access', async (_label, input) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    await expect(scoped(async () => (await createConfiguredStudentMutation()).updateBatch(input))).rejects.toThrow();
    expect(mocks.updateBatch).not.toHaveBeenCalled();
    expect(mocks.sheets).not.toHaveBeenCalled();
  });
  it('rejects DRAFT and absent trusted context; does not fall back after PG failure', async () => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    await expect(createConfiguredStudentMutation()).rejects.toThrow();
    await expect(scoped(() => createConfiguredStudentMutation(), 'DRAFT')).rejects.toThrow(/ACTIVE/);
    mocks.updateBatch.mockRejectedValueOnce(new Error('PG offline'));
    await expect(scoped(async () => (await createConfiguredStudentMutation()).updateBatch(body))).rejects.toThrow('PG offline');
    expect(mocks.sheets).not.toHaveBeenCalled();
  });
});
