import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignupAgreementView } from '@/components/account/SignupAgreementView';
import { TeacherHeader } from '@/components/brand/TeacherHeader';
import { revisionsSince } from '@/lib/legalDocuments';
import { readAccountIdentity } from '@/server/accountRequest';
import { getProductionClassMembershipRepository } from '@/server/repositories/database/classMemberships';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';
import { hubLoginEnabled } from '@/server/ddanssaem/hub';

export const metadata = { title: '가입 동의' };
export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (!teacherAccountsEnabled() || hubLoginEnabled()) redirect('/classes');
  const identity = await readAccountIdentity(new Request('http://classes.internal/signup', { headers: await headers() }));
  const pending = identity?.kind === 'pending' ? identity.pending : null;
  if (!pending) redirect('/classes');
  let classNames: string[] | undefined;
  if (pending.mode === 'update') {
    classNames = await getProductionClassMembershipRepository().listByGoogleSubject(pending.subject)
      .then((memberships) => memberships.filter((membership) => membership.role === 'OWNER').map((membership) => membership.displayName))
      .catch(() => undefined);
  }
  return (
    <>
    <TeacherHeader account={null} showLogin={false} />
    <SignupAgreementView
      mode={pending.mode}
      email={pending.email}
      expectedSessionId={pending.sessionId}
      changes={revisionsSince(pending.agreedVersion)}
      classNames={classNames}
    />
    </>
  );
}
