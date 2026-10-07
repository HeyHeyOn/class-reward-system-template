// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TENANT_ROUTE_INVENTORY } from './repositories/routeInventory';
import { runWithTrustedTenantRequestContext, type TrustedTenantRequestContext } from './trustedTenantRequestContext';

vi.mock('server-only', () => ({}));
const sheets = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected Sheets access'); }));
vi.mock('@/server/googleSheets', () => ({ createConfiguredSheetsStore: sheets, createConfiguredSheetsReader: sheets }));

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const routes = import.meta.glob('../app/api/tasks/**/route.ts');
// Every per-cycle task writer the tenant dispatcher leaves unrouted for PostgreSQL classes.
const WRITERS = TENANT_ROUTE_INVENTORY
  .filter((entry) => entry.scope === 'unsupported' && entry.route.startsWith('/tasks') && entry.method !== 'GET')
  .map(({ route, method }) => [route, method] as const);
const TENANT = { tenant: { id: '123e4567-e89b-12d3-a456-426614174000', slug: 'alpha', lifecycle: 'ACTIVE' } } as unknown as TrustedTenantRequestContext;

async function handler(route: string, method: string): Promise<Handler> {
  return ((await routes[`../app/api${route}/route.ts`]()) as Record<string, Handler>)[method];
}

async function call(route: string, method: string) {
  const run = await handler(route, method);
  const request = new Request(`http://localhost/api${route.replace('[taskId]', 'T1')}`, {
    method, headers: { 'content-type': 'application/json' }, body: '{}',
  });
  const json = vi.spyOn(request, 'json');
  const response = await run(request, { params: Promise.resolve({ taskId: 'T1' }) });
  return { response, json };
}

beforeEach(() => {
  vi.stubEnv('MIGRATION_READ_ONLY', '');
  // Synthetic test value: enables the Sheets admin check, which the request below does not pass.
  vi.stubEnv('ADMIN_PASSWORD', 'synthetic-test-password');
  sheets.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('per-cycle task writers in PostgreSQL mode', () => {
  it('covers all eleven writers', () => {
    expect(WRITERS).toHaveLength(11);
  });

  it.each(WRITERS)('%s %s answers a central PostgreSQL deployment like an unrouted path', async (route, method) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    const { response, json } = await call(route, method);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
    expect(json).not.toHaveBeenCalled();
    expect(sheets).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('%s %s answers a scoped tenant request like an unrouted path', async (route, method) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const { response, json } = await runWithTrustedTenantRequestContext(TENANT, () => call(route, method));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found.' });
    expect(json).not.toHaveBeenCalled();
    expect(sheets).not.toHaveBeenCalled();
  });

  it.each(WRITERS)('%s %s still reaches its Sheets handler (admin check first)', async (route, method) => {
    vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
    const { response } = await call(route, method);
    expect(response.status).toBe(401);
    expect(sheets).not.toHaveBeenCalled();
  });
});
