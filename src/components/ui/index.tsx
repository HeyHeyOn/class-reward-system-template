'use client';

import {
  forwardRef, useEffect, useId, useRef,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type KeyboardEvent, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './icons';

export { Icon, type IconName } from './icons';

/* ------------------------------------------------------------------ */
/* Class helpers                                                       */
/* ------------------------------------------------------------------ */

export { buttonClass, controlClass, cx, type ButtonSize, type ButtonVariant } from './classes';
import { buttonClass, controlClass, cx, focusRing, buttonVariants, type ButtonSize, type ButtonVariant } from './classes';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  block?: boolean;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, block, loading, className, children, type = 'button', ...rest }, ref,
) {
  const iconSize = size === 'sm' ? 15 : 17;
  return (
    <button ref={ref} type={type} className={buttonClass({ variant, size, block, className })} {...rest}>
      {loading ? <Spinner size={iconSize} /> : icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={iconSize} /> : null}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, 'icon' | 'children'> & { icon: IconName; label: string }>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', className, type = 'button', ...rest }, ref,
) {
  const box = size === 'sm' ? 'h-8 w-8 rounded-[9px]' : size === 'lg' ? 'h-12 w-12 rounded-[13px]' : 'h-10 w-10 rounded-[11px]';
  return (
    <button ref={ref} type={type} aria-label={label} title={label}
      className={cx('inline-flex shrink-0 items-center justify-center transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45', focusRing, buttonVariants[variant], box, className)} {...rest}>
      <Icon name={icon} size={size === 'sm' ? 16 : 18} />
    </button>
  );
});

export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return <span aria-hidden="true" style={{ width: size, height: size }} className={cx('inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-70', className)} />;
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export function Card({ children, className, padded = true, as: Tag = 'section', ...rest }: { children: ReactNode; className?: string; padded?: boolean; as?: 'section' | 'div' | 'article' } & Record<string, unknown>) {
  return (
    <Tag className={cx('min-w-0 rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)]', padded && 'p-5 sm:p-6', className)} {...rest}>
      {children}
    </Tag>
  );
}

