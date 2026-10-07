// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import type { GoogleSheetsStore } from './googleSheets';

// Real repository + real GoogleSheetsStore. Only OAuth and the remote transport
// are replaced. This fake implements unconditional writes, NOT an invented CAS.
const transport = vi.hoisted(() => ({
  get: vi.fn(), batchGet: vi.fn(), metadata: vi.fn(), batchUpdate: vi.fn(),
  valuesBatchUpdate: vi.fn(), append: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/server/googleOAuth', () => ({ createDeploymentSheetsAuth: async () => ({}) }));
vi.mock('googleapis', () => ({ google: { sheets: () => ({ spreadsheets: {
  get: transport.metadata, batchUpdate: transport.batchUpdate,
  values: { get: transport.get, batchGet: transport.batchGet,
    batchUpdate: transport.valuesBatchUpdate, append: transport.append },
} }) } }));

type Repository = typeof import('./sheetsRepository');
type Request = sheets_v4.Schema$Request;
const OP = 'd0300000-0000-4000-8000-000000000001';
const CANCEL_OP = 'd0300000-0000-4000-8000-000000000002';
let rows: Record<string, string[][]>;
let names: string[];
let claims: Set<string>;
let trace: string[];
let beforeCommit: (() => Promise<void>) | undefined;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function barrier() {
  const reached = deferred();
  const release = deferred();
  beforeCommit = async () => { reached.resolve(); await release.promise; };
  return { reached: reached.promise, release: release.resolve };
}
async function atCommit() {
  const hook = beforeCommit;
  beforeCommit = undefined;
  await hook?.();
}
function sheetName(range: string) { return range.split('!')[0].replaceAll("'", ''); }
function value(cell: sheets_v4.Schema$CellData) {
  const entered = cell.userEnteredValue;
  return String(entered?.stringValue ?? entered?.numberValue ?? entered?.boolValue ?? '');
}
function applyRequests(requests: Request[]) {
  const proposed = requests.flatMap((request) => request.addNamedRange?.namedRange?.name ?? []);
  if (new Set(proposed).size !== proposed.length || proposed.some((name) => claims.has(name))) {
    throw Error('duplicate named range; entire fake batch rejected');
  }
  proposed.forEach((name) => claims.add(name));
  for (const request of requests) {
    if (request.updateCells) {
      const { range, rows: changed } = request.updateCells;
      rows[names[range!.sheetId!]][range!.startRowIndex!][range!.startColumnIndex!] = value(changed![0].values![0]);
    } else if (request.appendCells) {
      rows[names[request.appendCells.sheetId!]].push(...request.appendCells.rows!.map((row) => row.values!.map(value)));
    } else if (!request.addNamedRange) throw Error('unsupported fake request');
  }
  trace.push(`commit:${rows.Students[1][2]}/${rows.Products[1][3]}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    Students: [['studentId', 'name', 'balance', 'qrValue', 'status'], ['S001', 'Synthetic student', '90', 'S001', 'ACTIVE']],
    Products: [['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'], ['P001', 'Synthetic pencil', '10', '2', 'TRUE', '', '', '1']],
    Transactions: [
      ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
      ['SALE', '2026-09-29T00:00:00.000Z', 'S001', 'Synthetic student', JSON.stringify([{ productId: 'P001', name: 'Synthetic pencil', price: 10, quantity: 1, subtotal: 10 }]), '10', '100', '90', 'COMPLETED', 'kiosk'],
    ],
    Settings: [['key', 'value']], Adjustments: [['adjustmentId']],
  };
  names = Object.keys(rows); claims = new Set(); trace = []; beforeCommit = undefined;
  transport.get.mockImplementation(async ({ range }: { range: string }) => {
    const name = sheetName(range); trace.push(`read:${name}`);
    return { data: { values: structuredClone(rows[name] ?? []) } };
  });
  transport.batchGet.mockImplementation(async ({ ranges }: { ranges: string[] }) => {
    trace.push(`batchRead:${ranges.map(sheetName).join(',')}`);
    return { data: { valueRanges: ranges.map((range) => ({ values: structuredClone(rows[sheetName(range)] ?? []) })) } };
  });
  transport.metadata.mockImplementation(async () => ({ data: { sheets: names.map((title, sheetId) => ({
    properties: { title, sheetId, gridProperties: { rowCount: 1000, columnCount: 26 } },
  })), namedRanges: [...claims].map((name) => ({ name })) } }));
  transport.batchUpdate.mockImplementation(async ({ requestBody }: { requestBody: { requests: Request[] } }) => {
    await atCommit(); applyRequests(requestBody.requests); return { data: {} };
  });
  transport.valuesBatchUpdate.mockImplementation(async ({ requestBody }: {
    requestBody: { data: Array<{ range: string; values: Array<Array<string | number>> }> };
  }) => {
    await atCommit();
    for (const update of requestBody.data) {
      const match = /!([A-Z]+)(\d+)$/.exec(update.range)!;
      const column = [...match[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0);
      rows[sheetName(update.range)][Number(match[2]) - 1][column - 1] = String(update.values[0][0]);
    }
    trace.push(`commit:${rows.Students[1][2]}/${rows.Products[1][3]}`);
    return { data: {} };
  });
  transport.append.mockImplementation(async ({ range, requestBody }: { range: string; requestBody: { values: string[][] } }) => {
    await atCommit(); rows[sheetName(range)].push(...structuredClone(requestBody.values)); return { data: {} };
  });
});

async function runtime() {
  const repo = await import('./sheetsRepository');
  const { GoogleSheetsStore } = await import('./googleSheets');
  return { repo, store: new GoogleSheetsStore('D03-SYNTHETIC-NO-NETWORK') };
}
const writers = ['student-list', 'product-list', 'student-single', 'product-single', 'student-legacy-batch', 'adjust-add', 'adjust-set'] as const;
type Writer = typeof writers[number];
function edit(repo: Repository, store: GoogleSheetsStore, writer: Writer) {
  const student = { studentId: 'S001', name: 'Synthetic student', balance: 125, status: 'ACTIVE' as const };
  const product = { productId: 'P001', name: 'Synthetic pencil', price: 10, stock: 5, isActive: true, sortOrder: 1 };
  switch (writer) {
    case 'student-list': return repo.updateStudentDetailsBatchWithBalanceTransactions(store, [student], OP);
    case 'product-list': return repo.updateProductDetailsBatch(store, [product], OP);
    case 'student-single': return repo.updateStudentDetails(store, 'S001', student);
    case 'product-single': return repo.updateProductDetails(store, 'P001', product);
    case 'student-legacy-batch': return repo.updateStudentDetailsBatch(store, [student]);
    case 'adjust-add': return repo.bulkAdjustStudentBalances(store, { studentIds: ['S001'], mode: 'add', amount: 35, operationId: OP });
    case 'adjust-set': return repo.bulkAdjustStudentBalances(store, { studentIds: ['S001'], mode: 'set', amount: 125, operationId: OP });
  }
}
async function snapshot() {
  const { repo, store } = await runtime(); // independent, cold provider reader
  return { balance: (await repo.getStudents(store))[0].balance, stock: (await repo.getProducts(store))[0].stock,
    transactions: await repo.getTransactions(store) };
}
function ledger(snapshotValue: Awaited<ReturnType<typeof snapshot>>) {
  return snapshotValue.transactions.filter((entry) => entry.transactionId !== 'SALE')
    .map((entry) => [entry.status, entry.balanceBefore, entry.balanceAfter]);
}

// Separate Vitest module graphs have genuinely distinct taskCommandQueue maps.
// They model independent server instances, NOT OS processes or cloud deployment.
describe('D-03 OPEN independent-runtime Sheets numeric race', () => {
  it.each(['student-list', 'product-list', 'adjust-add', 'adjust-set'] as const)(
    'retains counterexample: cancellation read then %s commits before cancellation write', async (writer) => {
      vi.resetModules(); const cancellation = await runtime();
      vi.resetModules(); const editor = await runtime();
      const gate = barrier();
      const cancelling = cancellation.repo.cancelTransaction(cancellation.store, 'SALE', CANCEL_OP);
      try {
        await gate.reached;
        await edit(editor.repo, editor.store, writer);
      } finally { gate.release(); }
      await cancelling;
      const observed = await snapshot();
      expect(observed.balance).toBe(100); expect(observed.stock).toBe(3);
      if (writer !== 'product-list') expect(ledger(observed)).toEqual(expect.arrayContaining([
        ['ADMIN_ADJUSTMENT', 90, 125], ['CANCEL_REVERSAL', 90, 100],
      ]));
      console.info('D03_OPEN_CANCEL_LAST', JSON.stringify({ writer, balance: observed.balance, stock: observed.stock, ledger: ledger(observed), trace }));
    },
  );
  it.each(['student-list', 'product-list', 'adjust-add', 'adjust-set'] as const)(
    'records editor-last ordering: %s read then cancellation commits before editor write', async (writer) => {
      vi.resetModules(); const editor = await runtime();
      vi.resetModules(); const cancellation = await runtime();
      const gate = barrier();
      const editing = edit(editor.repo, editor.store, writer);
      try { await gate.reached; await cancellation.repo.cancelTransaction(cancellation.store, 'SALE', CANCEL_OP); }
      finally { gate.release(); }
      await editing;
      const observed = await snapshot();
      expect(observed.balance).toBe(writer === 'product-list' ? 100 : 125);
      expect(observed.stock).toBe(writer === 'product-list' ? 5 : 3);
      // Explicit stock=5 after a cancellation is a valid last-set result by
      // itself. The balance ledger (and add=35) expose the stale read here;
      // cancellation-last above is the stock lost-update counterexample.
      if (writer !== 'product-list') expect(ledger(observed)).toEqual(expect.arrayContaining([
        ['ADMIN_ADJUSTMENT', 90, 125], ['CANCEL_REVERSAL', 90, 100],
      ]));
      console.info('D03_OPEN_EDITOR_LAST', JSON.stringify({ writer, balance: observed.balance, stock: observed.stock, ledger: ledger(observed), trace }));
    },
  );
  it('distinct student-list operation claims both commit but do not serialize their adjustment bases', async () => {
    vi.resetModules(); const first = await runtime();
    vi.resetModules(); const second = await runtime();
    const gate = barrier();
    const writing = edit(first.repo, first.store, 'student-list');
    try {
      await gate.reached;
      await second.repo.updateStudentDetailsBatchWithBalanceTransactions(second.store,
        [{ studentId: 'S001', name: 'Synthetic student', balance: 150, status: 'ACTIVE' }], CANCEL_OP);
    } finally { gate.release(); }
    await writing;
    expect(claims.size).toBe(2);
    const observed = await snapshot();
    expect(observed.balance).toBe(125);
    expect(ledger(observed)).toEqual(expect.arrayContaining([
      ['ADMIN_ADJUSTMENT', 90, 150], ['ADMIN_ADJUSTMENT', 90, 125],
    ]));
    console.info('D03_DISTINCT_CLAIMS_NOT_CAS', JSON.stringify({ claims: [...claims], ledger: ledger(observed) }));
  });
  it('the fake rejects a duplicate claim atomically, not a different operation writing the same cell', async () => {
    vi.resetModules(); const first = await runtime();
    vi.resetModules(); const second = await runtime();
    const gate = barrier();
    const writing = edit(first.repo, first.store, 'student-list');
    const rejection = expect(writing).rejects.toThrow('duplicate named range');
    try { await gate.reached; await edit(second.repo, second.store, 'student-list'); }
    finally { gate.release(); }
    await rejection;
    expect(claims.size).toBe(1);
    expect(ledger(await snapshot())).toEqual([['ADMIN_ADJUSTMENT', 90, 125]]);
  });
});

describe('D-03 bounded same-runtime serialization', () => {
  it.each(writers)('queues %s after cancellation and refreshes a prewarmed store', async (writer) => {
    vi.resetModules(); const cancellation = await runtime(); const editor = await runtime();
    await editor.store.primeRows(['Students', 'Products', 'Transactions', 'Settings']);
    const gate = barrier();
    const cancelling = cancellation.repo.cancelTransaction(cancellation.store, 'SALE', CANCEL_OP);
    let editing: ReturnType<typeof edit> | undefined;
    let traceBeforeRelease: string[] = [];
    try {
      await gate.reached;
      traceBeforeRelease = [...trace];
      editing = edit(editor.repo, editor.store, writer);
      // A finite event-loop turn is enough for the in-memory transport; no sleeps
      // choose the commit order. The explicit barrier controls that order.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect.soft(trace).toEqual(traceBeforeRelease);
    } finally { gate.release(); }
    await Promise.all([cancelling, editing]);
    const observed = await snapshot();
    const productWriter = writer.startsWith('product');
    expect(observed.balance).toBe(productWriter ? 100 : writer === 'adjust-add' ? 135 : 125);
    expect(observed.stock).toBe(productWriter ? 5 : 3);
    if (writer === 'student-list' || writer.startsWith('adjust')) {
      expect(ledger(observed)).toEqual(expect.arrayContaining([
        ['ADMIN_ADJUSTMENT', 100, writer === 'adjust-add' ? 135 : 125], ['CANCEL_REVERSAL', 90, 100],
      ]));
    }
  });
  it.each(writers)('queues cancellation after %s without losing the edit', async (writer) => {
    vi.resetModules(); const editor = await runtime(); const cancellation = await runtime();
    await cancellation.store.primeRows(['Students', 'Products', 'Transactions']);
    const gate = barrier();
    const editing = edit(editor.repo, editor.store, writer);
    let cancelling: ReturnType<Repository['cancelTransaction']> | undefined;
    try {
      await gate.reached;
      const traceBefore = [...trace];
      cancelling = cancellation.repo.cancelTransaction(cancellation.store, 'SALE', CANCEL_OP);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect.soft(trace).toEqual(traceBefore);
    } finally { gate.release(); }
    await Promise.all([editing, cancelling]);
    const observed = await snapshot();
    expect(observed.balance).toBe(writer.startsWith('product') ? 100 : 135);
    expect(observed.stock).toBe(writer.startsWith('product') ? 6 : 3);
  });
  it.each(writers)('fails closed on a %s fresh-read failure and releases the local queue', async (writer) => {
    vi.resetModules(); const editor = await runtime();
    await editor.store.primeRows(['Students', 'Products', 'Transactions', 'Settings']);
    transport.get.mockRejectedValueOnce(Error('D03 fresh read refused'));
    const before = structuredClone(rows);
    await expect(edit(editor.repo, editor.store, writer)).rejects.toThrow('D03 fresh read refused');
    expect(rows).toEqual(before);
    expect(transport.batchUpdate).not.toHaveBeenCalled();
    expect(transport.valuesBatchUpdate).not.toHaveBeenCalled();
    const cancellation = await runtime();
    await cancellation.repo.cancelTransaction(cancellation.store, 'SALE', CANCEL_OP);
    expect(await snapshot()).toMatchObject({ balance: 100, stock: 3 });
  });
});
