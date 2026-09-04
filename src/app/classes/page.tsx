import { headers } from 'next/headers';
import { ClassesSelectionView } from './ClassesSelectionView';
import { loadClassMembershipPage } from '@/server/classMembershipPageAccess';
import { getGoogleSessionFromRequest } from '@/server/googleOAuth';
import { getProductionClassMembershipRepository } from '@/server/repositories/database/classMemberships';

export const metadata = { title: '내 학급' };
export const dynamic = 'force-dynamic';

export default async function ClassesPage() {
  const requestHeaders = await headers();
  const repository = getProductionClassMembershipRepository();
  const model = await loadClassMembershipPage(
    new Request('http://classes.internal/classes', { headers: requestHeaders }),
    {
      getSession: getGoogleSessionFromRequest,
      listByGoogleSubject: repository.listByGoogleSubject,
    },
  );
  return <ClassesSelectionView model={model} />;
}
