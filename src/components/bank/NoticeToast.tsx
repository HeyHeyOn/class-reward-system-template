'use client';

import { useEffect, useRef } from 'react';
import { Icon, NOTICE_DOCK_STYLE, cx } from '../ui';

export type Notice = Readonly<{ message: string; tone?: 'info' | 'danger' }>;

/** How long a notice stays before it goes away by itself. */
const NOTICE_MS = 4000;

/**
 * A small notice at the bottom centre of the screen, like the one the teacher's screen shows after saving: why a
 * button cannot be used now, or what went wrong. It goes away by itself, or with its close button.
 */
export function NoticeToast({ notice, onClose }: Readonly<{ notice: Notice; onClose: () => void }>) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  // Every new notice (even the same words again) gets its full time.
  useEffect(() => {
    const timer = window.setTimeout(() => close.current(), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const danger = notice.tone === 'danger';
  return (
    <div style={NOTICE_DOCK_STYLE} className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4">
      <div role={danger ? 'alert' : 'status'}
        className={cx('pointer-events-auto flex w-full max-w-[480px] items-start gap-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] px-4 py-3 text-[13px] font-semibold leading-relaxed shadow-[var(--crs-shadow-lg)] [animation:crs-pop-in_.18s_ease-out]',
          danger ? 'bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]' : 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]')}>
        <span className="mt-[1px] shrink-0"><Icon name={danger ? 'alert' : 'info'} size={17} /></span>
        <p className="min-w-0 flex-1">{notice.message}</p>
        <button type="button" aria-label="알림 닫기" onClick={onClose} className="-mr-1 shrink-0 rounded-md p-0.5 opacity-70 hover:opacity-100"><Icon name="close" size={16} /></button>
      </div>
    </div>
  );
}
