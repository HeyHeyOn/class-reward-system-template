import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ClassesSelectionView } from './ClassesSelectionView';
import { loadClassMembershipPage } from '@/server/classMembershipPageAccess';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { getProductionClassDashboardRepository } from '@/server/repositories/database/classDashboard';
import { loadTeacherAccountView, teacherAccountsEnabled } from '@/server/teacherAccounts';
import type { GoogleSession } from '@/server/googleOAuth';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';
import { hubStartPath, teacherScreenRedirect } from '@/server/ddanssaem/teacherGate';
import { newClassNote } from '@/lib/teacherVerification';

export const metadata = { title: '내 학급' };
export const dynamic = 'force-dynamic';

export default async function ClassesPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  const requestHeaders = await headers();
  const request = new Request('http://classes.internal/classes', { headers: requestHeaders });
  const params = await searchParams;
  let sessionRead: Promise<GoogleSession | null> | undefined;
  const getSession = (from: Request) => (sessionRead ??= getTeacherGoogleSessionFromRequest(from));
  // With the 딴쌤 hub there is no sign-in screen here: the hub's sign-in page, or back after a failed sign-in.
  const hub = hubLoginEnabled();
  const loginFailed = hub && typeof params.login_error === 'string';
  if (hub && !loginFailed) {
    const target = teacherScreenRedirect({ path: '/classes', session: await getSession(request), cookieHeader: requestHeaders.get('cookie') });
    if (target) redirect(target);
  }
  const repository = getProductionClassDashboardRepository();
  const loaded = await loadClassMembershipPage(request, { getSession, listByGoogleSubject: repository.listByGoogleSubject });
  const model = hub && loaded.kind === 'LOGIN_REQUIRED' ? { ...loaded, loginHref: hubStartPath('/classes') } : loaded;
  const session = model.kind === 'MEMBERSHIPS' && teacherAccountsEnabled() ? await getSession(request) : null;
  const account = session ? await loadTeacherAccountView(session) : undefined;
  const withdrawn = params.withdrawn === '1';
  const newClass = account ? { note: newClassNote(account.verification), verifyUrl: account.header.verifyUrl } : undefined;
  return <ClassesSelectionView model={model} account={account} header={account?.header} newClass={newClass} withdrawn={withdrawn} loginFailed={loginFailed} />;
}
