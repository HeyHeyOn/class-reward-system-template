import 'server-only';

import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { readPreflightReport, type PreflightReportReadResult } from '@/app/api/migrations/status/readPreflightReport';

// Cache Components is not enabled in this repository. Under the installed
// Next guide this opts every request out of the Full Route/Data Cache; do not
// wrap the reader or its authorization result in a cache or a client component.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata: Metadata = {
  title: '과거 사전검사 보고서 · 학급 보상 시스템',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

type PageProps = Readonly<{
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>;

type SelectedReport = Exclude<PreflightReportReadResult, { kind: 'HISTORICAL_REPORT' }>
  | (Extract<PreflightReportReadResult, { kind: 'HISTORICAL_REPORT' }> & Readonly<{ downloadHref: string }>);

function admitSelectors(query: Record<string, string | string[] | undefined> | undefined):
  Readonly<{ jobId: string; reportId: string }> | null {
  if (!query || Object.keys(query).length !== 2
    || !Object.hasOwn(query, 'jobId') || !Object.hasOwn(query, 'reportId')) return null;
  const { jobId, reportId } = query;
  // Match the reader's literal opaque-job and archival-report contracts. Never
  // pick an array element, trim, case-fold, decode twice, or select "latest".
  return typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 1024
    && jobId.trim() === jobId && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(jobId)
    && typeof reportId === 'string' && reportId.length === 79
    && /^reconciliation:[a-f0-9]{64}$/.test(reportId) ? { jobId, reportId } : null;
}

async function selectedReport({ params, searchParams }: PageProps): Promise<SelectedReport> {
  try {
    const [{ slug }, query] = await Promise.all([params, searchParams]);
    const selection = admitSelectors(query);
    // Exact full match also rejects a trailing newline (JS `$` alone does not).
    if (typeof slug !== 'string' || slug.length > 63
      || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.exec(slug)?.[0] !== slug || !selection) {
      return { kind: 'INVALID_REQUEST' };
    }
    // Capture admitted primitives before awaiting headers/reader. Never reread
    // mutable props or infer job/tenant selectors from the historical projection.
    const { jobId, reportId } = selection;
    // Next has already decoded searchParams. Validate that page boundary, then
    // encode these two values exactly once for the existing canonical reader.
    // This does not claim to validate raw wire query spelling before Next.
    const url = new URL(`http://tenant.internal/api/migrations/status/${slug}/preflight`);
    url.searchParams.set('jobId', jobId);
    url.searchParams.set('reportId', reportId);
    const authentication = new Headers();
    const cookie = (await headers()).get('cookie');
    if (cookie !== null) authentication.set('cookie', cookie);
    // Request is only an in-process auth/selector envelope, never an HTTP fetch.
    // No caller-supplied host, origin, tenant, role or authority headers survive.
    const result = await readPreflightReport(slug, new Request(url, {
      method: 'GET', headers: authentication, cache: 'no-store',
    }));
    if (result.kind !== 'HISTORICAL_REPORT') return result;
    if (result.projection?.reportId !== reportId) return { kind: 'UNAVAILABLE' };
    // A locator, not a capability: the existing attachment route independently
    // reauthorizes every click. No second read, host forwarding or filename hint.
    return { kind: result.kind, projection: result.projection,
      downloadHref: `/api/migrations/status/${slug}/preflight/download?${new URLSearchParams({ jobId, reportId })}` };
  } catch {
    // No raw error/selector/cookie logging, retry, acquisition or fallback reader.
    return { kind: 'UNAVAILABLE' };
  }
}

function failureTitle(kind: PreflightReportReadResult['kind']): string {
  switch (kind) {
    case 'UNAUTHENTICATED': return '로그인 필요';
    case 'FORBIDDEN': return '접근할 수 없음';
    case 'INVALID_REQUEST': return '잘못된 보고서 선택';
    case 'NOT_FOUND': return '보고서를 찾을 수 없음';
    default: return '보고서 확인 불가';
  }
}

export default async function MigrationHistoryPage(props: PageProps) {
  const result = await selectedReport(props);
  const projection = result.kind === 'HISTORICAL_REPORT' ? result.projection : null;
  const report = projection?.report;

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-5 text-sm text-slate-800">
      <header className="space-y-2">
        <h1 className="text-xl font-semibold">과거 사전검사 보고서 — 현재 상태/전환 승인 아님</h1>
        <p className="text-slate-600">읽기 전용 · 명시적으로 선택한 보관 보고서만 표시합니다.</p>
      </header>
      <section aria-label="조회 범위와 권한 한계" className="space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
          <dt className="font-medium">조회 범위</dt><dd>HISTORICAL_ONLY</dd>
          <dt className="font-medium">현재 사전검사</dt><dd>NOT_EVALUATED</dd>
          <dt className="font-medium">현재 운영 권한</dt><dd>UNKNOWN</dd>
          <dt className="font-medium">전환 허용</dt><dd>cutoverAllowed: false</dd>
        </dl>
        <p>보관된 MATCHED_PREFLIGHT도 현재 사전검사 통과나 전환·쓰기 권한을 뜻하지 않습니다.</p>
        <p>보고서의 내용 일치는 원본 출처의 진위나 현재성을 증명하지 않습니다. 이 화면은 현재 상태를 평가하지 않습니다.</p>
        <p>원본 조회·사전검사 실행·동결·전환·재개·재시도를 실행하지 않습니다.</p>
      </section>
      {!projection || !report ? (
        <section role="status" className="space-y-2 rounded-lg border border-slate-200 p-4">
          <h2 className="font-semibold">{failureTitle(result.kind)}</h2>
          <p>선택한 과거 보고서를 표시할 수 없습니다. 현재 작업 상태나 운영 권한을 추정하지 않습니다.</p>
        </section>
      ) : (
        <>
          <section aria-label="보관 보고서 요약" className="space-y-3 rounded-lg border border-slate-200 p-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="font-medium">과거 보고서 결과</dt><dd>{report.status}</dd>
              <dt className="font-medium">보관된 비교 시각</dt><dd>{projection.comparisonInstant ?? '보관된 비교 시각 없음'}</dd>
              <dt className="font-medium">원본 결합 증명</dt><dd>NOT_VERIFIED</dd>
              <dt className="font-medium">현재성 검증</dt><dd>NOT_VERIFIED</dd>
            </dl>
            {result.kind === 'HISTORICAL_REPORT' && (
              <div className="space-y-2">
                <a href={result.downloadHref} referrerPolicy="no-referrer" className="text-blue-700 underline underline-offset-2">
                  과거 보고서 JSON 다운로드
                </a>
                <p className="text-slate-600">선택한 과거 보고서만 수동으로 내려받습니다. 다운로드 요청 시 로그인과 접근 권한을 다시 확인합니다.</p>
                <p className="text-slate-600">로그인 만료·권한 변경·보고서 없음·일시적 오류로 다운로드가 거부될 수 있습니다.</p>
              </div>
            )}
          </section>
          {/* Native disclosure only: no action, fetch, acknowledgement persistence
              or new authority check. Every value comes from the same admitted archive. */}
          <details className="space-y-3 rounded-lg border border-slate-200 p-4">
            <summary className="cursor-pointer font-semibold">과거 스냅샷 식별 정보 확인 (읽기 전용)</summary>
            <p>아래 값은 선택한 과거 보고서에 보관된 값입니다. 현재 원본이나 현재 스냅샷을 조회한 결과가 아닙니다.</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
              <dt className="font-medium">과거 보고서 ID</dt>
              <dd className="break-all font-mono">{projection.reportId}</dd>
              <dt className="font-medium">보관된 원본 매니페스트 해시</dt>
              <dd className="break-all font-mono">{projection.manifestDigest}</dd>
              <dt className="font-medium">보관된 비교 매니페스트 해시 (현재 조회 아님)</dt>
              <dd className="break-all font-mono">{projection.currentManifestDigest ?? '보관된 비교 매니페스트 해시 없음'}</dd>
              <dt className="font-medium">보관된 원본 지문</dt>
              <dd className="break-all font-mono">{projection.sourceFingerprint}</dd>
              <dt className="font-medium">보관된 스냅샷 범위</dt>
              <dd className="break-all font-mono">{projection.freshness}</dd>
              <dt className="font-medium">검증 범위</dt><dd>{projection.verification}</dd>
              <dt className="font-medium">보관 내용 무결성</dt><dd>{projection.eventIntegrity}</dd>
            </dl>
            <p>해시 일치는 보관 내용의 무결성만 확인합니다. 원본 출처·현재성·전환 권한은 증명하지 않습니다.</p>
          </details>
          <section aria-label="보관된 비교 내역" className="space-y-2">
            {report.metrics.length === 0 ? (
              <p>보관된 비교 지표가 없습니다. 현재 비교 결과가 아닙니다.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full border-collapse text-left">
                  <caption className="p-3 text-left font-semibold">과거 비교 지표</caption>
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="p-3">분류</th>
                      <th scope="col" className="p-3">과거 기대값</th>
                      <th scope="col" className="p-3">과거 실제값</th>
                      <th scope="col" className="p-3">과거 차이</th>
                      <th scope="col" className="p-3">과거 비교 결과</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.metrics.map(metric => (
                      <tr key={metric.category} className="border-t border-slate-200">
                        <th scope="row" className="p-3 font-medium">{metric.category}</th>
                        <td className="whitespace-nowrap p-3 font-mono">{metric.expected}</td>
                        <td className="whitespace-nowrap p-3 font-mono">{metric.actual}</td>
                        <td className="whitespace-nowrap p-3 font-mono">{metric.delta}</td>
                        <td className="p-3">{metric.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section aria-label="보관된 진단 내역" className="space-y-2">
            {report.diagnostics.length === 0 ? (
              <p>보관된 진단 항목이 없습니다. 현재 검사 결과를 뜻하지 않습니다.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full border-collapse text-left">
                  <caption className="p-3 text-left font-semibold">과거 진단</caption>
                  <thead className="bg-slate-50">
                    <tr>
                      <th scope="col" className="p-3">분류</th>
                      <th scope="col" className="p-3">진단 코드</th>
                      <th scope="col" className="p-3">해시된 행 참조</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.diagnostics.map((diagnostic, index) => (
                      <tr key={index} className="border-t border-slate-200">
                        <td className="p-3">{diagnostic.category}</td>
                        <td className="p-3">{diagnostic.code}</td>
                        <td className="break-all p-3 font-mono">{diagnostic.rowReference ?? '보관된 참조 없음'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p>생략된 과거 진단 수: {report.omittedDiagnostics}</p>
          </section>
        </>
      )}
    </main>
  );
}
