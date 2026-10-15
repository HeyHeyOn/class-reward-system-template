'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import styles from '../classroom.module.css';
import { QrScanner } from '../QrScanner';
import { Button, Callout, Field, Icon, Input } from '../ui';

type BankLoginProps = Readonly<{
  title: string;
  manualInputEnabled: boolean;
  busy: boolean;
  error: string;
  notice: string;
  /** Resolves true when the login succeeded. */
  onLogin: (studentQr: string) => Promise<boolean>;
}>;

/** The only screen before login: the student signs in with the QR code they own. */
export function BankLogin({ title, manualInputEnabled, busy, error, notice, onLogin }: BankLoginProps) {
  const [scanning, setScanning] = useState(false);
  const [scannerKey, setScannerKey] = useState(0);
  const [manualValue, setManualValue] = useState('');
  const submitting = useRef(false);
  const manualId = useId();
  const headingId = useId();

  async function attempt(value: string) {
    const trimmed = value.trim();
    if (!trimmed || submitting.current || busy) return;
    submitting.current = true;
    try {
      const ok = await onLogin(trimmed);
      // The scanner ignores a repeat of the last value it read; remount it so the
      // same card can be shown again after a failed attempt.
      if (!ok) setScannerKey((key) => key + 1);
    } finally {
      submitting.current = false;
    }
  }

  function submitManual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = manualValue;
    setManualValue('');
    void attempt(value);
  }

  return (
    <div className="flex min-h-[calc(100dvh-65px)] flex-col gap-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.25rem,env(safe-area-inset-top))]">
      <header className={`${styles.bankHeader} flex items-center gap-3`}>
        <h1 className="min-w-0 truncate text-[clamp(1.35rem,5vw,1.75rem)] font-black leading-tight tracking-[-0.035em]">{title}</h1>
      </header>

      <section aria-labelledby={headingId} className="rounded-[24px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-5 shadow-[var(--crs-shadow)] sm:p-7">
        <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-[18px] bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]">
          <Icon name="qr" size={28} />
        </span>
        <h2 id={headingId} className="mt-4 text-[clamp(1.4rem,6vw,1.75rem)] font-black leading-tight tracking-[-0.035em]">내 QR 코드로 로그인해요</h2>
        <p className="mt-1.5 text-[15px] leading-relaxed text-[var(--theme-muted-text)]">선생님께 받은 내 QR 코드를 카메라에 보여 주세요.</p>

        {notice ? (
          <div role="status" className="mt-4"><Callout tone="info">{notice}</Callout></div>
        ) : null}
        {error ? (
          <div role="alert" className="mt-4"><Callout tone="danger" title="로그인하지 못했어요">{error}</Callout></div>
        ) : null}

        {scanning ? (
          <div className="mt-5">
            <div className="flex justify-center overflow-hidden rounded-[20px] border border-[var(--crs-line)] bg-white">
              <QrScanner key={scannerKey} onScan={(value) => { void attempt(value); }} />
            </div>
            <Button variant="secondary" size="lg" block className="mt-3" icon="close" onClick={() => setScanning(false)} disabled={busy}>카메라 끄기</Button>
          </div>
        ) : (
          <Button variant="primary" size="lg" block className="mt-5 h-14 text-[17px]" icon="qr" onClick={() => setScanning(true)} disabled={busy} loading={busy}>
            {busy ? '로그인하는 중…' : 'QR 코드 찍기'}
          </Button>
        )}

        {manualInputEnabled ? (
          <form onSubmit={submitManual} className="mt-6 border-t border-[var(--crs-line)] pt-5" aria-label="QR 코드 값으로 로그인">
            <Field label="QR 코드 값 직접 입력" htmlFor={manualId} hint="카메라를 쓸 수 없을 때만 입력해 주세요.">
              <Input id={manualId} value={manualValue} onChange={(event) => setManualValue(event.target.value)}
                autoComplete="off" autoCapitalize="off" spellCheck={false} enterKeyHint="go" className="h-12 text-base" />
            </Field>
            <Button type="submit" variant="secondary" size="lg" block className="mt-3" disabled={busy || !manualValue.trim()}>로그인</Button>
          </form>
        ) : null}
      </section>

      <p className="flex items-start gap-2 px-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
        <span className="mt-0.5 shrink-0"><Icon name="lock" size={15} /></span>
        <span>로그인은 이 기기에서 7일 동안 유지돼요. 다른 사람과 함께 쓰는 기기라면 다 쓴 뒤 꼭 로그아웃해 주세요.</span>
      </p>
    </div>
  );
}
