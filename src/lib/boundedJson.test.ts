import { describe, expect, it, vi } from 'vitest';
import * as json from './boundedJson';
import { BudgetExceededError, BudgetUnavailableError, createBudgetContext } from './boundedWork';

const make = () => createBudgetContext({ now: () => 0 });

describe('bounded JSON lexical admission (not normalization shape admission)', () => {
  it.each([
    'null', 'true', 'false', '0', '-0', '1.5', '1e999', '""', '"한😀"',
    '"\\ud800"', '"\\ud800\\udc00"', '"\\u0061\\n\\t\\/\\\\\\\""',
    '[]', '{}', '[1,true,null,{"x":["y"]}]', '{"a":1,"a":2}',
    '{"__proto__":{"x":1},"constructor":2}', ' \n { "a" : [ 1, 2 ] } \r\t',
  ])('preserves native JSON grammar/value semantics for %s', (text) => {
    expect(json.parseBoundedJson(text, make())).toEqual(JSON.parse(text));
  });
  it.each(['', 'undefined', 'NaN', '[1,]', '{"a":1,}', '{a:1}', '{"a" 1}', '[1 2]',
    '01', '-01', '1.', '1e+', '+1', 'true false', '"\\x00"', '"\\u00xz"', '"\n"', '"unterminated', '[', '{', '"\\'])('rejects malformed %j before JSON.parse', (text) => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson(text, make())).toThrow('Legacy bounded JSON is invalid.');
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('checks depth 64/65 before JSON.parse', () => {
    expect(json.parseBoundedJson('['.repeat(64) + ']'.repeat(64), make())).toBeInstanceOf(Array);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson('['.repeat(65) + ']'.repeat(65), make())).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('counts scalar root depth and nested scalars, not only containers', () => {
    const budget = createBudgetContext({ now: () => 0, limits: { depth: 1 } });
    expect(json.parseBoundedJson('{}', budget)).toEqual({});
    expect(() => json.parseBoundedJson('{"a":0}', budget)).toThrow(BudgetExceededError);
  });
  it('rejects parsed graph allocations atomically before native parse', () => {
    const budget = createBudgetContext({ now: () => 0, limits: { nodes: 131 } });
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson('[0]', budget)).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('charges all duplicate-key occurrences and decoded UTF-8 keys without deduplicating admission', () => {
    const budget = make();
    expect(json.parseBoundedJson('{"한":"\\ud800","한":"😀"}', budget)).toEqual({ 한: '😀' });
    const counters = budget.usage();
    expect(counters.nodes).toBe(133); // two fixed 64-slot stacks + root and two strings
    expect(counters.slots).toBe(130);
    expect(counters.contentBytes).toBe(7);
    expect(counters.structuralBytes).toBe(1094); // fixed scratch 1056 + object16 + properties14 + scalars8
  });
  it('shares counters for two parses rather than resetting for each document', () => {
    const budget = createBudgetContext({ now: () => 0, limits: { contentBytes: 3 } });
    expect(json.parseBoundedJson('"ab"', budget)).toBe('ab');
    expect(() => json.parseBoundedJson('"cd"', budget)).toThrow(BudgetExceededError);
  });
  it('checks cancellation before native parse, and cooperative time immediately after it', () => {
    const signal = { aborted: true };
    expect(() => json.parseBoundedJson('{}', createBudgetContext({ now: () => 0, signal }))).toThrow(BudgetUnavailableError);
    let now = 0;
    const budget = createBudgetContext({ now: () => now });
    const native = JSON.parse;
    const parse = vi.spyOn(JSON, 'parse').mockImplementation((text) => { now = 5_000; return native(text); });
    try { expect(() => json.parseBoundedJson('{}', budget)).toThrow(BudgetUnavailableError); }
    finally { parse.mockRestore(); }
  });
  it.each([new BudgetExceededError(), new BudgetUnavailableError()])('never turns a budget exception into malformed JSON', (error) => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw error; });
    try { expect(() => json.parseBoundedJson('{}', make())).toThrow(error); }
    finally { parse.mockRestore(); }
  });
  it('enforces a tightened per-string limit for decoded values and property keys', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      const small = () => createBudgetContext({ now: () => 0, limits: { stringBytes: 2 } });
      expect(() => json.parseBoundedJson('"abc"', small())).toThrow(BudgetExceededError);
      expect(() => json.parseBoundedJson('{"abc":0}', small())).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('does not expose native exception payloads', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => { throw new Error('dummy-sensitive-payload'); });
    try { expect(() => json.parseBoundedJson('{}', make())).toThrow('Legacy bounded JSON is invalid.'); }
    finally { parse.mockRestore(); }
  });
  it.each([7_999_999, 8_000_000])('admits raw text at %s UTF-8 bytes', (length) => {
    expect(json.parseBoundedJson('0' + ' '.repeat(length - 1), make())).toBe(0);
  });
  it('rejects raw text at 8,000,001 bytes before native parse', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson('0' + ' '.repeat(8_000_000), make())).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it.each([299_999, 300_000])('admits exactly %s graph nodes', (nodes) => {
    const text = '[' + '0,'.repeat(nodes - 2) + '0]';
    expect(json.parseBoundedJson(text, make())).toHaveLength(nodes - 1);
  });
  it('rejects node 300,001 before native parse', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson('[' + '0,'.repeat(299_999) + '0]', make())).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it.each([3_999_999, 4_000_000])('admits exactly %s structural units including UTF-8 property names', (units) => {
    const text = '{"' + 'a'.repeat(units - 24) + '":0}';
    expect(json.parseBoundedJson(text, make())).toBeTypeOf('object');
  });
  it('rejects structural unit 4,000,001 before native parse', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson('{"' + 'a'.repeat(3_999_977) + '":0}', make())).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
  it('rejects decoded content over 4,000,000 bytes before native parsing', () => {
    const accepted = '"' + 'a'.repeat(4_000_000) + '"';
    expect(json.parseBoundedJson(accepted, make())).toHaveLength(4_000_000);
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(() => json.parseBoundedJson('"' + 'a'.repeat(4_000_001) + '"', make())).toThrow(BudgetExceededError);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });
});
