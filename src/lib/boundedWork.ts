/** Cumulative logical accounting, not a JavaScript heap sandbox or native-call interrupt.
 * One owner creates a context for the whole request; consumers never reset it.
 * No Node, server, environment, or application imports: shared parsers may use it.
 */
export type Allocation = Readonly<Partial<{
  nodes: number; slots: number; contentBytes: number; structuralBytes: number;
}>>;
export type BudgetLimits = Readonly<{
  nodes: number; slots: number; contentBytes: number; structuralBytes: number;
  work: number; stringBytes: number; depth: number; deadlineMs: number;
}>;
export const NORMALIZATION_BUDGET_LIMITS: BudgetLimits = Object.freeze({
  nodes: 1_200_000, slots: 1_200_000, contentBytes: 32_000_000,
  structuralBytes: 32_000_000, work: 5_000_000, stringBytes: 8_000_000,
  depth: 64, deadlineMs: 5_000,
});
export class BudgetExceededError extends Error {
  constructor() { super('Legacy normalization budget exceeded.'); this.name = 'BudgetExceededError'; }
}
export class BudgetUnavailableError extends Error {
  constructor() { super('Legacy normalization budget unavailable.'); this.name = 'BudgetUnavailableError'; }
}
export type BudgetUsage = Readonly<{
  nodes: number; slots: number; contentBytes: number; structuralBytes: number; work: number;
}>;
export interface BudgetContext {
  readonly limits: BudgetLimits;
  check(): void;
  reserve(cost: Allocation): void;
  spend(amount?: number): void;
  checkDepth(depth: number): void;
  /** Charge one newly allocated string/buffer payload, never a shared reference. */
  reserveString(bytes: number): void;
  usage(): BudgetUsage;
}

function validAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new BudgetExceededError();
}

export function createBudgetContext(options: Readonly<{
  /** Testing or stricter consumers may lower ceilings, never raise them. */
  limits?: Partial<BudgetLimits>;
  now?: () => number;
  signal?: Readonly<{ aborted: boolean }>;
}> = {}): BudgetContext {
  const limits = Object.freeze({ ...NORMALIZATION_BUDGET_LIMITS, ...options.limits });
  for (const key of Object.keys(NORMALIZATION_BUDGET_LIMITS) as (keyof BudgetLimits)[]) {
    validAmount(limits[key]);
    if (limits[key] > NORMALIZATION_BUDGET_LIMITS[key]) throw new BudgetExceededError();
  }
  const now = options.now ?? (() => performance.now());
  const signal = options.signal;
  const started = now();
  if (!Number.isFinite(started)) throw new BudgetUnavailableError();
  let last = started;
  const used = { nodes: 0, slots: 0, contentBytes: 0, structuralBytes: 0, work: 0 };
  function check(): void {
    const current = now();
    if (signal?.aborted || !Number.isFinite(current) || current < last
      || current - started >= limits.deadlineMs) throw new BudgetUnavailableError();
    last = current;
  }
  function addition(key: keyof BudgetUsage, amount: number): void {
    validAmount(amount);
    // Subtraction avoids overflow, even for a deliberately hostile safe integer.
    if (amount > limits[key] - used[key]) throw new BudgetExceededError();
  }
  function reserve(cost: Allocation): void {
    check();
    const nodes = cost.nodes ?? 0, slots = cost.slots ?? 0;
    const content = cost.contentBytes ?? 0, structural = cost.structuralBytes ?? 0;
    addition('nodes', nodes); addition('slots', slots);
    addition('contentBytes', content); addition('structuralBytes', structural);
    used.nodes += nodes; used.slots += slots;
    used.contentBytes += content; used.structuralBytes += structural;
  }
  const context: BudgetContext = {
    limits, check, reserve,
    spend(amount = 1) { check(); addition('work', amount); used.work += amount; },
    checkDepth(depth) { check(); validAmount(depth); if (depth > limits.depth) throw new BudgetExceededError(); },
    reserveString(bytes) {
      check(); validAmount(bytes);
      if (bytes > limits.stringBytes) throw new BudgetExceededError();
      reserve({ nodes: 1, contentBytes: bytes, structuralBytes: 4 });
    },
    // Counter snapshots and fixed-size context metadata are not input-derived graphs.
    usage() { return Object.freeze({ ...used }); },
  };
  check();
  return Object.freeze(context);
}

/** The recipe must describe the allocation BEFORE evaluating its arguments.
 * Callers must not construct payloads in the cost expression or close over an
 * already-created replacement object and claim that object was pre-reserved.
 */
export function allocate<T>(budget: BudgetContext | undefined, cost: Allocation, factory: () => T): T {
  budget?.reserve(cost);
  const value = factory();
  budget?.check();
  return value;
}

/** UTF-8 replacement semantics for lone surrogates, without TextEncoder allocation. */
export function utf8ByteLength(value: string, budget?: BudgetContext): number {
  let bytes = 0, chargedThrough = 0;
  function codeAt(index: number): number {
    if (index >= chargedThrough) { budget?.spend(); chargedThrough += 256; }
    return value.charCodeAt(index);
  }
  for (let i = 0; i < value.length; i++) {
    const code = codeAt(i);
    if (code < 128) bytes++;
    else if (code < 2048) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = codeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
      else bytes += 3;
    } else bytes += 3;
  }
  budget?.check();
  return bytes;
}

