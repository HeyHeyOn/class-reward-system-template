import { Suspense } from 'react';
import { MigrationFreezingPage } from '@/components/MigrationFreezingPage';
import { notFound, redirect } from 'next/navigation';
import { AdminLoginPage } from '@/components/AdminLoginPage';
import { AdminManagePage } from '@/components/AdminManagePage';
import { StudentQrPrintPage } from '@/components/StudentQrPrintPage';
import { TransactionsPage } from '@/components/TransactionsPage';
import { tenantPagePath } from '@/lib/tenantApiPath';
import { requireTenantAdminPage } from '@/server/tenantAdminPageAccess';

export const metadata = { title: '학급 보상 시스템' };

export default async function TenantAdminSubroute({
  params,
}: Readonly<{ params: Promise<{ slug: string; path?: string[] }> }>) {
  const { slug, path = [] } = await params;
  if (path.length !== 1) notFound();

  const access = path[0] !== 'login' ? await requireTenantAdminPage(slug) : null;

  switch (path[0]) {
    case 'login':
      return (
        <Suspense fallback={null}>
          <AdminLoginPage googleLoginEnabled tenantScoped />
        </Suspense>
      );
    case 'migrations':
      if (!access?.membership || !access.session || access.needsRedirect || access.tenant.slug !== slug) notFound();
      return <MigrationFreezingPage slug={access.tenant.slug} tenantId={access.tenant.id} sessionKey={String(access.session.issuedAt)} />;
    case 'manage':
      return <AdminManagePage migrationsHref={access?.membership ? `/c/${access.tenant.slug}/admin/migrations` : undefined} />;
    case 'settings':
      redirect(`/c/${slug}/admin`);
    case 'student-qrs':
      return <StudentQrPrintPage />;
    case 'transactions':
      return <TransactionsPage adminHref={tenantPagePath('/admin', `/c/${slug}/admin/transactions`)} />;
    default:
      notFound();
  }
}