export function CardHeader({ title, description, actions, className, titleAs: Title = 'h2' }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; titleAs?: 'h2' | 'h3' }) {
  return (
    <div className={cx('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <Title className="text-[17px] font-extrabold tracking-[-0.02em]">{title}</Title>
        {description ? <p className="mt-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        {eyebrow ? <p className="mb-1.5 text-[13px] font-semibold text-[var(--theme-muted-text)]">{eyebrow}</p> : null}
        <h2 className="text-[26px] font-black leading-tight tracking-[-0.035em] sm:text-[30px]">{title}</h2>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--theme-muted-text)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function StatCard({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: ReactNode; icon?: IconName }) {
  return (
    <div className="min-w-0 rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-5 py-4 shadow-[var(--crs-shadow-sm)]">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-[13px] font-semibold text-[var(--theme-muted-text)]">{label}</p>
        {icon ? <span className="text-[var(--theme-muted-text)]"><Icon name={icon} size={17} /></span> : null}
      </div>
      <p className="mt-1.5 truncate text-[26px] font-black leading-tight tracking-[-0.03em] tabular-nums">{value}</p>
      {hint ? <p className="mt-1 truncate text-xs text-[var(--theme-muted-text)]">{hint}</p> : null}
    </div>
  );
}

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent';
const toneClasses: Record<Tone, string> = {
  neutral: 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]',
  success: 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]',
  warning: 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]',
  danger: 'bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]',
  info: 'bg-[var(--crs-info-bg)] text-[var(--crs-info-text)]',
  accent: 'bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]',
};

export function Badge({ tone = 'neutral', dot = false, icon, children, className }: { tone?: Tone; dot?: boolean; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <span className={cx('inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-[3px] text-[11.5px] font-bold leading-[18px]', toneClasses[tone], className)}>
      {dot ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {icon ? <Icon name={icon} size={13} strokeWidth={2.2} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function Callout({ tone = 'info', title, children, icon, className }: { tone?: Exclude<Tone, 'accent'>; title?: ReactNode; children?: ReactNode; icon?: IconName; className?: string }) {
  const fallback: Record<string, IconName> = { info: 'info', neutral: 'info', success: 'check', warning: 'alert', danger: 'alert' };
  return (
    <div className={cx('flex gap-3 rounded-[var(--crs-radius)] px-4 py-3 text-[13px] leading-relaxed', toneClasses[tone], className)}>
      <span className="mt-[1px] shrink-0"><Icon name={icon ?? fallback[tone]} size={17} /></span>
      <div className="min-w-0">
        {title ? <p className="font-bold">{title}</p> : null}
        {children ? <div className={cx(title ? 'mt-0.5' : undefined, 'opacity-95')}>{children}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'box', title, description, action }: { icon?: IconName; title: ReactNode; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--crs-radius-lg)] border border-dashed border-[var(--crs-line-strong)] px-6 py-14 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]"><Icon name={icon} size={22} /></span>
      <p className="mt-4 text-base font-extrabold">{title}</p>
      {description ? <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{description}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Form controls                                                       */
/* ------------------------------------------------------------------ */


export function Field({ label, hint, error, htmlFor, children, className, optional }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; htmlFor?: string; children: ReactNode; className?: string; optional?: boolean }) {
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline gap-1.5 text-[13px] font-bold text-[var(--theme-text)]">
        {label}
        {optional ? <span className="text-xs font-medium text-[var(--theme-muted-text)]">선택</span> : null}
      </label>
      {children}
      {error ? <p role="alert" className="mt-1.5 text-xs font-semibold text-[var(--crs-danger-text)]">{error}</p>
        : hint ? <p className="mt-1.5 text-xs leading-relaxed text-[var(--theme-muted-text)]">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { suffix?: ReactNode }>(function Input({ className, suffix, ...rest }, ref) {
  if (!suffix) return <input ref={ref} className={cx(controlClass, 'h-11', className)} {...rest} />;
  return (
    <div className="relative">
      <input ref={ref} className={cx(controlClass, 'h-11 pr-12', className)} {...rest} />
      <span className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-sm font-semibold text-[var(--theme-muted-text)]">{suffix}</span>
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(controlClass, 'min-h-24 py-3 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className="relative min-w-0">
      <select ref={ref} className={cx(controlClass, 'h-11 cursor-pointer appearance-none pr-10', className)} {...rest}>{children}</select>
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--theme-muted-text)]"><Icon name="chevronDown" size={16} /></span>
    </div>
  );
});

export function Switch({ checked, onChange, label, description, ariaLabel, disabled }: { checked: boolean; onChange: (checked: boolean) => void; label?: ReactNode; description?: ReactNode; ariaLabel?: string; disabled?: boolean }) {
  const id = useId();
  const control = (
    <span className="relative inline-flex h-6 w-11 shrink-0">
      <input id={id} type="checkbox" role="switch" aria-label={ariaLabel} checked={checked} disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className={cx('peer absolute inset-0 z-10 h-full w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed', focusRing)} />
      <span aria-hidden="true" className="absolute inset-0 rounded-full bg-[var(--crs-line-strong)] transition-colors duration-150 peer-checked:bg-[var(--theme-accent-text)] peer-disabled:opacity-50" />
      <span aria-hidden="true" className="absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-transform duration-150 peer-checked:translate-x-5" />
    </span>
  );
  if (!label) return control;
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center justify-between gap-4 rounded-[var(--crs-radius)] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-bold">{label}</span>
        {description ? <span className="mt-0.5 block text-xs leading-relaxed text-[var(--theme-muted-text)]">{description}</span> : null}
      </span>
      {control}
    </label>
  );
}

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Checkbox({ className, ...rest }, ref) {
  return <input ref={ref} type="checkbox" className={cx('h-[18px] w-[18px] shrink-0 cursor-pointer rounded-[5px] accent-[var(--theme-accent-text)]', focusRing, className)} {...rest} />;
});

export function SearchInput({ value, onChange, placeholder = '검색', ariaLabel, className }: { value: string; onChange: (value: string) => void; placeholder?: string; ariaLabel?: string; className?: string }) {
  return (
    <div className={cx('relative min-w-0', className)}>
      <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-[var(--theme-muted-text)]"><Icon name="search" size={17} /></span>
      <input type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} aria-label={ariaLabel ?? placeholder}
        className={cx(controlClass, 'h-10 pl-10 text-sm')} />
    </div>
  );
}

export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, size = 'md', className }: {
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} className={cx('inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[12px] bg-[var(--crs-subtle-hover)] p-1', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button key={option.value} type="button" aria-pressed={active} onClick={() => onChange(option.value)}
            className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] font-bold transition-colors duration-150', focusRing,
              size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
              active ? 'bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)]' : 'text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]')}>
            {option.label}
            {typeof option.count === 'number' ? <span className="text-[11px] font-semibold opacity-60 tabular-nums">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overlays                                                            */
/* ------------------------------------------------------------------ */

const focusableSelector = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogFocus(ref: React.RefObject<HTMLElement | null>, opener: HTMLElement | null | undefined, autoFocus = true) {
  useEffect(() => {
    const previous = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (autoFocus) {
      const node = ref.current;
      const preferred = node?.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? node?.querySelector<HTMLElement>(focusableSelector) ?? node)?.focus();
    }
    return () => {
      window.queueMicrotask(() => { if (previous?.isConnected) previous.focus(); });
    };
    // Focus moves once per opening; later re-renders must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function trapTab(event: KeyboardEvent<HTMLElement>, container: HTMLElement | null) {
  if (event.key !== 'Tab' || !container) return;
  const controls = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter((node) => !node.closest('[inert]'));
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

type OverlayProps = {
  title: ReactNode;
  ariaLabel?: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
  busy?: boolean;
  obscured?: boolean;
  opener?: HTMLElement | null;
  headerActions?: ReactNode;
  className?: string;
  /** Hide the dialog while busy. Only for dialogs covered by a separate loading overlay. */
  hideWhileBusy?: boolean;
};

/** Right-hand editor panel. Full-height on desktop, full-screen sheet on phones. */
export function Sheet({ title, ariaLabel, description, eyebrow, onClose, footer, children, busy = false, obscured = false, opener, headerActions, width = 'max-w-[560px]', toolbar, className, hideWhileBusy = false }: OverlayProps & { width?: string; toolbar?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogFocus(ref, opener);
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div aria-hidden="true" className="absolute inset-0 bg-[rgb(15_23_42/0.38)] backdrop-blur-[2px] [animation:crs-fade-in_.15s_ease-out]" onClick={() => { if (!busy) onClose(); }} />
      <section ref={ref} role="dialog" aria-modal="true" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : titleId}
        aria-hidden={obscured || (busy && hideWhileBusy) ? true : undefined} inert={obscured || (busy && hideWhileBusy) ? true : undefined}
        onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } trapTab(event, ref.current); }}
        className={cx('relative flex h-full w-full flex-col bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-lg)] [animation:crs-sheet-in_.2s_cubic-bezier(.2,.8,.2,1)] sm:border-l sm:border-[var(--crs-line)]', width, className)}>
        <header className="flex items-start gap-3 border-b border-[var(--crs-line)] px-5 pb-4 pt-5 sm:px-6">
          <div className="min-w-0 flex-1">
            {eyebrow ? <p className="text-xs font-semibold text-[var(--theme-muted-text)]">{eyebrow}</p> : null}
            <h2 id={titleId} className="mt-0.5 truncate text-[19px] font-black tracking-[-0.025em]">{title}</h2>
            {description ? <div className="mt-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{description}</div> : null}
          </div>
          {headerActions}
          <IconButton icon="close" label="닫기" onClick={onClose} disabled={busy} className="-mr-2 -mt-1" />
        </header>
        {toolbar ? <div className="border-b border-[var(--crs-line)] px-5 py-3 sm:px-6">{toolbar}</div> : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">{children}</div>
        {footer ? <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--crs-line)] bg-[var(--crs-subtle)] px-5 py-3.5 sm:px-6">{footer}</footer> : null}
      </section>
    </div>
  );
}

/** Centered dialog for confirmations and short flows. */
export function Modal({ title, ariaLabel, description, onClose, footer, children, busy = false, obscured = false, opener, size = 'md', className, headerActions, tone, hideWhileBusy = false }: OverlayProps & { size?: 'sm' | 'md' | 'lg' | 'xl'; tone?: Tone }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useDialogFocus(ref, opener);
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div aria-hidden="true" className="absolute inset-0 bg-[rgb(15_23_42/0.42)] backdrop-blur-[2px] [animation:crs-fade-in_.15s_ease-out]" onClick={() => { if (!busy) onClose(); }} />
      <section ref={ref} role="dialog" aria-modal="true" aria-label={ariaLabel} aria-labelledby={ariaLabel ? undefined : titleId}
        aria-hidden={obscured || (busy && hideWhileBusy) ? true : undefined} inert={obscured || (busy && hideWhileBusy) ? true : undefined}
        onKeyDown={(event) => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); onClose(); } trapTab(event, ref.current); }}
        className={cx('relative flex max-h-[min(92dvh,900px)] w-full flex-col overflow-hidden rounded-t-[22px] border border-[var(--crs-line)] bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-lg)] [animation:crs-pop-in_.18s_cubic-bezier(.2,.8,.2,1)] sm:rounded-[22px]', width, className)}>
        <header className="flex items-start gap-3 px-5 pb-1 pt-5 sm:px-6">
          {tone ? <span className={cx('mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', toneClasses[tone])}><Icon name={tone === 'danger' || tone === 'warning' ? 'alert' : tone === 'success' ? 'check' : 'info'} size={18} /></span> : null}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-black tracking-[-0.025em]">{title}</h2>
            {description ? <div className="mt-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{description}</div> : null}
          </div>
          {headerActions}
          <IconButton icon="close" label="닫기" onClick={onClose} disabled={busy} size="sm" className="-mr-1.5" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-3 sm:px-6">{children}</div>
        {footer ? <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--crs-line)] bg-[var(--crs-subtle)] px-5 py-3.5 sm:px-6">{footer}</footer> : null}
      </section>
    </div>
  );
}

