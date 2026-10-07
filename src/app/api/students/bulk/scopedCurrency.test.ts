// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantAdminContextDependencies } from '@/server/tenantAuth';

const mocks = vi.hoisted(() => ({
  access: {} as TenantAdminContextDependencies,
  commands: vi.fn(),
  adjust: vi.fn(),
  transaction: vi.fn(),
  sheets: vi.fn(),
  single: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/tenantAccess', () => ({ getProductionTenantAccessDependencies: () => mocks.access }));
vi.mock('@/server/db/transaction', async original => ({
  ...await original<object>(), withTenantTransaction: mocks.transaction,
}));
vi.mock('@/server/repositories/database/adminCommands', async original => ({
  ...await original<object>(), createDatabaseAdminCommands: mocks.commands,
}));
vi.mock('@/server/googleSheets', async original => ({
  ...await original<object>(), createConfiguredSheetsStore: mocks.sheets,
}));
vi.mock('@/server/sheetsRepository', async original => ({
  ...await original<object>(),
  updateStudentDetails: mocks.single,
  bulkAdjustStudentBalances: vi.fn(),
}));

import { PATCH } from '@/app/api/c/[slug]/[...path]/route';

const TENANT_ID = 'd1700000-0000-4000-8000-000000000001';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
  vi.stubEnv('MIGRATION_READ_ONLY', '');
  Object.assign(mocks.access, {
    findBySlug: vi.fn(async () => ({
      id: TENANT_ID, slug: 'd17-currency', displayName: 'D17',
      lifecycle: 'ACTIVE', timezone: 'Asia/Seoul',
    })),
    getSession: vi.fn(async () => ({ subject: 'd17-teacher', email: 'teacher@example.invalid', issuedAt: Date.now() })),
    findByTenantAndSubject: vi.fn(async () => ({
      id: 'membership', tenantId: TENANT_ID, userId: 'teacher', googleSubject: 'd17-teacher', role: 'OWNER',
    })),
  });
  mocks.commands.mockReturnValue({ adjust: mocks.adjust });
  mocks.sheets.mockRejectedValue(new Error('unexpected single-student Sheets fallback'));
});
afterEach(() => vi.unstubAllEnvs());

describe('scoped administrator QR currency route selection', () => {
  it('routes the literal bulk PATCH to configured adjustment rather than the single-student handler', async () => {
    for (const [mode, amount, balance] of [['add', 20, 120], ['subtract', 130, -10]] as const) {
      const body = {
        studentIds: ['D17-STUDENT'], mode, amount,
        operationId: mode === 'add' ? 'd1700000-0000-4000-8000-000000000011' : 'd1700000-0000-4000-8000-000000000012',
      };
      mocks.adjust.mockResolvedValueOnce({ students: [{ studentId: 'D17-STUDENT', balanceAfter: balance }] });
      const response = await PATCH(new Request('https://test.invalid/api/c/d17-currency/students/bulk', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), { params: Promise.resolve({ slug: 'd17-currency', path: ['students', 'bulk'] }) });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([{ studentId: 'D17-STUDENT', balance }]);
      expect(mocks.adjust).toHaveBeenLastCalledWith(body);
    }
    expect(mocks.commands).toHaveBeenCalledTimes(2);
    expect(mocks.commands).toHaveBeenLastCalledWith({ tenantId: TENANT_ID, runTenantTransaction: mocks.transaction });
    expect(mocks.sheets).not.toHaveBeenCalled();
    expect(mocks.single).not.toHaveBeenCalled();
  });
});
