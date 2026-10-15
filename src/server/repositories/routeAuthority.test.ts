import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TENANT_ROUTE_INVENTORY } from './routeInventory';

const ROOT = process.cwd();
const READ_AUTHORITY = [
  ['migrations/[jobId]/freezing/reacquisition/bootstrap', 'GET', 'getProductionFreezingReacquisitionHandlers'],
  ['migrations/[jobId]/freezing/reacquisition/[attemptId]', 'GET', 'getProductionFreezingReacquisitionStatus'],
  ['migrations/[jobId]/freezing/start/[attemptId]', 'GET', 'getProductionStartFreezingStatus'],
  ['bank/balance', 'GET', 'createConfiguredBankReader'],
  ['bank/balance', 'POST', 'createConfiguredBankReader'],
  ['bank/student', 'GET', 'createConfiguredBankReader'],
  ['bank/tasks', 'GET', 'createConfiguredTaskReader'],
  ['bank/session', 'GET', 'createConfiguredStudentBankReader'],
  ['bank/me/transactions', 'GET', 'createConfiguredStudentBankReader'],
  ['bank/me/tasks', 'GET', 'createConfiguredTaskReader'],
  ['checkout/preview', 'POST', 'createConfiguredCheckoutPreviewService'],
  ['products', 'GET', 'createConfiguredCatalogReader'],
  ['promotions/active', 'GET', 'createConfiguredCatalogReader'],
  ['promotions', 'GET', 'createConfiguredCatalogReader'],
  ['qrcode', 'POST', 'createConfiguredStudentReader'],
  ['settings', 'GET', 'createConfiguredSettingsReader'],
  ['students/[studentId]', 'GET', 'createConfiguredStudentReader'],
  ['students', 'GET', 'createConfiguredStudentReader'],
  ['students/import/template', 'GET', 'createStudentImportTemplate'],
  ['students/import/preview', 'POST', 'createConfiguredStudentImport'],
  ['products/import/template', 'GET', 'createProductImportTemplate'],
  ['products/import/preview', 'POST', 'createConfiguredProductImport'],
  ['tasks/[taskId]', 'GET', 'createConfiguredTaskReader'],
  ['tasks', 'GET', 'createConfiguredTaskReader'],
  ['transactions', 'GET', 'createConfiguredTransactionReader'],
  ['migrations/xlsx/preview', 'POST', 'createConfiguredXlsxImport'],
  ['task-ledger', 'GET', 'createConfiguredTaskLedger'],
  ['task-ledger/tasks/[taskId]/history', 'GET', 'createConfiguredTaskLedger'],
  ['task-ledger/padlet', 'GET', 'createConfiguredPadlet'],
  ['task-ledger/padlet/preview', 'GET', 'createConfiguredPadlet'],
  ['bank/me/tree', 'GET', 'createConfiguredClassTree'],
  ['class-tree', 'GET', 'createConfiguredClassTree'],
  ['bank/me/pet', 'GET', 'createConfiguredPets'],
  ['bank/me/pet/dex', 'GET', 'createConfiguredPets'],
  ['pets', 'GET', 'createConfiguredPets'],
  ['bank/me/bag', 'GET', 'createConfiguredStudentBag'],
  ['bag/students/[studentId]', 'GET', 'createConfiguredStudentBag'],
  ['bag/digital-products', 'GET', 'createConfiguredStudentBag'],
  ['checkout/vouchers', 'POST', 'createConfiguredStudentBag'],
] as const;
const CONFIGURED_MUTATION_AUTHORITY = [
  ['migrations/[jobId]/freezing/reacquisition/challenge', 'POST', 'getProductionFreezingReacquisitionHandlers'],
  ['migrations/[jobId]/freezing/reacquisition', 'POST', 'getProductionFreezingReacquisitionHandlers'],
  ['migrations/[jobId]/freezing/start/challenge', 'GET', 'getProductionStartFreezingHandlers'],
  ['migrations/[jobId]/freezing/start', 'POST', 'getProductionStartFreezingHandlers'],
  ['migrations/[jobId]/freezing/consent/challenge', 'POST', 'getProductionFreezingConsentHandlers'],
  ['migrations/[jobId]/freezing/consent', 'POST', 'getProductionFreezingConsentHandlers'],
  ['bank/session', 'POST', 'createConfiguredStudentBankReader'],
  ['bank/me/tasks/[taskId]/complete', 'POST', 'createConfiguredTaskCompletion'],
  ['checkout', 'POST', 'createConfiguredCheckoutCommand'],
  ['products', 'POST', 'createConfiguredProductCreation'],
  ['products/batch', 'PATCH', 'createConfiguredProductMutation'],
  ['products/[productId]', 'DELETE', 'createConfiguredProductDeletion'],
  ['promotions/[promotionId]', 'DELETE', 'createConfiguredPromotionDeletion'],
  ['promotions/[promotionId]', 'PATCH', 'createConfiguredPromotionMutation'],
  ['promotions', 'POST', 'createConfiguredPromotionCreation'],
  ['students', 'POST', 'createConfiguredStudentCreation'],
  ['students/batch', 'PATCH', 'createConfiguredStudentMutation'],
  ['students/batch', 'DELETE', 'createConfiguredStudentDeletion'],
  ['students/qr-reissue', 'POST', 'createConfiguredStudentQrCodes'],
  ['students/[studentId]', 'DELETE', 'createConfiguredStudentDeletion'],
  ['students/bulk', 'PATCH', 'createConfiguredAdminAdjustmentCommand'],
  ['students/import/commit', 'POST', 'createConfiguredStudentImport'],
  ['products/import/commit', 'POST', 'createConfiguredProductImport'],
  ['tasks/[taskId]/complete', 'POST', 'createConfiguredTaskCompletion'],
  ['transactions/[transactionId]/cancel', 'POST', 'createConfiguredTransactionCancellation'],
  ['migrations/xlsx/commit', 'POST', 'createConfiguredXlsxImport'],
  ['task-ledger/tasks', 'POST', 'createConfiguredTaskLedger'],
  ['task-ledger/tasks/delete', 'POST', 'createConfiguredTaskLedger'],
  ['task-ledger/tasks/[taskId]', 'PATCH', 'createConfiguredTaskLedger'],
  ['task-ledger/stages', 'POST', 'createConfiguredTaskLedger'],
  ['task-ledger/reset', 'POST', 'createConfiguredTaskLedger'],
  ['task-ledger/repeat', 'POST', 'createConfiguredTaskLedger'],
  ['task-ledger/qr', 'POST', 'createConfiguredTaskLedger'],
  ['task-ledger/padlet/key', 'POST', 'createConfiguredPadlet'],
  ['task-ledger/padlet/links', 'POST', 'createConfiguredPadlet'],
  ['task-ledger/padlet/unlink', 'POST', 'createConfiguredPadlet'],
  ['task-ledger/padlet/sync', 'POST', 'createConfiguredPadlet'],
  ['bank/me/tree/water', 'POST', 'createConfiguredClassTree'],
  ['class-tree/settings', 'POST', 'createConfiguredClassTree'],
  ['class-tree/feed', 'POST', 'createConfiguredClassTree'],
  ['class-tree/harvest', 'POST', 'createConfiguredClassTree'],
  ['bank/me/pet/adopt', 'POST', 'createConfiguredPets'],
  ['bank/me/pet/care', 'POST', 'createConfiguredPets'],
  ['bank/me/pet/graduate', 'POST', 'createConfiguredPets'],
  ['bank/me/pet/decor/buy', 'POST', 'createConfiguredPets'],
  ['bank/me/pet/decor/place', 'POST', 'createConfiguredPets'],
  ['bank/me/pet/companions', 'POST', 'createConfiguredPets'],
  ['bank/me/pet/rename', 'POST', 'createConfiguredPets'],
  ['pets/settings', 'POST', 'createConfiguredPets'],
  ['pets/rename', 'POST', 'createConfiguredPets'],
  ['pets/growth', 'POST', 'createConfiguredPets'],
  ['bag/items/use', 'POST', 'createConfiguredStudentBag'],
  ['bag/items/give', 'POST', 'createConfiguredStudentBag'],
  ['bag/items/revoke', 'POST', 'createConfiguredStudentBag'],
  ['bag/digital-products', 'POST', 'createConfiguredStudentBag'],
] as const;

