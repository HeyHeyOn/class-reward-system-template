import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: vi.fn() }));
vi.mock('@/server/googleOAuth', () => ({ getGoogleSessionFromRequest: vi.fn() }));

import { createTenantAccessDependencies } from '@/server/tenantAccess';

const TENANT_ID = '20000000-0000-4000-8000-000000000001';

describe('tenant access database queries', () => {
  it('finds a tenant through the exact-slug platform function with a bound value', async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      void text;
      void values;
      return { rows: [{
        id: TENANT_ID,
        slug: 'alpha-class',
        display_name: 'Alpha',
        lifecycle: 'ACTIVE',
        timezone: 'Asia/Seoul',
      }] as unknown[] };
    });
    const dependencies = createTenantAccessDependencies({ query }, vi.fn());

    await expect(dependencies.findBySlug('alpha-class')).resolves.toEqual({
      id: TENANT_ID,
      slug: 'alpha-class',
      displayName: 'Alpha',
      lifecycle: 'ACTIVE',
      timezone: 'Asia/Seoul',
    });

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM public.platform_find_tenant_by_slug($1)',
      ['alpha-class'],
    );
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\bFROM\s+(?:public\.)?tenants\b/i);
  });

  it('finds a membership through the exact tenant-and-subject platform function', async () => {
    const query = vi.fn(async (text: string, values?: unknown[]) => {
      void text;
      void values;
      return { rows: [{
        id: '30000000-0000-4000-8000-000000000001',
        tenant_id: TENANT_ID,
        user_id: '10000000-0000-4000-8000-000000000001',
        google_subject: 'subject-a',
        role: 'OWNER',
      }] as unknown[] };
    });
    const dependencies = createTenantAccessDependencies({ query }, vi.fn());

    await expect(dependencies.findByTenantAndSubject(TENANT_ID, 'subject-a')).resolves.toEqual({
      id: '30000000-0000-4000-8000-000000000001',
      tenantId: TENANT_ID,
      userId: '10000000-0000-4000-8000-000000000001',
      googleSubject: 'subject-a',
      role: 'OWNER',
    });

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM public.platform_find_membership_by_tenant_and_google_subject($1, $2)',
      [TENANT_ID, 'subject-a'],
    );
    expect(query.mock.calls[0]?.[0]).not.toMatch(/\bFROM\s+(?:public\.)?tenant_memberships\b/i);
  });
});
