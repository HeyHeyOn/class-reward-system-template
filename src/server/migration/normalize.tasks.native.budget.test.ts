import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext, type BudgetContext } from '@/lib/boundedWork';
import * as bounded from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as validators from './validators';
import * as rows from '@/server/sheetsRows';
import { normalizeLegacySnapshots as run } from './normalize';
type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/task-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input }[] };
function input(b?: BudgetContext, name = 'current-none') { const value = golden.cases.find(f => f.name === name)!.input; return b ? parseRegisteredBoundedJson(JSON.stringify(value), b) as Input : value; }
const sites = [['canonical', 317, 17], ['task staged', 720, 40], ['link staged', 196, 12], ['ref', 55, 5], ['error', 8, 1, 'duplicate-allowed'], ['self', 8, 1, 'self-prerequisite'], ['malformed', 8, 2, 'invalid-current']] as const;
describe('Tasks independent closed work recipes', () => {
  for (const [name, bytes, work, fixture] of sites) for (const delta of [-1, 0, 1]) it(`${name} ${delta}`, () => {
    const native = bounded.allocate, stop = new Error('reached real recipe'); let ordinal = 0, selected = 0, last = 0, armed = false;
    const real = createBudgetContext({ now: () => 0 });
    const b: BudgetContext = { ...real, spend(amount = 1) { if (armed) { ordinal++; last = amount; } real.spend(amount); } };
    const admitted = input(b, fixture); armed = true;
    const locate = vi.spyOn(bounded, 'allocate').mockImplementation((owner, cost, make) => { if (owner === b && cost.structuralBytes === bytes) { selected = ordinal; throw stop; } return native(owner, cost, make); });
    try { run(admitted, b); } catch (e) { expect(e).toBe(stop); } finally { locate.mockRestore(); }
    expect(selected).toBeGreaterThan(0); expect(last).toBe(work);
    let current = 0, active = false, factories = 0, reached = false, error: unknown;
    const counter = createBudgetContext({ now: () => 0 });
    const context: BudgetContext = { ...counter, spend(amount = 1) { if (active && ++current === selected) { reached = true; counter.spend(counter.limits.work - counter.usage().work - work - delta); } counter.spend(amount); } };
    const next = input(context, fixture); active = true;
    const factory = vi.spyOn(bounded, 'allocate').mockImplementation((owner, cost, make) => { if (owner === context && cost.structuralBytes === bytes) return native(owner, cost, () => { factories++; throw stop; }); return native(owner, cost, make); });
    try { run(next, context); } catch (e) { error = e; } finally { factory.mockRestore(); }
    expect(reached).toBe(true); expect(factories).toBe(delta < 0 ? 0 : 1); if (delta < 0) expect(error).toBeInstanceOf(BudgetExceededError); else expect(error).toBe(stop);
  });
  it('precharges parsed warning predicate before reading mutable result', () => {
    const b = createBudgetContext({ now: () => 0 }), admitted = input(b), parser = rows.parseTaskRow;
    let reached = 0, work = 0;
    const spy = vi.spyOn(rows, 'parseTaskRow').mockImplementation((row, index, zone, owner) => {
      const result = parser(row, index, zone, owner);
      if (owner === b && result) { const start = b.usage().work, warnings = result.scheduleReadWarnings; Object.defineProperty(result, 'scheduleReadWarnings', { get() { reached++; work = b.usage().work - start; return warnings; } }); }
      return result;
    });
    try { run(admitted, b); } finally { spy.mockRestore(); }
    expect(reached).toBe(1); expect(work).toBe(3);
  });
  for (const site of ['scalar-condition', 'parser-condition'] as const) for (const delta of [-1, 0, 1]) it(`${site} precondition ${delta}`, () => {
    let armed = false, reached = 0, error: unknown;
    const cost = site === 'scalar-condition' ? 20 : 3, real = createBudgetContext({ now: () => 0 });
    const b: BudgetContext = { ...real, spend(amount = 1) { if (armed && amount === cost && !reached) { reached++; real.spend(real.limits.work - real.usage().work - cost - delta); } real.spend(amount); } };
    const admitted = input(b), instant = validators.canonicalInstant, parse = rows.parseTaskRow;
    const i = vi.spyOn(validators, 'canonicalInstant').mockImplementation((value, owner) => { const result = instant(value, owner); if (site === 'scalar-condition' && owner === b && value === '2026-09-01T00:00:00.000Z') armed = true; return result; });
    const p = vi.spyOn(rows, 'parseTaskRow').mockImplementation((row, index, zone, owner) => { const result = parse(row, index, zone, owner); if (site === 'parser-condition' && owner === b) armed = true; return result; });
    try { run(admitted, b); } catch (e) { error = e; } finally { i.mockRestore(); p.mockRestore(); }
    expect(armed).toBe(true); expect(reached).toBe(1); expect(error).toBeInstanceOf(BudgetExceededError);
  });
});