// Logout touches no class data: it only clears the student's own bank session cookie.
const SESSION_ONLY_MUTATIONS = [
  ['bank/session', 'DELETE', 'clearedStudentBankSessionCookie'],
] as const;

// Class administrators sign in with Google only; these Sheets-era logins refuse every class request.
const GOOGLE_ONLY_REFUSALS = [
  ['admin/login', 'POST'],
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

it('keeps companion disable outside tenant authority and on the concrete production authentication root', async () => {
  expect(TENANT_ROUTE_INVENTORY.find(e => e.route === '/internal/migrations/final-bridge')).toEqual({
    route: '/internal/migrations/final-bridge', method: 'POST', scope: 'platform', effect: 'mutation',
  });
  const body = await exportedMethodBody('internal/migrations/final-bridge', 'POST');
  expect(body).toContain('getProductionBridgeProducer()');
  expect(body).not.toMatch(/createConfiguredSheets|request\.(json|arrayBuffer|text)/);
});

it('classifies signed read-candidate ingress as companion replay mutation, never current central membership authority', async () => {
  expect(TENANT_ROUTE_INVENTORY.find(e => e.route === '/internal/migrations/freezing-reacquisition')).toEqual({
    route: '/internal/migrations/freezing-reacquisition', method: 'POST', scope: 'platform', effect: 'mutation',
  });
  const body = await exportedMethodBody('internal/migrations/freezing-reacquisition', 'POST');
  expect(body).toContain('getProductionFreezingReacquisitionProducer()');
  expect(body).not.toMatch(/createConfiguredSheets|request\.(json|arrayBuffer|text)/);
});

describe('tenant read route PostgreSQL authority', () => {
  it('covers every and only tenant-data read handler in the route inventory', () => {
    const inventory = TENANT_ROUTE_INVENTORY
      .filter((entry) => entry.scope === 'tenant-data' && entry.effect === 'read')
      .map((entry) => [`${entry.route.replace(/^\//, '')}`, entry.method])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`));
    const authority = READ_AUTHORITY.map(([route, method]) => [route, method] as string[])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`));
    expect(inventory).toHaveLength(39);
    expect(authority).toEqual(inventory);
  });

  it.each(READ_AUTHORITY)('%s %s resolves through %s without direct Sheets reads',
  async (route, method, configuredRoot) => {
    const body = await exportedMethodBody(route, method);
    expect(body).toContain(`${configuredRoot}(`);
    expect(body).not.toMatch(/createConfiguredSheets(?:Reader|Store)\s*\(/);
  });
});

