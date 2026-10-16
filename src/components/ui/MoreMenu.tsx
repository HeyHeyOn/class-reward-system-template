'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from './classes';
import { Icon, type IconName } from './icons';

export type MoreMenuItem = Readonly<{
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  /** A link (opens here), or an action. */
  href?: string;
  onSelect?: () => void;
}>;

/**
 * The ⋯ button and its menu for an item's management actions (ddanssaem-brand README '목록 화면'). Closes on a
 * click outside, on Escape (focus back on the button) and after a choice; arrow keys move between the items.
 */
export function MoreMenu({ label, items, className, align = 'right' }: Readonly<{
  label: string;
  items: readonly (MoreMenuItem | null | false)[];
  className?: string;
  align?: 'left' | 'right';
}>) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = items.filter((item): item is MoreMenuItem => Boolean(item));

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const entries = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    entries[(at + (event.key === 'ArrowDown' ? 1 : entries.length - 1)) % entries.length]?.focus();
  }

  if (shown.length === 0) return null;
  const itemClass = (item: MoreMenuItem) => cx('flex min-h-11 w-full items-center gap-2 px-3 text-left text-[14px] font-semibold no-underline',
    'hover:bg-[var(--crs-subtle)] focus-visible:bg-[var(--crs-subtle)] focus-visible:outline-none aria-disabled:cursor-default aria-disabled:opacity-45',
    item.danger ? 'text-[var(--crs-danger-text)]' : 'text-[var(--theme-text)]');
  return (
    <div ref={root} className={cx('relative', className)} onKeyDown={onKeyDown}>
      <button ref={button} type="button" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? id : undefined} onClick={() => setOpen((value) => !value)}
        className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle)] hover:text-[var(--theme-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-focus-ring)]">
        <Icon name="more" size={18} />
      </button>
      {open ? (
        <div id={id} role="menu" aria-label={label}
          className={cx('absolute top-10 z-20 min-w-44 overflow-hidden rounded-[12px] border border-[var(--crs-line)] bg-[var(--theme-surface)] py-1 shadow-[var(--crs-shadow-lg)]',
            align === 'right' ? 'right-0' : 'left-0')}>
          {shown.map((item) => item.href && !item.disabled ? (
            <a key={item.label} role="menuitem" href={item.href} className={itemClass(item)} onClick={() => setOpen(false)}>
              {item.icon ? <Icon name={item.icon} size={16} /> : null}{item.label}
            </a>
          ) : (
            <button key={item.label} type="button" role="menuitem" aria-disabled={item.disabled || undefined} className={itemClass(item)}
              onClick={() => { if (item.disabled) return; setOpen(false); item.onSelect?.(); }}>
              {item.icon ? <Icon name={item.icon} size={16} /> : null}{item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
