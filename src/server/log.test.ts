// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { errorTag, logFailure } from './log';

describe('logging a failure without its data', () => {
  it('keeps a failed query to its class name and SQLSTATE, never its SQL or values', () => {
    const cause = Object.assign(new Error('connection terminated'), { code: '57P01' });
    const error = new DrizzleQueryError('INSERT INTO transactions VALUES ($1,$2,$3)', ['S001', '김민준', 3500], cause);
    expect(errorTag(error)).toBe('DrizzleQueryError 57P01');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      logFailure('[pet:care] unexpected failure', error);
      expect(spy).toHaveBeenCalledWith('[pet:care] unexpected failure', 'DrizzleQueryError 57P01');
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/김민준|3500|INSERT/);
    } finally { spy.mockRestore(); }
  });

  it('names other failures by class only, and ignores codes of an unknown shape', () => {
    expect(errorTag(new TypeError('student 김민준'))).toBe('TypeError');
    expect(errorTag(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('Error ECONNRESET');
    expect(errorTag(Object.assign(new Error('x'), { code: '김민준 3500' }))).toBe('Error');
    expect(errorTag('a string')).toBe('Error');
    expect(errorTag(null)).toBe('Error');
  });
});
