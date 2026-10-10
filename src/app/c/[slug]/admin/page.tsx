import { headers } from 'next/headers';
import { AdminManagePage } from '@/components/AdminManagePage';
import { LegalAgreementGate } from '@/components/account/LegalAgreementGate';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { requireTenantAdminPage } from '@/server/tenantAdminPageAccess';
import { loadTeacherAccountView, teacherAccountsEnabled } from '@/server/teacherAccounts';

export const metadata = { title: '학급 보상 시스템' };

export default async function TenantAdminPage({
  params,
}: Readonly<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;
  const access = await requireTenantAdminPage(slug);
  const session = teacherAccountsEnabled()
    ? getGoogleSessionFromRequest(new Request(`http://classes.internal/c/${slug}/admin`, { headers: await headers() }))
    : null;
  const account = session ? await loadTeacherAccountView(session) : undefined;
  return (
    <>
      <AdminManagePage
        migrationsHref={access.membership ? `/c/${access.tenant.slug}/admin/migrations` : undefined}
        account={account?.profile}
      />
      {account ? <LegalAgreementGate notice={account.notice} /> : null}
    </>
  );
}
