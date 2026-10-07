import { BudgetExceededError, BudgetUnavailableError, type BudgetContext, stableBudgetSort, trimBudgetString, utf8ByteLength } from './boundedWork';

/** Dependency-free lexical admission and opt-in immutable registered graph
 * serialization/clone-freeze foundation. This does NOT bound the normalizer:
 * only fixed artifact projections are registered here; normalizer/parser/output
 * factory schemas and complete callgraph wiring remain.
 */
class InvalidBoundedJsonError extends Error {
  constructor() { super('Legacy bounded JSON is invalid.'); this.name = 'InvalidBoundedJsonError'; }
}
const invalid = (): never => { throw new InvalidBoundedJsonError(); };
const MAX_TEXT_BYTES = 8_000_000;
const MAX_CONTENT_BYTES = 4_000_000;
const MAX_STRUCTURE_BYTES = 4_000_000;
const MAX_NODES = 300_000;
const STACK_DEPTH = 64;

/** A scanner-owned admission is never accepted from caller JSON. Its counters
 * include duplicate property occurrences, even though JSON.parse keeps the last.
 */
function admit(text: string, budget: BudgetContext) {
  budget.check();
  if (utf8ByteLength(text, budget) > MAX_TEXT_BYTES) throw new BudgetExceededError();
  // Fixed-depth scratch: two arrays, 128 conservative scalar occurrences/slots.
  budget.reserve({ nodes: 130, slots: 128, structuralBytes: 1_056 });
  const states = new Array<number>(STACK_DEPTH), arities = new Array<number>(STACK_DEPTH);
  let depth = 0, index = 0, chargedThrough = 0, nodes = 0, slots = 0;
  let contentBytes = 0, structuralBytes = 0, maxArity = 0, complete = false;
  function code(at = index): number {
    if (at >= text.length) return -1;
    if (at >= chargedThrough) { budget.spend(); chargedThrough += 256; }
    return text.charCodeAt(at);
  }
  function bounds(): void {
    if (nodes > MAX_NODES || contentBytes > MAX_CONTENT_BYTES || structuralBytes > MAX_STRUCTURE_BYTES) {
      throw new BudgetExceededError();
    }
  }
  function whitespace(): void {
    while (index < text.length) {
      const next = code();
      if (next !== 32 && next !== 9 && next !== 10 && next !== 13) return;
      index++;
    }
  }
  function hex(): number {
    const next = code(); index++;
    if (next >= 48 && next <= 57) return next - 48;
    if (next >= 65 && next <= 70) return next - 55;
    if (next >= 97 && next <= 102) return next - 87;
    return invalid();
  }
  function stringBytes(): number {
    budget.spend(); // next string token, before scanning any of its contents
    if (code() !== 34) return invalid();
    index++;
    let bytes = 0, pendingHigh = false;
    while (index < text.length) {
      let next = code(); index++;
      if (next === 34) {
        const result = bytes + (pendingHigh ? 3 : 0);
        if (result > budget.limits.stringBytes) throw new BudgetExceededError();
        return result;
      }
      if (next < 32) return invalid();
      if (next === 92) {
        next = code(); index++;
        if (next === 117) {
          next = hex() * 4096 + hex() * 256 + hex() * 16 + hex();
        } else if (next === 98) next = 8;
        else if (next === 102) next = 12;
        else if (next === 110) next = 10;
        else if (next === 114) next = 13;
        else if (next === 116) next = 9;
        else if (next !== 34 && next !== 47 && next !== 92) return invalid();
      }
      if (pendingHigh) {
        pendingHigh = false;
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; continue; }
        bytes += 3;
      }
      if (next >= 0xd800 && next <= 0xdbff) pendingHigh = true;
      else bytes += next < 128 ? 1 : next < 2048 ? 2 : 3;
    }
    return invalid();
  }
  function literal(expected: string): void {
    // expected is a constant, not a text-derived substring.
    for (let i = 0; i < expected.length; i++) {
      if (code() !== expected.charCodeAt(i)) return invalid();
      index++;
    }
  }
  function digit(): boolean { const next = code(); return next >= 48 && next <= 57; }
  function number(): void {
    if (code() === 45) index++;
    if (code() === 48) index++;
    else {
      if (!digit()) return invalid();
      while (digit()) index++;
    }
    if (code() === 46) {
      index++; if (!digit()) return invalid();
      while (digit()) index++;
    }
    if (code() === 101 || code() === 69) {
      index++; if (code() === 43 || code() === 45) index++;
      if (!digit()) return invalid();
      while (digit()) index++;
    }
  }
  function childSlot(): void {
    budget.spend();
    slots++; arities[depth - 1]++;
    if (arities[depth - 1] > maxArity) maxArity = arities[depth - 1];
    structuralBytes += 4;
    bounds();
  }
  function value(): void {
    budget.spend();
    budget.checkDepth(depth + 1);
    nodes++;
    const next = code();
    if (next === 123 || next === 91) {
      structuralBytes += 16; bounds();
      if (depth >= STACK_DEPTH) throw new BudgetExceededError();
      // 0: initial object key/end; 5: initial array value/end.
      states[depth] = next === 123 ? 0 : 5; arities[depth] = 0;
      depth++; index++;
    } else {
      structuralBytes += 4; bounds();
      if (next === 34) contentBytes += stringBytes();
      else if (next === 116) literal('true');
      else if (next === 102) literal('false');
      else if (next === 110) literal('null');
      else if (next === 45 || (next >= 48 && next <= 57)) number();
      else return invalid();
      bounds();
    }
  }
  // Iterative grammar states ensure commas/colons/trailing data are validated
  // before native parsing; neither substrings nor token arrays are produced.
  while (true) {
    budget.spend(); whitespace();
    if (depth === 0) {
      if (complete) { if (index !== text.length) return invalid(); break; }
      complete = true; value(); continue;
    }
    const state = states[depth - 1], next = code();
    budget.spend();
    if (state === 0 || state === 1) {
      if (state === 0 && next === 125) { index++; depth--; continue; }
      if (next !== 34) return invalid();
      const bytes = stringBytes();
      childSlot(); structuralBytes += bytes; bounds();
      states[depth - 1] = 2;
    } else if (state === 2) {
      if (next !== 58) return invalid();
      index++; states[depth - 1] = 3;
    } else if (state === 3) {
      states[depth - 1] = 4; value();
    } else if (state === 4) {
      if (next === 125) { index++; depth--; }
      else if (next === 44) { index++; states[depth - 1] = 1; }
      else return invalid();
    } else if (state === 5 || state === 6) {
      if (state === 5 && next === 93) { index++; depth--; continue; }
      childSlot(); states[depth - 1] = 7; value();
    } else {
      if (next === 93) { index++; depth--; }
      else if (next === 44) { index++; states[depth - 1] = 6; }
      else return invalid();
    }
  }
  // The admission record is fixed-size counter metadata, not an input graph.
  return { text, nodes, slots, contentBytes, structuralBytes, maxArity };
}

/** Parse only after grammar, per-document limits, cumulative graph reservation,
 * and native parse work have all succeeded. This does not validate business
 * shape, poison keys, finite numbers, authenticity, or normalize any value.
 */
export function parseBoundedJson(text: string, budget: BudgetContext): unknown {
  const ticket = admit(text, budget);
  budget.reserve({ nodes: ticket.nodes, slots: ticket.slots,
    contentBytes: ticket.contentBytes, structuralBytes: ticket.structuralBytes });
  budget.spend(Math.ceil(ticket.text.length / 256));
  let value: unknown;
  try { value = JSON.parse(ticket.text); }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check();
    throw new InvalidBoundedJsonError();
  }
  // Native JSON.parse cannot be interrupted; a late result is discarded here.
  budget.check();
  return value;
}

/** Native header Maps stay mutable, but only this closed constructor grants
 * request ownership. Ownership is NOT an immutable shape certificate: consumers
 * measure the current native size and validate each current primitive entry.
 * In particular Map.prototype.set cannot forge an immutable JSON certificate. */
