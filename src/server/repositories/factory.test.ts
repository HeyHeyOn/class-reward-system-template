import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { RepositoryAuthority } from '@/server/repositories/contracts';
import { parseStorageSelection } from '@/server/repositories/context';
import { resolveRepository, resolveRepositoryFromEnv } from '@/server/repositories/factory';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';

function postgresqlEnv(overrides: Record<string, string | undefined> = {}) {
  return { CLASS_STORE_STORAGE: 'postgresql', ...overrides };
}

function activeTenant(overrides: Record<string, unknown> = {}) {
  return { tenantId: TENANT_ID, tenantStatus: 'ACTIVE', ...overrides };
}

function creators() {
  return {
    createPostgresql: vi.fn(async () => ({ backend: 'fake-postgresql' as const })),
    createSheets: vi.fn(async () => ({ backend: 'fake-sheets' as const })),
  };
}

describe('repository storage selection', () => {
  it('resolves each trusted request tenant independently through only the DB creator', async () => {
    const dependencies = creators();
    const otherTenantId = '223e4567-e89b-12d3-a456-426614174000';

    await expect(resolveRepositoryFromEnv(postgresqlEnv(), activeTenant(), dependencies)).resolves.toMatchObject({
      storage: 'postgresql', tenantId: TENANT_ID, tenantStatus: 'ACTIVE',
    });
    await expect(resolveRepositoryFromEnv(
      postgresqlEnv(), activeTenant({ tenantId: otherTenantId }), dependencies,
    )).resolves.toMatchObject({
      storage: 'postgresql', tenantId: otherTenantId, tenantStatus: 'ACTIVE',
    });
    expect(dependencies.createPostgresql).toHaveBeenCalledTimes(2);
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('resolves explicit legacy Sheets only when no central tenant context exists', async () => {
    const dependencies = creators();

    await expect(resolveRepositoryFromEnv(
      { CLASS_STORE_STORAGE: 'sheets' }, undefined, dependencies,
    )).resolves.toEqual({ storage: 'sheets', legacy: true, adapter: { backend: 'fake-sheets' } });
    expect(dependencies.createSheets).toHaveBeenCalledOnce();
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
  });

  it('rejects inherited deployment storage instead of trusting the prototype chain', () => {
    const inheritedEnv = Object.create({ CLASS_STORE_STORAGE: 'sheets' }) as Record<string, string>;

    expect(() => parseStorageSelection(inheritedEnv)).toThrow(/CLASS_STORE_STORAGE/);
  });

  it('rejects inherited request tenant authority fields', async () => {
    const dependencies = creators();
    const inheritedTenant = Object.create(activeTenant()) as Record<string, unknown>;

    await expect(resolveRepositoryFromEnv(
      postgresqlEnv(), inheritedTenant, dependencies,
    )).rejects.toThrow(/tenant/i);
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('rejects an inherited raw repository discriminant', async () => {
    const dependencies = creators();
    const inheritedAuthority = Object.create({
      storage: 'postgresql', tenantId: TENANT_ID, tenantStatus: 'ACTIVE',
    }) as RepositoryAuthority;

    await expect(resolveRepository(inheritedAuthority, dependencies)).rejects.toThrow(/authority|storage/i);
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', {}],
    ['blank', { CLASS_STORE_STORAGE: '   ' }],
    ['unknown', { CLASS_STORE_STORAGE: 'redis' }],
    ['fallback-like auto', { CLASS_STORE_STORAGE: 'auto' }],
    ['mixed', { CLASS_STORE_STORAGE: 'postgresql,sheets' }],
  ])('rejects a %s storage mode without initializing either backend', async (_label, env) => {
    const dependencies = creators();

    await expect(resolveRepositoryFromEnv(env, activeTenant(), dependencies)).rejects.toThrow(
      'CLASS_STORE_STORAGE must be exactly "postgresql" or "sheets".',
    );
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it.each([
    ['missing context', undefined],
    ['missing ID', { tenantStatus: 'ACTIVE' }],
    ['blank ID', activeTenant({ tenantId: '   ' })],
    ['malformed ID', activeTenant({ tenantId: 'not-a-uuid' })],
    ['non-canonical ID', activeTenant({ tenantId: '123e4567e89b12d3a456426614174000' })],
    ['nil UUID', activeTenant({ tenantId: '00000000-0000-0000-0000-000000000000' })],
    ['unsupported UUID version', activeTenant({ tenantId: '123e4567-e89b-92d3-a456-426614174000' })],
    ['invalid UUID variant', activeTenant({ tenantId: '123e4567-e89b-12d3-7456-426614174000' })],
  ])('rejects PostgreSQL %s before initializing either backend', async (_label, tenantContext) => {
    const dependencies = creators();

    await expect(resolveRepositoryFromEnv(
      postgresqlEnv(), tenantContext, dependencies,
    )).rejects.toThrow(/tenant/i);
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('accepts a request tenant UUID regardless of hex letter case', async () => {
    const dependencies = creators();
    const uppercaseTenantId = TENANT_ID.toUpperCase();

    await expect(resolveRepositoryFromEnv(
      postgresqlEnv(), activeTenant({ tenantId: uppercaseTenantId }), dependencies,
    )).resolves.toMatchObject({ tenantId: uppercaseTenantId, tenantStatus: 'ACTIVE' });
  });

  it.each([undefined, '', 'PENDING', 'SUSPENDED']) (
    'rejects request tenant status %s before initializing either backend',
    async (tenantStatus) => {
      const dependencies = creators();

      await expect(resolveRepositoryFromEnv(
        postgresqlEnv(), activeTenant({ tenantStatus }), dependencies,
      )).rejects.toThrow(/ACTIVE/);
      expect(dependencies.createPostgresql).not.toHaveBeenCalled();
      expect(dependencies.createSheets).not.toHaveBeenCalled();
    },
  );

  it('rejects any central tenant context in legacy Sheets mode', async () => {
    const dependencies = creators();

    await expect(resolveRepositoryFromEnv(
      { CLASS_STORE_STORAGE: 'sheets' }, activeTenant(), dependencies,
    )).rejects.toThrow('Legacy Sheets storage must not include central tenant context.');
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('runtime-validates a raw PostgreSQL authority before invoking its creator', async () => {
    const dependencies = creators();
    const malformed = {
      storage: 'postgresql', tenantId: '', tenantStatus: 'ACTIVE',
    } as unknown as RepositoryAuthority;

    await expect(resolveRepository(malformed, dependencies)).rejects.toThrow(/tenant/i);
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('runtime-validates a raw Sheets authority before invoking its creator', async () => {
    const dependencies = creators();
    const malformed = { storage: 'sheets', legacy: false } as unknown as RepositoryAuthority;

    await expect(resolveRepository(malformed, dependencies)).rejects.toThrow(/legacy/i);
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('rejects a malformed selected creator without touching the unselected backend', async () => {
    const unselectedGetter = vi.fn(() => { throw new Error('unselected creator accessed'); });
    const malformedCreators = { createPostgresql: null } as unknown as ReturnType<typeof creators>;
    Object.defineProperty(malformedCreators, 'createSheets', { get: unselectedGetter });

    await expect(resolveRepositoryFromEnv(
      postgresqlEnv(), activeTenant(), malformedCreators,
    )).rejects.toThrow(/PostgreSQL repository creator/i);
    expect(unselectedGetter).not.toHaveBeenCalled();
  });

  it('rejects a malformed selected Sheets creator without touching PostgreSQL', async () => {
    const unselectedGetter = vi.fn(() => { throw new Error('unselected creator accessed'); });
    const malformedCreators = { createSheets: 'not-callable' } as unknown as ReturnType<typeof creators>;
    Object.defineProperty(malformedCreators, 'createPostgresql', { get: unselectedGetter });

    await expect(resolveRepositoryFromEnv(
      { CLASS_STORE_STORAGE: 'sheets' }, undefined, malformedCreators,
    )).rejects.toThrow(/Sheets repository creator/i);
    expect(unselectedGetter).not.toHaveBeenCalled();
  });

  it('propagates a DB creator rejection without falling back to Sheets', async () => {
    const dbError = new Error('fake DB unavailable');
    const dependencies = creators();
    dependencies.createPostgresql.mockRejectedValueOnce(dbError);

    await expect(resolveRepositoryFromEnv(
      postgresqlEnv(), activeTenant(), dependencies,
    )).rejects.toBe(dbError);
    expect(dependencies.createPostgresql).toHaveBeenCalledOnce();
    expect(dependencies.createSheets).not.toHaveBeenCalled();
  });

  it('propagates a Sheets creator rejection without initializing PostgreSQL', async () => {
    const sheetsError = new Error('fake Sheets unavailable');
    const dependencies = creators();
    dependencies.createSheets.mockRejectedValueOnce(sheetsError);

    await expect(resolveRepositoryFromEnv(
      { CLASS_STORE_STORAGE: 'sheets' }, undefined, dependencies,
    )).rejects.toBe(sheetsError);
    expect(dependencies.createSheets).toHaveBeenCalledOnce();
    expect(dependencies.createPostgresql).not.toHaveBeenCalled();
  });

  it('does not silently choose Sheets when storage mode is absent despite tenant context', () => {
    expect(() => parseStorageSelection({}, activeTenant())).toThrow(
      'CLASS_STORE_STORAGE must be exactly "postgresql" or "sheets".',
    );
  });
});
