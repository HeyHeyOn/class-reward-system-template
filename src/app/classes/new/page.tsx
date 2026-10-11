import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { buttonClass } from '@/components/ui/classes';
import { ClassPageShell } from '../ClassPageShell';
import { ClassCreationForm } from './ClassCreationForm';

export const metadata = { title: '새 학급' };
export const dynamic = 'force-dynamic';

export default async function NewClassPage() {
  const session = await getTeacherGoogleSessionFromRequest(new Request('http://classes.internal/classes/new', { headers: await headers() }));
  return (
    <ClassPageShell eyebrow="학급 만들기" title="새 학급" description="학급 이름만 정하면 바로 매점과 은행을 쓸 수 있습니다. 학생, 상품, 과제는 만든 뒤 관리자 화면에서 등록합니다.">
      {session ? <ClassCreationForm operationId={randomUUID()} startOperationId={randomUUID()} /> : (
        <div className="space-y-4">
          <p className="text-sm">새 학급을 만들려면 Google 계정으로 로그인해 주세요.</p>
          <a href="/api/google/login?returnTo=%2Fclasses" className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>Google 계정으로 로그인</a>
        </div>
      )}
    </ClassPageShell>
  );
}