const sheetHeaders = new WeakMap<Map<string, number>, BudgetContext>();
// Fixed native method metadata is captured at module initialization, not allocated
// from a request-derived graph or used as a caller-supplied arity certificate.
const sheetHeaderSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size')!.get!;
export function createBoundedSheetsHeaderIndex(headers: string[], budget: BudgetContext): Map<string, number> {
  if (headers !== null && (typeof headers === 'object' || typeof headers === 'function')) registeredBoundedKeys(headers, budget);
  budget.reserve({ nodes: 1, slots: 2, structuralBytes: 24 });
  budget.spend(2);
  const index = new Map<string, number>();
  sheetHeaders.set(index, budget);
  budget.spend();
  headers.forEach((header, position) => {
    budget.spend();
    // Keep the original native error expression on malformed admitted cells.
    const normalized = typeof header === 'string' ? trimBudgetString(header, budget) : (header as string).trim();
    budget.spend(2 + 2 * Math.ceil(normalized.length / 256));
    const duplicate = Map.prototype.has.call(index, normalized);
    if (!duplicate) budget.reserve({ nodes: 1, slots: 2, structuralBytes: 12 });
    budget.spend(); Map.prototype.set.call(index, normalized, duplicate ? -1 : position);
    budget.check();
  });
  budget.check(); return index;
}
export function assertBoundedSheetsHeaderIndex(index: Map<string, number>, budget: BudgetContext): void {
  budget.spend();
  if (sheetHeaders.get(index) !== budget) return invalid();
}
/** String conversion of decoder-owned JSON, including every nested native join
 * intermediate. No arbitrary object factory or caller-supplied shape is trusted. */
export function stringBoundedJson(value: unknown, budget: BudgetContext): string {
  function size(input: unknown, depth: number, arrayElement: boolean): number {
    budget.checkDepth(depth); budget.spend();
    if (typeof input === 'string') return utf8ByteLength(input, budget);
    if (input === null || input === undefined) return arrayElement ? 0 : 9;
    if (typeof input !== 'object') { if (typeof input !== 'number' && typeof input !== 'boolean') return invalid(); return 32; }
    const shape = shapeOf(input, budget);
    if (!shape.array) return 15;
    const array = input as unknown[];
    let bytes = Math.max(0, array.length - 1);
    for (let i = 0; i < array.length; i++) {
      budget.spend(); bytes += size(array[i], depth + 1, true);
      if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
    }
    bytes = Math.max(15, bytes);
    budget.reserveString(bytes);
    budget.reserve({ nodes: 1, slots: array.length, structuralBytes: 16 + 4 * array.length });
    budget.spend(1 + Math.ceil(bytes / 256)); return bytes;
  }
  budget.reserve({ nodes: 64, slots: 256, structuralBytes: 8192 });
  const bytes = size(value, 1, false);
  budget.reserveString(bytes); budget.spend(1 + Math.ceil(bytes / 256));
  try { const result = String(value); budget.check(); return result; }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}
