// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredStudentBankReader } from '@/server/repositories/configuredStudentBank';
import { createConfiguredPets } from '@/server/repositories/configuredPets';
import { createStudentBankSession, sealStudentBankSession, STUDENT_BANK_SESSION_COOKIE } from '@/server/studentBankSession';
import type { TenantRecord } from '@/server/tenantContext';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';
import { GET } from './route';

vi.mock('server-only', () => ({}));
vi.mock('@/server/repositories/configuredStudentBank', () => ({ createConfiguredStudentBankReader: vi.fn() }));
vi.mock('@/server/repositories/configuredPets', () => ({ createConfiguredPets: vi.fn() }));
const tenant: TenantRecord = { id: '11111111-1111-4111-8111-111111111111', slug: 'class-a', displayName: 'Synthetic', lifecycle: 'ACTIVE', timezone: 'Asia/Seoul' };
const secret = 'synthetic-pet-dex-route-secret-1234567';
const confirmStudent = vi.fn(), dexPage = vi.fn();
function call(query = '', authenticated = true) {
  const value = sealStudentBankSession(createStudentBankSession({ tenantId: tenant.id, cookiePath: '/api/c/class-a/bank' }, 'S1'), { AUTH_SECRET: secret });
  return runWithTrustedTenantRequestContext({ tenant }, () => GET(new Request(`https://example.invalid/api/bank/me/pet/dex${query}`,
    authenticated ? { headers: { cookie: `${STUDENT_BANK_SESSION_COOKIE}=${value}` } } : undefined)));
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv('AUTH_SECRET', secret); vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  confirmStudent.mockResolvedValue({ status: 'FOUND', student: { studentId: 'S1', name: 'Synthetic', balance: 100, status: 'ACTIVE' } });
  vi.mocked(createConfiguredStudentBankReader).mockResolvedValue({ confirmStudent, getTransactions: vi.fn() });
  vi.mocked(createConfiguredPets).mockResolvedValue({ dexPage } as never);
  dexPage.mockResolvedValue({ entries: [], collection: [], nextCursor: null });
});
afterEach(() => vi.unstubAllEnvs());
describe('student pet dex authorization', () => {
  it('pages only the confirmed session student and disables caching', async () => {
    const response = await call('?cursor=synthetic-cursor');
    expect(response.status).toBe(200);
    expect(dexPage).toHaveBeenCalledWith('S1', 'synthetic-cursor');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('rejects student overrides, repeated cursors and arbitrary limits', async () => {
    for (const query of ['?studentId=S2', '?cursor=a&cursor=b', '?limit=1000000']) expect((await call(query)).status).toBe(400);
    expect(dexPage).not.toHaveBeenCalled();
  });
  it('requires a current active student session', async () => {
    expect((await call('', false)).status).toBe(401);
    confirmStudent.mockResolvedValue({ status: 'NOT_FOUND' });
    expect((await call()).status).toBe(401);
    expect(dexPage).not.toHaveBeenCalled();
  });
});
