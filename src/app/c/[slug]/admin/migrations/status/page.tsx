import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { readMigrationStatus } from '@/app/api/migrations/status/readStatus';

export const dynamic = 'force-dynamic';
export const metadata = { title: '마이그레이션 상태 - 딴쌤 클래스', referrer: 'no-referrer' };

// Keep this separate from the existing /admin/migrations FREEZING controls.
// Server rendering rechecks access on every request; there is no client polling,
// source read, mutation form, retry/resume action, or status inferred from inputs.
export default async function MigrationStatusPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { slug } = await params;
  const query = await searchParams;
  const jobId = query?.jobId;
  const reportId = query?.reportId;
  // Capture literal selectors before asynchronous access checks. This matches
  // the existing history page's admission, not report existence or authority.
  // Invalid/extra historical input suppresses only the link, not status access.
  const historicalQuery = query && Object.keys(query).length === 2
    && Object.hasOwn(query, 'jobId') && Object.hasOwn(query, 'reportId')
    && typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 1024
    && jobId.trim() === jobId && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(jobId)
    && typeof reportId === 'string' && reportId.length === 79
    && /^reconciliation:[a-f0-9]{64}$/.test(reportId)
    ? new URLSearchParams({ jobId, reportId }).toString() : null;
  const request = new Request('http://tenant.internal/migration-status', { headers: await headers() });
  // Only an explicit selector is forwarded; never use tenant/source/status
  // hints or pick the first value from a duplicate selector.
  const result = await readMigrationStatus(slug, request, jobId);
  if (result.kind === 'UNAUTHENTICATED') redirect(`/c/${slug}/admin/login`);
  if (result.kind === 'FORBIDDEN') notFound();

  if (result.kind !== 'BLOCKED' && result.kind !== 'JOB_AVAILABLE') {
    const title = result.kind === 'JOB_NOT_FOUND' ? '작업을 찾을 수 없음'
      : result.kind === 'JOB_UNAVAILABLE' ? '작업 상태 확인 불가'
        : result.kind === 'INVALID_REQUEST' ? '잘못된 작업 선택' : '접근 권한 확인 불가';
    return (
      <main className="mx-auto max-w-3xl space-y-4 p-5 text-sm text-slate-800">
        <h1 className="text-xl font-semibold">마이그레이션 상태</h1>
        <section role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h2 className="font-semibold">{title}</h2>
          <p className="mt-2">{result.kind === 'UNAVAILABLE'
            ? '접근 권한을 검증할 수 없어 상태 정보를 표시하지 않아요.'
            : '선택한 작업의 상태를 표시할 수 없어요.'} 어떤 변경도 실행하지 않았어요.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-5 text-sm text-slate-800">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">마이그레이션 상태</h1>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">읽기 전용</span>
      </header>
      <section role="status" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <h2 className="font-semibold">{result.kind === 'JOB_AVAILABLE' ? '저장된 작업 상태' : '상태 조회 차단'}</h2>
        <p>{result.status.reason}</p>
        <p className="break-all text-xs text-slate-600">{result.status.reasonCode}</p>
      </section>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-slate-200 p-4">
        <dt className="font-medium">{result.kind === 'JOB_AVAILABLE' ? '저장된 작업 상태' : '이전 진행 상태'}</dt>
        <dd>{result.kind === 'JOB_AVAILABLE' ? result.status.migrationStatus : `확인 불가 (${result.status.migrationStatus})`}</dd>
        <dt className="font-medium">현재 운영 권한</dt>
        <dd>확인 불가 ({result.status.authority})</dd>
      </dl>
      <p>원본 조회, 사전검사, 동결, 전환, 재개, 보고서 다운로드를 실행하지 않아요.</p>
      <p className="text-slate-600">{result.kind === 'JOB_AVAILABLE'
        ? '저장된 ACTIVE를 포함한 작업 상태는 실제 운영 전환이나 현재 쓰기 권한의 증거가 아니에요.'
        : '이 화면의 차단은 실제 이전 실패나 완료, 기존 서비스의 쓰기 중지를 뜻하지 않아요.'}</p>
      {result.kind === 'JOB_AVAILABLE' && historicalQuery !== null && (
        <div className="space-y-2">
          <a href={`/c/${slug}/admin/migrations/history?${historicalQuery}`} referrerPolicy="no-referrer" className="text-blue-700 underline underline-offset-2">
            선택한 과거 사전검사 보고서 보기
          </a>
          <p className="text-slate-600">과거 기록만 조회해요. 현재 충돌, 사전검사 통과, 전환 권한을 뜻하지 않아요. 이동 시 로그인과 접근 권한을 다시 확인해요.</p>
        </div>
      )}
      <Link href={`/c/${slug}/admin`} prefetch={false} className="inline-block rounded-lg border border-slate-300 px-3 py-2">
        관리 화면으로
      </Link>
    </main>
  );
}
