import { beforeEach, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
const gate = vi.hoisted(() => vi.fn());
vi.mock('@/server/tenantAdminPageAccess', () => ({ requireTenantAdminPage: gate }));
vi.mock('next/navigation', () => ({ notFound: () => { throw Error('not-found'); }, redirect: () => { throw Error('redirect'); } }));
vi.mock('@/components/AdminManagePage', () => ({ AdminManagePage: ({ migrationsHref }: { migrationsHref?: string }) => <a href={migrationsHref}>마이그레이션</a> }));
vi.mock('@/components/AdminLoginPage', () => ({ AdminLoginPage: () => null }));
vi.mock('@/components/StudentQrPrintPage', () => ({ StudentQrPrintPage: () => null }));
vi.mock('@/components/TransactionsPage', () => ({ TransactionsPage: () => null }));
import Page from './[...path]/page';
import Admin from './page';
const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha' };
beforeEach(() => { gate.mockReset(); gate.mockResolvedValue({ tenant, session: { issuedAt: 1 }, membership: { role: 'ADMIN' } }); });
it('has no unscoped migration page or compatibility authority fallback', async () => {
  await expect(access(resolve(process.cwd(), 'src/app/admin/migrations/page.tsx'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('surfaces migrations through canonical gated catch-all', async () => {
  const element = await Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) });
  expect(renderToStaticMarkup(element)).toContain('마이그레이션 FREEZING'); expect(gate).toHaveBeenCalledWith('alpha');
});
it.each(['MEMBER', 'STUDENT', undefined])('refuses membership without current OWNER/ADMIN role: %s', async role => {
  gate.mockResolvedValue({ tenant, session: { issuedAt: 1 }, membership: { role } });
  await expect(Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) })).rejects.toThrow('not-found');
});
it('surfaces the separate diagnostic UI for current OWNER', async () => {
  gate.mockResolvedValue({ tenant, session: { issuedAt: 1 }, membership: { role: 'OWNER' } });
  expect(renderToStaticMarkup(await Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) }))).toContain('진단 준비');
});
it('keys transient controls by original subject/email as well as issuedAt', async () => {
  gate.mockResolvedValue({ tenant, session: { subject: 'actor-a', email: 'a@example.test', issuedAt: 1 }, membership: { role: 'OWNER' } });
  const first = await Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) });
  gate.mockResolvedValue({ tenant, session: { subject: 'actor-b', email: 'a@example.test', issuedAt: 1 }, membership: { role: 'OWNER' } });
  const second = await Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) });
  gate.mockResolvedValue({ tenant, session: { subject: 'actor-a', email: 'b@example.test', issuedAt: 1 }, membership: { role: 'OWNER' } });
  const third = await Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) });
  expect(first.props.sessionKey).not.toBe(second.props.sessionKey);
  expect(first.props.sessionKey).not.toBe(third.props.sessionKey);
});
it('does not expose migration controls to nonmembers', async () => {
  gate.mockRejectedValue(Error('not-found')); await expect(Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) })).rejects.toThrow('not-found');
});
it('refuses compatibility-only and noncanonical context', async () => {
  gate.mockResolvedValue({ tenant, compatibilitySession: { tenantId: tenant.id } }); await expect(Page({ params: Promise.resolve({ slug: 'alpha', path: ['migrations'] }) })).rejects.toThrow('not-found');
  gate.mockResolvedValue({ tenant, needsRedirect: true, session: { issuedAt: 1 }, membership: {} }); await expect(Page({ params: Promise.resolve({ slug: 'Alpha', path: ['migrations'] }) })).rejects.toThrow('not-found');
});
it('provides scoped admin navigation only for member context', async () => {
  expect(renderToStaticMarkup(await Admin({ params: Promise.resolve({ slug: 'alpha' }) })) ).toContain('href="/c/alpha/admin/migrations"');
  gate.mockResolvedValue({ tenant, compatibilitySession: {} }); expect(renderToStaticMarkup(await Admin({ params: Promise.resolve({ slug: 'alpha' }) })) ).not.toContain('href=');
});
