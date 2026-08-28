import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { QueryResult, QueryResultRow } from 'pg';
import * as schema from '@/server/db/schema';
import {
  createTenantTransactionRunner,
  type TenantTransaction,
  type TransactionConnection,
  type TransactionPool,
} from '@/server/db/transaction';

const TENANT_ONE = '20000000-0000-4000-8000-000000000001';
const TENANT_TWO = '20000000-0000-4000-8000-000000000002';
const MIGRATIONS = [
  '0001_identity_tenants.sql',
  '0002_operational.sql',
  '0003_operations_migrations.sql',
] as const;

type PgQueryConfig = {
  text: string;
  values?: unknown[];
  rowMode?: 'array';
};

class PgliteRuntimeConnection implements TransactionConnection {
  constructor(private readonly database: PGlite) {}

  async query<TResult extends QueryResultRow = QueryResultRow>(
    textOrConfig: string | PgQueryConfig,
    values: unknown[] = [],
  ): Promise<QueryResult<TResult>> {
    const config = typeof textOrConfig === 'string'
      ? { text: textOrConfig, values }
      : textOrConfig;

    if (config.text === 'BEGIN') {
      await this.database.exec('BEGIN');
      await this.database.exec('SET LOCAL ROLE app_runtime');
      return { rows: [], rowCount: null } as unknown as QueryResult<TResult>;
    }

    const result = await this.database.query<TResult>(
      config.text,
      config.values ?? values,
      config.rowMode ? { rowMode: config.rowMode } : undefined,
    );
    return result as unknown as QueryResult<TResult>;
  }

  release(): void {}
}

class PgliteRuntimePool implements TransactionPool {
  constructor(private readonly database: PGlite) {}

  async connect(): Promise<TransactionConnection> {
    return new PgliteRuntimeConnection(this.database);
  }
}

export type PgliteDatabaseHarness = {
  database: PGlite;
  runtimePool: TransactionPool;
  createDatabase: (connection: TransactionConnection) => TenantTransaction;
  runTenantTransaction: ReturnType<typeof createTenantTransactionRunner>;
  tenantOneId: string;
  tenantTwoId: string;
  close(): Promise<void>;
};

export async function createPgliteDatabaseHarness(): Promise<PgliteDatabaseHarness> {
  const database = new PGlite({ extensions: { pgcrypto } });
  try {
    for (const migration of MIGRATIONS) {
      const migrationSql = await readFile(resolve(
        process.cwd(),
        'src/server/db/migrations',
        migration,
      ), 'utf8');
      await database.exec(migrationSql);
    }

    await database.query(
      `INSERT INTO tenants (id, slug, display_name)
       VALUES ($1, 'transaction-tenant-one', 'Transaction Tenant One'),
              ($2, 'transaction-tenant-two', 'Transaction Tenant Two')`,
      [TENANT_ONE, TENANT_TWO],
    );
    await database.exec('CREATE ROLE app_runtime NOSUPERUSER NOBYPASSRLS');
    await database.exec('GRANT USAGE ON SCHEMA public TO app_runtime');
    await database.exec(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime',
    );
    await database.exec(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime',
    );

    const runtimePool = new PgliteRuntimePool(database);
    const createDatabase = (connection: TransactionConnection): TenantTransaction => (
      drizzle(connection as never, { schema })
    );
    const runTenantTransaction = createTenantTransactionRunner({
      pool: runtimePool,
      createDatabase,
      sleep: async () => {},
    }, { retryDelayMs: 0 });

    return {
      database,
      runtimePool,
      createDatabase,
      runTenantTransaction,
      tenantOneId: TENANT_ONE,
      tenantTwoId: TENANT_TWO,
      close: () => database.close(),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