/** Floating action bar shown while list rows are selected. */
export function SelectionBar({ count, onClear, children, label = '개 선택됨' }: { count: number; onClear: () => void; children: ReactNode; label?: string }) {
  if (count === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-3 lg:pl-[260px]">
      <div role="toolbar" aria-label="선택 항목 작업" className="pointer-events-auto flex max-w-full items-center gap-1.5 overflow-x-auto rounded-[16px] bg-[var(--theme-text)] p-1.5 pl-4 text-[var(--theme-surface)] shadow-[var(--crs-shadow-lg)] [animation:crs-rise-in_.18s_ease-out]">
        <span className="whitespace-nowrap pr-2 text-[13px] font-bold tabular-nums">{count}{label}</span>
        {children}
        <button type="button" onClick={onClear} aria-label="선택 해제" className="ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] opacity-70 hover:bg-[color-mix(in_srgb,var(--theme-surface)_14%,transparent)] hover:opacity-100"><Icon name="close" size={16} /></button>
      </div>
    </div>
  );
}

export function SelectionBarButton({ icon, children, onClick, danger, disabled, ...rest }: { icon?: IconName; children: ReactNode; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; danger?: boolean; disabled?: boolean } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className={cx('inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-bold transition-colors disabled:opacity-40',
        danger ? 'text-[color-mix(in_srgb,#f43f5e_72%,var(--theme-surface))] hover:bg-[#e11d48]/25' : 'hover:bg-[color-mix(in_srgb,var(--theme-surface)_14%,transparent)]')} {...rest}>
      {icon ? <Icon name={icon} size={15} /> : null}{children}
    </button>
  );
}