describe('tenant mutation route PostgreSQL authority', () => {
  it.each(CONFIGURED_MUTATION_AUTHORITY)(
    '%s %s resolves through %s without direct Sheets mutation authority',
    async (route, method, configuredRoot) => {
      const body = await exportedMethodBody(route, method);
      expect(body).toContain(`${configuredRoot}(`);
      expect(body).not.toMatch(/createConfiguredSheetsStore\s*\(/);
    },
  );

  it.each(SESSION_ONLY_MUTATIONS)('%s %s only clears the session cookie through %s', async (route, method, root) => {
    const body = await exportedMethodBody(route, method);
    expect(body).toContain(`${root}(`);
    expect(body).not.toMatch(/createConfigured\w*\s*\(|request\.(json|arrayBuffer|text)/);
  });

  it.each(GOOGLE_ONLY_REFUSALS)('%s %s refuses PostgreSQL classes before reading any credential', async (route, method) => {
    const body = await exportedMethodBody(route, method);
    const postgresBranch = body.slice(0, body.indexOf("code: 'GOOGLE_LOGIN_REQUIRED'"));
    expect(body).toContain("code: 'GOOGLE_LOGIN_REQUIRED'");
    expect(postgresBranch).toContain("process.env.CLASS_STORE_STORAGE === 'postgresql'");
    expect(postgresBranch).not.toMatch(/request\.(json|arrayBuffer|text)|createConfigured\w*\s*\(/);
  });

  it('accounts for the remaining tenant mutations that retain a legacy Sheets branch', async () => {
    const configured = new Set(
      [...CONFIGURED_MUTATION_AUTHORITY, ...SESSION_ONLY_MUTATIONS, ...GOOGLE_ONLY_REFUSALS].map(([route, method]) => `${method} /${route}`),
    );
    const sheetsMutations = TENANT_ROUTE_INVENTORY.filter((entry) =>
      entry.scope === 'tenant-data'
      && entry.effect === 'mutation'
      && !configured.has(`${entry.method} ${entry.route}`));

    expect(CONFIGURED_MUTATION_AUTHORITY).toHaveLength(55);
    expect(sheetsMutations).toHaveLength(4);
    for (const entry of sheetsMutations) {
      const body = await exportedMethodBody(entry.route.replace(/^\//, ''), entry.method);
      expect(body, `${entry.method} ${entry.route}`).toMatch(/createConfiguredSheetsStore\s*\(/);
    }
  });
});
