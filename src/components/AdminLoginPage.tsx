'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

export function AdminLoginPage({ googleLoginEnabled = true }: { googleLoginEnabled?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const scanTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [password, setPassword] = useState('');
  const [qrText, setQrText] = useState('');
  const [message, setMessage] = useState(searchParams.get('error') ?? '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isScanning, setIsScanning] = useState(false);

  useEffect(() => () => stopScan(), []);

  async function submitPassword(value = password) {
    setIsSubmitting(true);
    setMessage('');

    try {
      const response = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: normalizeQrPassword(value) }),
      });
      const body = (await response.json()) as { error?: string };

      if (!response.ok) throw new Error(body.error ?? '로그인하지 못했습니다.');
      router.replace(searchParams.get('next') || '/admin');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '로그인하지 못했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitPassword(password);
  }

  async function startScan() {
    setMessage('');
    if (!window.BarcodeDetector) {
      setMessage('이 브라우저는 QR 카메라 인식을 지원하지 않습니다. QR 내용을 아래 입력칸에 붙여넣어 주세요.');
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
          const normalized = normalizeQrPassword(value);
          setPassword(normalized);
          await submitPassword(normalized);
          return;
        }
        scanTimerRef.current = window.setTimeout(scan, 350);
      };
      scan();
    } catch {
      setMessage('카메라를 열지 못했습니다. 브라우저 권한을 확인하거나 QR 내용을 붙여넣어 주세요.');
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
    const normalized = normalizeQrPassword(qrText);
    setPassword(normalized);
    void submitPassword(normalized);
  }

  return (
    <main className="min-h-screen bg-[#dbeaf6] px-4 py-10 text-[#25313f]">
      <section className="mx-auto max-w-md rounded-[2rem] bg-white p-8 shadow-[0_20px_60px_rgba(37,49,63,0.15)]">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-[#4f8fba]">Class Store Admin</p>
        <h1 className="mt-3 text-3xl font-black">관리자 로그인</h1>
        <p className="mt-3 text-sm text-[#627184]">{googleLoginEnabled ? 'Google 계정, 관리자 암호, 관리자 QR 중 편한 방법으로 로그인합니다.' : '관리자 암호 또는 관리자 QR로 로그인합니다.'}</p>

        {googleLoginEnabled ? (
          <>
            <a className="mt-8 flex w-full items-center justify-center rounded-2xl bg-[#4285f4] px-5 py-3 text-center font-black text-white shadow-[0_10px_30px_rgba(66,133,244,0.25)]" href="/api/google/login">
              Google 계정으로 로그인
            </a>

            <div className="my-6 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-[#94a3b8]"><span className="h-px flex-1 bg-[#e2e8f0]" /><span>또는</span><span className="h-px flex-1 bg-[#e2e8f0]" /></div>
          </>
        ) : (
          <p className="mt-6 rounded-2xl bg-sky-50 px-4 py-3 text-sm font-bold text-sky-800">
            이 배포 앱은 생성 시 연결된 Google Sheets 권한으로 동작합니다. 관리자 화면 접속은 관리자 비밀번호 또는 관리자 QR을 사용하세요.
          </p>
        )}

        <button type="button" onClick={isScanning ? stopScan : startScan} className="w-full rounded-2xl bg-sky-600 px-5 py-3 font-black text-white">
          {isScanning ? 'QR 인식 중지' : 'QR로 로그인'}
        </button>
        {isScanning ? <video ref={videoRef} className="mt-3 aspect-video w-full rounded-2xl bg-black object-cover" muted playsInline /> : null}
        <div className="mt-3 flex gap-2">
          <input aria-label="QR 로그인 값" value={qrText} onChange={(event) => setQrText(event.target.value)} placeholder="QR 내용 붙여넣기" className="min-w-0 flex-1 rounded-2xl border border-[#c8d7e3] px-3 py-2 text-sm outline-none" />
          <button type="button" onClick={applyQrText} className="rounded-2xl bg-slate-100 px-3 py-2 text-sm font-black">적용</button>
        </div>

        <div className="my-6 flex items-center gap-3 text-xs font-bold uppercase tracking-[0.2em] text-[#94a3b8]"><span className="h-px flex-1 bg-[#e2e8f0]" /><span>또는</span><span className="h-px flex-1 bg-[#e2e8f0]" /></div>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <label className="block text-sm font-bold" htmlFor="admin-password">관리자 비밀번호</label>
          <input id="admin-password" className="w-full rounded-2xl border border-[#c8d7e3] px-4 py-3 text-lg outline-none focus:border-[#4f8fba]" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
          {message ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{message}</p> : null}
          <button className="w-full rounded-2xl bg-[#25313f] px-5 py-3 font-black text-white disabled:opacity-60" type="submit" disabled={isSubmitting}>{isSubmitting ? '확인 중...' : '관리자 페이지로 이동'}</button>
        </form>
      </section>
    </main>
  );
}

function normalizeQrPassword(value: string): string {
  return value.trim().startsWith('class-store-admin:') ? value.trim().slice('class-store-admin:'.length) : value.trim();
}
