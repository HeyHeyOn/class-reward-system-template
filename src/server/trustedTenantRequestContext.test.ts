import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  getTrustedTenantRequestContext,
  runWithTrustedTenantRequestContext,
} from '@/server/trustedTenantRequestContext';
import { resolveCompatibilityConfiguredRepository } from '@/server/repositories/configuredRepository';

const tenant = {
  id: '20000000-0000-4000-8000-000000000001',
  slug: 'alpha-class',
  displayName: 'Alpha Class',
  lifecycle: 'ACTIVE' as const,
  timezone: 'Asia/Seoul' as const,
};

describe('trusted tenant request context', () => {
  it('isolates concurrent tenant contexts', async () => {
    const seen: string[] = [];
    await Promise.all([
      runWithTrustedTenantRequestContext({ tenant }, async () => {
        await Promise.resolve();
        seen.push(getTrustedTenantRequestContext().tenant.id);
      }),
      runWithTrustedTenantRequestContext({ tenant: { ...tenant, id: '20000000-0000-4000-8000-000000000002', slug: 'beta-class' } }, async () => {
        await Promise.resolve();
        seen.push(getTrustedTenantRequestContext().tenant.id);
      }),
    ]);
    expect(seen.sort()).toEqual([
      '20000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
    ]);
  });

  it('makes configured PostgreSQL repositories prefer the trusted request tenant over env', async () => {
    const createPostgresql = vi.fn((authority) => authority);
    const createSheets = vi.fn();

    const resolved = await runWithTrustedTenantRequestContext({ tenant }, () =>
      resolveCompatibilityConfiguredRepository({
        env: {
          CLASS_STORE_STORAGE: 'postgresql',
          CLASS_STORE_CENTRAL_TENANT_ID: '20000000-0000-4000-8000-000000000099',
          CLASS_STORE_CENTRAL_TENANT_STATUS: 'ACTIVE',
        },
        getCentralTenantContext: () => ({
          tenantId: '20000000-0000-4000-8000-000000000099',
          tenantStatus: 'ACTIVE',
        }),
        creators: { createPostgresql, createSheets },
      }),
    );

    expect(resolved.storage).toBe('postgresql');
    if (resolved.storage !== 'postgresql') throw new Error('Expected PostgreSQL repository.');
    expect(resolved.tenantId).toBe(tenant.id);
    expect(createPostgresql).toHaveBeenCalledWith(expect.objectContaining({ tenantId: tenant.id }));
  });

  it('never falls back to Sheets for a trusted scoped tenant even when legacy env selects Sheets', async () => {
    const createPostgresql = vi.fn((authority) => authority);
    const createSheets = vi.fn();

    const resolved = await runWithTrustedTenantRequestContext({ tenant }, () =>
      resolveCompatibilityConfiguredRepository({
        env: { CLASS_STORE_STORAGE: 'sheets' },
        getCentralTenantContext: () => undefined,
        creators: { createPostgresql, createSheets },
      }),
    );

    expect(resolved.storage).toBe('postgresql');
    expect(createPostgresql).toHaveBeenCalledWith(expect.objectContaining({ tenantId: tenant.id }));
    expect(createSheets).not.toHaveBeenCalled();
  });

  it('preserves explicit legacy repository resolution outside scoped context', async () => {
    const adapter = { legacy: true };
    await expect(resolveCompatibilityConfiguredRepository({
      env: { CLASS_STORE_STORAGE: 'sheets' },
      getCentralTenantContext: () => undefined,
      creators: { createPostgresql: vi.fn(), createSheets: vi.fn(() => adapter) },
    })).resolves.toMatchObject({ storage: 'sheets', adapter });
  });
});
