import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { types } from 'node:util';

/**
 * A deliberately small DISPLAY DTO, not a DB row, inventory ledger, or backup.
 * The caller must supply already-authorized, single-tenant product display data.
 * No source/tenant lookup, permission check, snapshot, freshness, provenance,
 * operational authority, or completeness is inferred by this formatter.
 *
 * IDs are opaque text: never trimmed, normalized, parsed as numbers or URLs.
 * Price/stock are canonical nonnegative decimal STRINGS, never JS numbers.
 * Their serialization bounds are not a claim that a DB accepts the same range.
 * category is required; null and empty string both display as an empty cell.
 * No optional keys, URLs, credential fields, diagnostics or raw source payloads.
 * The allowlist is not DLP: an approved text field containing a secret would
 * still be exported. The upstream reader must not put sensitive values in it.
 */
export type ProductInventoryDisplayRow = Readonly<{
  productId: string;
  name: string;
  category: string | null;
  price: string;
  stock: string;
  isActive: boolean;
}>;

export type ProductInventoryDisplayDto = Readonly<{
  rows: readonly ProductInventoryDisplayRow[];
}>;

export const PRODUCT_INVENTORY_CSV_COLUMNS = Object.freeze([
  'product_id', 'name', 'category', 'price', 'stock', 'is_active',
] as const);

/** Inclusive limits; invalid/oversize input throws, never truncates or pages. */
export const PRODUCT_INVENTORY_CSV_LIMITS = Object.freeze({
  maxRows: 10_000,
  maxProductIdBytes: 256,
  maxNameBytes: 4_096,
  maxCategoryBytes: 256,
  maxIntegerDigits: 128,
  maxOutputBytes: 8 * 1024 * 1024,
});

export type ProductInventoryCsv = Readonly<{
  format: 'CSV';
  schemaVersion: 'product-inventory-display/v1';
  purpose: 'DISPLAY_ONLY';
  contentType: 'text/csv; charset=utf-8; header=present';
  /** Number of supplied rows actually serialized, NOT a source total. */
  rowCount: number;
  /** Fresh caller-owned bytes. Mutating them invalidates byteLength/sha256. */
  bytes: Uint8Array;
  byteLength: number;
  /** Lowercase SHA-256 of exactly bytes, integrity only, NOT authentication. */
  sha256: string;
}>;

const ROW_KEYS = ['productId', 'name', 'category', 'price', 'stock', 'isActive'] as const;
const HEADER = PRODUCT_INVENTORY_CSV_COLUMNS.map((column) => `"${column}"`).join(',') + '\r\n';
const LIMITS = PRODUCT_INVENTORY_CSV_LIMITS;

function invalid(): never {
  // Never interpolate field names, values, identifiers or caller exceptions.
  throw new TypeError('Invalid product inventory display CSV input');
}

function closedRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function closedRows(value: unknown): unknown[] {
  // Reject proxies before introspection, including revoked proxies. Accessors,
  // custom prototypes, holes and even non-enumerable/symbol extras are not DTOs.
  if (value === null || typeof value !== 'object' || types.isProxy(value)) invalid();
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  if (value.length > LIMITS.maxRows) invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid(); // indices + length
  const rows: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    rows.push(descriptor.value);
  }
  return rows;
}

function text(value: unknown, maxBytes: number, allowBlank: boolean): string {
  // The cheap code-unit bound precedes encoding/scanning oversized strings.
  if (typeof value !== 'string' || value.length > maxBytes) invalid();
  if (!allowBlank && value.trim().length === 0) invalid();
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    // Keep CSV's embedded tab/CR/LF, reject other C0 controls plus DEL/C1.
    if ((unit < 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d)
      || (unit >= 0x7f && unit <= 0x9f)) invalid();
    // Buffer UTF-8 encoding replaces lone surrogates: reject rather than lose ID/data.
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) invalid();
  return value;
}

function decimal(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > LIMITS.maxIntegerDigits
    || /[^0-9]/.test(value) || (value.length > 1 && value[0] === '0')) invalid();
  return value;
}

function displayCell(value: string): string {
  // Quote ALL cells and prefix ALL nonempty data with an ASCII apostrophe.
  // Quoting alone does NOT stop spreadsheet formula evaluation or precision loss.
  // Unconditional prefixing also covers leading whitespace/control/Unicode signs,
  // numeric-looking IDs and literal leading apostrophes, with no heuristic trimming.
  const display = value === '' ? '' : `'${value}`;
  return `"${display.replace(/"/g, '""')}"`;
}

/**
 * Pure, synchronous Node formatter. No I/O, environment, clock, randomness,
 * migration imports or external authority. Runtime validation accepts unknown
 * to enforce the closed DTO even when called from untyped JavaScript.
 *
 * v1 wire contract: UTF-8 without BOM, comma separator, double-quoted header and
 * cells, doubled embedded quotes, CRLF records (including final CRLF), original
 * embedded CR/LF and Unicode preserved. Rows sort ascending by raw productId
 * using JS UTF-16 code-unit comparison, NOT locale/numeric order. Duplicate IDs
 * are rejected instead of silently merged. Inactive rows are not filtered.
 *
 * DISPLAY SAFETY IS NOT REVERSIBILITY: nonempty cells have a literal leading
 * apostrophe and null/empty categories collapse. CSV has no native cell types;
 * consumers must import as text and retain this protection, not strip prefixes
 * and re-save/re-open as executable cells. Not a guarantee about all spreadsheet
 * importers/settings. No spreadsheet formula wrappers such as ="..." are used.
 * This is not a canonical source artifact, Sheets restore format, retained
 * backup, delta export or rollback representation. Digest equality cannot prove
 * authentic origin, authorization, freshness, complete data, or recovery.
 */
export function buildProductInventoryCsv(input: unknown): ProductInventoryCsv {
  const envelope = closedRecord(input, ['rows']);
  const inputRows = closedRows(envelope.rows);
  const seen = new Set<string>();
  const records: { productId: string; line: string }[] = [];
  let byteLength = Buffer.byteLength(HEADER, 'utf8');
  for (const inputRow of inputRows) {
    const source = closedRecord(inputRow, ROW_KEYS);
    const productId = text(source.productId, LIMITS.maxProductIdBytes, false);
    const name = text(source.name, LIMITS.maxNameBytes, false);
    const category = source.category === null ? '' : text(source.category, LIMITS.maxCategoryBytes, true);
    const price = decimal(source.price);
    const stock = decimal(source.stock);
    if (typeof source.isActive !== 'boolean' || seen.has(productId)) invalid();
    seen.add(productId);
    const line = [productId, name, category, price, stock, source.isActive ? 'true' : 'false']
      .map(displayCell).join(',') + '\r\n';
    byteLength += Buffer.byteLength(line, 'utf8');
    if (byteLength > LIMITS.maxOutputBytes) invalid();
    records.push({ productId, line });
  }
  records.sort((a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0);
  const bytes = Buffer.from(HEADER + records.map((record) => record.line).join(''), 'utf8');
  return {
    format: 'CSV',
    schemaVersion: 'product-inventory-display/v1',
    purpose: 'DISPLAY_ONLY',
    contentType: 'text/csv; charset=utf-8; header=present',
    rowCount: records.length,
    bytes,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
