import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TENANT_ROUTE_INVENTORY } from './routeInventory';

function exportedHttpMethods(source: string): string[] {
  const file = ts.createSourceFile('route.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods: string[] = [];
  file.forEachChild((node) => {
    const exported = ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    if (ts.isFunctionDeclaration(node) && node.name
      && ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(node.name.text)) {
      methods.push(node.name.text);
      return;
    }
    if (ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)
          && ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(declaration.name.text)) {
          methods.push(declaration.name.text);
        }
      }
    }
  });
  return methods.sort();
}

async function discoverRoutes() {
  const appRoot = resolve(process.cwd(), 'src/app/api');
  const routeFiles = ts.sys.readDirectory(appRoot, ['.ts'], undefined, ['**/route.ts']);
  const discovered: Array<{ route: string; method: string }> = [];
  for (const path of routeFiles) {
    const source = await readFile(path, 'utf8');
    const route = `/${path.slice(appRoot.length + 1).replaceAll('\\', '/').replace(/\/route\.ts$/, '')}`;
    for (const method of exportedHttpMethods(source)) discovered.push({ route, method });
  }
  return discovered.sort(compareRouteMethod);
}

function compareRouteMethod(
  left: { route: string; method: string },
  right: { route: string; method: string },
): number {
  const leftKey = `${left.method} ${left.route}`;
  const rightKey = `${right.method} ${right.route}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

describe('tenant route inventory', () => {
  it('detects both function and const-style exported HTTP handlers', () => {
    expect(exportedHttpMethods(`
      export async function GET() {}
      export const POST = async () => {};
      const PATCH = () => {};
    `)).toEqual(['GET', 'POST']);
  });

  it('classifies every exported API method exactly once', async () => {
    const discovered = await discoverRoutes();
    const inventory = TENANT_ROUTE_INVENTORY
      .map(({ route, method }) => ({ route, method }))
      .sort(compareRouteMethod);
    expect(inventory).toEqual(discovered);
    expect(new Set(inventory.map(({ route, method }) => `${method} ${route}`)).size).toBe(51);
  });

  it('preserves the reviewed Task 10 authority boundary counts', () => {
    expect(TENANT_ROUTE_INVENTORY).toHaveLength(51);
    expect(TENANT_ROUTE_INVENTORY.filter((entry) => entry.scope === 'tenant-data' && entry.effect === 'read')).toHaveLength(15);
    expect(TENANT_ROUTE_INVENTORY.filter((entry) => entry.scope === 'tenant-data' && entry.effect === 'mutation')).toHaveLength(27);
    expect(TENANT_ROUTE_INVENTORY.filter((entry) => entry.scope === 'unsupported')).toEqual([
      { route: '/settings', method: 'PATCH', scope: 'unsupported', effect: 'none' },
    ]);
    expect(TENANT_ROUTE_INVENTORY.filter((entry) => entry.scope === 'platform')).toHaveLength(8);
  });
});
