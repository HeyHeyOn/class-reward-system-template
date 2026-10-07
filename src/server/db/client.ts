import 'server-only';

import { attachDatabasePool } from '@vercel/functions';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { getDatabaseConfig, type DatabaseConfig } from '@/server/db/config';
import * as schema from '@/server/db/schema';

export type ProductionDatabase = NodePgDatabase<typeof schema>;

export type DatabaseClient<TPool = unknown, TDatabase = unknown> = {
  pool: TPool;
  database: TDatabase;
};

export type DatabaseClientDependencies<TPool = unknown, TDatabase = unknown> = {
  getConfig: () => DatabaseConfig;
  createPool: (connectionString: string) => TPool;
  attachPool: (pool: TPool) => void;
  createDrizzle: (pool: TPool) => TDatabase;
  disposePool: (pool: TPool) => void;
};

type PoolDiagnostic = Readonly<{ code: string }>;
type RuntimePoolDependencies = Readonly<{
  createPool: (config: PoolConfig) => Pool;
  reportIdleError: (diagnostic: PoolDiagnostic) => void;
}>;

// Keep each server instance's pool small and bound both queued acquisition and connection setup.
const RUNTIME_POOL_MAX = 5;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_ERROR_CODES = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '53300', '53400', '57P01', '57P02', '57P03',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
]);

/** pg removes failed idle clients itself; handle the event without logging connection details. */
export function createRuntimeDatabasePool(
  connectionString: string,
  dependencies: RuntimePoolDependencies = {
    createPool: (config) => new Pool(config),
    reportIdleError: (diagnostic) => console.error('[database-pool] idle connection failure', diagnostic),
  },
): Pool {
  const pool = dependencies.createPool({ connectionString, max: RUNTIME_POOL_MAX, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS });
  pool.on('error', (error: unknown) => {
    let code = 'UNKNOWN';
    try {
      const candidate = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (typeof candidate === 'string' && IDLE_ERROR_CODES.has(candidate)) code = candidate;
    } catch { /* Diagnostic fields are not trusted. */ }
    try {
      dependencies.reportIdleError({ code });
    } catch { /* Observability must not turn an idle connection failure into an uncaught error. */ }
  });
  return pool;
}

export function createDatabaseClientManager<TPool, TDatabase>(
  dependencies: DatabaseClientDependencies<TPool, TDatabase>,
): () => DatabaseClient<TPool, TDatabase> {
  let client: DatabaseClient<TPool, TDatabase> | undefined;
  let attachmentFailure: unknown;
  let hasAttachmentFailure = false;

  return () => {
    if (client) {
      return client;
    }
    if (hasAttachmentFailure) {
      throw attachmentFailure;
    }

    const { databaseUrl } = dependencies.getConfig();
    const pool = dependencies.createPool(databaseUrl);
    try {
      const database = dependencies.createDrizzle(pool);
      try {
        dependencies.attachPool(pool);
      } catch (error) {
        attachmentFailure = error;
        hasAttachmentFailure = true;
        throw error;
      }
      client = { pool, database };
      return client;
    } catch (error) {
      try {
        dependencies.disposePool(pool);
      } catch {
        // Preserve the initialization error.
      }
      throw error;
    }
  };
}

const productionDependencies: DatabaseClientDependencies<Pool, ProductionDatabase> = {
  getConfig: getDatabaseConfig,
  createPool: createRuntimeDatabasePool,
  attachPool: attachDatabasePool,
  createDrizzle: (pool) => drizzle(pool, { schema }),
  disposePool: (pool) => { void pool.end().catch(() => {}); },
};

const singletonKey = Symbol.for('class-store.production-database-client');
type GlobalDatabaseState = typeof globalThis & {
  [singletonKey]?: () => DatabaseClient<Pool, ProductionDatabase>;
};
const globalDatabaseState = globalThis as GlobalDatabaseState;

globalDatabaseState[singletonKey] ??= createDatabaseClientManager(productionDependencies);

export function getDatabaseClient(): DatabaseClient<Pool, ProductionDatabase> {
  const manager = globalDatabaseState[singletonKey];
  if (!manager) {
    throw new Error('Database client manager is unavailable.');
  }
  return manager();
}
