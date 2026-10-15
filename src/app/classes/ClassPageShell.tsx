import type { ReactNode } from 'react';
import { TeacherHeader } from '@/components/brand/TeacherHeader';
import { themeStyles } from '@/components/uiTheme';

const theme = themeStyles('white');

/** Centered single-task layout shared by the class creation and start pages. */
export function ClassPageShell({ eyebrow, title, description, children }: Readonly<{ eyebrow: string; title: ReactNode; description?: ReactNode; children: ReactNode }>) {
  return (
    <>
    <TeacherHeader />
    <main style={theme.variables} className="min-h-[calc(100vh-65px)] bg-[var(--theme-shell)] px-4 py-6 text-[var(--theme-text)] sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-xl">
        <a href="/classes" className="inline-flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[13px] font-semibold text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)]">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
          내 학급
        </a>
        <section className="mt-4 rounded-[24px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-6 shadow-[var(--crs-shadow)] sm:p-8">
          <p className="text-[13px] font-semibold text-[var(--theme-muted-text)]">{eyebrow}</p>
          <h1 className="mt-1 text-[28px] font-black leading-tight tracking-[-0.035em]">{title}</h1>
          {description ? <p className="mt-2 text-sm leading-relaxed text-[var(--theme-muted-text)]">{description}</p> : null}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
    </>
  );
}
