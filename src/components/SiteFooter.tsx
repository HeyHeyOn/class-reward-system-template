import { PRIVACY_URL, TERMS_URL } from '@/lib/brand';

// Plain server-safe markup (no hooks): shown at the bottom of the main pages. The documents are the 딴쌤 hub's.
export const SITE_COPYRIGHT = '© 2026 환잇쌤. All rights reserved.';

export function SiteFooter({ className = '' }: Readonly<{ className?: string }>) {
  return (
    <footer className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 ${className}`}>
      <span>{SITE_COPYRIGHT}</span>
      <nav aria-label="약관과 정책" className="flex items-center gap-3">
        <a href={TERMS_URL} className="text-[var(--theme-text)] underline-offset-2 hover:underline">이용약관</a>
        {/* The privacy policy link stays visible and bold, as the guideline for Korean services asks. */}
        <a href={PRIVACY_URL} className="font-bold text-[var(--theme-text)] underline-offset-2 hover:underline">개인정보처리방침</a>
      </nav>
    </footer>
  );
}
