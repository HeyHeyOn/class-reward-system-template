'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { tenantFetch, tenantPagePath } from '@/lib/tenantApiPath';
import { themeStyles } from './uiTheme';
import { LoadingOverlay, buttonClass, controlClass } from './ui';
import { GoogleLoginButton } from './brand/GoogleLoginButton';

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

export function AdminLoginPage({
  googleLoginEnabled = true,
  membershipOnly = false,
  tenantSlug,
}: {
  googleLoginEnabled?: boolean;
  membershipOnly?: boolean;
  tenantSlug?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [password, setPassword] = useState('');
  const [qrText, setQrText] = useState('');
  const [message, setMessage] = useState(searchParams.get('error') ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittingFromQr, setSubmittingFromQr] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => () => stopScan(), []);

  if (membershipOnly) {
    return (
      <main className="min-h-screen bg-slate-100 px-4 py-10 text-[#25313f]">
        <section className="mx-auto max-w-md rounded-[2rem] bg-white p-8 shadow-[0_20px_60px_rgba(37,49,63,0.15)]">
          <p className="text-sm font-bold uppercase tracking-[0.3em] text-[#4f8fba]">Class Store Admin</p>
          <h1 className="mt-3 text-3xl font-black">학급 관리자 로그인</h1>
          <p className="mt-3 text-sm text-[#627184]">Google 계정으로 로그인한 뒤 관리자 권한이 있는 학급을 선택해요.</p>
          <GoogleLoginButton href="/api/google/login?returnTo=%2Fclasses" block className="mt-8" />
        </section>
      </main>
    );
  }

  if (tenantSlug) {
    // A class is administered by its Google accounts only (the membership of that class); the password
    // and QR logins below belong to the Google Sheets edition, which had no social login.
    return (
      <main style={themeStyles('white').variables} className="flex min-h-[calc(100vh-65px)] items-center justify-center bg-[var(--theme-shell)] px-4 py-10 text-[var(--theme-text)]">
        <section className="w-full max-w-md rounded-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-7 shadow-[var(--crs-shadow)] sm:p-9">
          <h1 className="text-[28px] font-black tracking-[-0.035em]">관리자 로그인</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--theme-muted-text)]">이 학급을 만든 Google 계정으로 로그인해 주세요.</p>
          <GoogleLoginButton href={`/api/google/login?returnTo=${encodeURIComponent(`/c/${tenantSlug}/admin`)}`} block className="mt-7" />
          {message ? <p role="alert" className="mt-4 rounded-[12px] bg-[var(--crs-danger-bg)] px-4 py-3 text-[13px] font-semibold text-[var(--crs-danger-text)]">{message}</p> : null}
          <a className={buttonClass({ variant: 'ghost', size: 'md', block: true, className: 'mt-3' })} href="/classes">메인 화면으로</a>
        </section>
      </main>
    );
  }

  async function submitCredential(value: string, kind: 'password' | 'qr', fromQr = false) {
    setSubmittingFromQr(fromQr);
    setIsSubmitting(true);
    setMessage('');

    try {
      const response = await tenantFetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, value }),
      });
      const body = (await response.json()) as { error?: string };

      if (!response.ok) throw new Error(body.error ?? '로그인하지 못했어요.');
      router.replace(searchParams.get('next') || tenantPagePath('/admin'));
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '로그인하지 못했어요.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitCredential(password, 'password');
  }

  async function startScan() {
    setMessage('');
    if (!window.BarcodeDetector) {
      setMessage('이 브라우저는 QR 카메라 인식을 지원하지 않아요. QR 내용을 아래 칸에 붙여넣어 주세요.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      setIsScanning(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const scan = async () => {
        if (!videoRef.current) return;
        const codes = await detector.detect(videoRef.current).catch(() => []);
        const value = codes[0]?.rawValue;
        if (value) {
          stopScan();
          setQrText(value);
          await submitCredential(value, 'qr', true);
          return;
        }
        scanTimerRef.current = window.setTimeout(scan, 350);
      };
      scan();
    } catch {
      setMessage('카메라를 열지 못했어요. 브라우저 권한을 확인하거나 QR 내용을 붙여넣어 주세요.');
      stopScan();
    }
  }

  function stopScan() {
    if (scanTimerRef.current) window.clearTimeout(scanTimerRef.current);
    scanTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setIsScanning(false);
  }

  function applyQrText() {
    void submitCredential(qrText, 'qr', true);
  }

  const divider = (
    <div className="my-6 flex items-center gap-3 text-xs font-semibold text-[var(--theme-muted-text)]"><span className="h-px flex-1 bg-[var(--crs-line)]" /><span>또는</span><span className="h-px flex-1 bg-[var(--crs-line)]" /></div>
  );
  return (
    <main style={themeStyles('white').variables} className="flex min-h-screen items-center justify-center bg-[var(--theme-shell)] px-4 py-10 text-[var(--theme-text)]">
      {isSubmitting ? (
        <LoadingOverlay
          title="관리자 로그인 확인 중"
          message={submittingFromQr ? 'QR을 인식했어요. 관리자 권한을 확인하는 중이에요.' : '관리자 권한을 확인하는 중이에요.'}
        />
      ) : null}
      <section className="w-full max-w-md rounded-[26px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-7 shadow-[var(--crs-shadow)] sm:p-9">
        <h1 className="text-[28px] font-black tracking-[-0.035em]">관리자 로그인</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--theme-muted-text)]">{googleLoginEnabled ? 'Google 계정, 관리자 암호, 관리자 QR 중 편한 방법으로 로그인해요.' : '관리자 암호, 관리자 QR, Recovery 탭의 recoveryCode로 로그인해요.'}</p>

        {googleLoginEnabled ? (
          <>
            <GoogleLoginButton href={tenantSlug ? `/api/google/login?returnTo=${encodeURIComponent(`/c/${tenantSlug}/admin`)}` : '/api/google/login'} block className="mt-7" />
            {divider}
          </>
        ) : (
          <div className="mt-6 space-y-2 rounded-[14px] bg-[var(--crs-subtle-hover)] px-4 py-3 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
            <p>이 배포 앱은 만들 때 연결한 Google Sheets 권한으로 동작해요.</p>
            <p>비밀번호가 틀리거나 기억나지 않으면 Google Drive에서 이 학급의 스프레드시트를 열고 Recovery 탭의 recoveryCode 값을 아래 칸에 그대로 입력해 복구 로그인할 수 있어요.</p>
          </div>
        )}

        <button type="button" onClick={isScanning ? stopScan : startScan} className={buttonClass({ variant: 'secondary', size: 'lg', block: true, className: googleLoginEnabled ? '' : 'mt-6' })}>
          {isScanning ? 'QR 인식 중지' : 'QR로 로그인'}
        </button>
        {isScanning ? <video ref={videoRef} className="mt-3 aspect-video w-full rounded-[16px] bg-black object-cover" muted playsInline /> : null}
        <div className="mt-3 flex gap-2">
          <input aria-label="QR 로그인 값" value={qrText} onChange={(event) => setQrText(event.target.value)} placeholder="QR 내용 붙여넣기" className={`${controlClass} h-10 text-sm`} />
          <button type="button" onClick={applyQrText} className={buttonClass({ variant: 'soft' })}>적용</button>
        </div>

        {divider}

        <form className="space-y-3" onSubmit={handleSubmit}>
          <label className="block text-[13px] font-bold" htmlFor="admin-password">관리자 비밀번호</label>
          <input id="admin-password" className={`${controlClass} h-12 text-base`} type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="비밀번호 또는 복구 코드" autoFocus />
          {message ? <p className="rounded-[12px] bg-[var(--crs-danger-bg)] px-4 py-3 text-[13px] font-semibold text-[var(--crs-danger-text)]">{message}</p> : null}
          <button className={buttonClass({ variant: 'primary', size: 'lg', block: true })} type="submit" disabled={isSubmitting}>{isSubmitting ? '확인 중...' : '관리자 페이지로 이동'}</button>
        </form>
      </section>
    </main>
  );
}
