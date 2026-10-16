import { CONTACT_EMAIL, OPERATOR_NAME, PRIVACY_URL, TERMS_URL } from '@/lib/brand';
import { DdanssaemMark } from './brand/DdanssaemLogo';

// Plain server-safe markup (no hooks), the same as the 딴쌤 hub's footer (ddanssaem-brand README '공통 부품'):
// the mark and the operator on the left; the terms, the privacy policy (bold) and the contact on the right.
export const SITE_COPYRIGHT = `© 2026 ${OPERATOR_NAME}`;

export function SiteFooter({ className = '' }: Readonly<{ className?: string }>) {
  return (
    <footer className={`border-t border-[#E6E7EA] bg-white ${className}`}>
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-4 sm:p-6">
        <div className="flex items-center gap-2 text-[13px] text-[#5C6370]">
          <DdanssaemMark size={22} />
          <span>{SITE_COPYRIGHT}</span>
        </div>
        <nav aria-label="바닥글" className="flex flex-wrap gap-x-1 text-[13px]">
          <a href={TERMS_URL} className="inline-flex min-h-11 items-center px-2 text-[#5C6370] hover:text-[#2B2D31]">이용약관</a>
          {/* The privacy policy link stays visible and bold, as the guideline for Korean services asks. */}
          <a href={PRIVACY_URL} className="inline-flex min-h-11 items-center px-2 font-bold text-[#2B2D31] hover:text-[#1D58C6]">개인정보 처리방침</a>
          <a href={`mailto:${CONTACT_EMAIL}`} className="inline-flex min-h-11 items-center px-2 text-[#5C6370] hover:text-[#2B2D31]">문의 {CONTACT_EMAIL}</a>
        </nav>
      </div>
    </footer>
  );
}
