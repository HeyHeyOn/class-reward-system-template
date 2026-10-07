// @vitest-environment node
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildProductInventoryCsv,
  PRODUCT_INVENTORY_CSV_COLUMNS,
  PRODUCT_INVENTORY_CSV_LIMITS,
  type ProductInventoryDisplayRow,
} from './productInventoryCsv';

const header = '"product_id","name","category","price","stock","is_active"\r\n';
const invalidMessage = 'Invalid product inventory display CSV input';
const row = (overrides: Partial<ProductInventoryDisplayRow> = {}): ProductInventoryDisplayRow => ({
  productId: '001', name: '연필', category: '', price: '10', stock: '20', isActive: true,
  ...overrides,
});
const build = (rows: readonly ProductInventoryDisplayRow[]) => buildProductInventoryCsv({ rows });
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

// Independent RFC-4180 reader: no production escaping/column helper is used.
// It accepts quoted AND unquoted fields, and rejects malformed/truncated records.
function parseCsv(bytes: Uint8Array): string[][] {
  const text = decode(bytes);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (state === 'quoted') {
      if (char !== '"') field += char;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else state = 'closed';
      continue;
    }
    if (char === ',') {
      record.push(field); field = ''; state = 'start';
    } else if (char === '\r' && text[i + 1] === '\n') {
      record.push(field); records.push(record);
      record = []; field = ''; state = 'start'; i++;
    } else if (char === '"' && state === 'start') {
      state = 'quoted';
    } else if (char === '"' || char === '\r' || char === '\n' || state === 'closed') {
      throw new Error('Malformed CSV fixture');
    } else {
      field += char; state = 'plain';
    }
  }
  if (state !== 'start' || field !== '' || record.length !== 0) {
    throw new Error('Truncated CSV fixture');
  }
  return records;
}

