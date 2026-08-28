import 'server-only';

import { attachDatabasePool } from '@vercel/functions';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
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
  createPool: (connectionString) => new Pool({ connectionString }),
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
