// Plain class-name helpers. No 'use client': server components may call these.

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerGhost' | 'soft';
export type ButtonSize = 'sm' | 'md' | 'lg';

export const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--theme-surface)]';

export const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)] hover:bg-[var(--theme-hover)] hover:text-[var(--theme-hover-text)] shadow-[var(--crs-shadow-sm)]',
  secondary: 'border border-[var(--crs-line-strong)] bg-[var(--theme-surface)] text-[var(--theme-text)] hover:bg-[var(--crs-subtle-hover)] shadow-[var(--crs-shadow-sm)]',
  ghost: 'text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)]',
  soft: 'bg-[var(--crs-subtle)] text-[var(--theme-text)] hover:bg-[var(--crs-subtle-hover)]',
  danger: 'bg-[var(--crs-danger-solid)] text-white hover:brightness-95 shadow-[var(--crs-shadow-sm)]',
  dangerGhost: 'text-[var(--crs-danger-text)] hover:bg-[var(--crs-danger-bg)]',
};

export const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-[9px] px-3 text-[13px]',
  md: 'h-10 gap-2 rounded-[11px] px-4 text-sm',
  lg: 'h-12 gap-2 rounded-[13px] px-5 text-[15px]',
};

export function buttonClass({ variant = 'secondary', size = 'md', block = false, className }: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean; className?: string } = {}) {
  return cx(
    'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-bold tracking-[-0.01em] transition-[background-color,color,box-shadow,filter] duration-150',
    'disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:cursor-not-allowed aria-disabled:opacity-45',
    focusRing, buttonVariants[variant], buttonSizes[size], block && 'w-full', className,
  );
}

export const controlClass = cx(
  'block w-full min-w-0 rounded-[11px] border border-[var(--crs-line-strong)] bg-[var(--theme-input)] px-3.5 text-[15px] font-medium text-[var(--theme-text)]',
  'placeholder:text-[color-mix(in_srgb,var(--theme-muted-text)_70%,transparent)] transition-[border-color,box-shadow] duration-150',
  'hover:border-[var(--theme-border)] focus:border-[var(--theme-focus-ring)] focus:outline-none focus:ring-[3px] focus:ring-[color-mix(in_srgb,var(--theme-focus-ring)_18%,transparent)]',
  'disabled:cursor-not-allowed disabled:opacity-55',
);
