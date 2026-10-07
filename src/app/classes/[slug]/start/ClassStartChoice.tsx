'use client';

import { useState } from 'react';
import { Icon, cx, type IconName } from '@/components/ui';
import { XlsxImportPanel } from '@/components/xlsxImport/XlsxImportPanel';
import { ClassStartForm } from './ClassStartForm';

type Choice = 'empty' | 'xlsx';
const OPTIONS: readonly { value: Choice; title: string; description: string; icon: IconName }[] = [
  { value: 'empty', title: '새로 시작하기', description: '학생·상품·과제를 직접 등록해요.', icon: 'sparkle' },
  { value: 'xlsx', title: '기존 CRS 시트 파일(.xlsx)로 시작하기', description: '예전 구글 시트를 .xlsx로 저장해 올리면 학생·잔액·상품·과제를 옮겨요.', icon: 'migrate' },
];

/** The two ways to start a new, empty class: from scratch or from a saved CRS workbook. */
export function ClassStartChoice({ slug, operationId }: Readonly<{ slug: string; operationId: string }>) {
  const [choice, setChoice] = useState<Choice>('empty');
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="학급 시작 방법" className="grid gap-2 sm:grid-cols-2">
        {OPTIONS.map(option => {
          const selected = option.value === choice;
          return (
            <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => setChoice(option.value)}
              className={cx('flex min-w-0 items-start gap-3 rounded-[var(--crs-radius-lg)] border px-4 py-3.5 text-left transition-colors',
                'outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
                selected ? 'border-[var(--theme-accent-text)] bg-[var(--theme-accent-soft)]' : 'border-[var(--crs-line)] hover:bg-[var(--crs-subtle-hover)]')}>
              <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl',
                selected ? 'bg-[var(--theme-surface)] text-[var(--theme-accent-text)]' : 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]')}>
                <Icon name={option.icon} size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-extrabold leading-snug">{option.title}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-[var(--theme-muted-text)]">{option.description}</span>
              </span>
              {selected ? <span aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--theme-accent-text)]"><Icon name="check" size={17} /></span> : null}
            </button>
          );
        })}
      </div>
      {choice === 'empty' ? <ClassStartForm slug={slug} operationId={operationId} /> : <XlsxImportPanel slug={slug} mode="start" />}
    </div>
  );
}
