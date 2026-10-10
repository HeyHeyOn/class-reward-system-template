'use client';

/* eslint-disable @next/next/no-img-element */
import type { MouseEvent } from 'react';
import type { Student } from '@/domain/types';
import { Icon, type IconName } from '../ui';
import { themeStyles } from '../uiTheme';

const sidebarRowClass = 'flex items-center gap-2.5 rounded-[11px] px-3 py-2 text-[13px] font-semibold text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]';

export function SidebarLink({ href, icon, label, external = false }: { href: string; icon: IconName; label: string; external?: boolean }) {
  return (
    <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer', 'aria-label': `${label} 새 탭 열림` } : {})}
      className={sidebarRowClass}>
      <Icon name={icon} size={17} />
      <span className="flex-1">{label}</span>
      {external ? <Icon name="external" size={14} className="opacity-60" /> : null}
    </a>
  );
}

/** A shortcut that opens a page, with a share button (address, copy, QR) beside it. */
export function SidebarShortcut({ href, icon, label, shareLabel, onShare }: { href: string; icon: IconName; label: string; shareLabel: string; onShare: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <div className="flex items-center gap-0.5">
      <div className="min-w-0 flex-1"><SidebarLink href={href} icon={icon} label={label} external /></div>
      <button type="button" aria-label={shareLabel} title={shareLabel} onClick={onShare}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
        <Icon name="share" size={16} />
      </button>
    </div>
  );
}

export function SidebarButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" onClick={onClick} className={`${sidebarRowClass} w-full text-left`}>
      <Icon name={icon} size={17} />
      <span className="flex-1">{label}</span>
    </button>
  );
}

export function QuickAction({ icon, title, description, onClick, href }: { icon: IconName; title: string; description: string; onClick?: () => void; href?: string }) {
  const body = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]"><Icon name={icon} size={20} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-extrabold">{title}</span>
        <span className="mt-0.5 hidden truncate text-xs text-[var(--theme-muted-text)] sm:block">{description}</span>
      </span>
      <Icon name={href ? 'external' : 'chevronRight'} size={16} className="hidden shrink-0 text-[var(--theme-muted-text)] sm:block" />
    </>
  );
  const className = 'flex items-center gap-3 rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-3 text-left sm:p-4 shadow-[var(--crs-shadow-sm)] transition-[box-shadow,transform] hover:-translate-y-px hover:shadow-[var(--crs-shadow)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]';
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" aria-label={`${title} 새 탭 열림`} className={className}>{body}</a>
    : <button type="button" onClick={onClick} className={className}>{body}</button>;
}

export function SheetLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex items-center gap-3 rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-4 text-[13px] font-semibold text-[var(--theme-muted-text)]">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />{label}
    </div>
  );
}

export function LoadingScreen({ title, message }: { title: string; message: string }) {
  const loadingTheme = themeStyles('white');
  return (
    <main style={loadingTheme.variables} className="flex min-h-screen items-center justify-center bg-[var(--theme-shell)] p-4 text-[var(--theme-text)]">
      <section role="dialog" aria-modal="true" aria-label={title} className="flex w-full max-w-sm flex-col items-center rounded-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-6 py-8 text-center shadow-[var(--crs-shadow)]">
        <span aria-hidden="true" className="h-9 w-9 animate-spin rounded-full border-[3px] border-[var(--crs-line-strong)] border-t-[var(--theme-accent-text)]" />
        <h1 className="mt-5 text-lg font-black tracking-[-0.02em]">{title}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{message}</p>
      </section>
    </main>
  );
}

export function StudentQrCard({ student, qrUrl }: { student: Student; qrUrl: string | null | undefined }) {
  return (
    <article className="break-inside-avoid rounded-[20px] border border-slate-200 bg-white p-5 text-center text-slate-950 print:rounded-2xl print:p-4">
      <div className="mx-auto mb-4 flex h-44 w-44 items-center justify-center rounded-2xl bg-white print:h-40 print:w-40">
        {qrUrl ? <img alt={`${student.name} QR 코드`} className="h-full w-full" src={qrUrl} /> : <span className={`text-sm font-bold ${qrUrl === null ? 'text-red-700' : 'text-slate-500'}`}>{qrUrl === null ? 'QR 생성 실패' : 'QR 생성 중'}</span>}
      </div>
      <h3 className="text-xl font-black tracking-[-0.02em]">{student.name}</h3>
      <p className="mt-0.5 text-sm font-semibold text-slate-500">{student.studentId}</p>
      <p className="mt-4 rounded-xl bg-slate-50 px-4 py-2.5 text-xs font-semibold leading-relaxed text-slate-600 print:bg-white print:p-0">
        학급 은행과 매점에서<br />이 QR을 찍어 주세요.
      </p>
    </article>
  );
}
