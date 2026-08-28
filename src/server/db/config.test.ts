import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { parseDatabaseConfig } from '@/server/db/config';

describe('database configuration', () => {
  it('requires DATABASE_URL for runtime connections', () => {
    expect(() => parseDatabaseConfig({})).toThrow('DATABASE_URL is required.');
    expect(() => parseDatabaseConfig({ DATABASE_URL: '   ' })).toThrow('DATABASE_URL is required.');
  });

  it.each([
    'postgres://runtime.example/class_store',
    'postgresql://runtime.example/class_store',
  ])('accepts a PostgreSQL runtime URL (%s)', (databaseUrl) => {
    expect(parseDatabaseConfig({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      directDatabaseUrl: databaseUrl,
    });
  });

  it('uses DIRECT_DATABASE_URL for migrations when configured', () => {
    const databaseUrl = 'postgresql://pool.example/class_store?sslmode=require';
    const directDatabaseUrl = 'postgresql://direct.example/class_store?sslmode=require';

    expect(parseDatabaseConfig({ DATABASE_URL: databaseUrl, DIRECT_DATABASE_URL: directDatabaseUrl })).toEqual({
      databaseUrl,
      directDatabaseUrl,
    });
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: 'not a url' }],
    ['DATABASE_URL', { DATABASE_URL: 'https://example.com/class_store' }],
    ['DIRECT_DATABASE_URL', {
      DATABASE_URL: 'postgresql://runtime.example/class_store',
      DIRECT_DATABASE_URL: 'mysql://direct.example/class_store',
    }],
  ])('rejects malformed or non-PostgreSQL %s values', (name, env) => {
    expect(() => parseDatabaseConfig(env)).toThrow(`${name} must be a valid PostgreSQL URL.`);
  });

  it.each([
    {
      DATABASE_URL: 'postgresql://runtime-user:runtime-password@[runtime-secret.example/class_store?password=query-secret&sslcert=private-cert',
    },
    {
      DATABASE_URL: 'postgresql://runtime.example/class_store',
      DIRECT_DATABASE_URL: 'postgresql://direct-user:direct-password@[direct-secret.example/class_store?password=direct-query-secret',
    },
  ])('does not expose URL credentials in validation errors', (env) => {
    let message = '';
    try {
      parseDatabaseConfig(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe(
      env.DIRECT_DATABASE_URL
        ? 'DIRECT_DATABASE_URL must be a valid PostgreSQL URL.'
        : 'DATABASE_URL must be a valid PostgreSQL URL.',
    );
    expect(message).not.toMatch(/runtime-user|runtime-password|runtime-secret|query-secret|private-cert/);
    expect(message).not.toMatch(/direct-user|direct-password|direct-secret|direct-query-secret/);
  });
});