function rejects(input: unknown) {
  let caught: unknown;
  try { buildProductInventoryCsv(input); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(TypeError);
  expect((caught as Error).message).toBe(invalidMessage);
  expect((caught as Error).cause).toBeUndefined();
}

describe('product/inventory display CSV bytes', () => {
  it('checks the independent parser against literal RFC-style records and malformed bytes', () => {
    expect(parseCsv(Buffer.from('a,"b,b","c""d","x\r\ny",\r\n')))
      .toEqual([['a', 'b,b', 'c"d', 'x\r\ny', '']]);
    for (const text of ['"unclosed\r\n', 'a\nb\r\n', '"a"x\r\n', 'a,b', 'a,']) {
      expect(() => parseCsv(Buffer.from(text))).toThrow();
    }
    expect(() => parseCsv(new Uint8Array([0xc3, 0x28]))).toThrow();
  });

  it('produces a fixed schema, exact UTF-8 CSV bytes, byte length and independent SHA-256', async () => {
    const result = build([row()]);
    const expected = Buffer.from(header + '"\'001","\'연필","","\'10","\'20","\'true"\r\n', 'utf8');
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(result.bytes)).toEqual(expected);
    expect(result.byteLength).toBe(expected.byteLength);
    expect(result.byteLength).toBeGreaterThan(decode(result.bytes).length);
    expect(result.sha256).toBe(Buffer.from(await webcrypto.subtle.digest('SHA-256', expected)).toString('hex'));
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result).toEqual({
      format: 'CSV', schemaVersion: 'product-inventory-display/v1', purpose: 'DISPLAY_ONLY',
      contentType: 'text/csv; charset=utf-8; header=present', rowCount: 1,
      bytes: expected, byteLength: expected.byteLength, sha256: result.sha256,
    });
    expect(PRODUCT_INVENTORY_CSV_COLUMNS).toEqual(['product_id', 'name', 'category', 'price', 'stock', 'is_active']);
    expect(Object.isFrozen(PRODUCT_INVENTORY_CSV_COLUMNS)).toBe(true);
    expect(Object.isFrozen(PRODUCT_INVENTORY_CSV_LIMITS)).toBe(true);
    expect(parseCsv(result.bytes)).toEqual([
      ['product_id', 'name', 'category', 'price', 'stock', 'is_active'],
      ["'001", "'연필", '', "'10", "'20", "'true"],
    ]);
  });

  it('emits only the header for zero supplied rows, without inventing completeness or provenance', () => {
    const result = build([]);
    expect(decode(result.bytes)).toBe(header);
    expect(result.rowCount).toBe(0);
    expect(Object.keys(result).sort()).toEqual([
      'byteLength', 'bytes', 'contentType', 'format', 'purpose', 'rowCount', 'schemaVersion', 'sha256',
    ]);
    expect(result.bytes[0]).toBe(0x22); // no BOM, timestamp, comment, or formula directive
  });

  it('round-trips comma, quote, CR, LF, CRLF, tab and Unicode in every text column', () => {
    const text = '  =한글, "문구"\r\n줄\n다음\r끝\t😀e\u0301\u2028\u2029';
    const result = build([row({ productId: text, name: text, category: text })]);
    expect(parseCsv(result.bytes)[1]).toEqual([`'${text}`, `'${text}`, `'${text}`, "'10", "'20", "'true"]);
    expect(parseCsv(result.bytes)).toHaveLength(2);
  });

  it('retains opaque ID spelling and integer digits without number coercion or normalization', () => {
    const ids = ['001', '000000000000000000000000001', '1e12', '01/02', ' 001 ', "'001", 'é', 'e\u0301'];
    for (const productId of ids) {
      const result = build([row({ productId, price: '9007199254740993', stock: '9223372036854775807' })]);
      expect(parseCsv(result.bytes)[1]).toEqual([
        `'${productId}`, "'연필", '', "'9007199254740993", "'9223372036854775807", "'true",
      ]);
    }
    const huge = '9'.repeat(PRODUCT_INVENTORY_CSV_LIMITS.maxIntegerDigits);
    expect(parseCsv(build([row({ price: huge, stock: huge })]).bytes)[1].slice(3, 5))
      .toEqual([`'${huge}`, `'${huge}`]);
  });

  it.each([
    '=1+1', '+SUM(1,2)', '-1+2', '@SUM(1,2)', '\t=1', '\r=1', '\n=1', '  =1',
    '\u00a0=1', '\ufeff=1', '\u200b=1', '\u202e=1', '＝1+1', '＋1', '－1', '＠SUM(1,2)',
    "'=1", '\",=1\r\n=2', '=HYPERLINK("https://example.invalid","x")',
  ])('keeps formula-like text as a single prefixed display cell: %j', (text) => {
    const records = parseCsv(build([row({ productId: text, name: text, category: text })]).bytes);
    expect(records).toHaveLength(2);
    expect(records[1]).toHaveLength(6);
    expect(records[1].slice(0, 3)).toEqual([`'${text}`, `'${text}`, `'${text}`]);
    expect(records[1].every((cell) => cell.startsWith("'"))).toBe(true);
  });

  it('labels display-only transformations, not a reversible source or rollback artifact', () => {
    const nullCategory = build([row({ category: null })]);
    const emptyCategory = build([row({ category: '' })]);
    expect(nullCategory.bytes).toEqual(emptyCategory.bytes); // intentionally lossy display projection
    expect(parseCsv(build([row({ name: '=1+1' })]).bytes)[1][1]).toBe("'=1+1");
    expect(parseCsv(build([row({ name: "'=1+1" })]).bytes)[1][1]).toBe("''=1+1");
    expect(nullCategory.purpose).toBe('DISPLAY_ONLY');
  });

  it('sorts by raw opaque ID in locale-independent UTF-16 code-unit order without mutating input', () => {
    const ids = ['한', 'é', 'e\u0301', 'a', 'A', '2', '10', '001', '😀'];
    const rows = Object.freeze(ids.map((productId) => Object.freeze(row({ productId }))));
    const result = build(rows);
    expect(parseCsv(result.bytes).slice(1).map((record) => record[0]))
      .toEqual(["'001", "'10", "'2", "'A", "'a", "'e\u0301", "'é", "'한", "'😀"]);
    expect(rows.map((record) => record.productId)).toEqual(ids);
    expect(build([...rows].reverse())).toEqual(result);
    expect(build(rows)).toEqual(result);
  });

  it('includes inactive rows and zero values without silently filtering, aggregating or deduplicating', () => {
    expect(parseCsv(build([row({ isActive: false, price: '0', stock: '0' })]).bytes)[1])
      .toEqual(["'001", "'연필", '', "'0", "'0", "'false"]);
    rejects({ rows: [row(), row({ name: 'different' })] });
    rejects({ rows: [row(), row()] });
  });

  it('returns independently owned byte buffers, not a mutable shared cached artifact', () => {
    const first = build([row()]);
    const second = build([row()]);
    first.bytes.fill(0);
    expect(decode(second.bytes)).toBe(header + '"\'001","\'연필","","\'10","\'20","\'true"\r\n');
    expect(build([row()])).toEqual(second);
  });
});

