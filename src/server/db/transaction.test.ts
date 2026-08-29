import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabaseClientManager,
  type DatabaseClientDependencies,
} from '@/server/db/client';
import {
  createTenantTransactionRunner,
  TenantTransactionError,
} from '@/server/db/transaction';
import {
  createPgliteDatabaseHarness,
  type PgliteDatabaseHarness,
} from '@/server/db/testing/pglite';

vi.mock('server-only', () => ({}));

const TENANT_ONE = '20000000-0000-4000-8000-000000000001';
const TENANT_TWO = '20000000-0000-4000-8000-000000000002';

let harness: PgliteDatabaseHarness;

beforeEach(async () => {
  harness = await createPgliteDatabaseHarness();
});

afterEach(async () => {
  await harness?.close();
});

describe('production database client lifecycle', () => {
  it('creates one pooled DATABASE_URL client and attaches it once', () => {
    const pool = { connect: vi.fn() };
    const database = { marker: 'drizzle' };
    const dependencies: DatabaseClientDependencies = {
      getConfig: vi.fn(() => ({
        databaseUrl: 'postgresql://runtime:redacted@db.invalid/app',
        directDatabaseUrl: 'postgresql://migration:redacted@db.invalid/app',
      })),
      createPool: vi.fn(() => pool),
      attachPool: vi.fn(),
      createDrizzle: vi.fn(() => database),
      disposePool: vi.fn(),
    };
    const getClient = createDatabaseClientManager(dependencies);

    expect(getClient()).toEqual({ pool, database });
    expect(getClient()).toEqual({ pool, database });
    expect(dependencies.createPool).toHaveBeenCalledOnce();
    expect(dependencies.createPool).toHaveBeenCalledWith(
      'postgresql://runtime:redacted@db.invalid/app',
    );
    expect(dependencies.createPool).not.toHaveBeenCalledWith(
      'postgresql://migration:redacted@db.invalid/app',
    );
    expect(dependencies.attachPool).toHaveBeenCalledOnce();
    expect(dependencies.attachPool).toHaveBeenCalledWith(pool);
  });

  it('disposes a pool and safely retries when Drizzle construction fails before attachment', () => {
    const firstPool = { id: 'first' };
    const secondPool = { id: 'second' };
    const failure = new Error('drizzle construction failed');
    const dependencies: DatabaseClientDependencies = {
      getConfig: () => ({ databaseUrl: 'postgresql://runtime:***@db.invalid/app', directDatabaseUrl: '' }),
      createPool: vi.fn().mockReturnValueOnce(firstPool).mockReturnValueOnce(secondPool),
      createDrizzle: vi.fn().mockImplementationOnce(() => { throw failure; }).mockReturnValue({ ok: true }),
      attachPool: vi.fn(),
      disposePool: vi.fn(),
    };
    const getClient = createDatabaseClientManager(dependencies);

    expect(getClient).toThrow(failure);
    expect(dependencies.disposePool).toHaveBeenCalledWith(firstPool);
    expect(dependencies.attachPool).not.toHaveBeenCalled();
    expect(getClient()).toEqual({ pool: secondPool, database: { ok: true } });
    expect(dependencies.attachPool).toHaveBeenCalledOnce();
  });

  it('disposes and permanently fails a manager after ambiguous pool attachment failure', () => {
    const pool = { id: 'pool' };
    const failure = new Error('attach failed');
    const dependencies: DatabaseClientDependencies = {
      getConfig: () => ({ databaseUrl: 'postgresql://runtime:***@db.invalid/app', directDatabaseUrl: '' }),
      createPool: vi.fn(() => pool),
      createDrizzle: vi.fn(() => ({ ok: true })),
      attachPool: vi.fn(() => { throw failure; }),
      disposePool: vi.fn(),
    };
    const getClient = createDatabaseClientManager(dependencies);

    expect(getClient).toThrow(failure);
    expect(getClient).toThrow(failure);
    expect(dependencies.createPool).toHaveBeenCalledOnce();
    expect(dependencies.attachPool).toHaveBeenCalledOnce();
    expect(dependencies.disposePool).toHaveBeenCalledWith(pool);
  });

  it('keeps a falsy attachment failure sticky', () => {
    const pool = { id: 'pool' };
    const dependencies: DatabaseClientDependencies = {
      getConfig: () => ({ databaseUrl: 'postgresql://runtime:***@db.invalid/app', directDatabaseUrl: '' }),
      createPool: vi.fn(() => pool),
      createDrizzle: vi.fn(() => ({ ok: true })),
      attachPool: vi.fn(() => { throw undefined; }),
      disposePool: vi.fn(),
    };
    const getClient = createDatabaseClientManager(dependencies);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        getClient();
      } catch {
        // A falsy thrown value still marks attachment as permanently failed.
      }
    }
    expect(dependencies.createPool).toHaveBeenCalledOnce();
    expect(dependencies.attachPool).toHaveBeenCalledOnce();
    expect(dependencies.disposePool).toHaveBeenCalledOnce();
  });
});

