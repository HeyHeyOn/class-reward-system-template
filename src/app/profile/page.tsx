import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ProfileView } from '@/components/account/ProfileView';
import { LEGAL_REVISIONS } from '@/lib/legalDocuments';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { getProductionClassDashboardRepository } from '@/server/repositories/database/classDashboard';
import { getProductionTeacherAccountStore, legalNoticeFor, resolveTeacherProfile, teacherAccountsEnabled } from '@/server/teacherAccounts';

export const metadata = { title: '내 프로필' };
export const dynamic = 'force-dynamic';

/** e.g. 2026년 10월 8일 15:12 (Korea time), built from parts so it never depends on locale wording. */
function seoulDateTime(iso: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.year}년 ${parts.month}월 ${parts.day}일 ${parts.hour}:${parts.minute}`;
}

export default async function ProfilePage() {
  if (!teacherAccountsEnabled()) redirect('/classes');
  const session = getGoogleSessionFromRequest(new Request('http://classes.internal/profile', { headers: await headers() }));
  if (!session) redirect('/classes');
  const accounts = getProductionTeacherAccountStore();
  const [stored, agreement, memberships] = await Promise.all([
    accounts.getProfile(session.subject),
    accounts.latestAgreement(session.subject),
    getProductionClassDashboardRepository().listByGoogleSubject(session.subject),
  ]);
  const effectiveLabel = LEGAL_REVISIONS.find((revision) => revision.version === agreement?.version)?.effectiveLabel ?? agreement?.version;
  return (
    <ProfileView model={{
      email: session.email,
      profile: resolveTeacherProfile(session, stored),
      agreement: agreement && effectiveLabel ? { effectiveLabel, agreedAtLabel: seoulDateTime(agreement.agreedAt) } : null,
      classNames: memberships.filter((membership) => membership.role === 'OWNER').map((membership) => membership.displayName),
      notice: legalNoticeFor(session),
    }} />
  );
}
