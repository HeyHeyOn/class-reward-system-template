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
  it('covers every concrete export, including auth GETs and POST reads, exactly once', () => {
    const discovered = Object.keys(routes).filter(path => !path.includes('/c/[slug]/[...path]/'))
      .flatMap(path => exportedMethods(readFileSync(resolve('src/server', path), 'utf8'))
        .map(method => `${method} ${path.replace('../app/api', '').replace('/route.ts', '')}`)).sort();
    expect(inventory.map(e => `${e.method} ${e.route}`).sort()).toEqual(discovered);
    expect(new Set(discovered).size).toBe(66);
    expect(inventory.find(e => e.route === '/internal/migrations/freezing-reacquisition')?.effect).toBe('companion-authenticated-read-candidate');
    expect(TENANT_ROUTE_INVENTORY.map(e => `${e.method} ${e.route}`).sort()).toEqual(discovered);
    expect(writers).toHaveLength(28);
    expect(inventory.find(e => e.route === '/google/callback')?.effect).toBe('oauth-exchange');
    expect(inventory.find(e => e.route === '/admin/login')?.effect).toBe('auth-cookie');
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
