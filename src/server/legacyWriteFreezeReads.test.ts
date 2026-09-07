// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_SHEETS, DEFAULT_SETTINGS } from '@/generator/config/schema';
import inventory from './testing/legacyWriteFreezeRoutes.json';

vi.mock('server-only', () => ({}));
const sdk = vi.hoisted(() => ({
  rows: {} as Record<string, string[][]>,
  read: vi.fn(), write: vi.fn(),
}));
vi.mock('googleapis', () => ({ google: {
  auth: { JWT: class {} },
  sheets: () => ({ spreadsheets: {
    values: {
      get: async ({ range }: { range: string }) => {
        sdk.read(range);
        const name = /^'([^']+)'/.exec(range)?.[1] ?? '';
        if (!sdk.rows[name]) throw new Error('Unable to parse range');
        return { data: { values: structuredClone(sdk.rows[name]) } };
      },
      batchGet: async ({ ranges }: { ranges: string[] }) => {
        sdk.read(ranges);
        return { data: { valueRanges: ranges.map(range => {
          const name = /^'([^']+)'/.exec(range)?.[1] ?? '';
          return { values: structuredClone(sdk.rows[name] ?? []) };
        }) } };
      },
      batchUpdate: async (input: { requestBody: { data: { range: string; values: unknown[][] }[] } }) => {
        sdk.write(input);
        for (const item of input.requestBody.data) {
          const match = /^'([^']+)'!([A-Z])(\d+)$/.exec(item.range);
          if (!match) throw new Error('Test SDK only supports single-cell batch updates');
          sdk.rows[match[1]][Number(match[3]) - 1][match[2].charCodeAt(0) - 65] = String(item.values[0][0]);
        }
        return {};
      },
      append: sdk.write, update: sdk.write,
    },
    batchUpdate: sdk.write,
    get: async () => ({ data: { sheets: Object.keys(sdk.rows).map((title, sheetId) => ({
      properties: { title, sheetId, gridProperties: { rowCount: 100, columnCount: 40 } },
    })) } }),
  } }),
} }));
const routes = import.meta.glob('../app/api/**/route.ts');
const readRoutes = inventory.filter(e => (e.effect === 'read' || e.effect === 'qr-read')
  && !e.route.startsWith('/generator/') && !e.route.startsWith('/google/'));

beforeEach(() => {
  vi.stubEnv('MIGRATION_READ_ONLY', 'true');
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
  vi.stubEnv('GOOGLE_SHEET_ID', 'test-sheet-local-only');
  vi.stubEnv('GOOGLE_SERVICE_ACCOUNT_EMAIL', 'test@example.invalid');
  vi.stubEnv('GOOGLE_PRIVATE_KEY', 'local-sdk-placeholder');
  for (const key of ['ADMIN_PASSWORD', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']) vi.stubEnv(key, '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in local fixture tests'); }));
  sdk.rows = Object.fromEntries(Object.entries(REQUIRED_SHEETS).map(([name, headers]) => [name, [[...headers]]]));
  sdk.rows.Students.push(['s1', 'Student One', '100', 'ACTIVE']);
  sdk.rows.Products.push(['p1', 'Pencil', '10', '5', 'TRUE', '', '', '1']);
  sdk.rows.Settings.push(...DEFAULT_SETTINGS.map(({ key, value }) => [key, value]));
  // Authentic legacy shape without recurring columns: readers must not initialize them.
  sdk.rows.Tasks = [REQUIRED_SHEETS.Tasks.slice(0, 9), ['t1', 'Read', '', '5', 'TRUE', '1', '2026-01-01T00:00:00Z', '', '']];
  delete sdk.rows.TaskAssignments;
  sdk.read.mockClear(); sdk.write.mockClear();
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function call(route: string, method: string, body?: unknown, query = '') {
  const loadedRoute = await routes[`../app/api${route}/route.ts`]() as Record<string,
    (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  return loadedRoute[method](new Request(`https://legacy.example/api${route}${query}`, {
    method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { params: Promise.resolve({ studentId: 's1', taskId: 't1' }) });
}

describe('legacy reads through real route/repository/Sheets adapter under freeze', () => {
  it.each(readRoutes)('$method $route remains available without Sheets/Redis mutations', async ({ route, method }) => {
    const before = structuredClone(sdk.rows);
    const query = route === '/bank/student' || route === '/bank/balance' ? '?studentId=s1' : '';
    const body = route === '/checkout/preview' ? { items: [{ productId: 'p1', quantity: 1 }] }
      : route === '/qrcode' ? { kind: 'student', studentId: 's1' }
      : route === '/qrcode/link' ? { kind: 'system-link', url: 'https://legacy.example/' } : undefined;
    const response = await call(route, method, body, query);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    expect(text).not.toContain('MIGRATION_READ_ONLY');
    if (route !== '/qrcode/link') expect(sdk.read).toHaveBeenCalled();
    expect(sdk.write).not.toHaveBeenCalled();
    expect(sdk.rows).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows existing login for readonly administration without credential writeback', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'test-password');
    const response = await call('/admin/login', 'POST', { password: 'test-password' });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('class_store_admin=');
    expect(sdk.write).not.toHaveBeenCalled();
  });

  it('leaves real legacy writes working when unset, then refuses the same request unchanged when frozen', async () => {
    const update = { name: 'Renamed', balance: 100, status: 'ACTIVE' };
    vi.stubEnv('MIGRATION_READ_ONLY', undefined);
    const normal = await call('/students/[studentId]', 'PATCH', update);
    expect(normal.status, await normal.text()).toBe(200);
    expect(sdk.write).toHaveBeenCalled();
    expect(sdk.rows.Students[1][1]).toBe('Renamed');
    const before = structuredClone(sdk.rows);
    sdk.write.mockClear(); sdk.read.mockClear();
    vi.stubEnv('MIGRATION_READ_ONLY', 'true');
    const frozen = await call('/students/[studentId]', 'PATCH', { ...update, name: 'Must not save' });
    expect(frozen.status).toBe(503);
    expect((await frozen.json()).code).toBe('MIGRATION_READ_ONLY');
    expect(sdk.rows).toEqual(before);
    expect(sdk.write).not.toHaveBeenCalled();
    expect(sdk.read).not.toHaveBeenCalled();
  });
});
