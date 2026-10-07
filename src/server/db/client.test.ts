// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeDatabasePool } from './client';

vi.mock('server-only', () => ({}));

function fixture() {
  const pool = new EventEmitter() as Pool;
  const createPool = vi.fn(() => pool);
  const reportIdleError = vi.fn();
  const result = createRuntimeDatabasePool('postgresql://synthetic:private@db.invalid/example', { createPool, reportIdleError });
  return { pool: result, createPool, reportIdleError };
}

describe('runtime connection pool', () => {
  it('bounds concurrency and acquisition without opening connections during construction', () => {
    const { pool, createPool } = fixture();
    expect(createPool).toHaveBeenCalledExactlyOnceWith({
      connectionString: 'postgresql://synthetic:private@db.invalid/example',
      max: 5,
      connectionTimeoutMillis: 5_000,
    });
    expect(pool.listenerCount('error')).toBe(1);
  });

  it('handles repeated idle failures and exposes only an allowlisted code', () => {
    const { pool, reportIdleError } = fixture();
    const error = Object.assign(new Error('synthetic private connection detail'), {
      code: 'ECONNRESET', connectionString: 'private-url', query: 'private-query',
    });
    expect(() => pool.emit('error', error, { connectionParameters: { password: 'private' } })).not.toThrow();
    expect(() => pool.emit('error', Object.assign(new Error('second private detail'), { code: '57P01' }))).not.toThrow();
    expect(reportIdleError.mock.calls).toEqual([[{ code: 'ECONNRESET' }], [{ code: '57P01' }]]);
  });

  it.each([undefined, 'private value', { code: 'private-value' }, { code: 123 },
    Object.defineProperty({}, 'code', { get() { throw new Error('private getter'); } }),
  ])('redacts unexpected error shapes', (error) => {
    const { pool, reportIdleError } = fixture();
    expect(() => pool.emit('error', error)).not.toThrow();
    expect(reportIdleError).toHaveBeenCalledExactlyOnceWith({ code: 'UNKNOWN' });
  });

  it('does not let a diagnostic sink failure escape the error listener', () => {
    const { pool, reportIdleError } = fixture();
    reportIdleError.mockImplementation(() => { throw new Error('logger unavailable'); });
    expect(() => pool.emit('error', new Error('idle connection closed'))).not.toThrow();
  });
});
