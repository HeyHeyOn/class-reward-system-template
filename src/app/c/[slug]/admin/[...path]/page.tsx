import { Suspense } from 'react';
import { MigrationFreezingPage } from '@/components/MigrationFreezingPage';
import { notFound, redirect } from 'next/navigation';
import { AdminLoginPage } from '@/components/AdminLoginPage';
import { AdminManagePage } from '@/components/AdminManagePage';
import { StudentQrPrintPage } from '@/components/StudentQrPrintPage';
import { TransactionsPage } from '@/components/TransactionsPage';
import { tenantPagePath } from '@/lib/tenantApiPath';
import { requireTenantAdminPage } from '@/server/tenantAdminPageAccess';
import { TeacherHeader } from '@/components/brand/TeacherHeader';
import { loadTeacherAccountView, teacherAccountsEnabled } from '@/server/teacherAccounts';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';

export const metadata = { title: '딴쌤 클래스' };

export default async function TenantAdminSubroute({
  params,
}: Readonly<{ params: Promise<{ slug: string; path?: string[] }> }>) {
  const { slug, path = [] } = await params;
  if (path.length !== 1) notFound();

  // With the 딴쌤 hub the class has no sign-in screen: the admin page sends a signed-out teacher to the hub.
  if (path[0] === 'login' && hubLoginEnabled()) redirect(`/c/${slug}/admin`);
  const access = path[0] !== 'login' ? await requireTenantAdminPage(slug) : null;

  switch (path[0]) {
    case 'login':
      return (
        <>
          <TeacherHeader showLogin={false} />
          <Suspense fallback={null}>
            <AdminLoginPage googleLoginEnabled tenantSlug={slug} />
          </Suspense>
        </>
      );
    case 'migrations':
      if (!access?.membership || !['OWNER', 'ADMIN'].includes(access.membership.role) || !access.session || access.needsRedirect || access.tenant.slug !== slug) notFound();
      return <MigrationFreezingPage slug={access.tenant.slug} tenantId={access.tenant.id} sessionKey={JSON.stringify([access.session.subject, access.session.email, access.session.issuedAt])} />;
    case 'manage': {
      const session = teacherAccountsEnabled() ? access?.session : null;
      const account = session ? await loadTeacherAccountView(session) : undefined;
      return <AdminManagePage migrationsHref={access?.membership ? `/c/${access.tenant.slug}/admin/migrations` : undefined} account={account?.profile} />;
    }
    case 'settings':
      redirect(`/c/${slug}/admin`);
    case 'student-qrs':
      return <><TeacherHeader /><StudentQrPrintPage /></>;
    case 'transactions':
      return <><TeacherHeader /><TransactionsPage adminHref={tenantPagePath('/admin', `/c/${slug}/admin/transactions`)} /></>;
    default:
      notFound();
  }
}
