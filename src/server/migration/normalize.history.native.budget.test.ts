import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';
import * as bounded from '@/lib/boundedWork';
import * as validators from './validators';
import { normalizeLegacySnapshots as run } from './normalize';

type Input = Parameters<typeof run>[0];
const golden = JSON.parse(readFileSync('src/server/migration/__fixtures__/history-construction-golden.json', 'utf8')) as { cases: { name: string; input: Input }[] };

describe('history native success/error deadline and original budget identity', () => {
  for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbudgeted'] as const) it(`ADMIN_RESET final numeric predicate ${exit} ${state}`, () => {
    let now = 0; const abort = new AbortController(), b = state === 'unbudgeted' ? undefined : createBudgetContext({ now: () => now, signal: abort.signal });
    const fixture = structuredClone(golden.cases.find(c => c.name === 'valid-evidence-bank-quarantine')!.input), tab = fixture.sheets.tabs.TaskCompletions;
    for (const [key, value] of Object.entries({ source: 'ADMIN_RESET', status: 'RESET', reward: '10', balanceBefore: '-90', balanceAfter: '-100' })) (tab.rows[0].cells as string[])[tab.headers.indexOf(key)] = value;
    const input = b ? parseRegisteredBoundedJson(JSON.stringify(fixture), b) as Input : fixture;
    const integer = Number.isSafeInteger, lower = String.prototype.toLowerCase, equal = bounded.equalBudgetValue;
    const injected = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('final native predicate');
    let armed = false, reached = 0, next = 0, error: unknown;
    String.prototype.toLowerCase = function () { const result = lower.call(this); if (result.startsWith('sha256:')) armed = true; return result; };
    Number.isSafeInteger = function (value) { if (armed && value === -100) { reached++; if (state === 'expired') now = 5001; if (state === 'aborted') abort.abort(); if (exit !== 'success') throw injected; } return integer(value); };
    const spy = vi.spyOn(bounded, 'equalBudgetValue').mockImplementation((left, right, owner) => { if (reached) next++; return equal(left, right, owner); });
    try { run(input, b); } catch (e) { error = e; } finally { Number.isSafeInteger = integer; String.prototype.toLowerCase = lower; spy.mockRestore(); }
    expect(reached).toBe(1);
    if (exit === 'success' && (state === 'expired' || state === 'aborted')) expect(next).toBe(0);
    if (exit !== 'success' && (exit !== 'ordinary' || state === 'timely' || state === 'unbudgeted')) expect(error).toBe(injected);
    else if (b && (state === 'expired' || state === 'aborted')) expect(error).toBeInstanceOf(BudgetUnavailableError); else expect(error).toBeUndefined();
  });
  it('lowercase copy is reserved after the actual payload trim and before native lower', () => {
    const b = createBudgetContext({ now: () => 0 }), f = golden.cases.find(c => c.name === 'valid-evidence-bank-quarantine')!, input = parseRegisteredBoundedJson(JSON.stringify(f.input), b) as Input;
    const trim = String.prototype.trim, lower = String.prototype.toLowerCase; let reached = 0, calls = 0, error: unknown;
    String.prototype.trim = function () { const result = trim.call(this); if (!reached && result.startsWith('sha256:')) { reached++; b.reserve({ contentBytes: b.limits.contentBytes - b.usage().contentBytes }); } return result; };
    String.prototype.toLowerCase = function () { if (reached) calls++; return lower.call(this); };
    try { run(input, b); } catch (e) { error = e; } finally { String.prototype.trim = trim; String.prototype.toLowerCase = lower; }
    expect(reached).toBe(1); expect(calls).toBe(0); expect(error).toBeInstanceOf(BudgetExceededError);
  });
  for (const operation of ['lower', 'boardRegex', 'postRegex', 'chronology'] as const) for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) for (const state of ['timely', 'expired', 'aborted', 'unbudgeted'] as const) it(`${operation} ${exit} ${state}`, () => {
    let now = 0; const abort = new AbortController(), b = state === 'unbudgeted' ? undefined : createBudgetContext({ now: () => now, signal: abort.signal });
    const f = golden.cases.find(c => c.name === 'valid-evidence-bank-quarantine')!;
    const input = b ? parseRegisteredBoundedJson(JSON.stringify(f.input), b) as Input : f.input;
    const ordinary = new RangeError('native boundary'), injected = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : ordinary;
    const lower = String.prototype.toLowerCase, regex = RegExp.prototype.test, parse = Date.parse, instant = validators.canonicalInstant;
    let reached = 0, armed = false, validatedAt = 0, nextNative = 0, error: unknown;
    const touch = () => { reached++; if (state === 'expired') now = 5001; if (state === 'aborted') abort.abort(); if (exit !== 'success') throw injected; };
    const spy = vi.spyOn(validators, 'canonicalInstant').mockImplementation((value, owner) => { const result = instant(value, owner); if (value === '2026-08-31T00:00:00.000Z' && ++validatedAt === 2) armed = true; return result; });
    String.prototype.toLowerCase = function () { if (operation === 'lower' && String(this).startsWith('sha256:') && !reached) touch(); return lower.call(this); };
    RegExp.prototype.test = function (value) {
      if (operation === 'lower' && reached) nextNative++;
      if (!reached && ((operation === 'boardRegex' && this.source === '^[A-Za-z0-9]{16,22}$') || (operation === 'postRegex' && this.source === '^[A-Za-z0-9_-]{3,128}$'))) touch();
      return regex.call(this, value);
    };
    Date.parse = function (value) { if (operation === 'chronology' && reached) nextNative++; if (operation === 'chronology' && armed && value === '2026-09-01T00:00:00.000Z' && !reached) touch(); return parse(value); };

    try { run(input, b); } catch (e) { error = e; } finally { String.prototype.toLowerCase = lower; RegExp.prototype.test = regex; Date.parse = parse; spy.mockRestore(); }
    expect(reached).toBe(1);
    if (exit === 'success' && (state === 'expired' || state === 'aborted') && (operation === 'lower' || operation === 'chronology')) expect(nextNative).toBe(0);
    if (exit !== 'success' && (exit !== 'ordinary' || state === 'timely' || state === 'unbudgeted')) expect(error).toBe(injected);
    else if (b && (state === 'expired' || state === 'aborted')) expect(error).toBeInstanceOf(BudgetUnavailableError);
    else expect(error).toBeUndefined();
  });
  it('evidence tuple and canonical binding hashes use the same context without certifying mutable output', () => {
    const b = createBudgetContext({ now: () => 0 }), f = golden.cases.find(c => c.name === 'valid-evidence-bank-quarantine')!, input = parseRegisteredBoundedJson(JSON.stringify(f.input), b) as Input;
    const hash = vi.spyOn(validators, 'sha256');
    try { run(input, b); const tuples = hash.mock.calls.filter(c => c[0] === 'BOARD123456789012\0POST-1'); const bindings = hash.mock.calls.filter(c => c[0].startsWith('{"cycleStartsAt"')); expect(tuples.some(c => c[1] === b)).toBe(true); expect(bindings.some(c => c[1] === b)).toBe(true); }
    finally { hash.mockRestore(); }
  });
});
