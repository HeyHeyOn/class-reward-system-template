import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TENANT_ROUTE_INVENTORY } from './routeInventory';

const ROOT = process.cwd();
const READ_AUTHORITY = [
  ['bank/balance', 'GET', 'createConfiguredBankReader'],
  ['bank/student', 'GET', 'createConfiguredBankReader'],
  ['bank/tasks', 'GET', 'createConfiguredTaskReader'],
  ['checkout/preview', 'POST', 'createConfiguredCheckoutPreviewService'],
  ['products', 'GET', 'createConfiguredCatalogReader'],
  ['promotions/active', 'GET', 'createConfiguredCatalogReader'],
  ['promotions', 'GET', 'createConfiguredCatalogReader'],
  ['settings', 'GET', 'createConfiguredSettingsReader'],
  ['students/[studentId]', 'GET', 'createConfiguredStudentReader'],
  ['students', 'GET', 'createConfiguredStudentReader'],
  ['tasks/[taskId]/assignments', 'GET', 'createConfiguredTaskReader'],
  ['tasks/[taskId]/history', 'GET', 'createConfiguredTaskReader'],
  ['tasks/[taskId]', 'GET', 'createConfiguredTaskReader'],
  ['tasks', 'GET', 'createConfiguredTaskReader'],
  ['transactions', 'GET', 'createConfiguredTransactionReader'],
] as const;

async function exportedMethodBody(route: string, method: string): Promise<string> {
  const file = resolve(ROOT, 'src/app/api', route, 'route.ts');
  const sourceText = await readFile(file, 'utf8');
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement)
    && statement.name?.text === method
    && statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true);
  if (!declaration?.body) throw new Error(`Missing exported ${method} in ${route}.`);
  return declaration.body.getText(source);
}

describe('tenant read route PostgreSQL authority', () => {
  it('covers every and only tenant-data read handler in the route inventory', () => {
    const inventory = TENANT_ROUTE_INVENTORY
      .filter((entry) => entry.scope === 'tenant-data' && entry.effect === 'read')
      .map((entry) => [`${entry.route.replace(/^\//, '')}`, entry.method])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`));
    const authority = READ_AUTHORITY.map(([route, method]) => [route, method] as string[])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`));
    expect(inventory).toHaveLength(15);
    expect(authority).toEqual(inventory);
  });

  it.each(READ_AUTHORITY)('%s %s resolves through %s without direct Sheets reads',
  async (route, method, configuredRoot) => {
    const body = await exportedMethodBody(route, method);
    expect(body).toContain(`${configuredRoot}(`);
    expect(body).not.toMatch(/createConfiguredSheets(?:Reader|Store)\s*\(/);
  });
});
