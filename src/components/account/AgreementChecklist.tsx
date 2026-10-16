'use client';

import { useId, useState } from 'react';
import { cx } from '../ui/classes';
import { Icon } from '../ui/icons';
import { PRIVACY_URL, TERMS_URL } from '@/lib/brand';

export type AgreementChoices = Readonly<{ age: boolean; terms: boolean; privacy: boolean }>;
export const NO_AGREEMENT: AgreementChoices = { age: false, terms: false, privacy: false };
export const allAgreed = (choices: AgreementChoices) => choices.age && choices.terms && choices.privacy;

/** The teacher's own data (not students'): what the service collects at sign-up and why. */
const PRIVACY_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['수집 항목', 'Google 계정 식별 번호, 이메일 주소, 이름(Google 프로필), 닉네임과 프로필 아이콘, 약관 동의 기록'],
  ['수집·이용 목적', '회원 가입과 확인, 로그인 유지, 학급 만들기·관리 권한 확인, 약관 변경 안내와 문의 응대'],
  ['보유·이용 기간', '회원 탈퇴 시까지 (탈퇴하면 지체 없이 파기)'],
  ['동의 거부 권리', '동의를 거부할 수 있어요. 다만 거부하면 가입하거나 서비스를 이용할 수 없어요.'],
];

function CheckRow({ checked, onChange, children, strong = false }: Readonly<{ checked: boolean; onChange: (checked: boolean) => void; children: React.ReactNode; strong?: boolean }>) {
  const id = useId();
  return (
    <div className="flex items-start gap-2.5">
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}
        className="mt-[3px] h-[18px] w-[18px] shrink-0 accent-[var(--theme-accent-solid)]" />
      <label htmlFor={id} className={cx('min-w-0 flex-1 text-[14px] leading-relaxed', strong ? 'font-extrabold' : 'font-semibold')}>{children}</label>
    </div>
  );
}

export function AgreementChecklist({ value, onChange }: Readonly<{ value: AgreementChoices; onChange: (next: AgreementChoices) => void }>) {
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const required = <span className="text-[var(--crs-danger-text)]">(필수)</span>;
  return (
    <div className="rounded-[16px] border border-[var(--crs-line)] bg-[var(--theme-surface)]">
      <div className="border-b border-[var(--crs-line)] px-4 py-3.5">
        <CheckRow strong checked={allAgreed(value)} onChange={(checked) => onChange({ age: checked, terms: checked, privacy: checked })}>
          아래 내용에 모두 동의해요
        </CheckRow>
      </div>
      <div className="space-y-3 px-4 py-3.5">
        <CheckRow checked={value.age} onChange={(age) => onChange({ ...value, age })}>{required} 만 14세 이상이에요.</CheckRow>
        <div className="flex items-start justify-between gap-2">
          <CheckRow checked={value.terms} onChange={(terms) => onChange({ ...value, terms })}>{required} 이용약관에 동의해요.</CheckRow>
          <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" aria-label="이용약관 전문 보기 새 탭 열림"
            className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-[var(--theme-accent-text)] underline-offset-2 hover:underline">
            전문 보기<Icon name="external" size={13} />
          </a>
        </div>
        <div>
          <div className="flex items-start justify-between gap-2">
            <CheckRow checked={value.privacy} onChange={(privacy) => onChange({ ...value, privacy })}>{required} 개인정보 수집·이용에 동의해요.</CheckRow>
            <button type="button" aria-expanded={privacyOpen} onClick={() => setPrivacyOpen((open) => !open)}
              className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-[var(--theme-accent-text)] underline-offset-2 hover:underline">
              내용 {privacyOpen ? '접기' : '보기'}<Icon name={privacyOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            </button>
          </div>
          {privacyOpen ? (
            <dl className="mt-2.5 overflow-hidden rounded-[12px] border border-[var(--crs-line)] text-[12.5px] leading-relaxed">
              {PRIVACY_ROWS.map(([term, detail]) => (
                <div key={term} className="grid grid-cols-[92px_minmax(0,1fr)] border-t border-[var(--crs-line)] first:border-t-0">
                  <dt className="bg-[var(--crs-subtle)] px-3 py-2 font-bold">{term}</dt>
                  <dd className="px-3 py-2">{detail}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
        <p className="rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--theme-muted-text)]">
          서비스 운영을 위해 개인정보가 싱가포르와 미국에 있는 서버 업체(Vercel, Neon)에 맡겨져 보관돼요. 자세한 내용은{' '}
          <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2">개인정보처리방침</a>에서 확인할 수 있어요.
        </p>
      </div>
    </div>
  );
}
