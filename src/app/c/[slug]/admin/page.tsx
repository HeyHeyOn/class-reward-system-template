import { AdminManagePage } from '@/components/AdminManagePage';
import { LegalAgreementGate } from '@/components/account/LegalAgreementGate';
import { requireTenantAdminPage } from '@/server/tenantAdminPageAccess';
import { loadTeacherAccountView, teacherAccountsEnabled } from '@/server/teacherAccounts';

export const metadata = { title: '딴쌤 클래스' };

export default async function TenantAdminPage({
  params,
}: Readonly<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;
  const access = await requireTenantAdminPage(slug);
  const session = teacherAccountsEnabled() ? access.session : null;
  const account = session ? await loadTeacherAccountView(session) : undefined;
  return (
    <>
      <AdminManagePage
        migrationsHref={access.membership ? `/c/${access.tenant.slug}/admin/migrations` : undefined}
        account={account?.header}
      />
      {account ? <LegalAgreementGate notice={account.notice} /> : null}
    </>
  );
}
