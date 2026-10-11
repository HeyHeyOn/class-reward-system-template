import { randomUUID } from 'node:crypto';
import { headers } from 'next/headers';
import { getTeacherGoogleSessionFromRequest } from '@/server/teacherSession';
import { getProductionClassStartRepository } from '@/server/repositories/database/classStart';
import { parseTenantSlug } from '@/server/tenantContext';
import { buttonClass } from '@/components/ui/classes';
import { ClassPageShell } from '../../ClassPageShell';
import { ClassStartChoice } from './ClassStartChoice';

export const metadata = { title: '학급 사용 시작' };
export const dynamic = 'force-dynamic';

export default async function ClassStartPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getTeacherGoogleSessionFromRequest(new Request('http://classes.internal/classes', { headers: await headers() }));
  if (!session) return (
    <ClassPageShell eyebrow="학급 준비" title="로그인이 필요합니다">
      <p className="text-sm">로그인이 필요합니다.</p>
      <a href="/api/google/login?returnTo=%2Fclasses" className={buttonClass({ variant: 'primary', size: 'lg', block: true, className: 'mt-4' })}>Google 계정으로 로그인</a>
    </ClassPageShell>
  );
  let setup;
  try {
    if (parseTenantSlug(slug).needsRedirect) throw new Error('Noncanonical slug.');
    setup = await getProductionClassStartRepository().getSetup(slug, session.subject);
  } catch {
    return (
      <ClassPageShell eyebrow="학급 준비" title="학급을 불러오지 못했습니다">
        <p className="text-sm">학급 상태를 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p>
        <a href="/classes" className={buttonClass({ variant: 'secondary', block: true, className: 'mt-4' })}>내 학급 확인</a>
      </ClassPageShell>
    );
  }
  return (
    <ClassPageShell eyebrow="학급 준비" title={setup?.displayName ?? '학급 준비'}>
      {!setup ? (
        <div className="space-y-4">
          <p className="text-sm leading-relaxed">이 경로에서는 새 빈 학급의 소유자만 사용을 시작할 수 있습니다. 기존 자료를 가져오는 학급은 이전 절차를 완료해 주세요.</p>
          <a href="/classes" className={buttonClass({ variant: 'secondary', block: true })}>내 학급 확인</a>
        </div>
      ) : setup.lifecycle === 'ACTIVE' ? (
        <div className="space-y-4">
          <p className="text-sm">이미 사용 중인 학급입니다.</p>
          <a href={`/c/${slug}/admin`} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>학급 관리 열기</a>
        </div>
      ) : <ClassStartChoice slug={slug} operationId={randomUUID()} />}
    </ClassPageShell>
  );
}
