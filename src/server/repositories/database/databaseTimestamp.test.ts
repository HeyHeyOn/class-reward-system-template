import { describe, expect, it } from 'vitest';
import { databaseTimestamp, databaseTimestampDate } from './databaseTimestamp';
describe('raw node-postgres / PGlite timestamp evidence boundary', () => {
  it('matches native UTC text and Date evidence while preserving PostgreSQL microseconds', () => {
    expect(databaseTimestamp(new Date('2026-10-01T00:00:00.000Z'))).toBe('2026-10-01T00:00:00.000Z');
    expect(databaseTimestamp('2026-10-01 00:00:00+00')).toBe('2026-10-01T00:00:00.000Z');
    expect(databaseTimestamp('2026-10-01 00:00:00.123456+00')).toBe('2026-10-01T00:00:00.123456Z');
    expect(databaseTimestampDate('2026-10-01 00:00:00.123+00').toISOString()).toBe('2026-10-01T00:00:00.123Z');
  });
  it.each([null, 0, {}, '2026-02-30 00:00:00+00', '2026-10-01 00:00:00+09', '2026-10-01T00:00:00Z', '2026-10-01 00:00:00.1234567+00', new Date('invalid')])('refuses non-authoritative timestamp shape %j', value => {
    expect(() => databaseTimestamp(value)).toThrow('Invalid timestamp evidence.');
  });
});
