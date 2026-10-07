import 'server-only';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { stageLegacyFinalGeneration } from './finalGeneration';
import type { LegacyNormalizationManifest } from './manifest';

// The actual private DeltaPlan type, obtained without loading/calling its writer.
type Plan = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>['plan'];
type Records = LegacyNormalizationManifest['records'];

// Deliberately pinned, not inferred from caller keys. A static AST regression
// compares this with finalGeneration.ts IDENTITIES; catalog drift must be reviewed.
// These are normalized tables, NOT report.ts's count/sum/diagnostic categories.
export const LOCAL_DELTA_COVERAGE_CATALOG = Object.freeze([
  { table: 'students', identityKeys: ['studentId'] },
  { table: 'accounts', identityKeys: ['studentId'] },
  { table: 'products', identityKeys: ['productId'] },
  { table: 'settings', identityKeys: ['key'] },
  { table: 'tasks', identityKeys: ['taskInstanceId'] },
  { table: 'task_allowed_students', identityKeys: ['taskInstanceId', 'studentId'] },
  { table: 'promotions', identityKeys: ['promotionId'] },
  { table: 'promotion_products', identityKeys: ['promotionProductId'] },
  { table: 'transactions', identityKeys: ['transactionId'] },
  { table: 'transaction_items', identityKeys: ['itemId'] },
  { table: 'adjustments', identityKeys: ['adjustmentId'] },
  { table: 'task_assignments', identityKeys: ['assignmentId'] },
  { table: 'task_completions', identityKeys: ['completionId'] },
  { table: 'legacy_operation_bindings', identityKeys: ['operationId'] },
  { table: 'padlet_evidence_claims', identityKeys: ['tupleDigest'] },
  { table: 'padlet_claim_digest_tombstones', identityKeys: ['tupleDigest'] },
].map(({ table, identityKeys }) => Object.freeze({ table, identityKeys: Object.freeze(identityKeys) })));
const TABLES = new Set(LOCAL_DELTA_COVERAGE_CATALOG.map(({ table }) => table));
const MUTABLE_TABLES = new Set(['students', 'accounts', 'products', 'settings', 'tasks',
  'task_allowed_students', 'promotions', 'promotion_products']);
const MAX_ROWS = 4_000;
const MAX_NODES = 100_000;
const MAX_TEXT_BYTES = 1_000_000;
const MAX_STRING_LENGTH = 8_192;

/** Internal, pure consistency check of caller-supplied NORMALIZED records only.
 * Sparse absent tables mean zero supplied rows (as in the real delta planner),
 * never proof of absent source data. Accepts unchanged/ADDED only, even for mutable
 * tables; no publication, persisted acquisition, contributor/source digest,
 * tenant/job binding, domain/FK, credential or operational target verification.
 * A matching plan is NOT authenticated and must never authorize final import.
 *
 * Bounds are local admission limits, not the normalizer's BudgetContext contract:
 * 4000 rows per side/changes, 100000 visited nodes, 1MB total key/string bytes,
 * 8192 UTF-16 units per string/key, 128 object keys, array arity 4000, depth 16.
 * Plain JSON-shaped in-process data only; accessors, symbols/proxies are refused.
 * Property-name enumeration itself is a native operation, not a streaming parser.
 */
export function verifyLocalFullCategoryDeltaCoverage(original: Records, candidate: Records, plan: Plan) {
  return Object.freeze({ ...verifyCoverage(original, candidate, plan, false),
    scope: 'LOCAL_NORMALIZED_ADDED_DELTA_COVERAGE_ONLY' as const });
}

/** Explicit opt-in for mutable definitions only. Retained ledger/claim/tombstone
 * bytes must remain exact, including claim capture provenance. Does not authenticate
 * captures or prove domain constraints, storage, writer exclusion or activation. */
export function verifyLocalMutableCategoryDeltaCoverage(original: Records, candidate: Records, plan: Plan) {
  return Object.freeze({ ...verifyCoverage(original, candidate, plan, true),
    scope: 'LOCAL_NORMALIZED_MUTABLE_DELTA_COVERAGE_ONLY' as const });
}

