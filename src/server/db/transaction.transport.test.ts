// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createTenantTransactionRunner, type TenantTransaction, type TransactionConnection } from './transaction';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
const TENANT = '20000000-0000-4000-8000-000000000001';

// Contract controls; these event injections are NOT claimed as native transport evidence.
function fixture(options: { failAt?: string; eventOnly?: boolean; code?: string; releaseThrows?: boolean } = {}) {
  const events = new EventEmitter(), statements: string[] = [];
  const error = Object.assign(new Error('controlled connection event'), { code: options.code });
  const idle = vi.fn(), releaseFailure = new Error('release failure');
  const connection = Object.assign(events, {
    query: vi.fn(async (text: string) => {
      statements.push(text);
      expect(events.listenerCount('error')).toBe(1);
      if (text === options.failAt) {
        events.emit('error', error);
        if (!options.eventOnly) throw error;
      }
      return { rows: [], rowCount: 0 } as never;
    }),
    release: vi.fn(() => {
      expect(events.listenerCount('error')).toBe(1);
      events.on('error', idle); // pg-pool takes error ownership back on release.
      if (options.releaseThrows) throw releaseFailure;
    }),
  });
  const connect = vi.fn(async () => connection as TransactionConnection), cleanup = vi.fn();
  const run = createTenantTransactionRunner({ pool: { connect }, createDatabase: () => ({}) as TenantTransaction, onCleanupError: cleanup });
  return { events, statements, error, idle, releaseFailure, connection, connect, cleanup, run };
}

describe('checked-out connection error ownership', () => {
  it('owns exactly one listener through release and restores pool ownership without leaks', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) {
      f.events.removeListener('error', f.idle); // next checkout removes pg-pool listener.
      await expect(f.run(TENANT, async () => 'ok')).resolves.toBe('ok');
      expect(f.events.listeners('error')).toEqual([f.idle]);
    }
    expect(f.connection.release).toHaveBeenCalledTimes(3);
    expect(f.connection.release).toHaveBeenLastCalledWith();
  });
  it.each(['BEGIN', "SELECT set_config('app.tenant_id', $1, true)", 'COMMIT'])(
    'preserves real query rejection and discards on client error at %s', async failAt => {
      const f = fixture({ failAt });
      await expect(f.run(TENANT, async () => 'not accepted')).rejects.toBe(f.error);
      expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(f.events.listeners('error')).toEqual([f.idle]);
    });
  it('fails closed when the callback observes an error event between driver queries', async () => {
    const f = fixture();
    await expect(f.run(TENANT, async () => { f.events.emit('error', f.error); return 'unsafe'; })).rejects.toBe(f.error);
    expect(f.statements).not.toContain('COMMIT');
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('does not retry a transport error even when its code resembles serialization failure', async () => {
    const f = fixture({ failAt: 'COMMIT', code: '40001' });
    await expect(f.run(TENANT, async () => 'unsafe')).rejects.toBe(f.error);
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it('does not change acknowledged commit success when release throws; removes only its own listener', async () => {
    const f = fixture({ releaseThrows: true });
    await expect(f.run(TENANT, async () => 'committed')).resolves.toBe('committed');
    expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.releaseFailure);
    expect(f.events.listeners('error')).toEqual([f.idle]);
  });
  it('preserves primary callback failure if rollback also emits a client error', async () => {
    const f = fixture({ failAt: 'ROLLBACK' }), primary = new Error('callback failure');
    await expect(f.run(TENANT, async () => { throw primary; })).rejects.toBe(primary);
    expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(f.error);
    expect(f.connection.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.events.listeners('error')).toEqual([f.idle]);
  });
});
