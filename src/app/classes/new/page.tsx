import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { followHubSignIn } from '@/server/ddanssaem/teacherGate';
import { GoogleLoginButton } from '@/components/brand/GoogleLoginButton';
import { ClassPageShell } from '../ClassPageShell';
import { ClassCreationForm } from './ClassCreationForm';
import { hubLoginEnabled, hubVerifyUrl } from '@/server/ddanssaem/hub';
import { teacherVerificationOf } from '@/server/teacherAccounts';
import { blocksNewClass, NEW_CLASS_BLOCKED } from '@/lib/teacherVerification';

export const metadata = { title: '새 학급' };
export const dynamic = 'force-dynamic';

export default async function NewClassPage() {
  const requestHeaders = await headers();
  const session = await getTeacherGoogleSessionFromRequest(new Request('http://classes.internal/classes/new', { headers: requestHeaders }));
  followHubSignIn('/classes/new', session, requestHeaders.get('cookie'));
  // 교사 인증 (account-protocol 10-4): a teacher who must be verified and is not is told so instead of the form.
  const blocked = session ? blocksNewClass(await teacherVerificationOf(session.subject)) : false;
  return (
    <ClassPageShell eyebrow="학급 만들기" title="새 학급" description="학급 이름만 정하면 바로 매점과 은행을 쓸 수 있어요. 학생, 상품, 과제는 만든 뒤 관리자 화면에서 등록해요.">
      {session && blocked ? (
        <div data-testid="new-class-verify" className="space-y-4">
          <p className="text-[15px] font-semibold leading-relaxed">{NEW_CLASS_BLOCKED}</p>
          {hubLoginEnabled() ? (
            <a href={hubVerifyUrl()} className="inline-flex h-11 items-center justify-center rounded-[12px] bg-[#2B6DE8] px-5 text-[14px] font-bold text-white hover:bg-[#1D58C6]">인증하기</a>
          ) : null}
        </div>
      ) : session ? <ClassCreationForm operationId={randomUUID()} startOperationId={randomUUID()} /> : (
        <div className="space-y-4">
          <p className="text-sm">새 학급을 만들려면 Google 계정으로 로그인해 주세요.</p>
          <GoogleLoginButton href="/api/google/login?returnTo=%2Fclasses" block />
        </div>
      )}
    </ClassPageShell>
  );
}
