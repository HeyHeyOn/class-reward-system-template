// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { stageLegacyFinalGeneration } from './finalGeneration';
import { LOCAL_DELTA_COVERAGE_CATALOG, verifyLocalFullCategoryDeltaCoverage,
  verifyLocalMutableCategoryDeltaCoverage } from './localFullCategoryDeltaCoverage';
import { canonicalJson, sha256 } from './validators';
vi.mock('server-only', () => ({}));
type Plan = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>['plan'];
const mutable = ['students', 'accounts', 'products', 'settings', 'tasks', 'task_allowed_students', 'promotions', 'promotion_products'];
const row = (table: string, value: string) => ({ ...Object.fromEntries(LOCAL_DELTA_COVERAGE_CATALOG
  .find(entry => entry.table === table)!.identityKeys.map(key => [key, key])), value });
function change(table: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): Plan {
  const keys = LOCAL_DELTA_COVERAGE_CATALOG.find(entry => entry.table === table)!.identityKeys;
  return { status: 'DIFF_VALIDATED', blockers: [], changes: [{ table,
    identity: canonicalJson(keys.map(key => (before ?? after)![key])),
    kind: before === null ? 'ADDED' : after === null ? 'REMOVED' : 'MUTATED',
    beforeDigest: before && sha256(canonicalJson(before)), afterDigest: after && sha256(canonicalJson(after)) }] };
}
describe('explicit mutable delta consistency; not a capture or activation proof', () => {
  it.each(mutable)('accounts for update and removal of %s without weakening the old ADDED gate', table => {
    const before = row(table, 'before'), after = row(table, 'after');
    for (const candidate of [after, null]) {
      const original = { [table]: [before] }, final = { [table]: candidate ? [candidate] : [] };
      const plan = change(table, before, candidate);
      expect(verifyLocalMutableCategoryDeltaCoverage(original, final, plan)).toMatchObject({
        status: 'COVERED_LOCAL_INPUTS', authority: 'NONAUTHORITY', complete: false, activationAllowed: false,
      });
      expect(() => verifyLocalFullCategoryDeltaCoverage(original, final, plan)).toThrow('Local delta coverage refused.');
    }
  });
  it.each(LOCAL_DELTA_COVERAGE_CATALOG.filter(entry => !mutable.includes(entry.table)).map(entry => entry.table))(
    'never changes or drops retained ledger/claim/tombstone %s', table => {
      const before = row(table, 'before');
      for (const after of [row(table, 'after'), null]) {
        expect(() => verifyLocalMutableCategoryDeltaCoverage({ [table]: [before] }, { [table]: after ? [after] : [] },
          change(table, before, after))).toThrow('Local delta coverage refused.');
      }
      expect(verifyLocalMutableCategoryDeltaCoverage({}, { [table]: [before] }, change(table, null, before)).status)
        .toBe('COVERED_LOCAL_INPUTS');
    });
  it('rejects omissions, duplicate changes, wrong digests/kinds and hidden protected changes', () => {
    const before = row('products', 'before'), after = row('products', 'after');
    const original = { products: [before] }, candidate = { products: [after] };
    const plan = change('products', before, after);
    const entry = plan.changes[0];
    for (const changes of [[], [entry, entry], [{ ...entry, beforeDigest: '0'.repeat(64) }],
      [{ ...entry, afterDigest: '0'.repeat(64) }], [{ ...entry, kind: 'ADDED' as const, beforeDigest: null }]]) {
      expect(() => verifyLocalMutableCategoryDeltaCoverage(original, candidate, { ...plan, changes })).toThrow();
    }
    expect(() => verifyLocalMutableCategoryDeltaCoverage({ ...original, transactions: [row('transactions', 'ledger')] },
      candidate, plan)).toThrow();
    expect(() => verifyLocalMutableCategoryDeltaCoverage(new Proxy(original, {}), candidate, plan)).toThrow();
  });
});
