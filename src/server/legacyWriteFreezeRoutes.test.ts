// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import inventory from './testing/legacyWriteFreezeRoutes.json';
import { TENANT_ROUTE_INVENTORY } from './repositories/routeInventory';

vi.mock('server-only', () => ({}));
// Only the external SDK boundary is replaced; handlers, auth, repositories and commands are real.
const external = vi.hoisted(() => ({ sheets: vi.fn(() => { throw new Error('Unexpected Sheets access'); }) }));
vi.mock('googleapis', () => ({ google: { sheets: external.sheets, auth: {
  OAuth2: class {}, JWT: class {},
} } }));
const routes = import.meta.glob('../app/api/**/route.ts');
const writers = inventory.filter(({ effect }) => effect.endsWith('-write'));

beforeEach(() => {
  vi.stubEnv('MIGRATION_READ_ONLY', 'true');
  vi.stubEnv('CLASS_STORE_STORAGE', 'sheets');
  vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  for (const key of ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'DATABASE_URL', 'ADMIN_PASSWORD']) vi.stubEnv(key, '');
  external.sheets.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network/Redis access'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

async function handler(route: string, method: string) {
  const loadedRoute = await routes[`../app/api${route}/route.ts`]() as Record<string,
    (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  return loadedRoute[method];
}

function exportedMethods(text: string): string[] {
  const source = ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);
  const result: string[] = [];
  for (const node of source.statements) {
    let names: (string | undefined)[];
    if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) continue;
      if (!node.exportClause) throw new Error('Route inventory cannot resolve star re-exports');
      names = ts.isNamedExports(node.exportClause)
        ? node.exportClause.elements.filter(e => !e.isTypeOnly).map(e => e.name.text) : [];
    } else {
      if (!ts.canHaveModifiers(node) || !ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      names = ts.isFunctionDeclaration(node) ? [node.name?.text]
        : ts.isVariableStatement(node) ? node.declarationList.declarations.map(d => {
          if (!ts.isIdentifier(d.name)) throw new Error('Route inventory cannot resolve exported destructuring bindings');
          return d.name.text;
        }) : [];
    }
    result.push(...names.filter((name): name is string => !!name && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(name)));
  }
  return result;
}

describe('route inventory export discovery', () => {
  it.each([
    ['function and const exports', 'export function GET() {} export const POST = () => {};', ['GET', 'POST']],
    ['named HTTP re-export', "export { GET } from './handler';", ['GET']],
    ['aliased HTTP re-export', "export { handler as POST } from './handler';", ['POST']],
    ['HTTP name aliased away', "export { GET as helper } from './handler';", []],
    ['local named export', 'const handler = () => {}; export { handler as PATCH };', ['PATCH']],
    ['mixed declarations and re-exports', "export function GET() {} export { handler as HEAD } from './handler'; export const OPTIONS = () => {};", ['GET', 'HEAD', 'OPTIONS']],
    ['declaration-level type-only re-export', "export type { GET, Handler as POST } from './handler';", []],
    ['specifier-level type-only re-export', "export { type GET, type Handler as POST, handler as DELETE } from './handler';", ['DELETE']],
    ['local type-only export', 'type GET = () => void; export type { GET };', []],
    ['type-only star re-export', "export type * from './handler';", []],
    ['unexported declarations', 'function GET() {} const POST = () => {};', []],
  ])('discovers only runtime HTTP names: %s', (_label, text, expected) => {
    expect(exportedMethods(text as string)).toEqual(expected);
  });

  it.each([
    ['object', 'export const { POST } = handlers;'],
    ['aliased object', 'export const { handler: POST } = handlers;'],
    ['array', 'export const [POST] = handlers;'],
    ['nested', 'export const { handlers: [{ handler: POST }] } = source;'],
    ['default', 'export const { POST = fallback } = handlers;'],
    ['object rest', 'export const { ...POST } = handlers;'],
    ['array rest', 'export const [...POST] = handlers;'],
    ['non-HTTP binding', 'export const { helper } = handlers;'],
    ['mixed declarations', 'export const GET = handler, { POST } = handlers;'],
  ])('fails closed on exported destructuring: %s', (_label, text) => {
    expect(() => exportedMethods(text))
      .toThrow('Route inventory cannot resolve exported destructuring bindings');
  });

  it('fails closed on unresolved runtime star re-exports', () => {
    expect(() => exportedMethods("export function GET() {} export * from './handler';"))
      .toThrow('Route inventory cannot resolve star re-exports');
  });
});

