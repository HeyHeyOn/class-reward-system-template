'use client';

import { useState } from 'react';
import type { LegalRevision } from '@/lib/legalDocuments';
import { SiteFooter } from '../SiteFooter';
import { Button } from '../ui';
import { themeStyles } from '../uiTheme';
import { accountRequest, safeRedirect } from './accountApi';
import { AgreementChecklist, allAgreed, NO_AGREEMENT } from './AgreementChecklist';
import { LegalChanges } from './LegalAgreementGate';
import { WithdrawalConfirm } from './WithdrawalConfirm';

const theme = themeStyles('white');

/**
 * The step between Google sign-in and the account: a new teacher agrees to sign up; an existing one
 * agrees to the terms in force (or withdraws).
 */
export function SignupAgreementView({ mode, email, changes, classNames, expectedSessionId }: Readonly<{
  mode: 'signup' | 'update';
  email: string;
  changes: readonly LegalRevision[];
  classNames?: readonly string[];
  expectedSessionId?: string;
}>) {
  const [choices, setChoices] = useState(NO_AGREEMENT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [declining, setDeclining] = useState(false);

  async function agree() {
    setBusy(true);
    setError('');
    const reply = await accountRequest('/api/account/agreement', 'POST', { ...choices, expectedSessionId });
    if (!reply.ok) {
      setBusy(false);
      setError(reply.status === 401
        ? '가입 시간이 지났어요. 메인 화면에서 Google 로그인을 다시 해 주세요.'
        : reply.error ?? '동의를 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
      return;
    }
    window.location.assign(safeRedirect(reply.data.redirectTo));
  }

  async function cancel() {
    setBusy(true);
    await accountRequest('/api/account/agreement', 'DELETE');
    window.location.assign('/classes');
  }

  const signup = mode === 'signup';
  return (
    <main style={theme.variables} className="flex min-h-screen flex-col items-center bg-[var(--theme-shell)] px-4 py-8 text-[var(--theme-text)] sm:py-14">
      <section className="w-full max-w-lg rounded-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-6 shadow-[var(--crs-shadow)] sm:p-8">
        <span role="img" aria-label="딴쌤 클래스 로고" className="block h-10 w-10 bg-[var(--theme-accent-text)] [mask-image:url('/class-reward-system-icon.png')] [mask-position:center] [mask-repeat:no-repeat] [mask-size:contain]" />
        <h1 className="mt-4 text-[25px] font-black tracking-[-0.035em]">
          {declining ? '회원 탈퇴' : signup ? '딴쌤 클래스 가입' : '약관 동의가 필요해요'}
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-[var(--theme-muted-text)]">
          {declining
            ? '바뀐 약관에 동의하지 않으면 서비스를 계속 이용할 수 없어요. 탈퇴하면 아래처럼 처리돼요.'
            : signup
              ? <><strong className="font-bold text-[var(--theme-text)]">{email}</strong> 계정으로 가입해요. 아래 내용을 확인하고 동의하면 가입이 끝나요.</>
              : <><strong className="font-bold text-[var(--theme-text)]">{email}</strong> 계정으로 계속 이용하려면 새로 마련되거나 바뀐 약관에 동의해 주세요.</>}
        </p>
        <div className="mt-5 space-y-3.5">
          {declining ? (
            <WithdrawalConfirm classNames={classNames} expectedSessionId={expectedSessionId} onCancel={() => setDeclining(false)} cancelLabel="돌아가서 동의하기" />
          ) : (
            <>
              {signup ? null : <LegalChanges changes={changes} />}
              <AgreementChecklist value={choices} onChange={setChoices} />
              {error ? <p role="alert" className="text-[13px] font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
              <Button variant="primary" size="lg" block onClick={() => void agree()} disabled={!allAgreed(choices) || busy} loading={busy}>
                {signup ? '동의하고 가입하기' : '동의하고 계속하기'}
              </Button>
              {signup
                ? <Button variant="ghost" block onClick={() => void cancel()} disabled={busy}>가입하지 않고 돌아가기</Button>
                : <Button variant="ghost" block onClick={() => setDeclining(true)} disabled={busy}>동의하지 않아요</Button>}
            </>
          )}
        </div>
      </section>
      <SiteFooter className="mt-6 w-full max-w-lg px-1 text-[11px] text-[var(--theme-muted-text)]" />
    </main>
  );
}