/** Stable bottom-up merge sort. Two arrays hold shared references, not payload copies.
 * Comparators must separately charge input-length-dependent string/native work.
 */
export function stableBudgetSort<T>(input: readonly T[], compare: (left: T, right: T) => number, budget?: BudgetContext): T[] {
  if (!budget) return input.slice().sort(compare);
  const length = input.length;
  budget.reserve({ nodes: 2, slots: 2 * length, structuralBytes: 32 + 8 * length });
  let source = new Array<T>(length), scratch = new Array<T>(length);
  for (let i = 0; i < length; i++) { budget.spend(); source[i] = input[i]; }
  for (let width = 1; width < length; width *= 2) {
    budget.spend();
    for (let start = 0; start < length; start += width * 2) {
      budget.spend();
      const mid = Math.min(start + width, length), end = Math.min(start + 2 * width, length);
      let left = start, right = mid;
      for (let output = start; output < end; output++) {
        budget.spend();
        let takeLeft = right >= end;
        if (left < mid && right < end) {
          budget.spend();
          const order = compare(source[left], source[right]);
          budget.check();
          // Array.sort treats NaN as equality; retain that stable behavior.
          takeLeft = order <= 0 || Number.isNaN(order);
        }
        budget.spend();
        scratch[output] = takeLeft ? source[left++] : source[right++];
      }
    }
    const swap = source; source = scratch; scratch = swap;
  }
  budget.check();
  return source;
}


/** Array operands are already admitted by the parser boundary. The callback owns
 * its payload recipe; reserving only this result list cannot certify that payload. */
export function mapBudgetList<T, U>(input: readonly T[], map: (value: T, index: number) => U, budget?: BudgetContext): U[] {
  budget?.reserve({ nodes: 1, slots: input.length, structuralBytes: 16 + 4 * input.length });
  budget?.spend();
  const output = input.map((value, index) => { budget?.spend(); const result = map(value, index); budget?.check(); return result; });
  budget?.check(); return output;
}
export function trimBudgetString(value: string, budget?: BudgetContext): string {
  if (budget) { budget.reserveString(utf8ByteLength(value, budget)); budget.spend(1 + Math.ceil(value.length / 256)); }
  const result = value.trim(); budget?.check(); return result;
}
export function equalBudgetValue<const T>(left: unknown, right: T, budget?: BudgetContext): left is T {
  budget?.spend(1 + (typeof left === 'string' ? Math.ceil(left.length / 256) : 0) + (typeof right === 'string' ? Math.ceil(right.length / 256) : 0));
  const result = left === right; budget?.check(); return result;
}
export function uniqueBudgetStrings(values: readonly string[], budget?: BudgetContext): boolean {
  if (!budget) return new Set(values).size === values.length;
  budget.reserve({ nodes: 1, structuralBytes: 16 }); budget.spend();
  const seen = new Set<string>();
  for (let i = 0; i < values.length; i++) { budget.spend(); addBudgetSet(seen, values[i], budget); }
  return seen.size === values.length;
}

/** Helpers accept application-owned native collections, NOT unknown JSON graphs. */
export function setBudgetMap<V>(map: Map<string, V>, key: string, value: () => V, budget?: BudgetContext): void {
  if (budget) {
    budget.spend(3 + 2 * Math.ceil(key.length / 256));
    if (!map.has(key)) budget.reserve({ slots: 2, structuralBytes: 8 });
  }
  const child = value(); budget?.check(); map.set(key, child);
}
export function addBudgetSet(set: Set<string>, value: string, budget?: BudgetContext): void {
  if (budget) {
    budget.spend(2 + 2 * Math.ceil(value.length / 256));
    if (!set.has(value)) budget.reserve({ slots: 1, structuralBytes: 4 });
  }
  set.add(value);
}
export function appendBudgetList<T>(list: T[], value: () => T, budget?: BudgetContext): void {
  budget?.spend(); budget?.reserve({ slots: 1, structuralBytes: 4 });
  const child = value(); budget?.check(); list.push(child);
}
export function splitBudgetString(value: string, delimiter: ',' | '|', budget?: BudgetContext): string[] {
  if (budget) {
    // Fixed single-code-unit delimiters only. Scan before native split, never
    // materialize substrings to discover the number of slots they require.
    if (delimiter !== ',' && delimiter !== '|') throw new BudgetExceededError();
    let count = 1;
    for (let index = 0; index < value.length; index++) {
      if (index % 256 === 0) budget.spend();
      if (value[index] === delimiter) count++;
    }
    const bytes = utf8ByteLength(value, budget);
    if (bytes > budget.limits.stringBytes) throw new BudgetExceededError();
    budget.reserve({ nodes: 1 + count, slots: count, contentBytes: bytes,
      structuralBytes: 16 + 8 * count });
    budget.spend(1 + Math.ceil(value.length / 256));
  }
  const result = value.split(delimiter); budget?.check(); return result;
}
