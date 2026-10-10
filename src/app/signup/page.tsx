import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SignupAgreementView } from '@/components/account/SignupAgreementView';
import { revisionsSince } from '@/lib/legalDocuments';
import { getPendingAgreementFromRequest } from '@/server/googleOAuth';
import { getProductionClassMembershipRepository } from '@/server/repositories/database/classMemberships';
import { teacherAccountsEnabled } from '@/server/teacherAccounts';

export const metadata = { title: '가입 동의' };
export const dynamic = 'force-dynamic';

export default async function SignupPage() {
  if (!teacherAccountsEnabled()) redirect('/classes');
  const pending = getPendingAgreementFromRequest(new Request('http://classes.internal/signup', { headers: await headers() }));
  if (!pending) redirect('/classes');
  let classNames: string[] | undefined;
  if (pending.mode === 'update') {
    classNames = await getProductionClassMembershipRepository().listByGoogleSubject(pending.subject)
      .then((memberships) => memberships.filter((membership) => membership.role === 'OWNER').map((membership) => membership.displayName))
      .catch(() => undefined);
  }
  return (
    <SignupAgreementView
      mode={pending.mode}
      email={pending.email}
      changes={revisionsSince(pending.agreedVersion)}
      classNames={classNames}
    />
  );
}
