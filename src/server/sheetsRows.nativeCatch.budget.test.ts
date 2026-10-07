import { describe, expect, it, vi } from 'vitest';
import { createHeaderIndex, parsePromotionRow, parseTaskRow, REQUIRED_PROMOTION_COLUMNS } from './sheetsRows';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext } from '@/lib/boundedWork';
import { parseRegisteredBoundedJson } from '@/lib/boundedJson';

const iso = '2026-01-01T00:00:00.000Z';
const NativeDate = Date;
const NativeNumber = Number;
const timestamp = NativeDate.parse(iso);
const seams = ['date-parse', 'date-constructor', 'iso', 'task-number', 'promotion-number', 'finite'] as const;
const exits = ['success', 'ordinary', 'exceeded', 'unavailable'] as const;
const states = ['timely', 'expired', 'aborted', 'no-budget'] as const;

describe('reachable row native catches preserve existing budget exception identity first', () => {
  for (const seam of seams) for (const exit of exits) for (const state of states) {
    it(`${seam} ${exit} ${state}`, () => {
      let now = 0;
      const controller = new AbortController();
      const budget = state === 'no-budget' ? undefined : createBudgetContext({ now: () => now, signal: controller.signal });
      const isTask = seam === 'task-number' || seam === 'finite';
      const raw = isTask
        ? { headers: ['taskId', 'title', 'reward'], row: ['T1', 'Task', '-731'] }
        : { headers: [...REQUIRED_PROMOTION_COLUMNS], row: ['P1', 'Promotion', '', 'FIXED_DISCOUNT', '1', '', '', iso, '2026-02-01T00:00:00.000Z', 'TRUE', '731', iso, iso, '3'] };
      const input = budget ? parseRegisteredBoundedJson(JSON.stringify(raw), budget) as typeof raw : raw;
      const map = createHeaderIndex(input.headers, budget);
      const injected = exit === 'exceeded' ? new BudgetExceededError() : exit === 'unavailable' ? new BudgetUnavailableError() : new RangeError('native sentinel');
      let reached = 0;
      const boundary = () => {
        reached++;
        if (state === 'expired') now = 6000;
        if (state === 'aborted') controller.abort();
        if (exit !== 'success') throw injected;
      };
      let result: unknown;
      let caught: unknown;
      try {
        if (seam === 'date-parse') {
          vi.spyOn(Date, 'parse').mockImplementation(value => { if (value === iso) boundary(); return NativeDate.prototype.getTime.call(new NativeDate(value)); });
        } else if (seam === 'date-constructor') {
          vi.stubGlobal('Date', new Proxy(NativeDate, { construct(target, args) { if (args[0] === timestamp) boundary(); return Reflect.construct(target, args); } }));
        } else if (seam === 'iso') {
          const original = Date.prototype.toISOString;
          vi.spyOn(Date.prototype, 'toISOString').mockImplementation(function (this: Date) { if (this.getTime() === timestamp) boundary(); return original.call(this); });
        } else if (seam === 'finite') {
          vi.spyOn(Number, 'isFinite').mockImplementation(value => { if (value === -731) boundary(); return typeof value === 'number' && value !== Infinity && value !== -Infinity && value === value; });
        } else {
          vi.stubGlobal('Number', new Proxy(NativeNumber, { apply(target, receiver, args) { if (args[0] === (isTask ? '-731' : '731')) boundary(); return Reflect.apply(target, receiver, args); } }));
        }
        try { result = isTask ? parseTaskRow(input.row, map, undefined, budget) : parsePromotionRow(input.row, map, budget); }
        catch (error) { caught = error; }
      } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
      expect(reached).toBeGreaterThan(0);
      if (exit === 'exceeded' || exit === 'unavailable') expect(caught).toBe(injected);
      else if (state === 'expired' || state === 'aborted') expect(caught).toBeInstanceOf(BudgetUnavailableError);
      else if (exit === 'ordinary') expect(caught).toBe(injected);
      else { expect(caught).toBeUndefined(); expect(result).not.toBeNull(); expect(result).toBeDefined(); }
    });
  }
});
