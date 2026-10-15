// @vitest-environment node
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('not found'); },
  redirect: () => { throw new Error('redirect'); },
}));
vi.mock('@/server/tenantAdminPageAccess', () => ({ requireTenantAdminPage: vi.fn() }));
vi.mock('@/components/AdminManagePage', () => ({ AdminManagePage: () => null }));
vi.mock('@/components/StudentQrPrintPage', () => ({ StudentQrPrintPage: () => null }));
vi.mock('@/components/TransactionsPage', () => ({ TransactionsPage: () => null }));
vi.mock('@/components/MigrationFreezingPage', () => ({ MigrationFreezingPage: () => null }));
vi.mock('@/components/brand/TeacherHeader', () => ({ TeacherHeader: () => null }));
vi.mock('@/server/teacherAccounts', () => ({ teacherAccountsEnabled: () => false, loadTeacherAccountView: vi.fn() }));
import TenantAdminSubroute from '@/app/c/[slug]/admin/[...path]/page';

it('server-renders the actual scoped login route with its class return path before hydration', async () => {
  expect(typeof window).toBe('undefined');
  const page = await TenantAdminSubroute({ params: Promise.resolve({ slug: 'crs-test-migrated-20261005', path: ['login'] }) });
  const html = renderToStaticMarkup(page);
  expect(html).toContain('href="/api/google/login?returnTo=%2Fc%2Fcrs-test-migrated-20261005%2Fadmin"');
  expect(html).not.toContain('href="/api/google/login?returnTo=%2Fadmin"');
});
