// Server-safe building blocks for the legal pages (terms of service, privacy policy). No hooks.
import type { ReactNode } from 'react';
import { SiteFooter } from '@/components/SiteFooter';
import { themeStyles } from '@/components/uiTheme';

/** The operator and the contact shown in the legal documents. */
export const OPERATOR = '환잇쌤';
export const OPERATOR_CONTACT_EMAIL = 'hwanit1105@gmail.com';

const theme = themeStyles('white');

export function ContactLink() {
  return (
    <a className="font-semibold text-[var(--theme-accent-text)] underline underline-offset-2" href={`mailto:${OPERATOR_CONTACT_EMAIL}`}>
      {OPERATOR_CONTACT_EMAIL}
    </a>
  );
}

export function LegalPage({ title, intro, children }: Readonly<{ title: string; intro: ReactNode; children: ReactNode }>) {
  return (
    <main style={theme.variables} className="min-h-screen bg-[var(--theme-shell)] px-4 py-6 text-[var(--theme-text)] sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-3xl">
        <a href="/classes" className="inline-flex items-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[13px] font-semibold text-[var(--theme-muted-text)] transition-colors hover:bg-[var(--crs-subtle-hover)] hover:text-[var(--theme-text)]">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
          메인 화면으로
        </a>
        <article className="mt-4 rounded-[24px] border border-[var(--crs-line)] bg-[var(--theme-surface)] p-6 shadow-[var(--crs-shadow)] sm:p-9">
          <h1 className="text-[28px] font-black leading-tight tracking-[-0.035em]">{title}</h1>
          <div className="mt-3 text-[14px] leading-[1.75] text-[var(--theme-muted-text)]">{intro}</div>
          <div className="mt-8 space-y-8">{children}</div>
        </article>
        <SiteFooter className="mt-8 border-t border-[var(--crs-line)] px-1 pt-6 pb-3 text-[11px] text-[var(--theme-muted-text)]" />
      </div>
    </main>
  );
}

export function Article({ id, title, children }: Readonly<{ id: string; title: string; children: ReactNode }>) {
  return (
    <section aria-labelledby={id} className="border-t border-[var(--crs-line)] pt-6">
      <h2 id={id} className="text-[17px] font-extrabold tracking-[-0.02em]">{title}</h2>
      <div className="mt-3 space-y-3 text-[14px] leading-[1.75] text-[var(--theme-text)]">{children}</div>
    </section>
  );
}

export function Table({ head, rows }: Readonly<{ head: readonly string[]; rows: ReadonlyArray<readonly ReactNode[]> }>) {
  return (
    <div className="overflow-x-auto rounded-[14px] border border-[var(--crs-line)]">
      <table className="w-full min-w-[520px] border-collapse text-left text-[13px] leading-relaxed">
        <thead className="bg-[var(--crs-subtle)]">
          <tr>{head.map((cell) => <th key={cell} scope="col" className="px-3 py-2.5 font-bold">{cell}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-t border-[var(--crs-line)] align-top">
              {row.map((cell, cellIndex) => <td key={cellIndex} className="px-3 py-2.5">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function List({ items, ordered = false }: Readonly<{ items: readonly ReactNode[]; ordered?: boolean }>) {
  const Tag = ordered ? 'ol' : 'ul';
  return <Tag className={`${ordered ? 'list-decimal' : 'list-disc'} space-y-1.5 pl-5`}>{items.map((item, index) => <li key={index}>{item}</li>)}</Tag>;
}
