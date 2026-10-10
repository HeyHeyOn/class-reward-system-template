'use client';

import { useState } from 'react';
import type { LegalRevision } from '@/lib/legalDocuments';
import { Button, Modal } from '../ui';
import { Icon } from '../ui/icons';
import { themeStyles } from '../uiTheme';
import { accountRequest } from './accountApi';
import { AgreementChecklist, allAgreed, NO_AGREEMENT } from './AgreementChecklist';
import { WithdrawalConfirm } from './WithdrawalConfirm';

// The gate may be rendered outside a themed page (e.g. next to the admin screen), so it carries its
// own theme: without it the dialog has no surface colour and the page shows through.
const theme = themeStyles('white');

export type LegalNoticeView = Readonly<{
  required: Readonly<{ current: LegalRevision; changes: readonly LegalRevision[] }> | null;
  upcoming: LegalRevision | null;
}>;

export function LegalChanges({ changes }: Readonly<{ changes: readonly LegalRevision[] }>) {
  if (!changes.length) return null;
  return (
    <div className="space-y-2 rounded-[14px] bg-[var(--crs-subtle)] px-4 py-3 text-[13px] leading-relaxed">
      {changes.map((revision) => (
        <div key={revision.version}>
          <p className="font-bold">{revision.effectiveLabel} 시행</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--theme-muted-text)]">
            {revision.changes.map((change) => <li key={change}>{change}</li>)}
          </ul>
        </div>
      ))}
      <p className="text-[12.5px] text-[var(--theme-muted-text)]">
        전문:{' '}
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2">이용약관</a>{' · '}
        <a href="/privacy" target="_blank" rel="noopener noreferrer" className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2">개인정보처리방침</a>
      </p>
    </div>
  );
}

/**
 * Shown on teacher pages. When the terms or the privacy policy in force have not been agreed to by
 * this session, a dialog that cannot be dismissed asks for agreement (or withdrawal). A revision
 * announced for later is shown as a notice.
 */
export function LegalAgreementGate({ notice, classNames }: Readonly<{ notice: LegalNoticeView; classNames?: readonly string[] }>) {
  const [choices, setChoices] = useState(NO_AGREEMENT);
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [upcomingClosed, setUpcomingClosed] = useState(false);

  async function agree() {
    setBusy(true);
    setError('');
    const reply = await accountRequest('/api/account/agreement', 'POST', choices);
    if (!reply.ok) {
      setBusy(false);
      setError(reply.error ?? '동의를 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    setAgreed(true);
    // The session now carries the new version; reload so every part of the page sees it.
    window.location.reload();
  }

  const upcoming = notice.upcoming && !upcomingClosed ? (
    <div role="status" className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl items-start gap-3 rounded-[16px] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-4 py-3 text-[13px] leading-relaxed text-[var(--theme-text)] shadow-[var(--crs-shadow-lg)]">
      <span className="mt-0.5 shrink-0 text-[var(--theme-accent-text)]"><Icon name="info" size={17} /></span>
      <p className="min-w-0 flex-1">
        <strong className="font-bold">{notice.upcoming.effectiveLabel}</strong>부터 이용약관·개인정보처리방침이 바뀌어요. {notice.upcoming.changes[0]}{' '}
        <a href="/terms" className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2">자세히 보기</a>
      </p>
      <button type="button" aria-label="안내 닫기" onClick={() => setUpcomingClosed(true)} className="shrink-0 rounded-md p-0.5 opacity-70 hover:opacity-100"><Icon name="close" size={16} /></button>
    </div>
  ) : null;

  if (!notice.required || agreed) return upcoming ? <div style={theme.variables} className="contents">{upcoming}</div> : null;
  return (
    <div style={theme.variables} className="contents">
      {upcoming}
      <Modal
        title={declining ? '회원 탈퇴' : '약관 동의가 필요해요'}
        description={declining
          ? '바뀐 약관에 동의하지 않으면 서비스를 계속 이용할 수 없어요. 탈퇴하면 아래처럼 처리돼요.'
          : '이용약관과 개인정보처리방침이 새로 마련되거나 바뀌었어요. 계속 이용하려면 아래 내용을 확인하고 동의해 주세요.'}
        onClose={() => undefined}
        busy
        size="md"
        footer={declining ? undefined : (
          <>
            <Button variant="ghost" onClick={() => setDeclining(true)} disabled={busy} className="mr-auto">동의하지 않아요</Button>
            <Button variant="primary" icon="check" onClick={() => void agree()} disabled={!allAgreed(choices) || busy} loading={busy}>동의하고 계속하기</Button>
          </>
        )}>
        {declining ? (
          <WithdrawalConfirm classNames={classNames} onCancel={() => setDeclining(false)} cancelLabel="돌아가서 동의하기" />
        ) : (
          <div className="space-y-3.5">
            <LegalChanges changes={notice.required.changes} />
            <AgreementChecklist value={choices} onChange={setChoices} />
            {error ? <p role="alert" className="text-[13px] font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
          </div>
        )}
      </Modal>
    </div>
  );
}
