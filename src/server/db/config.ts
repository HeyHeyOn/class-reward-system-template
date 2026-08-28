import 'server-only';

type DatabaseEnv = {
  [key: string]: string | undefined;
  DATABASE_URL?: string;
  DIRECT_DATABASE_URL?: string;
};

export type DatabaseConfig = {
  databaseUrl: string;
  directDatabaseUrl: string;
};

export function parseDatabaseConfig(env: DatabaseEnv): DatabaseConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required.');
  }

  assertPostgresUrl(databaseUrl, 'DATABASE_URL');

  const directDatabaseUrl = env.DIRECT_DATABASE_URL?.trim() || databaseUrl;
  assertPostgresUrl(directDatabaseUrl, 'DIRECT_DATABASE_URL');

  return { databaseUrl, directDatabaseUrl };
}

export function getDatabaseConfig(env: DatabaseEnv = process.env): DatabaseConfig {
  return parseDatabaseConfig(env);
}

function assertPostgresUrl(value: string, name: 'DATABASE_URL' | 'DIRECT_DATABASE_URL'): void {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || !url.hostname) {
      throw new Error('invalid PostgreSQL URL');
    }
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
}
