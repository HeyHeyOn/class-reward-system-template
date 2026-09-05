import { Suspense } from 'react';
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

  if (path[0] !== 'login') await requireTenantAdminPage(slug);

  switch (path[0]) {
    case 'login':
      return (
        <Suspense fallback={null}>
          <AdminLoginPage googleLoginEnabled tenantScoped />
        </Suspense>
      );
    case 'manage':
      return <AdminManagePage />;
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
