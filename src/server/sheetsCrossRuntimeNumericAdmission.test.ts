// @vitest-environment node
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { sheets_v4 } from 'googleapis';
import { describe, expect, it } from 'vitest';

// Characterization of OPEN risks, not a distributed-safety acceptance suite.
// A single HTTP transport owns synthetic shared rows. Two real Node processes
// run repository + GoogleSheetsStore; only the remote transport is replaced.
// This transport intentionally implements unconditional writes, never fake CAS.
const WRITERS = ['student-list', 'product-list', 'student-single', 'product-single',
  'student-legacy-batch', 'adjust-add', 'adjust-set', 'checkout'] as const;
const OP1 = 'd0400000-0000-4000-8000-000000000001';
const OP2 = 'd0400000-0000-4000-8000-000000000002';
type Event = { pid: number; method: string; phase: string; balance: number; stock: number };
type Worker = {
  child: ChildProcess; pid: number; argv: string[]; writer: string;
  exit: Promise<{ code: number | null; signal: string | null }>; output: () => string;
};
type Call = {
  pid: number; method: string;
  args: {
    spreadsheetId?: string; range?: string; ranges?: string[]; writer?: string;
    balance?: number; stock?: number;
    requestBody?: { requests?: sheets_v4.Schema$Request[];
      data?: Array<{ range: string; values: Array<Array<string | number>> }>;
      values?: string[][] };
  };
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function name(range: string) { return range.split('!')[0].replaceAll("'", ''); }
function cellValue(cell: sheets_v4.Schema$CellData) {
  const v = cell.userEnteredValue;
  return String(v?.stringValue ?? v?.numberValue ?? v?.boolValue ?? '');
}
function seed(): Record<string, string[][]> {
  return {
    Students: [['studentId', 'name', 'balance', 'qrValue', 'status'], ['S001', 'Synthetic student', '90', 'S001', 'ACTIVE']],
    Products: [['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'], ['P001', 'Synthetic pencil', '10', '2', 'TRUE', '', '', '1']],
    Transactions: [
      ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'],
      ['SALE', '2026-09-29T00:00:00.000Z', 'S001', 'Synthetic student', JSON.stringify([{ productId: 'P001', name: 'Synthetic pencil', price: 10, quantity: 1, subtotal: 10 }]), '10', '100', '90', 'COMPLETED', 'kiosk'],
    ],
    Settings: [['key', 'value']], Adjustments: [['adjustmentId']],
    Promotions: [], PromotionProducts: [],
  };
}
async function fixture() {
  const rows = seed();
  const names = Object.keys(rows);
  const claims = new Set<string>();
  const events: Event[] = [];
  const hellos = new Map<number, string>();
  const dones = new Map<number, { balance?: number; stock?: number }>();
  const numeric = (sheet: string, col: number) => (sheet === 'Students' && col === 2) || (sheet === 'Products' && col === 3);
  const state = () => ({ balance: Number(rows.Students[1][2]), stock: Number(rows.Products[1][3]) });
  const log = (call: Call, phase: string) => events.push({ pid: call.pid, method: call.method, phase, ...state() });
  let heldPid: number | undefined;
  const reached = deferred(), release = deferred();
  const valuesUpdates = (call: Call) => (call.args.requestBody?.data ?? []).map(update => {
    const match = /!([A-Z]+)(\d+)$/.exec(update.range);
    if (!match) throw Error('unsupported fake range');
    return { sheet: name(update.range), row: Number(match[2]) - 1,
      col: [...match[1]].reduce((n, char) => n * 26 + char.charCodeAt(0) - 64, 0) - 1,
      value: String(update.values[0][0]) };
  });
  async function dispatch(call: Call) {
    if (call.method === 'hello') { hellos.set(call.pid, call.args.writer!); return {}; }
    if (call.method === 'done') { dones.set(call.pid, call.args); return {}; }
    if (call.args.spreadsheetId !== 'D04-SYNTHETIC-NO-NETWORK') throw Error('non-synthetic target refused');
    log(call, 'received');
    if (call.method === 'get') return { data: { values: structuredClone(rows[name(call.args.range!)] ?? []) } };
    if (call.method === 'batchGet') return { data: { valueRanges: call.args.ranges!.map(range => ({ values: structuredClone(rows[name(range)] ?? []) })) } };
    if (call.method === 'metadata') return { data: {
      sheets: names.map((title, sheetId) => ({ properties: { title, sheetId, gridProperties: { rowCount: 1000, columnCount: 26 } } })),
      namedRanges: [...claims].map(name => ({ name })),
    } };
    const requests = call.args.requestBody?.requests ?? [];
    const writesNumeric = call.method === 'valuesBatchUpdate'
      ? valuesUpdates(call).some(u => numeric(u.sheet, u.col))
      : call.method === 'batchUpdate'
        ? requests.some(r => r.updateCells && numeric(names[r.updateCells.range!.sheetId!], r.updateCells.range!.startColumnIndex!))
        : call.method === 'append' && ['Students', 'Products'].includes(name(call.args.range!));
    if (call.pid === heldPid && writesNumeric) {
      heldPid = undefined;
      log(call, 'barrier'); reached.resolve(); await release.promise;
    }
    // Duplicate names are a bounded fake assumption, not provider certification.
    // Validate before changing any synthetic row or claim to model batch rollback.
    if (call.method === 'batchUpdate') {
      const proposed = requests.flatMap(r => r.addNamedRange?.namedRange?.name ?? []);
      if (new Set(proposed).size !== proposed.length || proposed.some(n => claims.has(n))) {
        log(call, 'duplicate-rejected'); throw Error('duplicate named range');
      }
      if (requests.some(r => !r.addNamedRange && !r.updateCells && !r.appendCells)) throw Error('unsupported fake batch request');
      proposed.forEach(n => claims.add(n));
      for (const r of requests) {
        if (r.updateCells) {
          const { range, rows: changed } = r.updateCells;
          rows[names[range!.sheetId!]][range!.startRowIndex!][range!.startColumnIndex!] = cellValue(changed![0].values![0]);
        } else if (r.appendCells) {
          rows[names[r.appendCells.sheetId!]].push(...r.appendCells.rows!.map(row => row.values!.map(cellValue)));
        }
      }
    } else if (call.method === 'valuesBatchUpdate') {
      for (const u of valuesUpdates(call)) rows[u.sheet][u.row][u.col] = u.value;
    } else if (call.method === 'append') {
      rows[name(call.args.range!)].push(...structuredClone(call.args.requestBody!.values!));
    } else throw Error('unsupported fake method');
    log(call, writesNumeric ? 'numeric-commit' : 'commit');
    return { data: {} };
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const result = await dispatch(JSON.parse(Buffer.concat(chunks).toString()));
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 409; res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: String((error as Error).message) }));
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const children: Worker[] = [];
  function launch(writer: string, options: { hold?: boolean; operationId?: string; duplicate?: boolean; frozen?: boolean } = {}): Worker {
    const argv = ['node_modules/vitest/vitest.mjs', 'run', 'test-support/sheetsNumericProcess.worker.test.ts',
      '--pool=threads', '--maxWorkers=1', '--no-file-parallelism', '--reporter=dot'];
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: 'Asia/Seoul',
        D04_TRANSPORT: endpoint, D04_WRITER: writer, D04_OPERATION: options.operationId ?? OP1,
        D04_EXPECT_DUPLICATE: options.duplicate ? '1' : '0', MIGRATION_READ_ONLY: options.frozen ? 'true' : 'false' },
    });
    if (options.hold) heldPid = child.pid;
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const exit = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const instance = { child, pid: child.pid!, argv, writer, exit, output: () => output };
    children.push(instance); return instance;
  }
  async function finished(worker: ReturnType<typeof launch>) {
    const end = await worker.exit;
    expect(end, worker.output()).toEqual({ code: 0, signal: null });
    // threads pool means the actual executing test PID must equal spawned Node PID.
    expect(hellos.get(worker.pid)).toBe(worker.writer);
    expect(dones.has(worker.pid)).toBe(true);
    return end;
  }
  function observation(label: string) {
    return { label, coordinatorPid: process.pid, ...state(),
      ledger: rows.Transactions.slice(2).map(row => [row[8], Number(row[6]), Number(row[7])]),
      claims: [...claims], events, children: children.map(c => ({ pid: c.pid, writer: c.writer, argv: c.argv,
        exit: c.child.exitCode, signal: c.child.signalCode, actualExecutionPidMatched: hellos.get(c.pid) === c.writer,
        coldReadback: dones.get(c.pid) })) };
  }
  return { rows, state, events, claims, reached, release, launch, finished, observation,
    async close() {
      release.resolve();
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await Promise.allSettled(children.map(c => c.exit));
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}

const requireAdmission = process.env.D04_REQUIRE_ADMISSION === '1';
describe.skipIf(requireAdmission)('D-04 OPEN actual two-process interleavings', () => {
  for (const cancelFirst of [true, false]) {
    it.each(WRITERS)(`retains %s counterexample/control with cancelFirst=${cancelFirst}`, async writer => {
      const f = await fixture();
      try {
        const first = f.launch(cancelFirst ? 'cancel' : writer, { hold: true });
        await Promise.race([f.reached.promise, first.exit.then(() => { throw Error('writer exited before numeric barrier: ' + first.output()); })]);
        expect(first.child.exitCode).toBeNull();
        const second = f.launch(cancelFirst ? writer : 'cancel', { operationId: OP2 });
        expect(first.pid).not.toBe(second.pid);
        await f.finished(second);
        expect(first.child.exitCode).toBeNull();
        f.release.resolve(); await f.finished(first);
        const o = f.observation(`${writer}:cancelFirst=${cancelFirst}`);
        console.info('D04_OBSERVATION', JSON.stringify(o));
        expect(o.balance).toBe(cancelFirst ? 100 : writer === 'checkout' ? 80 : writer.startsWith('product') ? 100 : 125);
        expect(o.stock).toBe(cancelFirst ? 3 : writer === 'checkout' ? 1 : writer.startsWith('product') ? 5 : 3);
        if (writer === 'student-list' || writer.startsWith('adjust')) expect(o.ledger).toEqual(expect.arrayContaining([
          ['ADMIN_ADJUSTMENT', 90, 125], ['CANCEL_REVERSAL', 90, 100],
        ]));
        if (writer === 'checkout') expect(o.ledger).toEqual(expect.arrayContaining([
          ['COMPLETED', 90, 80], ['CANCEL_REVERSAL', 90, 100],
        ]));
        const barrierIndex = f.events.findIndex(e => e.phase === 'barrier');
        const secondCommit = f.events.findIndex(e => e.pid === second.pid && e.phase === 'numeric-commit');
        const firstCommit = f.events.findIndex(e => e.pid === first.pid && e.phase === 'numeric-commit');
        expect(secondCommit).toBeGreaterThan(barrierIndex); expect(firstCommit).toBeGreaterThan(secondCommit);
      } finally { await f.close(); }
    }, 45_000);
  }
  for (const cancelFirst of [true, false]) {
    it.each(['student-list', 'product-list', 'checkout'])(`serial %s preserves normal behavior cancelFirst=${cancelFirst}`, async writer => {
      const f = await fixture();
      try {
        await f.finished(f.launch(cancelFirst ? 'cancel' : writer));
        await f.finished(f.launch(cancelFirst ? writer : 'cancel', { operationId: OP2 }));
        const o = f.observation(`serial:${writer}:cancelFirst=${cancelFirst}`);
        console.info('D04_OBSERVATION', JSON.stringify(o));
        expect(f.state()).toEqual(writer === 'checkout' ? { balance: 90, stock: 2 }
          : writer === 'product-list' ? { balance: 100, stock: cancelFirst ? 5 : 6 }
            : { balance: cancelFirst ? 125 : 135, stock: 3 });
      } finally { await f.close(); }
    }, 45_000);
  }
  it.each([false, true])('operationId duplicate=%s is not cross-operation CAS', async duplicate => {
    const f = await fixture();
    try {
      const first = f.launch('student-list', { hold: true, duplicate });
      await Promise.race([f.reached.promise, first.exit.then(() => { throw Error(first.output()); })]);
      const second = f.launch('student-list', { operationId: duplicate ? OP1 : OP2 });
      await f.finished(second); f.release.resolve(); await f.finished(first);
      const o = f.observation(`claims:duplicate=${duplicate}`);
      console.info('D04_OBSERVATION', JSON.stringify(o));
      expect(f.claims.size).toBe(duplicate ? 1 : 2);
      expect(o.ledger).toEqual(Array.from({ length: duplicate ? 1 : 2 }, () => ['ADMIN_ADJUSTMENT', 90, 125]));
      expect(f.events.filter(e => e.phase === 'numeric-commit')).toHaveLength(duplicate ? 1 : 2);
    } finally { await f.close(); }
  }, 45_000);
});

describe('D-04 missing common numeric admission boundary', () => {
  it.each(['raw-updateCell', 'raw-updateCells', 'raw-cross-sheet', 'raw-atomic', 'raw-append'])(
    'unguarded %s reaches transport even with route-only freeze enabled', async writer => {
      const f = await fixture();
      try {
        await f.finished(f.launch(writer, { frozen: true }));
        const o = f.observation(`unguarded:${writer}`);
        console.info('D04_OBSERVATION', JSON.stringify(o));
        const commits = f.events.filter(e => e.phase === 'numeric-commit');
        // Opt-in RED is the desired but NOT IMPLEMENTED admission contract.
        // Default passes characterize the defect; they must not be called a fix.
        expect(commits).toHaveLength(requireAdmission ? 0 : 1);
      } finally { await f.close(); }
    }, 30_000,
  );
});