describe('tenant transaction boundary', () => {
  it.each(['', '   ', 'not-a-uuid', undefined])(
    'rejects invalid tenant context before acquiring a connection: %s',
    async (tenantId) => {
      const connect = vi.fn(harness.runtimePool.connect.bind(harness.runtimePool));
      const run = createTenantTransactionRunner({
        pool: { connect },
        createDatabase: harness.createDatabase,
      });

      await expect(run(tenantId as string, async () => 'unreachable'))
        .rejects.toThrow(/valid tenant id/i);
      expect(connect).not.toHaveBeenCalled();
    },
  );

  it('starts an explicit repeatable-read snapshot before setting tenant context', async () => {
    const statements: string[] = [];
    const connect = vi.fn(async () => ({
      query: async (text: string) => {
        statements.push(text);
        return { rows: [], rowCount: null } as never;
      },
      release: vi.fn(),
    }));
    const run = createTenantTransactionRunner({
      pool: { connect },
      createDatabase: () => ({}) as never,
    }, { isolationLevel: 'REPEATABLE READ' });

    await expect(run(TENANT_ONE, async () => 'snapshot')).resolves.toBe('snapshot');
    expect(statements.slice(0, 2)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      `SELECT set_config('app.tenant_id', $1, true)`,
    ]);
  });

  it('rejects unsupported isolation levels before acquiring a connection', () => {
    const connect = vi.fn();
    expect(() => createTenantTransactionRunner({
      pool: { connect },
    }, { isolationLevel: 'READ UNCOMMITTED' as 'REPEATABLE READ' })).toThrow(/isolation/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('allows same-tenant reads and writes while hiding and rejecting cross-tenant rows', async () => {
    const run = harness.runTenantTransaction;

    await run(TENANT_ONE, async (tx) => {
      await tx.execute(sql`
        insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
        values (${TENANT_ONE}, 'owned', '{"tenant":1}'::jsonb)
      `);
      const visible = await tx.execute(sql`
        select tenant_id::text as tenant_id, setting_key
        from tenant_setting_extras order by setting_key
      `);
      expect(visible.rows).toEqual([{ tenant_id: TENANT_ONE, setting_key: 'owned' }]);

      const crossTenant = await tx.execute(sql`
        select * from tenant_setting_extras where tenant_id = ${TENANT_TWO}
      `);
      expect(crossTenant.rows).toEqual([]);
    });

    await expect(run(TENANT_ONE, (tx) => tx.execute(sql`
      insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
      values (${TENANT_TWO}, 'blocked', 'true'::jsonb)
    `))).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/row-level security policy/i) },
    });

    await run(TENANT_TWO, async (tx) => {
      const rows = await tx.execute(sql`select * from tenant_setting_extras`);
      expect(rows.rows).toEqual([]);
    });
  });

  it('rolls back all callback effects when the callback throws', async () => {
    await expect(harness.runTenantTransaction(TENANT_ONE, async (tx) => {
      await tx.execute(sql`
        insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
        values (${TENANT_ONE}, 'rolled-back', 'true'::jsonb)
      `);
      throw new Error('domain failure');
    })).rejects.toThrow('domain failure');

    await harness.runTenantTransaction(TENANT_ONE, async (tx) => {
      const rows = await tx.execute(sql`
        select setting_key from tenant_setting_extras where setting_key = 'rolled-back'
      `);
      expect(rows.rows).toEqual([]);
    });
  });

  it('does not leak tenant context after commit, rollback, or pool reuse', async () => {
    await harness.runTenantTransaction(TENANT_ONE, async (tx) => {
      await tx.execute(sql`
        insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
        values (${TENANT_ONE}, 'committed', 'true'::jsonb)
      `);
    });
    await expect(harness.runTenantTransaction(TENANT_ONE, async () => {
      throw new Error('force rollback');
    })).rejects.toThrow('force rollback');

    const reusedClient = await harness.runtimePool.connect();
    const context = await reusedClient.query<{ tenant_id: string }>(
      `select current_setting('app.tenant_id', true) as tenant_id`,
    );
    reusedClient.release();
    expect(context.rows).toEqual([{ tenant_id: '' }]);

    await harness.runTenantTransaction(TENANT_TWO, async (tx) => {
      const rows = await tx.execute(sql`select setting_key from tenant_setting_extras`);
      expect(rows.rows).toEqual([]);
    });
  });

  it('fails closed as app_runtime when a transaction has no tenant context', async () => {
    await harness.runTenantTransaction(TENANT_ONE, async (tx) => {
      await tx.execute(sql`
        insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
        values (${TENANT_ONE}, 'missing-context-proof', 'true'::jsonb)
      `);
    });

    const connection = await harness.runtimePool.connect();
    await connection.query('BEGIN');
    try {
      const role = await connection.query<{ current_user: string }>('select current_user');
      expect(role.rows).toEqual([{ current_user: 'app_runtime' }]);
      const hidden = await connection.query('select * from tenant_setting_extras');
      expect(hidden.rows).toEqual([]);
      await expect(connection.query(
        `insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
         values ($1, 'missing-context-blocked', 'true'::jsonb)`,
        [TENANT_ONE],
      )).rejects.toThrow(/row-level security policy/i);
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
  });

  it('does not allow release cleanup failures to mask the primary error', async () => {
    const primaryError = new Error('primary domain failure');
    const run = createTenantTransactionRunner({
      pool: {
        connect: async () => ({
          query: async () => ({ rows: [], rowCount: null }) as never,
          release: () => { throw new Error('cleanup failure'); },
        }),
      },
      createDatabase: () => ({}) as never,
    });

    await expect(run(TENANT_ONE, async () => {
      throw primaryError;
    })).rejects.toBe(primaryError);
  });

  it('retries only SQLSTATE 40001 with a fresh transaction and bounded delay', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const run = createTenantTransactionRunner({
      pool: harness.runtimePool,
      createDatabase: harness.createDatabase,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
    }, { maxAttempts: 3, retryDelayMs: 7 });

    await run(TENANT_ONE, async (tx) => {
      attempts += 1;
      await tx.execute(sql`
        insert into tenant_setting_extras (tenant_id, setting_key, setting_value)
        values (${TENANT_ONE}, ${`attempt-${attempts}`}, 'true'::jsonb)
      `);
      if (attempts < 3) {
        throw Object.assign(new Error('serialization fixture'), { code: '40001' });
      }
    });

    expect(attempts).toBe(3);
    expect(delays).toEqual([7, 14]);
    await harness.runTenantTransaction(TENANT_ONE, async (tx) => {
      const rows = await tx.execute(sql`
        select setting_key from tenant_setting_extras order by setting_key
      `);
      expect(rows.rows).toEqual([{ setting_key: 'attempt-3' }]);
    });
  });

  it('retries a serialization failure wrapped in a bounded Drizzle cause chain', async () => {
    let attempts = 0;
    const run = createTenantTransactionRunner({
      pool: harness.runtimePool,
      createDatabase: harness.createDatabase,
      sleep: async () => {},
    }, { maxAttempts: 2, retryDelayMs: 0 });

    await run(TENANT_ONE, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('Drizzle query failed'), {
          code: 'DRIZZLE_QUERY_ERROR',
          cause: Object.assign(new Error('serialization failure'), { code: '40001' }),
        });
      }
    });
    expect(attempts).toBe(2);
  });

  it('discards a connection after rollback failure and retries on a fresh connection', async () => {
    const firstRelease = vi.fn();
    const secondRelease = vi.fn();
    const connections = [
      {
        query: vi.fn(async (text: string) => {
          if (text === 'ROLLBACK') throw new Error('rollback failed');
          return { rows: [], rowCount: null } as never;
        }),
        release: firstRelease,
      },
      {
        query: vi.fn(async () => ({ rows: [], rowCount: null }) as never),
        release: secondRelease,
      },
    ];
    const connect = vi.fn(async () => connections.shift()!);
    let attempts = 0;
    const run = createTenantTransactionRunner({
      pool: { connect },
      createDatabase: () => ({}) as never,
      sleep: async () => {},
    }, { maxAttempts: 2, retryDelayMs: 0 });

    await run(TENANT_ONE, async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('serialization'), { code: '40001' });
    });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(firstRelease).toHaveBeenCalledWith(true);
    expect(secondRelease).toHaveBeenCalledWith();
  });

  it('returns the committed result when release fails and reports cleanup separately', async () => {
    const cleanupErrors: unknown[] = [];
    const run = createTenantTransactionRunner({
      pool: {
        connect: async () => ({
          query: async () => ({ rows: [], rowCount: null }) as never,
          release: () => { throw new Error('release after commit failed'); },
        }),
      },
      createDatabase: () => ({}) as never,
      onCleanupError: (error) => { cleanupErrors.push(error); },
    });

    await expect(run(TENANT_ONE, async () => 'committed')).resolves.toBe('committed');
    expect(cleanupErrors).toHaveLength(1);
  });

  it('rejects retry delays that exceed the operational bound', () => {
    expect(() => createTenantTransactionRunner({
      pool: harness.runtimePool,
      createDatabase: harness.createDatabase,
    }, { maxAttempts: 10, retryDelayMs: 10_000 })).toThrow(/retry delay/i);
  });

  it('does not retry non-serialization errors', async () => {
    let attempts = 0;
    const run = createTenantTransactionRunner({
      pool: harness.runtimePool,
      createDatabase: harness.createDatabase,
      sleep: vi.fn(),
    });
    const domainError = Object.assign(new Error('domain conflict'), { code: '23505' });

    await expect(run(TENANT_ONE, async () => {
      attempts += 1;
      throw domainError;
    })).rejects.toBe(domainError);
    expect(attempts).toBe(1);
  });

  it('stops after the configured serialization attempt limit with a safe error', async () => {
    let attempts = 0;
    const run = createTenantTransactionRunner({
      pool: harness.runtimePool,
      createDatabase: harness.createDatabase,
      sleep: async () => {},
    }, { maxAttempts: 2, retryDelayMs: 0 });

    const rejection = run(TENANT_ONE, async () => {
      attempts += 1;
      throw Object.assign(
        new Error('postgresql://secret-user:secret-password@db.invalid leaked payload'),
        { code: '40001' },
      );
    });
    await expect(rejection).rejects.toMatchObject({
      name: TenantTransactionError.name,
      code: '40001',
      message: 'Tenant transaction failed after serialization retries.',
    });
    await expect(rejection).rejects.not.toThrow(/secret-user|secret-password|db\.invalid/);
    expect(attempts).toBe(2);
  });

  it('uses a NOSUPERUSER NOBYPASSRLS runtime role', async () => {
    const role = await harness.database.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`select rolsuper, rolbypassrls from pg_roles where rolname = 'app_runtime'`);

    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
});