function verifyCoverage(original: Records, candidate: Records, plan: Plan, allowMutable: boolean) {
  try {
    admit([original, candidate, plan]);
    for (const records of [original, candidate]) {
      if (!isRecord(records) || Object.keys(records).some((table) => !TABLES.has(table))) refuse();
      let count = 0;
      for (const rows of Object.values(records)) {
        if (!Array.isArray(rows)) refuse();
        count += rows.length;
        if (count > MAX_ROWS) refuse();
      }
    }
    if (!isRecord(plan) || !exactKeys(plan, ['status', 'changes', 'blockers'])
      || plan.status !== 'DIFF_VALIDATED' || !Array.isArray(plan.blockers) || plan.blockers.length
      || !Array.isArray(plan.changes) || plan.changes.length > MAX_ROWS) refuse();
    const expected = new Map<string, Plan['changes'][number]>();
    const coverage = LOCAL_DELTA_COVERAGE_CATALOG.map(({ table, identityKeys }) => {
      const before = index(Object.hasOwn(original, table) ? original[table] : [], identityKeys);
      const after = index(Object.hasOwn(candidate, table) ? candidate[table] : [], identityKeys);
      for (const [identity, digest] of before) {
        // Includes hidden MUTATED/REMOVED even if the plan simply omits them.
        const next = after.get(identity);
        if (next === digest) continue;
        if (!allowMutable || !MUTABLE_TABLES.has(table)) refuse();
        expected.set(canonical([table, identity]), { table, identity,
          kind: next === undefined ? 'REMOVED' : 'MUTATED', beforeDigest: digest, afterDigest: next ?? null });
      }
      let addedCount = 0;
      for (const [identity, digest] of after) {
        if (!before.has(identity)) {
          expected.set(canonical([table, identity]), { table, identity, kind: 'ADDED', beforeDigest: null, afterDigest: digest });
          addedCount++;
        }
      }
      return Object.freeze({ table, originalCount: before.size, candidateCount: after.size, addedCount });
    });
    // Compare the exact table/identity multiset, not category totals or a Set
    // silently dropping duplicates. Each independently expected change is used
    // exactly once. Digests here describe normalized rows, not source provenance.
    if (plan.changes.length !== expected.size) refuse();
    for (const change of plan.changes) {
      if (!isRecord(change) || !exactKeys(change, ['table', 'identity', 'kind', 'beforeDigest', 'afterDigest'])
        || typeof change.table !== 'string' || !TABLES.has(change.table)
        || typeof change.identity !== 'string') refuse();
      const key = canonical([change.table, change.identity]);
      if (!expected.has(key) || canonical(expected.get(key)) !== canonical(change)) refuse();
      expected.delete(key);
    }
    if (expected.size) refuse();
    return Object.freeze({
      status: 'COVERED_LOCAL_INPUTS' as const,
      authority: 'NONAUTHORITY' as const, exclusion: 'NOT_PROVEN' as const,
      complete: false as const, activationAllowed: false as const,
      sourceReconciliation: 'NOT_PERFORMED' as const, targetReconciliation: 'NOT_PERFORMED' as const,
      coverage: Object.freeze(coverage),
    });
  } catch { return refuse(); }
}

function index(rows: Records[string], keys: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    if (!isRecord(row)) refuse();
    const parts = keys.map((key) => {
      const value = row[key];
      if (!Object.hasOwn(row, key) || typeof value !== 'string' || !value || value.length > 512) refuse();
      return value;
    });
    const identity = canonical(parts);
    if (result.has(identity)) refuse();
    result.set(identity, createHash('sha256').update(canonical(row), 'utf8').digest('hex'));
  }
  return result;
}
function exactKeys(record: object, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Canonical semantics match validators.canonicalJson (code-unit sorted keys,
// finite numbers and exact strings). Used only AFTER bounded descriptor admission;
// no caller toJSON/getter is invoked. No general date/string coercion is applied.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function admit(root: unknown): void {
  let nodes = 0;
  let bytes = 0;
  const text = (value: string) => {
    if (value.length > MAX_STRING_LENGTH) refuse();
    bytes += Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_TEXT_BYTES) refuse();
  };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > 16) refuse();
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'string') { text(value); return; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) refuse(); return; }
    if (typeof value !== 'object' || types.isProxy(value)) refuse();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) refuse();
    if (array && value.length > MAX_ROWS) refuse();
    const keys = Reflect.ownKeys(value);
    if (array ? keys.length !== value.length + 1 : keys.length > 128) refuse();
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string') refuse();
      text(key);
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)) refuse();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) refuse();
      visit(descriptor.value, depth + 1);
    }
  };
  visit(root, 0);
}
function refuse(): never { throw new Error('Local delta coverage refused.'); }
