import 'server-only';

import { getDatabaseClient } from '@/server/db/client';
import { createGoogleDriveV3SourceControlReader } from '@/server/migration/googleDriveSourceControlReader';
import { verifyGoogleSheetSourceControl } from '@/server/migration/googleSourceControl';
import type { EphemeralMigrationAuthorization } from '@/server/migration/googleSheetsConsent';
import {
  createTenantBootstrapper,
  type TenantBootstrapResult,
} from '@/server/repositories/database/tenantBootstrap';

type QueryResult = Readonly<{ rows: Record<string, unknown>[] }>;

type BootstrapConnection = Readonly<{
  query(text: string, values?: unknown[]): Promise<QueryResult>;
  release(error?: Error | boolean): void;
}>;

export type TenantBootstrapPool = Readonly<{
  connect(): Promise<BootstrapConnection>;
}>;

export type GoogleSheetTenantBootstrapInput = Readonly<{
  selectedSheetId: string;
  session: Readonly<{
    subject: string;
    email: string;
    name?: string;
    issuedAt: number;
  }>;
  slug: string;
  displayName: string;
  sourceFingerprint: string;
  credentialHashes?: Readonly<{
    adminPasswordHash?: string;
    recoveryCodeHash?: string;
  }>;
  authorization: EphemeralMigrationAuthorization;
}>;

export type GoogleSheetTenantBootstrapDependencies = Readonly<{
  pool: TenantBootstrapPool;
  now?: () => number;
  createId?: () => string;
  onCleanupError?: (error: unknown) => void;
}>;

export function createGoogleSheetTenantBootstrapService(
  dependencies: GoogleSheetTenantBootstrapDependencies,
) {
  return async function bootstrapGoogleSheetTenant(
    input: GoogleSheetTenantBootstrapInput,
  ): Promise<TenantBootstrapResult> {
    const authenticatedRequest = input.authorization.auth.request;
    if (!authenticatedRequest) {
      throw new Error('Authenticated Google Drive authorization is required.');
    }
    const reader = createGoogleDriveV3SourceControlReader({
      request: (options) => authenticatedRequest.call(input.authorization.auth, options),
    }, dependencies.now);
    const proof = await verifyGoogleSheetSourceControl({
      fileId: input.selectedSheetId,
      session: input.session,
      reader,
      ...(dependencies.now ? { now: dependencies.now } : {}),
    });
    const bootstrap = createTenantBootstrapper({
      runTransaction: (callback) => runBootstrapTransaction(
        dependencies.pool,
        callback,
        dependencies.onCleanupError,
      ),
      ...(dependencies.createId ? { createId: dependencies.createId } : {}),
    });

    return bootstrap({
      slug: input.slug,
      displayName: input.displayName,
      owner: {
        subject: input.session.subject,
        email: input.session.email,
        ...(input.session.name === undefined ? {} : { name: input.session.name }),
      },
      proof,
      sourceFingerprint: input.sourceFingerprint,
      ...(input.credentialHashes === undefined ? {} : { credentialHashes: input.credentialHashes }),
    });
  };
}

export async function bootstrapGoogleSheetTenant(
  input: GoogleSheetTenantBootstrapInput,
): Promise<TenantBootstrapResult> {
  return createGoogleSheetTenantBootstrapService({
    pool: getDatabaseClient().pool,
  })(input);
}

async function runBootstrapTransaction<TResult>(
  pool: TenantBootstrapPool,
  callback: (transaction: BootstrapConnection) => Promise<TResult>,
  onCleanupError?: (error: unknown) => void,
): Promise<TResult> {
  const connection = await pool.connect();
  let began = false;
  let committed = false;
  let failed = false;
  let discardConnection = false;
  try {
    await connection.query('BEGIN');
    began = true;
    const result = await callback(connection);
    await connection.query('COMMIT');
    began = false;
    committed = true;
    return result;
  } catch (error) {
    failed = true;
    if (began) {
      try {
        await connection.query('ROLLBACK');
      } catch (rollbackError) {
        discardConnection = true;
        reportCleanupError(onCleanupError, rollbackError);
      }
    }
    throw error;
  } finally {
    try {
      if (discardConnection) connection.release(true);
      else connection.release();
    } catch (releaseError) {
      if (failed || committed) {
        reportCleanupError(onCleanupError, releaseError);
      } else {
        throw releaseError;
      }
    }
  }
}

function reportCleanupError(
  observer: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    observer?.(error);
  } catch {
    // Cleanup observability must not change the transaction outcome.
  }
}