describe('exhaustive legacy side-effect inventory', () => {
  it.each(['/classes', '/classes/[slug]/start'])('%s remains a platform mutation requiring Google authentication under legacy freeze', async route => {
    expect(inventory.find(entry => entry.route === route)?.effect).toBe('postgres-platform-mutation');
    expect(TENANT_ROUTE_INVENTORY.find(entry => entry.route === route)).toEqual({
      route, method: 'POST', scope: 'platform', effect: 'mutation',
    });
    expect(writers.some(entry => entry.route === route)).toBe(false);
    const run = await handler(route, 'POST');
    const request = new Request(`https://legacy.example/api${route}`, { method: 'POST', body: '{}' });
    const readBody = vi.spyOn(request, 'json');
    const response = await run(request, { params: Promise.resolve({ slug: 'alpha' }) });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(readBody).not.toHaveBeenCalled();
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies the QR balance POST as a read and preserves input validation during legacy freeze', async () => {
    expect(inventory.find(entry => entry.route === '/bank/balance' && entry.method === 'POST')?.effect).toBe('read');
    const run = await handler('/bank/balance', 'POST');
    const response = await run(new Request('https://legacy.example/api/bank/balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }), { params: Promise.resolve({}) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).not.toBe('MIGRATION_READ_ONLY');
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('covers every concrete export, including auth GETs and POST reads, exactly once', () => {
    const discovered = Object.keys(routes).filter(path => !path.includes('/c/[slug]/[...path]/'))
      .flatMap(path => exportedMethods(readFileSync(resolve('src/server', path), 'utf8'))
        .map(method => `${method} ${path.replace('../app/api', '').replace('/route.ts', '')}`)).sort();
    expect(inventory.map(e => `${e.method} ${e.route}`).sort()).toEqual(discovered);
    expect(discovered).toHaveLength(138);
    expect(new Set(discovered).size).toBe(discovered.length);
    expect(inventory.find(e => e.route === '/internal/migrations/freezing-reacquisition')?.effect).toBe('companion-authenticated-read-candidate');
    expect(TENANT_ROUTE_INVENTORY.map(e => `${e.method} ${e.route}`).sort()).toEqual(discovered);
    expect(writers).toHaveLength(62);
    expect(writers.filter(entry => entry.effect !== 'postgres-write')).toHaveLength(29);
    expect(inventory.find(e => e.route === '/google/callback')?.effect).toBe('oauth-exchange');
    expect(inventory.find(e => e.route === '/admin/login')?.effect).toBe('auth-cookie');
    expect(inventory.find(e => e.route === '/bank/me/pet/dex')?.effect).toBe('student-session-read');
  });

  it('classifies membership-gated migration status as a direct read, not a writer or scoped data route', () => {
    const route = '/migrations/status/[slug]';
    expect(inventory.filter(entry => entry.route === route)).toEqual([
      { method: 'GET', route, effect: 'tenant-membership-status-read' },
    ]);
    expect(TENANT_ROUTE_INVENTORY.filter(entry => entry.route === route)).toEqual([
      { method: 'GET', route, scope: 'tenant-status', effect: 'read' },
    ]);
    expect(writers.some(entry => entry.route === route)).toBe(false);
    const dispatcher = readFileSync('src/app/api/c/[slug]/[...path]/route.ts', 'utf8');
    const scopedRoutes = Array.from(dispatcher.matchAll(/route\('[^']+',\s*'([^']+)'/g), match => `/${match[1]}`);
    expect(scopedRoutes).not.toContain(route);
  });

  it('keeps migration status authentication mandatory under legacy freeze without treating it as a write', async () => {
    const run = await handler('/migrations/status/[slug]', 'GET');
    const response = await run(new Request('https://legacy.example/api/migrations/status/alpha'), {
      params: Promise.resolve({ slug: 'alpha' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'AUTHENTICATION_REQUIRED' });
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('classifies only download GET/HEAD as historical membership reads outside the scoped dispatcher', () => {
    const route = '/migrations/status/[slug]/preflight/download';
    expect(inventory.filter(entry => entry.route === route)).toEqual([
      { method: 'GET', route, effect: 'tenant-membership-historical-report-read' },
      { method: 'HEAD', route, effect: 'tenant-membership-historical-report-read' },
    ]);
    expect(TENANT_ROUTE_INVENTORY.filter(entry => entry.route === route)).toEqual([
      { method: 'GET', route, scope: 'tenant-status', effect: 'read' },
      { method: 'HEAD', route, scope: 'tenant-status', effect: 'read' },
    ]);
    expect(writers.some(entry => entry.route === route)).toBe(false);
    const dispatcher = readFileSync('src/app/api/c/[slug]/[...path]/route.ts', 'utf8');
    const scopedRoutes = Array.from(dispatcher.matchAll(/route\('[^']+',\s*'([^']+)'/g), match => `/${match[1]}`);
    expect(scopedRoutes).not.toContain(route);
  });

  it.each(['GET', 'HEAD'])('requires download %s authentication under synthetic legacy freeze, without Sheets/fetch', async method => {
    const run = await handler('/migrations/status/[slug]/preflight/download', method);
    const response = await run(new Request(`https://legacy.example/api/migrations/status/alpha/preflight/download?jobId=fixture&reportId=reconciliation:${'a'.repeat(64)}`, { method }), {
      params: Promise.resolve({ slug: 'alpha' }),
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(method === 'HEAD' ? '' : JSON.stringify({ error: 'AUTHENTICATION_REQUIRED' }));
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'private, no-store', 'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer', vary: 'Cookie', 'x-content-type-options': 'nosniff',
    });
    if (method === 'HEAD') expect(response.body).toBeNull();
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  // Membership-gated NONAUTHORITY metadata, not configured current data authority.
  it('classifies only historical metadata CSV GET/HEAD as direct membership reads', () => {
    const route = '/exports/[slug]/historical-local-generation-metadata.csv';
    expect(inventory.filter(entry => entry.route === route)).toEqual([
      { method: 'GET', route, effect: 'tenant-membership-historical-metadata-read' },
      { method: 'HEAD', route, effect: 'tenant-membership-historical-metadata-read' },
    ]);
    expect(TENANT_ROUTE_INVENTORY.filter(entry => entry.route === route)).toEqual([
      { method: 'GET', route, scope: 'tenant-status', effect: 'read' },
      { method: 'HEAD', route, scope: 'tenant-status', effect: 'read' },
    ]);
    expect(writers.some(entry => entry.route === route)).toBe(false);
    const dispatcher = readFileSync('src/app/api/c/[slug]/[...path]/route.ts', 'utf8');
    const scopedRoutes = Array.from(dispatcher.matchAll(/route\('[^']+',\s*'([^']+)'/g), match => `/${match[1]}`);
    expect(scopedRoutes).not.toContain(route);
  });

  it.each(['GET', 'HEAD'])('requires historical metadata CSV %s authentication under synthetic legacy freeze, without Sheets/fetch', async method => {
    const run = await handler('/exports/[slug]/historical-local-generation-metadata.csv', method);
    // Exact ordered literal selector; malformed transport must not mask the auth boundary.
    const url = `https://legacy.example/api/exports/alpha/historical-local-generation-metadata.csv?jobId=fixture&generationId=preparation%3Acandidate%3A${'a'.repeat(64)}`;
    const response = await run(new Request(url, {
      method, headers: { 'x-tenant-id': 'spoofed', 'x-role': 'OWNER' },
    }), { params: Promise.resolve({ slug: 'alpha' }) });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(method === 'HEAD' ? '' : 'HISTORICAL_LOCAL_GENERATION_UNAUTHENTICATED\n');
    expect(Object.fromEntries(response.headers)).toEqual({
      'cache-control': 'private, no-store', 'content-type': 'text/plain; charset=utf-8',
      'referrer-policy': 'no-referrer', vary: 'Cookie', 'x-content-type-options': 'nosniff',
    });
    if (method === 'HEAD') expect(response.body).toBeNull();
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(writers)('$method $route has the refusal as its first composition-root operation', ({ route, method, effect }) => {
    const text = readFileSync(`src/app/api${route}/route.ts`, 'utf8');
    const source = ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === method);
    const argument = effect === 'generator-write' ? "'generator-sheets'" : '';
    expect(declaration?.body?.statements[0].getText(source)).toBe(`const frozen = legacyWriteFreezeResponse(${argument});`);
    expect(declaration?.body?.statements[1].getText(source)).toBe('if (frozen) return frozen;');
  });

  it('blocks generator Sheets creation before its global DB claim even on a PostgreSQL platform', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
    const run = await handler('/generator/create', 'POST');
    const response = await run(new Request('https://generator.example/api/generator/create', { method: 'POST', body: '{}' }), { params: Promise.resolve({}) });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('MIGRATION_READ_ONLY');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(writers)('$method $route refuses before body, auth, batches, provider or claims', async ({ route, method }) => {
    const run = await handler(route, method);
    const request = new Request(`https://legacy.example/api${route}?next=https://evil.example/&qr=private`, {
      method, headers: { 'content-type': 'application/json', 'x-tenant-id': 'spoofed' }, body: '{}',
    });
    const json = vi.spyOn(request, 'json').mockRejectedValue(new Error('Body must not be consumed'));
    const response = await run(request, { params: Promise.resolve({ taskId: 't1', studentId: 's1', productId: 'p1', promotionId: 'p1', transactionId: 'tx1' }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: 'MIGRATION_READ_ONLY', error: '이전 서비스는 이전 작업으로 읽기 전용입니다.' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(json).not.toHaveBeenCalled();
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['/products/batch', 'PATCH', { products: [{ productId: 'p1', price: 10, stock: 2 }, { productId: 'missing' }] }],
    ['/students/bulk', 'PATCH', { studentIds: ['s1', 'missing'], amount: 10, reason: 'adjustment' }],
    ['/tasks/assignments/batch', 'POST', { targets: [{ taskId: 't1', operations: [{ studentId: 's1', completed: true, source: 'ADMIN' }] }, { taskId: 'missing', operations: [] }] }],
    ['/tasks/[taskId]/complete', 'POST', { studentId: 's1', operationId: '10000000-0000-4000-8000-000000000001' }],
  ])('%s blocks partial batches and reward/claim execution with real payloads', async (route, method, body) => {
    const run = await handler(route as string, method as string);
    const request = new Request(`https://legacy.example/api${route}`, { method: method as string,
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await run(request, { params: Promise.resolve({ taskId: 't1' }) });
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('MIGRATION_READ_ONLY');
    expect(external.sheets).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['/admin/logout', '/google/logout'])('%s preserves local logout cookies', async route => {
    const run = await handler(route, 'POST');
    const response = await run(new Request(`https://legacy.example/api${route}`, { method: 'POST' }), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('unset mode retains existing checkout validation rather than freezing', async () => {
    vi.stubEnv('MIGRATION_READ_ONLY', undefined);
    const run = await handler('/checkout', 'POST');
    const response = await run(new Request('https://legacy.example/api/checkout', { method: 'POST', body: '{}' }), { params: Promise.resolve({}) });
    expect(response.status).toBe(400);
    expect((await response.json()).code).not.toBe('MIGRATION_READ_ONLY');
  });
});
