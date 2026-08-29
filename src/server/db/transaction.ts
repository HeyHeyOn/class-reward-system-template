import 'server-only';

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getDatabaseClient } from '@/server/db/client';
import * as schema from '@/server/db/schema';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERIALIZATION_FAILURE = '40001';
const MAX_TOTAL_RETRY_DELAY_MS = 30_000;
const MAX_CAUSE_DEPTH = 5;

export type TenantTransaction = Omit<
  NodePgDatabase<typeof schema>,
  '$client' | 'transaction'
>;

export type TransactionConnection = {
  query<TResult extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<TResult>>;
  release(error?: Error | boolean): void;
};

export type TransactionPool = {
  connect(): Promise<TransactionConnection>;
};

export type TenantTransactionDependencies = {
  pool: TransactionPool;
  createDatabase?: (connection: TransactionConnection) => TenantTransaction;
  sleep?: (milliseconds: number) => Promise<void>;
  onCleanupError?: (error: unknown) => void;
};

export type TenantTransactionOptions = {
  maxAttempts?: number;
  retryDelayMs?: number;
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ';
};

export class TenantTransactionError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'TenantTransactionError';
    this.code = code;
  }
}

function createNodePgDatabase(connection: TransactionConnection): TenantTransaction {
  return drizzle(connection as PoolClient, { schema });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    throw new Error('A valid tenant ID is required.');
  }
}

function readSqlState(error: unknown): string | undefined {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    if ('code' in current && current.code === SERIALIZATION_FAILURE) {
      return SERIALIZATION_FAILURE;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

export function createTenantTransactionRunner(
  dependencies: TenantTransactionDependencies,
  defaults: TenantTransactionOptions = {},
) {
  const createDatabase = dependencies.createDatabase ?? createNodePgDatabase;
  const sleep = dependencies.sleep ?? defaultSleep;
  const maxAttempts = defaults.maxAttempts ?? 3;
  const retryDelayMs = defaults.retryDelayMs ?? 10;
  const isolationLevel = defaults.isolationLevel ?? 'READ COMMITTED';
  const reportCleanupError = (error: unknown) => {
    try {
      dependencies.onCleanupError?.(error);
    } catch {
      // Observability must not change the transaction outcome.
    }
  };

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error('maxAttempts must be an integer between 1 and 10.');
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a nonnegative number.');
  }
  if (isolationLevel !== 'READ COMMITTED' && isolationLevel !== 'REPEATABLE READ') {
    throw new Error('Unsupported tenant transaction isolation level.');
  }
  const maximumDelay = retryDelayMs * Math.max(1, maxAttempts - 1);
  if (retryDelayMs > MAX_TOTAL_RETRY_DELAY_MS || maximumDelay > MAX_TOTAL_RETRY_DELAY_MS) {
    throw new Error('Retry delay exceeds the operational bound.');
  }

  return async function runTenantTransaction<TResult>(
    tenantId: string,
    callback: (transaction: TenantTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    assertTenantId(tenantId);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const connection = await dependencies.pool.connect();
      let began = false;
      let operationFailed = false;
      let committed = false;
      let discardConnection = false;
      try {
        await connection.query(isolationLevel === 'READ COMMITTED'
          ? 'BEGIN'
          : 'BEGIN ISOLATION LEVEL REPEATABLE READ');
        began = true;
        await connection.query(
          `SELECT set_config('app.tenant_id', $1, true)`,
          [tenantId],
        );
        const result = await callback(createDatabase(connection));
        await connection.query('COMMIT');
        began = false;
        committed = true;
        return result;
      } catch (error) {
        operationFailed = true;
        if (began) {
          try {
            await connection.query('ROLLBACK');
          } catch (rollbackError) {
            discardConnection = true;
            reportCleanupError(rollbackError);
            // Preserve the primary callback/query error.
          }
        }

        if (readSqlState(error) !== SERIALIZATION_FAILURE) {
          throw error;
        }
        if (attempt === maxAttempts) {
          throw new TenantTransactionError(
            'Tenant transaction failed after serialization retries.',
            SERIALIZATION_FAILURE,
          );
        }
        await sleep(retryDelayMs * attempt);
      } finally {
        try {
          if (discardConnection) {
            connection.release(true);
          } else {
            connection.release();
          }
        } catch (releaseError) {
          if (committed || operationFailed) {
            reportCleanupError(releaseError);
          } else {
            throw releaseError;
          }
        }
      }
    }

    throw new TenantTransactionError(
      'Tenant transaction failed after serialization retries.',
      SERIALIZATION_FAILURE,
    );
  };
}

const productionDependencies: TenantTransactionDependencies = {
  get pool() {
    return getDatabaseClient().pool as Pool;
  },
};

const productionRunner = createTenantTransactionRunner(productionDependencies);
const productionSnapshotRunner = createTenantTransactionRunner(
  productionDependencies,
  { isolationLevel: 'REPEATABLE READ' },
);

export const withTenantTransaction = productionRunner;
export const withTenantSnapshot = productionSnapshotRunner;
