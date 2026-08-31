import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  getCompatibilityCentralTenantContext,
  resolveCompatibilityConfiguredRepository,
} from '@/server/repositories/configuredRepository';

const TENANT_ID = '123e4567-e89b-12d3-a456-426614174000';

describe('compatibility configured repository authority', () => {
  it('projects only the compatibility central tenant fields from env', () => {
    expect(getCompatibilityCentralTenantContext({
      CLASS_STORE_STORAGE: 'postgresql',
      CLASS_STORE_CENTRAL_TENANT_ID: TENANT_ID,
      CLASS_STORE_CENTRAL_TENANT_STATUS: 'ACTIVE',
      UNRELATED: 'ignored',
    })).toEqual({ tenantId: TENANT_ID, tenantStatus: 'ACTIVE' });
  });

  it('reads central tenant compatibility authority only for PostgreSQL', async () => {
    const getCentralTenantContext = vi.fn(() => ({
      tenantId: TENANT_ID,
      tenantStatus: 'ACTIVE',
    }));
    const createPostgresql = vi.fn(async () => 'database');
    const sheetsGetter = vi.fn(() => vi.fn());
    const creators = { createPostgresql } as never;
    Object.defineProperty(creators, 'createSheets', { get: sheetsGetter });

    await expect(resolveCompatibilityConfiguredRepository({
      env: { CLASS_STORE_STORAGE: 'postgresql' },
      getCentralTenantContext,
      creators,
    })).resolves.toMatchObject({ storage: 'postgresql', adapter: 'database' });
    expect(getCentralTenantContext).toHaveBeenCalledOnce();
    expect(sheetsGetter).not.toHaveBeenCalled();
  });

  it('does not inspect central tenant compatibility authority for explicit Sheets', async () => {
    const getCentralTenantContext = vi.fn(() => {
      throw new Error('central tenant authority accessed');
    });
    const createSheets = vi.fn(async () => 'sheets');
    const postgresqlGetter = vi.fn(() => vi.fn());
    const creators = { createSheets } as never;
    Object.defineProperty(creators, 'createPostgresql', { get: postgresqlGetter });

    await expect(resolveCompatibilityConfiguredRepository({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext,
      creators,
    })).resolves.toEqual({ storage: 'sheets', legacy: true, adapter: 'sheets' });
    expect(getCentralTenantContext).not.toHaveBeenCalled();
    expect(postgresqlGetter).not.toHaveBeenCalled();
  });
});
