import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => vi.fn());
const snapshot = vi.hoisted(() => vi.fn());
vi.mock('server-only', () => ({}));
vi.mock('@/server/tenantAdminPageAccess', () => ({ requireTenantAdminPage: gate }));
vi.mock('@/server/db/transaction', () => ({ withTenantSnapshot: snapshot, withTenantTransaction: vi.fn() }));
vi.mock('next/navigation', () => ({ notFound: () => { throw Error('not-found'); }, redirect: () => { throw Error('redirect'); } }));
vi.mock('@/components/MigrationFreezingPage', () => ({ MigrationFreezingPage: ({ tenantId }: { tenantId: string }) => <p>운영자 이전 {tenantId}</p> }));
vi.mock('@/components/xlsxImport/XlsxImportPanel', () => ({ XlsxImportPanel: ({ slug, mode }: { slug: string; mode: string }) => <p>업로드 {slug} {mode}</p> }));
import Page from './page';

const tenant = { id: '20000000-0000-4000-8000-000000000001', slug: 'alpha', displayName: '알파 학급', lifecycle: 'ACTIVE' };
const empty = { students: 0, products: 0, promotions: 0, tasks: 0, transactions: 0 };
const render = async (query: Record<string, string> = {}) =>
  renderToStaticMarkup(await Page({ params: Promise.resolve({ slug: 'alpha' }), searchParams: Promise.resolve(query) }));

beforeEach(() => {
  gate.mockReset(); snapshot.mockReset();
  gate.mockResolvedValue({ tenant, needsRedirect: false, session: { subject: 's', email: 'e@example.invalid', issuedAt: 1 }, membership: { role: 'OWNER' } });
  snapshot.mockResolvedValue(empty);
});

it('offers the workbook upload to an active, still empty class', async () => {
  const html = await render();
  expect(html).toContain('자료 가져오기');
  expect(html).toContain('업로드 alpha import');
  expect(snapshot).toHaveBeenCalledWith(tenant.id, expect.any(Function));
  // The operator controls stay reachable but folded away for teachers.
  expect(html).toContain('운영자 이전 20000000-0000-4000-8000-000000000001');
  expect(html).not.toMatch(/<details[^>]* open/);
});

it('refuses to import into a class that already has data', async () => {
  snapshot.mockResolvedValue({ ...empty, students: 3, tasks: 1 });
  const html = await render();
  expect(html).not.toContain('업로드');
  expect(html).toContain('이미 자료가 있는 학급이에요');
  expect(html).toContain('학생 3명, 상품 0개, 과제 1개');
});

it('sends a new class to its start page and opens the operator controls on an OAuth return', async () => {
  gate.mockResolvedValue({ tenant: { ...tenant, lifecycle: 'DRAFT' }, needsRedirect: false,
    session: { subject: 's', email: 'e@example.invalid', issuedAt: 1 }, membership: { role: 'ADMIN' } });
  const html = await render();
  expect(html).toContain('href="/classes/alpha/start"');
  expect(snapshot).not.toHaveBeenCalled();
  expect(html).toMatch(/<details[^>]* open/);
  gate.mockResolvedValue({ tenant, needsRedirect: false, session: { subject: 's', email: 'e', issuedAt: 1 }, membership: { role: 'OWNER' } });
  expect(await render({ consent: 'returned' })).toMatch(/<details[^>]* open/);
});

it.each([
  [{ tenant, session: { issuedAt: 1 }, membership: { role: 'MEMBER' } }],
  [{ tenant, compatibilitySession: { tenantId: tenant.id } }],
  [{ tenant, needsRedirect: true, session: { issuedAt: 1 }, membership: { role: 'OWNER' } }],
])('refuses non-admin, compatibility-only or noncanonical context', async context => {
  gate.mockResolvedValue(context);
  await expect(render()).rejects.toThrow('not-found');
  expect(snapshot).not.toHaveBeenCalled();
});
