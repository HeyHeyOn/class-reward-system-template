'use client';

import { useEffect, useRef, useState } from 'react';

type QrScannerProps = {
  onScan: (decodedText: string) => void;
};

export function QrScanner({ onScan }: QrScannerProps) {
  const scannerId = 'class-store-qr-reader';
  const onScanRef = useRef(onScan);
  const [status, setStatus] = useState('카메라 준비 중입니다.');

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    let isMounted = true;
    let lastDecodedText = '';
    let scanner: { render: (onSuccess: (decodedText: string) => void, onError?: () => void) => void; clear: () => Promise<void> } | null = null;

    async function startScanner() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('이 브라우저에서는 카메라 QR 인식을 사용할 수 없습니다. 아래 직접 입력을 사용해 주세요.');
        return;
      }

      try {
        const { Html5QrcodeScanner } = await import('html5-qrcode');
        if (!isMounted) return;

        scanner = new Html5QrcodeScanner(
          scannerId,
          {
            fps: 10,
            qrbox: { width: 200, height: 200 },
            rememberLastUsedCamera: true,
          },
          false,
        );

        scanner.render((decodedText: string) => {
          const trimmedText = decodedText.trim();
          if (!trimmedText || trimmedText === lastDecodedText) return;

          lastDecodedText = trimmedText;
          setStatus(`QR 인식 완료: ${trimmedText}`);
          onScanRef.current(trimmedText);
        });
        setStatus('카메라 권한을 허용한 뒤 학생 QR을 보여 주세요.');
      } catch {
        if (isMounted) {
          setStatus('QR 스캐너를 시작하지 못했습니다. 아래 직접 입력을 사용해 주세요.');
        }
      }
    }

    startScanner();

    return () => {
      isMounted = false;
      if (scanner) {
        scanner.clear().catch(() => undefined);
      }
    };
  }, []);

  return (
    <div className="w-full max-w-xl rounded-[18px] bg-white p-3 text-slate-900">
      <div id={scannerId} className="overflow-hidden rounded-[14px]" />
      <p role="status" className="mt-2.5 flex items-center justify-center gap-1.5 text-center text-[13px] font-semibold text-slate-500">
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />{status}
      </p>
    </div>
  );
}
