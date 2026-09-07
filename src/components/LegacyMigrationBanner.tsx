'use client';

import { usePathname } from 'next/navigation';
import type { LegacyDeploymentMode } from '@/server/legacyDeploymentMode';

export function LegacyMigrationBanner({ mode }: { mode: LegacyDeploymentMode }) {
  const pathname = usePathname();
  const legacyPage = pathname === '/' || pathname === '/bank'
    || pathname === '/admin' || (pathname?.startsWith('/admin/') && pathname !== '/admin/generator');
  if (!mode.readOnly || !legacyPage) return null;
  return (
    <aside role="status" className="fixed inset-x-0 bottom-0 z-[100] border-t border-amber-300 bg-amber-50 px-4 py-3 text-center text-sm text-amber-950 shadow-lg">
      <p>서비스 이전 중: 이전 서비스는 읽기 전용입니다. 조회는 계속 이용할 수 있습니다.</p>
      {mode.centralTargetUrl && (
        <a href={mode.centralTargetUrl} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer"
          className="mt-1 inline-block font-semibold underline">
          중앙 서비스로 이동
        </a>
      )}
    </aside>
  );
}