describe('closed product/inventory display DTO validation', () => {
  it('rejects invalid envelope/row/array shapes and requires every field', () => {
    for (const input of [null, undefined, 1, 'rows', true, [], new Date(), {}, { rows: null }, { rows: {} }, { rows: '[]' }]) {
      rejects(input);
    }
    for (const bad of [null, undefined, 1, true, 'row', [], new Date(), new Map(), {}]) rejects({ rows: [bad] });
    for (const key of Object.keys(row())) {
      const incomplete: Record<string, unknown> = { ...row() };
      delete incomplete[key];
      rejects({ rows: [incomplete] });
    }
    rejects(Object.create({ rows: [row()] }));
    rejects({ rows: [Object.create(row())] });
    rejects({ rows: new Array(1) });
    rejects({ rows: [row(), , row({ productId: '2' })] });
    class Rows extends Array<ProductInventoryDisplayRow> {}
    rejects({ rows: new Rows(row()) });
    expect(buildProductInventoryCsv(Object.assign(Object.create(null), { rows: [Object.assign(Object.create(null), row())] })).rowCount).toBe(1);
  });

  it.each([
    'unknown', 'tenantId', 'jobId', 'snapshotAt', 'snapshotFresh', 'provenance', 'authority', 'complete',
    'password', 'secret', 'secret_hash', 'credentialHash', 'qrToken', 'accessToken', 'refreshToken',
    'redisUrl', 'recoveryCode', 'diagnostics', 'manifest', 'imageUrl', '__proto__', 'constructor', 'toJSON',
  ])('rejects unknown or sensitive keys at both levels without including them in an error: %s', (key) => {
    const canary = 'SYNTHETIC-PRIVATE-CANARY-NOT-A-REAL-SECRET';
    rejects({ rows: [row()], [key]: canary });
    rejects({ rows: [{ ...row(), [key]: canary }] });
  });

  it('rejects hidden, symbol, inherited and accessor properties without invoking getters/coercion', () => {
    let called = 0;
    const getter = () => { called++; throw new Error('SYNTHETIC-PRIVATE-CANARY'); };
    const envelope = { rows: [row()] };
    const record = row();
    for (const target of [envelope, record]) {
      const key = target === envelope ? 'rows' : 'name';
      rejects(target === envelope
        ? Object.defineProperty({ ...envelope }, key, { get: getter })
        : { rows: [Object.defineProperty({ ...record }, key, { get: getter })] });
      for (const extra of ['hiddenSecret', Symbol('secret')]) {
        const value = Object.defineProperty({ ...target }, extra, { get: getter, enumerable: false });
        rejects(target === envelope ? value : { rows: [value] });
      }
    }
    rejects({ rows: [Object.defineProperty(row(), 'name', { value: 'name', enumerable: false })] });
    rejects({ rows: [{ ...row(), name: { toString: getter, valueOf: getter, toJSON: getter } }] });
    rejects({ rows: [Object.assign(Object.create({ secret: 'synthetic' }), row())] });
    const accessorRows = [row()];
    Object.defineProperty(accessorRows, '0', { get: getter });
    rejects({ rows: accessorRows });
    rejects({ rows: Object.defineProperty([row()], Symbol('secret'), { value: 'synthetic' }) });
    rejects({ rows: Object.assign([row()], { secret: 'synthetic' }) });
    expect(called).toBe(0);
  });

  it('rejects proxies including revoked proxies without running traps', () => {
    let called = 0;
    const traps = {
      ownKeys() { called++; throw new Error('SYNTHETIC-PRIVATE-CANARY'); },
      getPrototypeOf() { called++; throw new Error('SYNTHETIC-PRIVATE-CANARY'); },
      get() { called++; throw new Error('SYNTHETIC-PRIVATE-CANARY'); },
    };
    rejects(new Proxy({ rows: [row()] }, traps));
    rejects({ rows: new Proxy([row()], traps) });
    rejects({ rows: [new Proxy(row(), traps)] });
    const revoked = Proxy.revocable({ rows: [row()] }, {});
    revoked.revoke();
    rejects(revoked.proxy);
    expect(called).toBe(0);
  });

  it('rejects non-string, empty required text, malformed UTF-16 and unsupported controls', () => {
    for (const key of ['productId', 'name', 'category']) {
      for (const bad of [0, false, [], {}, undefined, new String('text'), '\ud800', '\udfff', 'x\ud800x', '\0', '\u0001', '\u000b', '\u001f', '\u007f', '\u0085']) {
        rejects({ rows: [{ ...row(), [key]: bad }] });
      }
    }
    for (const key of ['productId', 'name']) {
      for (const bad of ['', null, ' \t\r\n']) rejects({ rows: [{ ...row(), [key]: bad }] });
    }
  });

  it('requires primitive booleans, not truthiness or string flags', () => {
    for (const bad of [0, 1, '', 'true', 'false', null, undefined, {}, [], new Boolean(true)]) {
      rejects({ rows: [{ ...row(), isActive: bad }] });
    }
  });

  it('requires canonical nonnegative decimal strings and rejects numeric precision hazards', () => {
    for (const key of ['price', 'stock']) {
      for (const bad of [0, 1, 9007199254740992, BigInt(1), NaN, Infinity, null, undefined, false, [], {}, '', '-0', '-1', '+1', '01', ' 1', '1 ', '1\n', '1.0', '1e3', '１', '١', '9'.repeat(PRODUCT_INVENTORY_CSV_LIMITS.maxIntegerDigits + 1)]) {
        rejects({ rows: [{ ...row(), [key]: bad }] });
      }
    }
  });

  it('enforces inclusive UTF-8 field bounds before escaping, not only JS character length', () => {
    const limits = PRODUCT_INVENTORY_CSV_LIMITS;
    for (const [key, max] of [
      ['productId', limits.maxProductIdBytes], ['name', limits.maxNameBytes], ['category', limits.maxCategoryBytes],
    ] as const) {
      for (const text of ['x'.repeat(max), '😀'.repeat(Math.floor(max / 4)) + 'x'.repeat(max % 4), '"'.repeat(max)]) {
        const input = { rows: [{ ...row(), [key]: text }] };
        expect(buildProductInventoryCsv(input).rowCount).toBe(1);
        rejects({ rows: [{ ...row(), [key]: text + 'x' }] });
      }
      rejects({ rows: [{ ...row(), [key]: '한'.repeat(max) }] });
    }
  });

  it('enforces a dense bounded row array and never silently truncates', () => {
    const max = PRODUCT_INVENTORY_CSV_LIMITS.maxRows;
    const rows = Array.from({ length: max }, (_, i) => row({ productId: `p${i}` }));
    expect(parseCsv(build(rows).bytes)).toHaveLength(max + 1);
    rejects({ rows: [...rows, row({ productId: 'overflow' })] });
    rejects({ rows: new Array(0xffffffff) });
  });

  it('enforces the exact total encoded byte bound including prefixes, doubled quotes and CRLF', () => {
    const limits = PRODUCT_INVENTORY_CSV_LIMITS;
    const rows = Array.from({ length: limits.maxRows }, (_, i) => ({ ...row({
      productId: `p${i}`, name: 'x', category: '', price: '0', stock: '0', isActive: false,
    }) }));
    const baseBytes = Buffer.byteLength(header + rows.map(({ productId }) =>
      `"'${productId}","'x","","'0","'0","'false"\r\n`).join(''));
    let remaining = limits.maxOutputBytes - baseBytes;
    for (const item of rows) {
      const extra = Math.min(remaining, limits.maxNameBytes - 1);
      item.name += 'x'.repeat(extra);
      remaining -= extra;
    }
    expect(remaining).toBe(0);
    const result = build(rows);
    expect(result.byteLength).toBe(limits.maxOutputBytes);
    expect(result.bytes.byteLength).toBe(limits.maxOutputBytes);
    expect(parseCsv(result.bytes)).toHaveLength(limits.maxRows + 1);
    rows[0].category = 'x'; // field still valid but escaped output exceeds cap
    rejects({ rows });
    rows[0].category = '';
    rows[0].name = '"' + rows[0].name.slice(1); // same raw byte size, one extra CSV escape byte
    rejects({ rows });
  });
});