describe('Tasks actual scalar/hash native success and exception exits', () => {
  for (const site of ['chronology', 'instance-trim', 'hash-update', 'hash-digest', 'id-slice'] as const)
    for (const state of ['timely', 'expired', 'aborted', 'no-budget'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const)
      it(`${site} ${state} ${exit}`, () => {
        let now = 0, armed = false, reached = 0, error: unknown;
        const signal = { aborted: false }, b = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal }), value = input(b);
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native task sentinel');
        const touch = () => { reached++; armed = false; if (state === 'expired') now = 5000; if (state === 'aborted') signal.aborted = true; if (exit !== 'success') throw sentinel; };
        const canonical = validators.canonicalInstant, id = validators.canonicalId, guarded = validators.deterministicIdWithBudget, legacy = validators.deterministicId;
        const instant = vi.spyOn(validators, 'canonicalInstant').mockImplementation((v, owner) => { const result = canonical(v, owner); if (site === 'chronology' && !reached && v === '2026-09-01T00:00:00.000Z' && owner === b) armed = true; return result; });
        const identity = vi.spyOn(validators, 'canonicalId').mockImplementation((v, owner) => { if (site === 'instance-trim' && !reached && v === 'TI1' && owner === b) armed = true; return id(v, owner); });
        const hash = vi.spyOn(validators, 'deterministicIdWithBudget').mockImplementation((owner, ...parts) => { if (site.startsWith('hash') || site === 'id-slice') if (owner === b && parts[1] === 'task_allowed_students' && !reached) armed = true; return guarded(owner, ...parts); });
        const oldHash = vi.spyOn(validators, 'deterministicId').mockImplementation((...parts: string[]) => { if (site.startsWith('hash') || site === 'id-slice') if (!b && parts[1] === 'task_allowed_students' && !reached) armed = true; return legacy(...parts); });
        const parse = Date.parse, trim = String.prototype.trim, slice = String.prototype.slice;
        const proto = Object.getPrototypeOf(createHash('sha256')) as ReturnType<typeof createHash>, update = proto.update, digest = proto.digest;
        Date.parse = function (v) { if (site === 'chronology' && armed) touch(); return parse(v); };
        String.prototype.trim = function () { if (site === 'instance-trim' && armed) touch(); return trim.call(this); };
        String.prototype.slice = function (start, end) { if (site === 'id-slice' && armed && this.length === 64) touch(); return slice.call(this, start, end); };
        proto.update = function (this: typeof proto, ...args: Parameters<typeof update>) { if (site === 'hash-update' && armed) touch(); return update.apply(this, args); } as typeof update;
        proto.digest = function (this: typeof proto, ...args: Parameters<typeof digest>) { if (site === 'hash-digest' && armed) touch(); return digest.apply(this, args); } as typeof digest;
        try { run(value, b); } catch (e) { error = e; } finally { Date.parse = parse; String.prototype.trim = trim; String.prototype.slice = slice; proto.update = update; proto.digest = digest; instant.mockRestore(); identity.mockRestore(); hash.mockRestore(); oldHash.mockRestore(); }
        expect(reached).toBe(1);
        if (exit === 'exceeded' || exit === 'unavailable' || ((state === 'timely' || state === 'no-budget') && exit === 'ordinary')) expect(error).toBe(sentinel);
        else if (state === 'expired' || state === 'aborted') expect(error).toBeInstanceOf(BudgetUnavailableError); else expect(error).toBeUndefined();
      });
  for (const guarded of [false, true]) it(`malformed native financial predicate order budget=${guarded}`, () => {
    const b = guarded ? createBudgetContext({ now: () => 0 }) : undefined, value = input(b, 'invalid-current'), has = Set.prototype.has, push = Array.prototype.push;
    const sentinel = new RangeError('original financial predicate'); let reached = 0, appended = 0, error: unknown;
    Set.prototype.has = function (key) { if (key === 'Tasks' && this.size === 4 && has.call(this, 'Transactions') && has.call(this, 'TaskCompletions')) { reached++; throw sentinel; } return has.call(this, key); };
    Array.prototype.push = function (...values: unknown[]) { if (values[0] === 'MALFORMED_REQUIRED_RECORD') appended++; return push.apply(this, values); };
    try { run(value, b); } catch (e) { error = e; } finally { Set.prototype.has = has; Array.prototype.push = push; }
    expect(reached).toBe(1); expect(error).toBe(sentinel); expect(appended).toBe(0);
  });
});
