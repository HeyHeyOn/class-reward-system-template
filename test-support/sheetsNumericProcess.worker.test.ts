// @vitest-environment node
import { expect, it, vi } from 'vitest';

// Only OAuth and Google transport are replaced. Repository, caches, queue,
// checkout planning and GoogleSheetsStore request construction are real.
const rpc = vi.hoisted(() => async (method: string, args: unknown = {}) => {
  const endpoint = process.env.D04_TRANSPORT;
  if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(endpoint)) throw Error('synthetic endpoint required');
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid: process.pid, method, args }),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
});
vi.mock('server-only', () => ({}));
vi.mock('@/server/googleOAuth', () => ({ createDeploymentSheetsAuth: async () => ({}) }));
vi.mock('googleapis', () => ({ google: { sheets: () => ({ spreadsheets: {
  get: (args: unknown) => rpc('metadata', args),
  batchUpdate: (args: unknown) => rpc('batchUpdate', args),
  values: {
    get: (args: unknown) => rpc('get', args), batchGet: (args: unknown) => rpc('batchGet', args),
    batchUpdate: (args: unknown) => rpc('valuesBatchUpdate', args), append: (args: unknown) => rpc('append', args),
  },
} }) } }));

it.skipIf(!process.env.D04_TRANSPORT)('D-04 subprocess writer', async () => {
  const repo = await import('@/server/sheetsRepository');
  const { GoogleSheetsStore } = await import('@/server/googleSheets');
  const store = new GoogleSheetsStore('D04-SYNTHETIC-NO-NETWORK');
  const operationId = process.env.D04_OPERATION ?? 'd0400000-0000-4000-8000-000000000001';
  const student = { studentId: 'S001', name: 'Synthetic student', balance: 125, status: 'ACTIVE' as const };
  const product = { productId: 'P001', name: 'Synthetic pencil', price: 10, stock: 5, isActive: true, sortOrder: 1 };
  await rpc('hello', { writer: process.env.D04_WRITER });
  const write = async () => {
    switch (process.env.D04_WRITER) {
      case 'cancel': return repo.cancelTransaction(store, 'SALE', operationId);
      case 'student-list': return repo.updateStudentDetailsBatchWithBalanceTransactions(store, [student], operationId);
      case 'product-list': return repo.updateProductDetailsBatch(store, [product], operationId);
      case 'student-single': return repo.updateStudentDetails(store, 'S001', student);
      case 'product-single': return repo.updateProductDetails(store, 'P001', product);
      case 'student-legacy-batch': return repo.updateStudentDetailsBatch(store, [student]);
      case 'adjust-add': return repo.bulkAdjustStudentBalances(store, { studentIds: ['S001'], mode: 'add', amount: 35, operationId });
      case 'adjust-set': return repo.bulkAdjustStudentBalances(store, { studentIds: ['S001'], mode: 'set', amount: 125, operationId });
      case 'checkout': {
        const { previewCheckoutCart, createSheetsCheckoutCommand } = await import('@/server/checkoutService');
        const items = [{ productId: 'P001', quantity: 1 }];
        const expectedPricing = await previewCheckoutCart(store, { items });
        if (!expectedPricing.ok) throw Error('synthetic pricing setup rejected');
        return createSheetsCheckoutCommand(store).execute({
          studentId: 'S001', items, expectedPricing, operationId, payloadHash: 'a'.repeat(64),
          transactionIdFactory: () => 'NEW-SALE',
        });
      }
      case 'raw-updateCell': return store.updateCell('Students', 2, 'balance', 125);
      case 'raw-updateCells': return store.updateCells('Products', [{ rowNumber: 2, columnName: 'stock', value: 5 }]);
      case 'raw-cross-sheet': return store.updateCellsAtomicallyAcrossSheets([
        { sheetName: 'Students', rowNumber: 2, columnNumber: 3, value: 125 },
        { sheetName: 'Products', rowNumber: 2, columnNumber: 4, value: 5 },
      ]);
      case 'raw-atomic': return store.applyAtomicMutation({
        updates: [{ sheetName: 'Students', rowNumber: 2, columnNumber: 3, value: 125 }], appends: [],
      });
      case 'raw-append': return store.appendRow('Students', ['S002', 'Synthetic new', '125', 'S002', 'ACTIVE']);
      default: throw Error('unknown synthetic writer');
    }
  };
  if (process.env.D04_EXPECT_DUPLICATE === '1') {
    await expect(write()).rejects.toThrow('duplicate named range');
  } else {
    const result = await write();
    if (result && 'ok' in result) expect(result.ok).toBe(true);
  }
  // A new request-scoped store performs actual transport reads, not cache readback.
  const cold = new GoogleSheetsStore('D04-SYNTHETIC-NO-NETWORK');
  await rpc('done', { balance: (await repo.getStudents(cold))[0].balance,
    stock: (await repo.getProducts(cold))[0].stock });
}, 30_000);
