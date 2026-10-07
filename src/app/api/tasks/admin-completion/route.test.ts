import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { POST } from './route';
import { TENANT_ROUTE_INVENTORY } from '@/server/repositories/routeInventory';
const state = vi.hoisted(() => ({ scoped: false }));
vi.mock('server-only', () => ({}));
vi.mock('@/server/legacyDeploymentMode', () => ({ legacyWriteFreezeResponse: () => undefined }));
vi.mock('@/server/trustedTenantRequestContext', () => ({ getOptionalTrustedTenantRequestContext: () => state.scoped ? { tenant: { id: 'tenant', lifecycle: 'ACTIVE' } } : undefined }));
beforeEach(() => { state.scoped = false; vi.stubEnv('CLASS_STORE_STORAGE', 'sheets'); });
afterEach(() => vi.unstubAllEnvs());
it('is not routed for PostgreSQL classes, whose completion marks live in the task ledger', () => {
  expect(TENANT_ROUTE_INVENTORY.filter(e => e.route === '/tasks/admin-completion')).toEqual([{ route: '/tasks/admin-completion', method: 'POST', scope: 'unsupported', effect: 'none' }]);
});
it('does not open a Sheets or compatibility completion writer', async () => {
  const response = await POST(); expect(response.status).toBe(401); expect((await response.json()).code).toBe('ADMIN_REQUIRED');
});
it.each(['tenant', 'central'])('answers a %s PostgreSQL request like an unrouted path', async kind => {
  if (kind === 'tenant') state.scoped = true; else vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  const response = await POST(); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Not found.' });
});
