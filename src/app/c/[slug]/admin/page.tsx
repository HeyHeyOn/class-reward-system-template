import { AdminManagePage } from '@/components/AdminManagePage';
import { requireTenantAdminPage } from '@/server/tenantAdminPageAccess';

export const metadata = { title: '학급 보상 시스템' };

export default async function TenantAdminPage({
  params,
}: Readonly<{ params: Promise<{ slug: string }> }>) {
  const { slug } = await params;
  const access = await requireTenantAdminPage(slug);
  return <AdminManagePage migrationsHref={access.membership ? `/c/${access.tenant.slug}/admin/migrations` : undefined} />;
}
