import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { followHubSignIn } from '@/server/ddanssaem/teacherGate';
import { GoogleLoginButton } from '@/components/brand/GoogleLoginButton';
import { ClassPageShell } from '../ClassPageShell';
import { ClassCreationForm } from './ClassCreationForm';

export const metadata = { title: '새 학급' };
export const dynamic = 'force-dynamic';

export default async function NewClassPage() {
  const requestHeaders = await headers();
  const session = await getTeacherGoogleSessionFromRequest(new Request('http://classes.internal/classes/new', { headers: requestHeaders }));
  followHubSignIn('/classes/new', session, requestHeaders.get('cookie'));
  return (
    <ClassPageShell eyebrow="학급 만들기" title="새 학급" description="학급 이름만 정하면 바로 매점과 은행을 쓸 수 있어요. 학생, 상품, 과제는 만든 뒤 관리자 화면에서 등록해요.">
      {session ? <ClassCreationForm operationId={randomUUID()} startOperationId={randomUUID()} /> : (
        <div className="space-y-4">
          <p className="text-sm">새 학급을 만들려면 Google 계정으로 로그인해 주세요.</p>
          <GoogleLoginButton href="/api/google/login?returnTo=%2Fclasses" block />
        </div>
      )}
    </ClassPageShell>
  );
}