export function LoadingOverlay({ title, message, restoreFocus = true }: { title: string; message: string; restoreFocus?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.focus();
    return () => {
      if (!restoreFocus) return;
      window.queueMicrotask(() => { if (previous?.isConnected) previous.focus(); });
    };
  }, [restoreFocus]);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgb(15_23_42/0.35)] p-4 backdrop-blur-[2px]">
      <section ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Tab') event.preventDefault(); }}
        className="flex w-full max-w-sm items-center gap-4 rounded-[20px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-5 text-[var(--theme-text)] shadow-[var(--crs-shadow-lg)] outline-none [animation:crs-pop-in_.15s_ease-out]">
        <Spinner size={26} className="text-[var(--theme-accent-text)]" />
        <div className="min-w-0">
          <h2 className="text-[15px] font-extrabold">{title}</h2>
          <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{message}</p>
        </div>
      </section>
    </div>
  );
}

/** Small key/value line used in detail panels. */
export function MetaRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
      <dt className="shrink-0 text-[var(--theme-muted-text)]">{label}</dt>
      <dd className="min-w-0 text-right font-semibold">{children}</dd>
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label?: string }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--crs-subtle-hover)]">
      <div className="h-full rounded-full bg-[var(--theme-accent-text)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
    </div>
  );
}
