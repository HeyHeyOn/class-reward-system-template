import { notFound } from 'next/navigation';
import { MigrationFreezingPage } from '@/components/MigrationFreezingPage';
import { XlsxImportPanel } from '@/components/xlsxImport/XlsxImportPanel';
import { buttonClass } from '@/components/ui/classes';
import { themeStyles } from '@/components/uiTheme';
import { withTenantSnapshot } from '@/server/db/transaction';
import { isEmptyXlsxImportTarget, readXlsxImportTargetCounts, type XlsxImportCounts } from '@/server/migration/xlsx/xlsxImportExecutor';
import { requireTenantAdminPage } from '@/server/tenantAdminPageAccess';

export const dynamic = 'force-dynamic';
export const metadata = { title: '자료 가져오기 · 학급 보상 시스템' };

const theme = themeStyles('white');

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--crs-radius)] bg-[var(--crs-info-bg)] px-4 py-3 text-[13px] leading-relaxed text-[var(--crs-info-text)]">
      <p className="font-bold">{title}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

/**
 * "자료 가져오기": an ACTIVE class that is still empty can import a saved CRS Google Sheets
 * workbook (.xlsx). The operator-only Google Sheets freezing controls that used to live here stay
 * available below (same gating), and open by themselves on their OAuth return.
 */
export default async function TenantMigrationsPage({ params, searchParams }: Readonly<{
  params: Promise<{ slug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { slug } = await params;
  const access = await requireTenantAdminPage(slug);
  if (!access.membership || !['OWNER', 'ADMIN'].includes(access.membership.role) || !access.session
    || access.needsRedirect || access.tenant.slug !== slug) notFound();
  const tenant = access.tenant;
  let counts: XlsxImportCounts | null = null;
  if (tenant.lifecycle === 'ACTIVE') {
    try { counts = await withTenantSnapshot(tenant.id, tx => readXlsxImportTargetCounts(tx, tenant.id)); } catch { counts = null; }
  }
  const query = (await searchParams) ?? {};
  const operatorOpen = tenant.lifecycle !== 'ACTIVE' || Object.keys(query).length > 0;
  return (
    <main style={theme.variables} className="min-h-screen bg-[var(--theme-shell)] px-4 py-6 text-[var(--theme-text)] sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-2xl space-y-4">
        <a href={`/c/${tenant.slug}/admin`} className="inline-flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[13px] font-semibold text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)]">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
          학급 관리
        </a>
        <section className="rounded-[24px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-6 shadow-[var(--crs-shadow)] sm:p-8">
          <p className="text-[13px] font-semibold text-[var(--theme-muted-text)]">{tenant.displayName}</p>
          <h1 className="mt-1 text-[28px] font-black leading-tight tracking-[-0.035em]">자료 가져오기</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--theme-muted-text)]">
            예전 학급 보상 시스템 구글 시트를 .xlsx 파일로 저장해 올리면 학생·잔액·상품·과제와 이번 회차 과제 상태를 이 학급으로 옮겨요.
          </p>
          <div className="mt-6">
            {tenant.lifecycle === 'DRAFT' ? (
              <div className="space-y-4">
                <Notice title="아직 사용을 시작하지 않은 학급이에요">학급 시작 화면에서 [기존 학급 보상 시스템 시트 파일(.xlsx)로 시작하기]를 고르면 시작과 함께 옮길 수 있어요.</Notice>
                <a href={`/classes/${tenant.slug}/start`} className={buttonClass({ variant: 'primary', size: 'lg', block: true })}>학급 시작 화면 열기</a>
              </div>
            ) : tenant.lifecycle !== 'ACTIVE' ? (
              <Notice title="지금은 가져올 수 없어요">학급이 사용 중일 때만 자료를 가져올 수 있어요.</Notice>
            ) : counts === null ? (
              <Notice title="학급 상태를 확인하지 못했어요">잠시 후 새로고침해 주세요.</Notice>
            ) : !isEmptyXlsxImportTarget(counts) ? (
              <div className="space-y-4">
                <Notice title="이미 자료가 있는 학급이에요">
                  학생 {counts.students}명 · 상품 {counts.products}개 · 과제 {counts.tasks}개가 있어 겹치지 않도록 가져오기를 막았어요.
                  예전 학급 보상 시스템 자료는 새 학급을 만들어 [기존 학급 보상 시스템 시트 파일(.xlsx)로 시작하기]로 옮겨 주세요.
                </Notice>
                <a href="/classes/new" className={buttonClass({ variant: 'secondary', block: true })}>새 학급 만들기</a>
              </div>
            ) : <XlsxImportPanel slug={tenant.slug} mode="import" />}
          </div>
        </section>
        <details open={operatorOpen} className="rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-5 py-4">
          <summary className="cursor-pointer text-[13px] font-bold text-[var(--theme-muted-text)]">Google 시트 직접 연결 이전 (운영자용)</summary>
          <div className="mt-4">
            <MigrationFreezingPage slug={tenant.slug} tenantId={tenant.id}
              sessionKey={JSON.stringify([access.session.subject, access.session.email, access.session.issuedAt])} />
          </div>
        </details>
      </div>
    </main>
  );
}
