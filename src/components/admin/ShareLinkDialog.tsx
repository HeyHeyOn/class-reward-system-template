'use client';

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react';
import { Button, Callout, Modal, SegmentedControl } from '../ui';
import { downloadBlob, shareCardPdf, shareCardPng, shareFileName, type ShareCardContent } from '@/lib/shareCard';
import { publicOrigin } from '@/lib/publicOrigin';

export type ShareTarget = 'store' | 'bank' | 'admin';

const TARGETS: Record<ShareTarget, Readonly<{ option: string; title: string; description?: string }>> = {
  store: { option: '매점', title: '매점', description: '학생 기기나 교실 기기에서 이 주소나 QR로 매점을 바로 열 수 있어요.' },
  bank: { option: '은행', title: '은행', description: '학생 기기나 교실 기기에서 이 주소나 QR로 은행을 바로 열 수 있어요.' },
  admin: { option: '관리자 페이지', title: '관리자 페이지' },
};
const TARGET_ORDER: ShareTarget[] = ['store', 'bank', 'admin'];
const HINT = '휴대폰 카메라로 QR을 비추면 바로 열려요.';
const ADMIN_CAUTION = '선생님 전용 · Google 로그인 필요';

type Busy = 'png' | 'pdf' | null;

function copySelectedAddress(input: HTMLInputElement | null) {
  if (!input) return false;
  input.focus();
  input.setSelectionRange(0, input.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/**
 * Share a class page: its address (to copy or send) and a QR, saved as an image or a PDF for printing.
 * The admin page is included for the teacher's own devices; it opens only after Google login as an
 * administrator of this class.
 */
export function ShareLinkDialog({ initialTarget, paths, classLabel, titles, onClose, opener }: {
  initialTarget: ShareTarget;
  /** Page paths of this class, e.g. `/c/<slug>/bank`. */
  paths: Readonly<Record<ShareTarget, string>>;
  classLabel: string;
  /** The names set in 설정 (매점 제목, 은행 제목); the card and its file are titled with them. */
  titles?: Readonly<Partial<Record<'store' | 'bank', string | undefined>>>;
  onClose: () => void;
  opener?: HTMLElement | null;
}) {
  const [target, setTarget] = useState<ShareTarget>(initialTarget);
  const [qrSrc, setQrSrc] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const page = TARGETS[target];
  const title = (target === 'admin' ? undefined : titles?.[target]?.trim()) || page.title;
  const url = new URL(paths[target], publicOrigin()).href;
  const canShare = typeof navigator.share === 'function';

  useEffect(() => {
    let active = true;
    void import('qrcode')
      .then((QRCode) => QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 }))
      .then((svg) => { if (active) setQrSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`); })
      .catch(() => { if (active) setQrSrc(null); });
    return () => { active = false; };
  }, [url]);

  useEffect(() => () => { if (copiedTimer.current) window.clearTimeout(copiedTimer.current); }, []);

  function choose(next: ShareTarget) {
    setTarget(next);
    setQrSrc(undefined);
    setCopied(false);
    setNotice('');
  }

  async function copyAddress() {
    const done = await navigator.clipboard?.writeText(url).then(() => true, () => false)
      // Some browsers (in-app browsers, locked-down devices) refuse the clipboard API; copying the
      // selected address the old way still works there.
      || copySelectedAddress(addressRef.current);
    if (!done) {
      addressRef.current?.select();
      setNotice('복사하지 못했어요. 주소 칸을 길게 눌러 직접 복사해 주세요.');
      return;
    }
    setCopied(true);
    setNotice('주소를 복사했어요.');
    if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  async function sendToApp() {
    try {
      await navigator.share({ title: `${classLabel} ${title}`, url });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      setNotice('다른 앱으로 보내지 못했어요. [주소 복사]를 이용해 주세요.');
    }
  }

  async function save(kind: Exclude<Busy, null>) {
    setBusy(kind);
    setNotice('');
    try {
      const content: ShareCardContent = {
        url,
        title,
        classLabel,
        hint: HINT,
        caution: target === 'admin' ? ADMIN_CAUTION : undefined,
        fontFamily: bodyRef.current ? getComputedStyle(bodyRef.current).fontFamily : 'sans-serif',
      };
      const blob = kind === 'png' ? await shareCardPng(content) : await shareCardPdf(content);
      downloadBlob(blob, shareFileName(classLabel, title, kind));
      setNotice(kind === 'png' ? '이미지 파일을 내려받았어요.' : 'PDF 파일을 내려받았어요.');
    } catch {
      setNotice('파일을 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={`${title} 공유`} onClose={onClose} opener={opener} size="md"
      footer={(
        <>
          {canShare ? <Button variant="ghost" icon="share" onClick={() => void sendToApp()} className="mr-auto">다른 앱으로 보내기</Button> : null}
          <Button variant="secondary" icon="printer" loading={busy === 'pdf'} onClick={() => void save('pdf')} disabled={busy !== null}>PDF로 저장</Button>
          <Button variant="primary" icon="download" loading={busy === 'png'} onClick={() => void save('png')} disabled={busy !== null}>이미지로 저장</Button>
        </>
      )}>
      <div ref={bodyRef} className="space-y-4">
        <SegmentedControl ariaLabel="공유할 페이지" value={target} onChange={choose}
          options={TARGET_ORDER.map((value) => ({ value, label: TARGETS[value].option }))} />
        {target === 'admin' ? (
          <Callout tone="warning" title="선생님 전용 주소예요">
            이 학급 관리자로 등록된 Google 계정으로 로그인해야 열려요. 학생에게는 공유하지 마세요.
          </Callout>
        ) : (
          <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{page.description}</p>
        )}
        <div className="flex justify-center">
          <div className="flex h-52 w-52 items-center justify-center rounded-[18px] border border-[var(--crs-line)] bg-white p-2">
            {qrSrc
              ? <img src={qrSrc} alt={`${title} QR 코드`} className="h-full w-full" />
              : <p className="text-xs font-semibold text-slate-500">{qrSrc === null ? 'QR을 만들지 못했어요.' : 'QR 만드는 중…'}</p>}
          </div>
        </div>
        <div>
          <label htmlFor="share-address" className="mb-1.5 block text-[13px] font-bold">주소</label>
          <div className="flex gap-2">
            <input id="share-address" ref={addressRef} readOnly value={url} onFocus={(event) => event.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-[11px] border border-[var(--crs-line-strong)] bg-[var(--crs-subtle)] px-3 text-[13px] font-semibold text-[var(--theme-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]" />
            <Button variant={copied ? 'soft' : 'secondary'} icon={copied ? 'check' : 'copy'} onClick={() => void copyAddress()}>
              {copied ? '복사했어요' : '주소 복사'}
            </Button>
          </div>
        </div>
        <p role="status" className="min-h-[18px] text-center text-[12.5px] font-semibold text-[var(--theme-muted-text)]">{notice}</p>
      </div>
    </Modal>
  );
}

export function sharePaths(pagePath: (path: string) => string): Readonly<Record<ShareTarget, string>> {
  return { store: pagePath('/'), bank: pagePath('/bank'), admin: pagePath('/admin') };
}