/** Exact String scalar increment. Graph preparation preserves its scalar ledger. */
function exactStringAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BudgetExceededError();
  return value;
}
function exactStringAdd(left: number, right: number): number {
  exactStringAmount(left); exactStringAmount(right);
  if (left > Number.MAX_SAFE_INTEGER - right) throw new BudgetExceededError();
  return left + right;
}
function exactStringMul(left: number, right: number): number {
  exactStringAmount(left); exactStringAmount(right);
  if (right !== 0 && left > Math.floor(Number.MAX_SAFE_INTEGER / right)) throw new BudgetExceededError();
  return left * right;
}
function exactStringBlocks(units: number): number {
  exactStringAmount(units);
  return exactStringAdd(Math.floor(units / 256), units % 256 === 0 ? 0 : 1);
}
type exactStringMetadata = { outU: number; outB: number; rootU: number; rootB: number };
function exactStringCap(value: number, cap: number): void {
  exactStringAmount(value);
  if (value > cap) throw new BudgetExceededError();
}
function exactStringScalar(value: unknown, budget: BudgetContext, metadata: exactStringMetadata, cap: number): void {
  try {
    budget.check();
    budget.spend();
    if (typeof value === 'string') {
      budget.spend();
      const units = value.length;
      budget.check();
      exactStringCap(units, cap);
      budget.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, units)) });
      budget.spend(exactStringBlocks(units));
      const bytes = utf8ByteLength(value, budget);
      budget.check();
      exactStringCap(bytes, cap);
      metadata.outU = units; metadata.outB = bytes;
    } else {
      if (typeof value !== 'boolean' && value !== null && value !== undefined
        && (typeof value !== 'number' || !Number.isFinite(value))) return invalid();
      const bound = value === null ? 4 : value === undefined ? 9 : typeof value === 'boolean' ? 5 : 32;
      exactStringCap(bound, cap);
      metadata.outU = metadata.outB = bound;
    }
    budget.check(); // scalar completion
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}
function exactStringGraph(input: unknown, context: BudgetContext, state: exactStringMetadata, ceiling: number, depth: number, element = false): void {
  try {
    context.check();
    if (input === null || typeof input !== 'object') {
      if (element && (input === null || input === undefined)) {
        context.spend();
        state.outU = state.outB = 0;
      } else {
        exactStringScalar(input, context, state, ceiling);
        context.check();
        if (element && (typeof input === 'number' || typeof input === 'boolean')) {
          context.reserveString(state.outB);
          context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, state.outU)) });
          context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(state.outU))));
        }
      }
      context.check();
      return;
    }
    context.spend();
    const shape = shapeOf(input, context);
    context.check();
    context.spend(4);
    if (!shape.array) {
      exactStringCap(15, ceiling);
      if (element) {
        context.reserveString(15);
        context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, 15)) });
        context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(15))));
      }
      state.outU = state.outB = 15;
      context.check();
      return;
    }
    const array = input as unknown[];
    context.spend();
    const count = array.length;
    context.check();
    exactStringAmount(count);
    if (count !== shape.keys.length) return invalid();
    const commas = count === 0 ? 0 : count - 1;
    let units = commas, bytes = commas;
    exactStringCap(units, ceiling); exactStringCap(bytes, ceiling);
    context.reserve({ nodes: 1, slots: count, structuralBytes: exactStringAdd(16, exactStringMul(4, count)) });
    context.spend(exactStringAdd(count, exactStringBlocks(commas)));
    for (let index = 0; index < count; index = exactStringAdd(index, 1)) {
      context.spend();
      const child = array[index];
      context.check();
      const childDepth = exactStringAdd(depth, 1);
      if (childDepth > 64) throw new BudgetExceededError();
      context.checkDepth(childDepth);
      exactStringGraph(child, context, state, ceiling, childDepth, true);
      context.check();
      units = exactStringAdd(units, state.outU); exactStringCap(units, ceiling);
      bytes = exactStringAdd(bytes, state.outB); exactStringCap(bytes, ceiling);
    }
    exactStringCap(units, ceiling); exactStringCap(bytes, ceiling);
    context.reserveString(bytes);
    context.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, units)) });
    context.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(units))));
    state.outU = units; state.outB = bytes;
    context.check();
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    context.check(); throw error;
  }
}
export function stringBoundedJsonExact(value: unknown, budget: BudgetContext): string {
  try {
    budget.check();
    budget.reserve({ nodes: 1, slots: 8, structuralBytes: 80 }); budget.spend();
    if (value !== null && value !== undefined && typeof value !== 'string'
      && typeof value !== 'boolean' && typeof value !== 'number' && typeof value !== 'object') return invalid();
    const cap = Math.min(8_000_000, exactStringAmount(budget.limits.stringBytes));
    budget.reserve({ nodes: 1, slots: 4, structuralBytes: 48 }); budget.spend();
    const metadata: exactStringMetadata = { outU: 0, outB: 0, rootU: 0, rootB: 0 };
    budget.check();
    if (value !== null && typeof value === 'object') {
      stackScratch(budget);
      budget.reserve({ slots: 768, structuralBytes: 8192 }); budget.spend();
    }
    budget.checkDepth(1);
    if (value !== null && typeof value === 'object') exactStringGraph(value, budget, metadata, cap, 1);
    else exactStringScalar(value, budget, metadata, cap);
    budget.check();
    metadata.rootU = metadata.outU; metadata.rootB = metadata.outB;
    exactStringCap(metadata.rootU, cap); exactStringCap(metadata.rootB, cap);
    budget.reserveString(metadata.rootB);
    budget.reserve({ nodes: 1, structuralBytes: exactStringAdd(16, exactStringMul(2, metadata.rootU)) });
    budget.spend(exactStringAdd(2, exactStringMul(2, exactStringBlocks(metadata.rootU))));
    budget.check(); // preparation completion
    const result = String(value);
    budget.check(); // native success
    budget.check(); // final helper completion
    return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

const SHEET_LEGACY_KEYS = Object.freeze(['classTimeZone', 'createdAt', 'taskId']);
/** A closed, immutable schedule-argument recipe. Its operands are admitted row
 * data, a privately owned native header Map, and named legacy fields; never an
 * arbitrary mutable object/factory. The historical parser RESULTS stay mutable. */
export function createBoundedSheetsScheduleInputs(
  row: string[], index: Map<string, number>, taskId: string, createdAt: string,
  classTimeZone: string, budget: BudgetContext,
): readonly [Readonly<Record<string, string>>, { taskId: string; createdAt: string; classTimeZone: string }] {
  if (row !== null && (typeof row === 'object' || typeof row === 'function')) registeredBoundedKeys(row, budget);
  else scalar(row);
  assertBoundedSheetsHeaderIndex(index, budget);
  if (typeof taskId !== 'string' || typeof createdAt !== 'string') return invalid();
  if (classTimeZone && typeof classTimeZone === 'object') registeredBoundedKeys(classTimeZone, budget);
  else scalar(classTimeZone);
  // Native size getter does not enumerate or dispatch caller overrides.
  budget.spend();
  const count = sheetHeaderSize.call(index) as number;
  // Entries/cells/key-view/result-pair containers, two private sidecars and the
  // legacy record's scalar occurrences. Sort scratch and each tuple are separate.
  // Field values and key views share strings; cells' dynamic key bytes are below.
  budget.reserve({ nodes: 14 + count, slots: 3 * count + 20,
    structuralBytes: 512 + 12 * count });
  budget.spend();
  const entries: [string, string][] = [];
  let keyBytes = 0;
  budget.spend();
  Map.prototype.forEach.call(index, (position: number, header: string) => {
    budget.spend();
    if (typeof header !== 'string' || !Number.isSafeInteger(position)) return invalid();
    keyBytes += utf8ByteLength(header, budget);
    // Native fromEntries property definition and its key metadata share strings.
    budget.reserve({ structuralBytes: utf8ByteLength(header, budget) });
    budget.reserve({ nodes: 1, slots: 2, structuralBytes: 24 });
    // Malformed legacy string rows are indexable too; indexing may create a
    // one-code-unit substring (including a replacement-encoded lone surrogate).
    if (typeof row === 'string') budget.reserveString(3);
    const value = trimBudgetString(stringBoundedJson(row[position] ?? '', budget), budget);
    budget.spend(); entries.push([header, value]); budget.check();
  });
  budget.spend(1 + count);
  const cells = Object.fromEntries(entries) as Record<string, string>;
  budget.check();
  // Object.keys follows original fromEntries own-key order; the private sorted
  // view is solely admission metadata, never reused for a legacy spread.
  budget.spend(1 + count); const keys = Object.keys(cells);
  const sorted = stableBudgetSort(keys, (a, b) => {
    budget.spend(Math.ceil(a.length / 256) + Math.ceil(b.length / 256));
    return a < b ? -1 : a > b ? 1 : 0;
  }, budget);
  budget.spend(2 + 2 * count); Object.freeze(sorted); Object.freeze(cells);
  installShape(cells, false, sorted, keyBytes, budget);
  const legacy = { taskId, createdAt, classTimeZone };
  budget.spend(4); Object.freeze(legacy);
  installShape(legacy, false, SHEET_LEGACY_KEYS, 28, budget);
  budget.check(); return [cells, legacy];
}

type ParserProjectionKind = 'promotion' | 'checkout' | 'legacyItem' | 'adjustment';
const PARSER_KEYS = Object.freeze({
  legacyItem: Object.freeze(['productId', 'name', 'price', 'quantity', 'subtotal']),
  checkout: Object.freeze(['productId', 'name', 'price', 'quantity', 'subtotal', 'regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions']),
  adjustment: Object.freeze(['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount']),
  adjustmentFree: Object.freeze(['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount', 'freeQuantity']),
  promotion: Object.freeze(['promotionId', 'name', 'description', 'productIds', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion', 'type']),
  N_PLUS_ONE: Object.freeze(['buyQuantity', 'freeQuantity']),
  PROMOTIONAL_PRICE: Object.freeze(['promotionalUnitPrice']),
  PERCENT_DISCOUNT: Object.freeze(['percent']),
  FIXED_DISCOUNT: Object.freeze(['discountAmount']),
});

/** Closed parser schemas consume private immutable SOURCE certificates. The
 * returned historical API objects remain plain, mutable and detached; they must
 * NOT receive certificates which could become stale after caller mutation.
 * No caller-supplied arity or arbitrary object factory can authorize enumeration.
 * A promotion's fixed maximum variant is reserved before its lazy source is read.
 */
export function createBoundedParserProjection(kind: ParserProjectionKind, source: () => unknown, budget: BudgetContext): Record<string, unknown> {
  function project(recipe: ParserProjectionKind, operand: () => unknown, depth: number): Record<string, unknown> {
    budget.checkDepth(depth);
    if (recipe !== 'promotion' && recipe !== 'checkout' && recipe !== 'legacyItem' && recipe !== 'adjustment') return invalid();
    const base = recipe === 'adjustment' ? PARSER_KEYS.adjustmentFree : PARSER_KEYS[recipe];
    let keyBytes = 0;
    for (let i = 0; i < base.length; i++) { budget.spend(); keyBytes += utf8ByteLength(base[i], budget); }
    // N+1 is the largest promotion variant (two properties, 23 key bytes).
    const count = base.length + (recipe === 'promotion' ? 2 : 0);
    budget.reserve({ nodes: 1 + count, slots: count,
      structuralBytes: 16 + 8 * count + keyBytes + (recipe === 'promotion' ? 23 : 0) });
    const input = operand(); budget.check();
    if (!input || typeof input !== 'object' || shapeOf(input, budget).array) return invalid();
    const record = input as Record<string, unknown>;
    const keys = recipe === 'adjustment' && record.freeQuantity === undefined ? PARSER_KEYS.adjustment : base;
    const result: Record<string, unknown> = {};
    function copy(key: string): void {
      budget.spend();
      const child = record[key];
      if ((recipe === 'promotion' && key === 'productIds') || (recipe === 'checkout' && (key === 'adjustments' || key === 'appliedPromotions'))) {
        if (!child || typeof child !== 'object') return invalid();
        const shape = shapeOf(child, budget);
        if (!shape.array) return invalid();
        budget.checkDepth(depth + 1);
        budget.reserve({ nodes: 1 + shape.keys.length, slots: shape.keys.length, structuralBytes: 16 + 8 * shape.keys.length });
        const list = new Array<unknown>(shape.keys.length);
        for (let i = 0; i < list.length; i++) {
          budget.spend(); budget.checkDepth(depth + 2);
          const value = (child as unknown[])[i];
          if (key === 'productIds') { scalar(value); list[i] = value; }
          else list[i] = project(key === 'adjustments' ? 'adjustment' : 'promotion', () => value, depth + 2);
        }
        result[key] = list;
      } else { budget.checkDepth(depth + 1); scalar(child); result[key] = child; }
    }
    for (let i = 0; i < keys.length; i++) copy(keys[i]);
    if (recipe === 'promotion') {
      const type = record.type;
      if (type !== 'N_PLUS_ONE' && type !== 'PROMOTIONAL_PRICE' && type !== 'PERCENT_DISCOUNT' && type !== 'FIXED_DISCOUNT') return invalid();
      const extra = PARSER_KEYS[type];
      for (let i = 0; i < extra.length; i++) copy(extra[i]);
    }
    budget.check(); return result;
  }
  return project(kind, source, 1);
}

const OPERATIONAL_SUBJECT_KEYS = Object.freeze(['0', '1', '2']);
const OPERATIONAL_ADJUSTMENT_KEYS = Object.freeze(['0', '1', '2', '3', '4']);
/** Closed operational tuples from immutable request-owned sources. Mutable parser
 * outputs and arbitrary caller factories cannot acquire a certificate here.
 * Subject keys deliberately retain native JSON own-key order; adjustment keys
 * retain the existing canonical encoder, including nested legacy mode values. */
export function serializeBoundedOperationalKey(
  kind: 'subject' | 'adjustment' | 'transaction', source: object, budget: BudgetContext,
  mode?: 'add' | 'subtract' | 'set', requested?: number,
): string {
  try {
    const shape = shapeOf(source, budget);
    if (shape.array || (kind !== 'subject' && kind !== 'adjustment' && kind !== 'transaction')) return invalid();
    if (kind === 'transaction' && (mode !== 'add' && mode !== 'subtract' && mode !== 'set'
      || typeof requested !== 'number' || !Number.isSafeInteger(requested))) return invalid();
    const keys = kind === 'subject' ? OPERATIONAL_SUBJECT_KEYS : OPERATIONAL_ADJUSTMENT_KEYS;
    // Tuple + scalar occurrences + private immutable sidecar. Field strings are
    // references, not copies. Missing native subject operands encode as null.
    budget.reserve({ nodes: 4 + keys.length, slots: keys.length + 6,
      structuralBytes: 144 + 8 * keys.length });
    budget.spend(keys.length);
    const row = source as Record<string, unknown>;
    const tuple = kind === 'subject' ? [row.taskId ?? null, row.taskInstanceId ?? null, row.studentId ?? null]
      : [row.timestamp, row.studentId, row.operator, kind === 'transaction' ? mode : row.mode,
        kind === 'transaction' ? requested : row.amount];
    budget.spend(1 + keys.length); Object.freeze(tuple); budget.check();
    installShape(tuple, true, keys, keys.length, budget);
    if (kind !== 'subject') return canonicalBoundedJson(tuple, budget);
    // Native stringify is required here: sorting object operands would alter the
    // historical subject identity. Preflight its complete immutable graph and
    // enumeration/number scratch without constructing escaped strings first.
    stackScratch(budget);
    let visits = 0;
    function size(value: unknown, depth: number): number {
      budget.checkDepth(depth); budget.spend(); visits++;
      if (typeof value === 'string') return 2 + 6 * value.length;
      if (value === null || typeof value === 'boolean') return 5;
      if (typeof value === 'number' && Number.isFinite(value)) { budget.reserveString(32); return 32; }
      if (!value || typeof value !== 'object') return invalid();
      const childShape = shapeOf(value, budget);
      budget.reserve({ nodes: 1 + childShape.keys.length, slots: childShape.keys.length,
        contentBytes: childShape.keyBytes, structuralBytes: 16 + 8 * childShape.keys.length });
      let bytes = 2;
      for (const key of childShape.keys) {
        budget.spend();
        bytes += 1 + (childShape.array ? 0 : 3 + 6 * key.length)
          + size((value as Record<string, unknown>)[key], depth + 1);
        if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
      }
      return bytes;
    }
    const bytes = size(tuple, 1);
    budget.reserveString(bytes); budget.spend(visits + 1 + Math.ceil(bytes / 256));
    const result = JSON.stringify(tuple); budget.check(); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}


const CORRELATION_ADJUSTMENT_KEYS = Object.freeze(['amount', 'mode', 'operator', 'studentId', 'timestamp']);
const CORRELATION_TRANSACTION_KEYS = Object.freeze(['balanceAfter', 'balanceBefore', 'items', 'operator', 'status', 'studentId', 'timestamp', 'totalAmount']);
const CORRELATION_ITEM_KEYS = Object.freeze(['name', 'price', 'productId', 'quantity', 'subtotal']);
const CORRELATION_ADJUSTMENT_READS = Object.freeze(['timestamp', 'studentId', 'operator', 'mode', 'amount']);
const CORRELATION_TRANSACTION_READS = Object.freeze(['timestamp', 'studentId', 'operator', 'status', 'totalAmount', 'balanceBefore', 'balanceAfter']);
const CORRELATION_ITEM_READS = Object.freeze(['productId', 'name', 'price', 'quantity', 'subtotal']);
/** Closed fixed-field detached input for adjustment keys. Source objects remain
 * mutable and UNREGISTERED. Only newly allocated, scalar-validated, frozen copies
 * receive a request-owned certificate; no caller arity or generic graph assertion
 * is accepted. Reserve the root before evaluating the lazy caller operand. */
export function createBoundedCorrelationInput(kind: 'adjustment' | 'transaction', source: () => Record<string, unknown>, budget: BudgetContext): Record<string, unknown> {
  try {
    budget.spend(2);
    if (kind !== 'adjustment' && kind !== 'transaction') return invalid();
    function reserveRecord(keys: readonly string[]): number {
      let bytes = 0;
      for (const key of keys) { budget.spend(); bytes += utf8ByteLength(key, budget); }
      budget.reserve({ nodes: 4 + keys.length, slots: keys.length + 6, structuralBytes: 144 + 8 * keys.length + bytes });
      budget.spend(1 + keys.length); return bytes;
    }
    function copyScalars(input: Record<string, unknown>, result: Record<string, unknown>, order: readonly string[]): void {
      for (const key of order) {
        budget.spend(); const value = input[key]; scalar(value); budget.check();
        budget.spend(); result[key] = value; budget.check();
      }
    }
    function close(value: object, array: boolean, keys: readonly string[], bytes: number): void {
      budget.spend(1 + keys.length); Object.freeze(value); budget.check();
      installHistoryShape(value, array, keys, bytes, budget);
    }
    const keys = kind === 'adjustment' ? CORRELATION_ADJUSTMENT_KEYS : CORRELATION_TRANSACTION_KEYS;
    const bytes = reserveRecord(keys), input = source(); budget.check();
    const result: Record<string, unknown> = {}; budget.check();
    copyScalars(input, result, kind === 'adjustment' ? CORRELATION_ADJUSTMENT_READS : CORRELATION_TRANSACTION_READS);
    if (kind === 'transaction') {
      budget.spend(); const items = input.items; budget.check();
      budget.spend(); const array = Array.isArray(items); budget.check();
      if (!array) { scalar(items); budget.check(); result.items = items; }
      else {
        budget.spend(); const count = (items as unknown[]).length; budget.check();
        // List + private index-key view + immutable shape; string index payloads
        // are independently reserved before their native String conversion.
        budget.reserve({ nodes: 5 + count, slots: 2 * count + 6, structuralBytes: 160 + 8 * count });
        budget.spend(2); const list: unknown[] = [], indices: string[] = [];
        let indexBytes = 0;
        for (let i = 0; i < count; i++) {
          budget.spend(); budget.reserveString(32);
          const index = String(i); budget.check(); indexBytes += utf8ByteLength(index, budget);
          budget.spend(); indices.push(index); budget.check();
          budget.spend(); const item = (items as unknown[])[i]; budget.check();
          if (!item || typeof item !== 'object') { scalar(item); budget.check(); budget.spend(); list.push(item); budget.check(); }
          else {
            const itemBytes = reserveRecord(CORRELATION_ITEM_KEYS), copy: Record<string, unknown> = {};
            copyScalars(item as Record<string, unknown>, copy, CORRELATION_ITEM_READS);
            close(copy, false, CORRELATION_ITEM_KEYS, itemBytes);
            budget.spend(); list.push(copy); budget.check();
          }
        }
        budget.spend(1 + count); Object.freeze(indices); budget.check();
        close(list, true, indices, indexBytes);
        budget.spend(); result.items = list; budget.check();
      }
    }
    close(result, false, keys, bytes); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

// Closed history construction: exported operands are primitives, never mutable
// canonical objects, caller factories, arity assertions, or parser certificates.
// The mutable public record is NOT registered. Its detached immutable sibling is
// retained in a private weak association and owned by the original request.
type HistoryScalar = string | number | null;
const historyViews = new WeakMap<object, Readonly<Record<string, unknown>>>();
const HISTORY_ASSIGNMENT_KEYS = Object.freeze(["assignmentId", "createdAt", "cycleEndsAt", "cycleId", "cycleStartsAt", "note", "previousAssignmentId", "ruleVersion", "schemaVersion", "source", "status", "studentId", "taskId", "taskInstanceId", "timeZone"]);
const HISTORY_COMPLETION_KEYS = Object.freeze(["assignmentId", "balanceAfter", "balanceBefore", "completionId", "cycleEndsAt", "cycleId", "cycleStartsAt", "note", "operationId", "operationPayloadHash", "reward", "ruleVersion", "schemaVersion", "source", "status", "studentId", "studentName", "taskId", "taskInstanceId", "timeZone", "timestamp"]);
const HISTORY_EVIDENCE_COMPLETION_KEYS = Object.freeze(["assignmentId", "balanceAfter", "balanceBefore", "completionId", "cycleEndsAt", "cycleId", "cycleStartsAt", "evidenceAuthorFullName", "evidenceBoardId", "evidenceCreatedAt", "evidencePostId", "evidenceProvider", "note", "operationId", "operationPayloadHash", "reward", "ruleVersion", "schemaVersion", "source", "status", "studentId", "studentName", "taskId", "taskInstanceId", "timeZone", "timestamp", "tupleDigest"]);
const HISTORY_INVALID_COMPLETION_KEYS = Object.freeze(["completionId", "cycleId", "cycleStartsAt", "operationId", "operationPayloadHash", "studentId", "taskId", "taskInstanceId", "tupleDigest"]);
function installHistoryShape(value: object, array: boolean, keys: readonly string[], keyBytes: number, budget: BudgetContext): void {
  // Storage was reserved by the closed recipe; check the native freeze before
  // installing a certificate, including its late-success boundary.
  budget.spend(); const shape = Object.freeze({ owner: budget, array, keys, keyBytes }); budget.check();
  budget.spend(); shapes.set(value, shape); budget.check();
}
function historyPair(keys: readonly string[], make: () => Record<string, HistoryScalar>, budget: BudgetContext): Record<string, unknown> {
  try {
    let keyBytes = 0;
    for (const key of keys) { budget.spend(); keyBytes += utf8ByteLength(key, budget); }
    // Two fixed records with scalar occurrences + immutable shape + association.
    budget.reserve({ nodes: 5 + 2 * keys.length, slots: 2 * keys.length + 8,
      structuralBytes: 168 + 16 * keys.length + 2 * keyBytes });
    budget.spend(2 + keys.length);
    const result = make(); budget.check();
    const view: Record<string, HistoryScalar> = Object.create(null); budget.check();
    for (const key of keys) {
      budget.spend(2); const value = result[key]; scalar(value); budget.check(); view[key] = value;
    }
    budget.spend(1 + keys.length); Object.freeze(view); budget.check();
    installHistoryShape(view, false, keys, keyBytes, budget);
    budget.spend(); historyViews.set(result, view); budget.check();
    return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}
export function createBoundedHistoryAssignment(budget: BudgetContext,
  assignmentId: HistoryScalar, taskId: HistoryScalar, taskInstanceId: HistoryScalar, cycleId: HistoryScalar, cycleStartsAt: HistoryScalar, cycleEndsAt: HistoryScalar, ruleVersion: HistoryScalar, timeZone: HistoryScalar, studentId: HistoryScalar, status: HistoryScalar, source: HistoryScalar, previousAssignmentId: HistoryScalar, createdAt: HistoryScalar, schemaVersion: HistoryScalar, note: HistoryScalar): Record<string, unknown> {
  return historyPair(HISTORY_ASSIGNMENT_KEYS, () => ({ assignmentId, taskId, taskInstanceId, cycleId, cycleStartsAt, cycleEndsAt, ruleVersion, timeZone, studentId, status, source, previousAssignmentId, createdAt, schemaVersion, note }), budget);
}
export function createBoundedHistoryInvalidCompletion(budget: BudgetContext,
  completionId: HistoryScalar, taskId: HistoryScalar, studentId: HistoryScalar, taskInstanceId: HistoryScalar, cycleId: HistoryScalar, cycleStartsAt: HistoryScalar, operationId: HistoryScalar, operationPayloadHash: HistoryScalar, tupleDigest: HistoryScalar): Record<string, unknown> {
  return historyPair(HISTORY_INVALID_COMPLETION_KEYS, () => ({ completionId, taskId, studentId, taskInstanceId, cycleId, cycleStartsAt, operationId, operationPayloadHash, tupleDigest }), budget);
}
export function createBoundedHistoryCompletion(budget: BudgetContext,
  completionId: HistoryScalar, timestamp: HistoryScalar, taskId: HistoryScalar, studentId: HistoryScalar, studentName: HistoryScalar, reward: HistoryScalar, balanceBefore: HistoryScalar, balanceAfter: HistoryScalar, status: HistoryScalar, note: HistoryScalar, taskInstanceId: HistoryScalar, cycleId: HistoryScalar, cycleStartsAt: HistoryScalar, cycleEndsAt: HistoryScalar, ruleVersion: HistoryScalar, timeZone: HistoryScalar, source: HistoryScalar, assignmentId: HistoryScalar, schemaVersion: HistoryScalar, operationId: HistoryScalar, operationPayloadHash: HistoryScalar, hasEvidence: boolean,
  evidenceProvider: HistoryScalar, evidenceBoardId: HistoryScalar, evidencePostId: HistoryScalar, evidenceCreatedAt: HistoryScalar, evidenceAuthorFullName: HistoryScalar, tupleDigest: HistoryScalar): Record<string, unknown> {
  if (typeof hasEvidence !== 'boolean') return invalid();
  return hasEvidence ? historyPair(HISTORY_EVIDENCE_COMPLETION_KEYS, () => ({ completionId, timestamp, taskId, studentId, studentName, reward, balanceBefore, balanceAfter, status, note, taskInstanceId, cycleId, cycleStartsAt, cycleEndsAt, ruleVersion, timeZone, source, assignmentId, schemaVersion, operationId, operationPayloadHash, evidenceProvider, evidenceBoardId, evidencePostId, evidenceCreatedAt, evidenceAuthorFullName, tupleDigest }), budget)
    : historyPair(HISTORY_COMPLETION_KEYS, () => ({ completionId, timestamp, taskId, studentId, studentName, reward, balanceBefore, balanceAfter, status, note, taskInstanceId, cycleId, cycleStartsAt, cycleEndsAt, ruleVersion, timeZone, source, assignmentId, schemaVersion, operationId, operationPayloadHash }), budget);
}
/** No object reads before the private identity/owner lookup. Public mutation can
 * never change the admitted graph, nor register an arbitrary mutable object. */
export function boundedOperationalHistoryView(record: object, budget: BudgetContext): Readonly<Record<string, unknown>> {
  try {
    budget.spend(); const view = historyViews.get(record); budget.check();
    if (!view) return invalid(); shapeOf(view, budget); budget.check(); return view;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

/** Closed list recipe: each lazy operand must be a privately paired history
 * record. Count only controls a pre-reserved new list, never certifies input. */
export function createBoundedOperationalHistoryList(count: number, source: (index: number) => object, budget: BudgetContext): readonly Readonly<Record<string, unknown>>[] {
  try {
    budget.spend(3);
    const validCount = Number.isSafeInteger(count); budget.check();
    if (!validCount || count < 0) return invalid();
    if (count > 0 && budget.limits.stringBytes < 16) throw new BudgetExceededError();
    // Result, numeric key array/scalars/strings and private sidecar. Safe integer
    // index text is at most 16 bytes; numeric String formatting is precharged.
    budget.reserve({ nodes: 5 + 2 * count, slots: 2 * count + 6,
      contentBytes: 16 * count, structuralBytes: 160 + 12 * count });
    budget.spend(); const result: Readonly<Record<string, unknown>>[] = new Array(count); budget.check();
    budget.spend(); const keys: string[] = new Array(count); budget.check();
    let keyBytes = 0;
    for (let i = 0; i < count; i++) {
      budget.spend(2); const operand = source(i); budget.check();
      result[i] = boundedOperationalHistoryView(operand, budget);
      budget.spend(); const key = String(i); budget.check(); keys[i] = key; keyBytes += key.length;
    }
    budget.spend(1 + count); Object.freeze(keys); budget.check();
    budget.spend(1 + count); Object.freeze(result); budget.check();
    installHistoryShape(result, true, keys, keyBytes, budget); return result;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

const PROJECTION_KEYS = Object.freeze({
  sheetsArtifact: Object.freeze(['capturedAt', 'credentialHashes', 'missingOptionalTabs', 'schemaVersion', 'snapshotVersion', 'sourceRevision', 'spreadsheetId', 'tabs'] as const),
  offlineSheetsArtifact: Object.freeze(['capturedAt', 'credentialHashes', 'missingOptionalTabs', 'offlineBaseline', 'schemaVersion', 'snapshotVersion', 'sourceRevision', 'spreadsheetId', 'tabs'] as const),
  redisArtifact: Object.freeze(['capturedAt', 'operationBindings', 'orphanedClaimDigests', 'snapshotVersion', 'sourceRevision', 'v1Tombstones', 'v2Claims'] as const),
});
type ProjectionKind = keyof typeof PROJECTION_KEYS;
type Projection<K extends ProjectionKind> = Readonly<Record<(typeof PROJECTION_KEYS)[K][number], unknown>>;

/** Fixed schema recipes only; the lazy operand supplies a registered source, not
 * an arbitrary constructed object or a caller-declared property count. */
export function createBoundedProjection<K extends ProjectionKind>(kind: K, source: () => unknown, budget: BudgetContext): Projection<K> {
  if (!Object.hasOwn(PROJECTION_KEYS, kind)) return invalid();
  const keys = PROJECTION_KEYS[kind];
  let keyBytes = 0;
  for (const key of keys) { budget.spend(); keyBytes += utf8ByteLength(key, budget); }
  // Maximum scalar occurrences plus exact slots, container and private sidecar.
  // Reserve before the source callback as well as before Object.create.
  budget.reserve({ nodes: 4 + keys.length, slots: keys.length + 6,
    structuralBytes: 144 + 8 * keys.length + keyBytes });
  const input = source();
  budget.check();
  if (!input || typeof input !== 'object') return invalid();
  const shape = shapeOf(input, budget);
  if (shape.array) return invalid();
  for (const key of keys) {
    let found = false;
    for (const sourceKey of shape.keys) { budget.spend(); if (sourceKey === key) { found = true; break; } }
    if (!found) return invalid();
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) { budget.spend(); result[key] = (input as Record<string, unknown>)[key]; }
  budget.spend(1 + keys.length); Object.freeze(result); budget.check();
  installShape(result, false, keys, keyBytes, budget);
  return result as Projection<K>;
}

// Only this module can mint certificates. Frozen containers prevent a stale arity
// certificate from authorizing an unbounded ownKeys after caller mutation. A
// certificate is accounting ownership, NOT evidence authenticity or business shape.
type Shape = Readonly<{ owner: BudgetContext; array: boolean; keys: readonly string[]; keyBytes: number }>;
const shapes = new WeakMap<object, Shape>();
const POISON = new Set(['__proto__', 'prototype', 'constructor']);

function stackScratch(budget: BudgetContext): void {
  // Bounded recursive call frames: at most 64 live, four conservative operands.
  budget.reserve({ nodes: 64, slots: 256, structuralBytes: 8_192 });
}
function scalar(value: unknown): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))) return;
  invalid();
}
/** Shared immutable key view; callers cannot alter the private recipe. */
export function registeredBoundedKeys(value: object, budget: BudgetContext): readonly string[] {
  return shapeOf(value, budget).keys;
}

function shapeOf(value: object, budget: BudgetContext): Shape {
  budget.spend();
  const shape = shapes.get(value); // WeakMap lookup does not invoke Proxy traps.
  if (!shape || shape.owner !== budget) return invalid();
  return shape;
}
function saveShape(value: object, array: boolean, keys: readonly string[], keyBytes: number, budget: BudgetContext): void {
  // Four-field sidecar + scalar operands + two WeakMap entry slots. Keys are
  // shared immutable references; their array allocation was reserved separately.
  budget.reserve({ nodes: 3, slots: 6, structuralBytes: 128 });
  installShape(value, array, keys, keyBytes, budget);
}
function installShape(value: object, array: boolean, keys: readonly string[], keyBytes: number, budget: BudgetContext): void {
  budget.spend();
  shapes.set(value, Object.freeze({ owner: budget, array, keys, keyBytes }));
}
function descriptor(value: object, key: PropertyKey, budget: BudgetContext): PropertyDescriptor {
  budget.reserve({ nodes: 7, slots: 6, structuralBytes: 192 });
  budget.spend();
  const result = Object.getOwnPropertyDescriptor(value, key);
  if (!result || !('value' in result)) return invalid();
  return result;
}

/** Stronger, opt-in decoder. Lexical-only parseBoundedJson stays unchanged.
 * The private scanner ticket supplies the first enumeration bound. Native JSON
 * parsing is a trusted runtime boundary (not an adversarial monkey-patch sandbox).
 * Every container is descriptor-checked and frozen before it escapes this call.
 */
export function parseRegisteredBoundedJson(text: string, budget: BudgetContext): unknown {
  const ticket = admit(text, budget);
  budget.reserve({ nodes: ticket.nodes, slots: ticket.slots,
    contentBytes: ticket.contentBytes, structuralBytes: ticket.structuralBytes });
  budget.spend(Math.ceil(ticket.text.length / 256));
  let root: unknown;
  try { root = JSON.parse(ticket.text); }
  catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check();
    return invalid();
  }
  budget.check();
  stackScratch(budget);
  budget.reserve({ nodes: 1, structuralBytes: 16 });
  const seen = new WeakSet<object>();
  function visit(value: unknown, depth: number): void {
    budget.spend(); budget.checkDepth(depth);
    if (!value || typeof value !== 'object') { scalar(value); return; }
    budget.spend();
    if (seen.has(value)) return invalid();
    budget.reserve({ slots: 1, structuralBytes: 4 });
    budget.spend(); seen.add(value);
    const array = Array.isArray(value);
    budget.spend();
    const proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    // JSON.parse has no reviver: every arity is bounded by the private ticket.
    // Include array length; do not obtain descriptors/keys before their recipes.
    const arity = ticket.maxArity + (array ? 1 : 0);
    budget.reserve({ nodes: 1, slots: arity, structuralBytes: 16 + 4 * arity });
    if (array) {
      // Native ownKeys can materialize decimal index strings, not just slots.
      // Reserve each bounded index payload BEFORE enumeration (length is fixed).
      if (ticket.maxArity && budget.limits.stringBytes < 32) throw new BudgetExceededError();
      budget.reserve({ nodes: ticket.maxArity, contentBytes: 32 * ticket.maxArity,
        structuralBytes: 4 * ticket.maxArity });
    }
    budget.spend(1 + arity);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > arity) return invalid();
    let keyBytes = 0;
    if (array) {
      const length = descriptor(value, 'length', budget).value as unknown;
      if (!Number.isSafeInteger(length) || (length as number) < 0 || ownKeys.length !== (length as number) + 1
        || ownKeys[ownKeys.length - 1] !== 'length') return invalid();
      ownKeys.pop();
    }
    for (let i = 0; i < ownKeys.length; i++) {
      budget.spend();
      const key = ownKeys[i];
      budget.spend(1 + (typeof key === 'string' ? Math.ceil(key.length / 256) : 0));
      if (typeof key !== 'string' || POISON.has(key)) return invalid();
      if (array) {
        budget.reserveString(32); budget.spend();
        if (key !== String(i)) return invalid();
      } else keyBytes += utf8ByteLength(key, budget);
      const field = descriptor(value, key, budget);
      if (!field.enumerable) return invalid();
      visit(field.value, depth + 1);
    }
    const keys = array ? ownKeys as string[] : stableBudgetSort(ownKeys as string[], (left, right) => {
      budget.spend(Math.ceil((left.length + right.length) / 256));
      return left < right ? -1 : left > right ? 1 : 0;
    }, budget);
    budget.spend(1 + keys.length); Object.freeze(keys);
    // Freeze visits own properties internally; charge native arity work first.
    budget.spend(1 + keys.length); Object.freeze(value); budget.check();
    saveShape(value, array, keys, keyBytes, budget);
  }
  visit(root, 1);
  return root;
}

/** Structural-only validation using private immutable descriptors. Business
 * snapshot shape/digests/redaction are still the migration validator's job.
 * No new key arrays or descriptors are needed for an already registered graph.
 */
export function assertRegisteredBoundedJson(value: unknown, budget: BudgetContext): void {
  if (value && typeof value === 'object') shapeOf(value, budget);
  stackScratch(budget);
  let nodes = 0, content = 0, structure = 0, records = 0;
  function check(): void {
    if (nodes > MAX_NODES || content > MAX_CONTENT_BYTES || structure > MAX_STRUCTURE_BYTES || records > 10_000) {
      throw new BudgetExceededError();
    }
  }
  function visit(child: unknown, depth: number): void {
    budget.spend(); budget.checkDepth(depth); nodes++; check();
    if (!child || typeof child !== 'object') {
      scalar(child); structure += 4;
      if (typeof child === 'string') content += utf8ByteLength(child, budget);
      check(); return;
    }
    const shape = shapeOf(child, budget);
    structure += 16 + 4 * shape.keys.length + shape.keyBytes; check();
    for (const key of shape.keys) {
      budget.spend();
      if (!shape.array && key === 'rowNumber') { records++; check(); }
      visit((child as Record<string, unknown>)[key], depth + 1);
    }
  }
  visit(value, 1);
}

/** Two passes over an immutable registered graph. Pass one never stringifies a
 * variable-length scalar or builds escaped substrings. Pass two emits exactly
 * those bytes into one pre-reserved buffer; output decoding is reserved too.
 * Scalar roots need no object certificate. The cap includes ALL framing bytes.
 */
export function canonicalBoundedJson(value: unknown, budget: BudgetContext, maxBytes = 8_000_000): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 8_000_000) throw new BudgetExceededError();
  if (value && typeof value === 'object') shapeOf(value, budget);
  stackScratch(budget);
  let offset = 0, chargedThrough = 0;
  let output: Uint8Array | undefined = undefined;
  function byte(code: number): void {
    if (offset >= maxBytes || offset >= budget.limits.stringBytes) throw new BudgetExceededError();
    if (offset >= chargedThrough) { budget.spend(); chargedThrough += 256; }
    if (output) output[offset] = code;
    offset++;
  }
  function ascii(text: string): void {
    for (let i = 0; i < text.length; i++) byte(text.charCodeAt(i));
  }
  function string(text: string): void {
    byte(34);
    let through = 0;
    function codeAt(index: number): number {
      if (index >= through) { budget.spend(); through += 256; }
      return text.charCodeAt(index);
    }
    for (let i = 0; i < text.length; i++) {
      let code = codeAt(i);
      if (code === 34 || code === 92) { byte(92); byte(code); }
      else if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
        byte(92); byte(code === 8 ? 98 : code === 9 ? 116 : code === 10 ? 110 : code === 12 ? 102 : 114);
      } else {
        const high = code >= 0xd800 && code <= 0xdbff;
        const low = high && i + 1 < text.length ? codeAt(i + 1) : -1;
        if (high && low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + (code - 0xd800) * 1024 + low - 0xdc00; i++;
        } else if (code < 32 || (code >= 0xd800 && code <= 0xdfff)) {
          byte(92); byte(117);
          for (let shift = 12; shift >= 0; shift -= 4) {
            const nibble = (code >> shift) & 15; byte(nibble < 10 ? 48 + nibble : 87 + nibble);
          }
          continue;
        }
        if (code < 128) byte(code);
        else if (code < 2048) { byte(192 | (code >> 6)); byte(128 | (code & 63)); }
        else if (code < 65536) { byte(224 | (code >> 12)); byte(128 | ((code >> 6) & 63)); byte(128 | (code & 63)); }
        else { byte(240 | (code >> 18)); byte(128 | ((code >> 12) & 63)); byte(128 | ((code >> 6) & 63)); byte(128 | (code & 63)); }
      }
    }
    byte(34);
  }
  function visit(child: unknown, depth: number): void {
    budget.spend(); budget.checkDepth(depth);
    if (typeof child === 'string') { string(child); return; }
    if (child === null) { ascii('null'); return; }
    if (typeof child === 'boolean') { ascii(child ? 'true' : 'false'); return; }
    if (typeof child === 'number' && Number.isFinite(child)) {
      budget.reserveString(32); budget.spend();
      const number = JSON.stringify(child); budget.check(); ascii(number); return;
    }
    if (!child || typeof child !== 'object') return invalid();
    const shape = shapeOf(child, budget);
    byte(shape.array ? 91 : 123);
    for (let i = 0; i < shape.keys.length; i++) {
      budget.spend();
      const key = shape.keys[i];
      if (i) byte(44);
      if (!shape.array) { string(key); byte(58); }
      visit((child as Record<string, unknown>)[key], depth + 1);
    }
    byte(shape.array ? 93 : 125);
  }
  visit(value, 1);
  const bytes = offset;
  // One atomic reservation for both simultaneously retained payload copies.
  budget.reserve({ nodes: 2, contentBytes: bytes * 2, structuralBytes: 8 });
  output = new Uint8Array(bytes);
  offset = 0; chargedThrough = 0;
  visit(value, 1);
  if (offset !== bytes) return invalid();
  budget.spend(Math.ceil(bytes / 256));
  const result = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
  budget.check();
  return result;
}

/** Explicit combined clone/freeze seam, not a mutable generic clone API. The
 * original is already immutable; every new container and scalar occurrence is
 * reserved before creation. Shared string payloads are not copied by assignment.
 */
export function cloneFreezeBoundedJson<T>(value: T, budget: BudgetContext): T {
  return cloneRegisteredJson(value, budget, true);
}

/** Mutable clones deliberately have NO shape certificate. A caller may add keys;
 * admitting that mutable result would make every cached enumeration bound stale. */
export function cloneMutableBoundedJson<T>(value: T, budget: BudgetContext): T {
  return cloneRegisteredJson(value, budget, false, 'generic');
}

/** Closed schedule result recipe: reserve the fixed schedule before evaluating
 * the lazy certified operand, then preserve native own-key order and all extras.
 * No mutable output is registered, and no arbitrary factory can mint a shape. */
export function createBoundedScheduleResult(source: () => unknown, budget: BudgetContext): Record<string, unknown> {
  budget.reserve({ nodes: 7, slots: 6, structuralBytes: 160 });
  const value = source(); budget.check();
  if (!value || typeof value !== 'object' || shapeOf(value, budget).array) return invalid();
  return cloneRegisteredJson(value, budget, false, true) as Record<string, unknown>;
}

function cloneRegisteredJson<T>(value: T, budget: BudgetContext, freeze: boolean, preserveOrder: boolean | 'generic' = false): T {
  if (value && typeof value === 'object') shapeOf(value, budget);
  stackScratch(budget);
  function visit(child: unknown, depth: number): unknown {
    budget.spend(); budget.checkDepth(depth);
    if (!child || typeof child !== 'object') {
      scalar(child); budget.reserve({ nodes: 1, structuralBytes: 4 }); return child;
    }
    const shape = shapeOf(child, budget);
    budget.reserve({ nodes: 1, slots: shape.keys.length,
      structuralBytes: 16 + 4 * shape.keys.length + shape.keyBytes });
    let keys = shape.keys;
    if (preserveOrder && !shape.array) {
      budget.reserve({ nodes: 1, slots: shape.keys.length, structuralBytes: 16 + 4 * shape.keys.length });
      budget.spend(1 + shape.keys.length);
      keys = Object.keys(child); budget.check();
    }
    const result: Record<string, unknown> | unknown[] = shape.array ? new Array(shape.keys.length) : preserveOrder === true ? {} : Object.create(null);
    for (const key of keys) {
      budget.spend();
      (result as Record<string, unknown>)[key] = visit((child as Record<string, unknown>)[key], depth + 1);
    }
    if (freeze) {
      budget.spend(1 + shape.keys.length); Object.freeze(result); budget.check();
      saveShape(result, shape.array, shape.keys, shape.keyBytes, budget);
    }
    return result;
  }
  return visit(value, 1) as T;
}

/** Standalone reservation prerequisite. No production comparator invokes this. */
export function reserveBoundedJsonRelational(left: unknown, right: unknown, budget: BudgetContext): void {
  try {
    budget.check();
    budget.reserve({ nodes: 1, slots: 8, structuralBytes: 80 });
    budget.spend(2);
    const fast = (left === null || left === undefined || typeof left === 'number' || typeof left === 'boolean')
      && (right === null || right === undefined || typeof right === 'number' || typeof right === 'boolean');
    budget.spend(2);
    if (fast && typeof left === 'number' && !Number.isFinite(left)) return invalid();
    budget.spend(2);
    if (fast && typeof right === 'number' && !Number.isFinite(right)) return invalid();
    // Complete reservation only: retain both W triples, then one P0 and ordered root R.
    if (!fast) {
      const metadata = relationalMetadata(budget);
      if ((left !== null && typeof left === 'object') || (right !== null && typeof right === 'object')) {
        stackScratch(budget);
        budget.reserve({ slots: 768, structuralBytes: 8192 });
        budget.spend(1);
        metadata.graphScratch = true;
      }
      budget.checkDepth(1);
      if (left !== null && typeof left === 'object') relationalGraph(left, budget, metadata, 1);
      else relationalScalar(left, budget, metadata);
      budget.check();
      metadata.leftU = metadata.outU; metadata.leftB = metadata.outB; metadata.leftText = metadata.outText;
      budget.checkDepth(1);
      if (right !== null && typeof right === 'object') relationalGraph(right, budget, metadata, 1);
      else relationalScalar(right, budget, metadata);
      budget.check();
      metadata.rightU = metadata.outU; metadata.rightB = metadata.outB; metadata.rightText = metadata.outText;
      if (metadata.leftText || metadata.rightText) {
        budget.reserve({ nodes: 1, structuralBytes: 8192 });
        budget.spend(1);
        metadata.parserScratch = true;
      }
      if (metadata.leftText) relationalRoot(metadata.leftU, budget);
      if (metadata.rightText) relationalRoot(metadata.rightU, budget);
      budget.spend(2);
      budget.check();
      return;
    }
    budget.checkDepth(1);
    budget.checkDepth(1);
    budget.spend(2);
    budget.check();
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

/** R: independent relation-input F, numeric workspace, four fixed/U scan classes. */
function relationalRoot(u: number, budget: BudgetContext): void {
  try {
    relationalAmount(u); relationalAmount(budget.limits.stringBytes);
    if (u > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    budget.reserve({ nodes: 1, structuralBytes: relationalAdd(16, relationalMul(2, u)) });
    budget.reserve({ nodes: 1, slots: u, structuralBytes: relationalAdd(16, relationalMul(8, u)) });
    budget.spend(relationalAdd(4, relationalMul(4, relationalBlocks(u))));
    budget.check();
    return;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

/** Private accounting only; not yet wired into the nontrivial relational path. */
function relationalAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new BudgetExceededError();
}
function relationalAdd(a: number, b: number): number {
  relationalAmount(a); relationalAmount(b);
  if (a > Number.MAX_SAFE_INTEGER - b) throw new BudgetExceededError();
  return a + b;
}
function relationalMul(a: number, b: number): number {
  relationalAmount(a); relationalAmount(b);
  if (b !== 0 && a > Math.floor(Number.MAX_SAFE_INTEGER / b)) throw new BudgetExceededError();
  return a * b;
}
function relationalBlocks(u: number): number {
  relationalAmount(u);
  const blocks = Math.floor(u / 256);
  return u % 256 !== 0 ? relationalAdd(blocks, 1) : blocks;
}
function relationalCommas(n: number): number {
  relationalAmount(n);
  return n === 0 ? 0 : n - 1;
}

type RelationalMetadata = {
  leftU: number; leftB: number; leftText: boolean;
  rightU: number; rightB: number; rightText: boolean;
  outU: number; outB: number; outText: boolean;
  graphScratch: boolean; parserScratch: boolean; phase: number;
};
/** Private twelve-field H; no graph or parser reservation is implied. */
function relationalMetadata(budget: BudgetContext): RelationalMetadata {
  try {
    budget.reserve({ nodes: 1, slots: 12, structuralBytes: 112 });
    budget.spend(1);
    const metadata: RelationalMetadata = {
      leftU: 0, leftB: 0, leftText: false,
      rightU: 0, rightB: 0, rightText: false,
      outU: 0, outB: 0, outText: false,
      graphScratch: false, parserScratch: false, phase: 0,
    };
    budget.check();
    return metadata;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

/** M: result occurrence, separate UTF16 F, fixed dispatch and two U-block passes. */
function relationalMaterialize(u: number, b: number, budget: BudgetContext): void {
  try {
    relationalAmount(u); relationalAmount(budget.limits.stringBytes);
    if (u > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    relationalAmount(b);
    if (b > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    budget.reserveString(b);
    budget.reserve({ nodes: 1, structuralBytes: relationalAdd(16, relationalMul(2, u)) });
    budget.spend(relationalAdd(2, relationalMul(2, relationalBlocks(u))));
    budget.check();
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

/** Complete record15/array W: every child occurrence is checked, accumulated
 * U then B before either total is stored, and every array materializes itself.
 * Existing positions: i=index8, u=U9/commas15, b=B10, childValue=11,
 * childU=12, childB=13, childDepth=phase16; childText14 is not needed.
 * One reused pair arena, with no new frame, result object or per-child cache. */
function relationalGraph(input: object, budget: BudgetContext, metadata: RelationalMetadata, depth: number): void {
  try {
    budget.spend(1);
    const shape = shapeOf(input, budget);
    budget.check();
    budget.spend(4);
    if (!shape.array) {
      relationalAmount(budget.limits.stringBytes);
      // Both fixed bounds are 15; one comparison caps each before M.
      if (15 > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
      relationalMaterialize(15, 15, budget);
      metadata.outU = 15; metadata.outB = 15; metadata.outText = true;
      budget.check();
      return;
    }
    budget.spend(1);
    const count = (input as readonly unknown[]).length;
    budget.check();
    relationalAmount(count);
    if (count !== shape.keys.length) return invalid();
    let u = relationalCommas(count);
    relationalAmount(budget.limits.stringBytes);
    if (u > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    budget.reserve({ nodes: 1, slots: count, structuralBytes: relationalAdd(16, relationalMul(4, count)) });
    budget.spend(relationalAdd(count, relationalBlocks(u)));
    let b = u;
    let i = 0;
    while (i < count) {
      budget.spend(1);
      const childValue = (input as readonly unknown[])[i];
      budget.check();
      const childDepth = relationalAdd(depth, 1);
      if (childDepth > 64) throw new BudgetExceededError();
      budget.checkDepth(childDepth);
      if (childValue !== null && typeof childValue === 'object') relationalGraph(childValue, budget, metadata, childDepth);
      else relationalElement(childValue, budget, metadata);
      budget.check();
      const childU = relationalAdd(u, metadata.outU);
      if (childU > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
      const childB = relationalAdd(b, metadata.outB);
      if (childB > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
      u = childU;
      b = childB;
      i = relationalAdd(i, 1);
    }
    relationalAmount(u);
    relationalAmount(budget.limits.stringBytes);
    if (u > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    relationalAmount(b);
    if (b > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    relationalMaterialize(u, b, budget);
    metadata.outU = u; metadata.outB = b; metadata.outText = true;
    budget.check();
    return;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}

/** Nonrecursive W uses input/budget/metadata and U/B within O's eight reused
 * positions. Graph/count/index/child state belongs to the pending graph path. */
function relationalScalar(input: unknown, budget: BudgetContext, metadata: RelationalMetadata): void {
  try {
    budget.spend(1);
    if (typeof input === 'string') {
      budget.spend(1);
      const u = input.length;
      budget.check();
      relationalAmount(u); relationalAmount(budget.limits.stringBytes);
      if (u > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
      budget.reserve({ nodes: 1, structuralBytes: relationalAdd(16, relationalMul(2, u)) });
      budget.spend(relationalBlocks(u));
      const b = utf8ByteLength(input, budget);
      budget.check();
      relationalAmount(b);
      if (b > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
      metadata.outU = u; metadata.outB = b; metadata.outText = true;
      budget.check();
      return;
    }
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) return invalid();
    } else if (input !== null && input !== undefined && typeof input !== 'boolean') return invalid();
    metadata.outU = 0; metadata.outB = 0; metadata.outText = false;
    budget.check();
    return;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}


/** Standalone element checkpoint; graph dispatch is not integrated. */
function relationalElement(input: unknown, budget: BudgetContext, metadata: RelationalMetadata): void {
  try {
    budget.check();
    if (typeof input === 'string' || input === null || input === undefined) {
      relationalScalar(input, budget, metadata);
      budget.check();
      return;
    }
    budget.spend(1);
    if (typeof input !== 'number' && typeof input !== 'boolean') return invalid();
    if (typeof input === 'number' && !Number.isFinite(input)) return invalid();
    relationalAmount(budget.limits.stringBytes);
    // Both fixed bounds are 32; one comparison caps each before M.
    if (32 > Math.min(8_000_000, budget.limits.stringBytes)) throw new BudgetExceededError();
    relationalMaterialize(32, 32, budget);
    metadata.outU = 32; metadata.outB = 32; metadata.outText = true;
    budget.check();
    return;
  } catch (error) {
    if (error instanceof BudgetExceededError || error instanceof BudgetUnavailableError) throw error;
    budget.check(); throw error;
  }
}
