import 'server-only';

import type {
  LegacySheetsRepositoryAuthority,
  PostgreSQLRepositoryAuthority,
  RepositoryAuthority,
  TenantId,
} from '@/server/repositories/contracts';

export type StorageSelectionEnv = {
  readonly [key: string]: string | undefined;
  readonly CLASS_STORE_STORAGE?: string;
};

export type CentralTenantContextInput = {
  readonly tenantId?: unknown;
  readonly tenantStatus?: unknown;
};

const TENANT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function parseStorageSelection(
  env: StorageSelectionEnv = process.env,
  centralTenant?: CentralTenantContextInput,
): RepositoryAuthority {
  if (!env || typeof env !== 'object' || !hasOwn(env, 'CLASS_STORE_STORAGE')) {
    throw new Error('CLASS_STORE_STORAGE must be exactly "postgresql" or "sheets".');
  }
  if (env.CLASS_STORE_STORAGE === 'postgresql') {
    if (!centralTenant || typeof centralTenant !== 'object' ||
        !hasOwn(centralTenant, 'tenantId') || !hasOwn(centralTenant, 'tenantStatus')) {
      throw new Error('Request-scoped tenant authority fields must be own properties.');
    }
    return validatePostgreSQLAuthority({
      storage: 'postgresql',
      tenantId: centralTenant?.tenantId,
      tenantStatus: centralTenant?.tenantStatus,
    });
  }

  if (env.CLASS_STORE_STORAGE === 'sheets') {
    if (centralTenant !== undefined) {
      throw new Error('Legacy Sheets storage must not include central tenant context.');
    }
    return { storage: 'sheets', legacy: true };
  }

  throw new Error('CLASS_STORE_STORAGE must be exactly "postgresql" or "sheets".');
}

export function validateRepositoryAuthority(value: unknown): RepositoryAuthority {
  if (!value || typeof value !== 'object') {
    throw new Error('Repository authority is invalid.');
  }

  const candidate = value as Record<string, unknown>;
  if (!hasOwn(candidate, 'storage')) {
    throw new Error('Repository authority storage is invalid.');
  }
  if (candidate.storage === 'postgresql') {
    return validatePostgreSQLAuthority(candidate);
  }

  if (candidate.storage === 'sheets') {
    if (candidate.legacy !== true) {
      throw new Error('Legacy Sheets repository authority must be explicit.');
    }
    if ('tenantId' in candidate || 'tenantStatus' in candidate) {
      throw new Error('Legacy Sheets storage must not include central tenant context.');
    }
    return { storage: 'sheets', legacy: true };
  }

  throw new Error('Repository authority storage is invalid.');
}

function validatePostgreSQLAuthority(
  candidate: Record<string, unknown>,
): PostgreSQLRepositoryAuthority {
  if (!hasOwn(candidate, 'tenantId') || !hasOwn(candidate, 'tenantStatus')) {
    throw new Error('Request-scoped tenant authority fields must be own properties.');
  }
  if (typeof candidate.tenantId !== 'string' || !TENANT_UUID.test(candidate.tenantId)) {
    throw new Error('A valid request-scoped tenant UUID is required for PostgreSQL storage.');
  }

  if (candidate.tenantStatus !== 'ACTIVE') {
    throw new Error('Request-scoped tenant status must be exactly "ACTIVE" for PostgreSQL storage.');
  }

  return {
    storage: 'postgresql',
    tenantId: candidate.tenantId as TenantId,
    tenantStatus: 'ACTIVE',
  };
}

export type { LegacySheetsRepositoryAuthority };
