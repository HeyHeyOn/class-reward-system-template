import { headers } from 'next/headers';
import { ClassesSelectionView } from './ClassesSelectionView';
import { loadClassMembershipPage } from '@/server/classMembershipPageAccess';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { getProductionClassDashboardRepository } from '@/server/repositories/database/classDashboard';
import { loadTeacherAccountView, teacherAccountsEnabled } from '@/server/teacherAccounts';

export const metadata = { title: '내 학급' };
export const dynamic = 'force-dynamic';

export default async function ClassesPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const requestHeaders = await headers();
  const request = new Request('http://classes.internal/classes', { headers: requestHeaders });
  const repository = getProductionClassDashboardRepository();
  const model = await loadClassMembershipPage(request, {
    getSession: getGoogleSessionFromRequest,
    listByGoogleSubject: repository.listByGoogleSubject,
  });
  const session = model.kind === 'MEMBERSHIPS' && teacherAccountsEnabled() ? getGoogleSessionFromRequest(request) : null;
  const account = session ? await loadTeacherAccountView(session) : undefined;
  const withdrawn = (await searchParams).withdrawn === '1';
  return <ClassesSelectionView model={model} account={account} withdrawn={withdrawn} />;
}
