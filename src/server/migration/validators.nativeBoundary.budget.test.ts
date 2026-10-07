import {it, expect} from 'vitest';
import {createBudgetContext, BudgetUnavailableError, BudgetExceededError} from '@/lib/boundedWork';
import {safeInteger, canonicalInstant, canonicalId, finiteNumber, isHexDigest} from './validators';
for (const helper of ['safeInteger','canonicalInstant','canonicalId'] as const) {
  for (const state of ['timely','expired','aborted','no-budget'] as const) {
    for (const exit of ['success','ordinary','exceeded','unavailable'] as const) {
      it(`direct ${helper} ${state} ${exit}`, () => {
        let now = 0, reached = 0; const signal = {aborted:false};
        const b = state === 'no-budget' ? undefined : createBudgetContext({now:()=>now,signal});
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native scalar');
        const safe = Number.isSafeInteger, parse = Date.parse, trim = String.prototype.trim;
        const hit = () => { reached++; if(state==='expired') now=5000; if(state==='aborted')signal.aborted=true; if(exit!=='success') throw sentinel; };
        if(helper==='safeInteger') Number.isSafeInteger = function(v) { if(v===-10)hit(); return safe(v); };
        if(helper==='canonicalInstant') Date.parse = function(v) { hit(); return parse(v); };
        if(helper==='canonicalId') String.prototype.trim = function() { hit(); return trim.call(this); };
        let error:unknown;
        try { if(helper==='safeInteger')safeInteger('-10',undefined,b); else if(helper==='canonicalInstant')canonicalInstant('2026-08-31T00:00:00.000Z',b); else canonicalId('S1',b); } catch(e){error=e;}
        finally {Number.isSafeInteger=safe;Date.parse=parse;String.prototype.trim=trim;}
        expect(reached).toBe(1);
        if(exit==='exceeded'||exit==='unavailable'||((state==='timely'||state==='no-budget')&&exit==='ordinary'))expect(error).toBe(sentinel);
        else if(state==='expired'||state==='aborted')expect(error).toBeInstanceOf(BudgetUnavailableError);
        else expect(error).toBeUndefined();
      });
    }
  }
}

// Direct sibling exits: no normalizer catch is allowed to mask a late native result.
for (const seam of ['integer-number', 'integer-regex', 'integer-false', 'finite-number', 'finite-final', 'finite-false', 'instant-finite-false', 'instant-format', 'id-regex-control'] as const) {
  for (const state of ['timely', 'expired', 'aborted', 'no-budget'] as const) {
    for (const exit of ['success', 'ordinary', 'exceeded', 'unavailable'] as const) {
      it(`sibling ${seam} ${state} ${exit}`, () => {
        let now = 0, reached = 0;
        const signal = { aborted: false };
        const budget = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal });
        const sentinel = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native sibling');
        const hit = () => {
          reached++;
          if (state === 'expired') now = 5000;
          if (state === 'aborted') signal.aborted = true;
          if (exit !== 'success') throw sentinel;
        };
        const number = globalThis.Number, safe = Number.isSafeInteger, finite = Number.isFinite;
        const regex = RegExp.prototype.test, iso = Date.prototype.toISOString;
        if (seam === 'integer-number' || seam === 'finite-number') {
          globalThis.Number = new Proxy(number, { apply(target, receiver, args) {
            if (args[0] === '-10') hit();
            return Reflect.apply(target, receiver, args);
          } });
        }
        if (seam === 'integer-regex' || seam === 'id-regex-control') RegExp.prototype.test = function(value) { if (value === '-10' || value === 'a'.repeat(64)) hit(); return regex.call(this, value); };
        if (seam === 'integer-false') Number.isSafeInteger = function(value) { if (value === -10) { hit(); return false; } return safe(value); };
        if (seam === 'finite-final' || seam === 'finite-false' || seam === 'instant-finite-false') Number.isFinite = function(value) {
          if (value === -10 || value === 1788134400000) { hit(); return seam === 'finite-final' ? finite(value) : false; }
          return finite(value);
        };
        if (seam === 'instant-format') Date.prototype.toISOString = function() { hit(); return iso.call(this); };
        let error: unknown, result: unknown;
        try {
          if (seam.startsWith('integer')) result = safeInteger('-10', undefined, budget);
          else if (seam.startsWith('finite')) result = finiteNumber('-10', -100, 100, budget);
          else if (seam === 'id-regex-control') result = isHexDigest('a'.repeat(64), budget);
          else result = canonicalInstant('2026-08-31T00:00:00.000Z', budget);
        } catch (caught) { error = caught; }
        finally {
          globalThis.Number = number; Number.isSafeInteger = safe; Number.isFinite = finite;
          RegExp.prototype.test = regex; Date.prototype.toISOString = iso;
        }
        expect(reached).toBe(1);
        if (exit === 'exceeded' || exit === 'unavailable' || ((state === 'timely' || state === 'no-budget') && exit === 'ordinary')) expect(error).toBe(sentinel);
        else if (state === 'expired' || state === 'aborted') expect(error).toBeInstanceOf(BudgetUnavailableError);
        else {
          expect(error).toBeUndefined();
          expect(result).toBe(seam.endsWith('false') ? null : seam === 'instant-format' ? '2026-08-31T00:00:00.000Z' : seam === 'id-regex-control' ? true : -10);
        }
      });
    }
  }
}
