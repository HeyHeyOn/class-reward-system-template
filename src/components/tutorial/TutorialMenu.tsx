'use client';

import type { MouseEvent } from 'react';
import { Button, Callout, Card, Icon, Modal, cx } from '../ui';
import { TUTORIAL_PAGE_HREF, queueTutorial } from './PendingTutorial';
import { TUTORIAL_CHAPTERS, tutorialById } from './tutorials';

/** Home tab block: opens the tutorial list. */
export function TutorialHomeCard({ onOpen }: { onOpen: (event: MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <Card data-testid="tutorial-home-card" className="flex flex-wrap items-center gap-4">
      <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]">
        <Icon name="sparkle" size={24} />
      </span>
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-[17px] font-black tracking-[-0.02em]">튜토리얼</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
          배우고 싶은 기능을 고르면, 이 화면에서 누를 곳과 적을 곳을 한 단계씩 짚어 드려요. 따라 하며 입력하고 저장한 내용은 실제로 반영돼요.
        </p>
      </div>
      <Button variant="primary" icon="sparkle" onClick={onOpen}>튜토리얼 열기</Button>
    </Card>
  );
}

/** The guide's table of contents; sections with a tutorial start it. */
export function TutorialMenu({ opener, ledgerMode, classList, onClose, onStart }: {
  opener: HTMLElement | null;
  ledgerMode: boolean;
  /** This class is opened from the teacher's class list (where 1-1 runs). */
  classList: boolean;
  onClose: () => void;
  onStart: (id: string) => void;
}) {
  return (
    <Modal title="튜토리얼" ariaLabel="튜토리얼 고르기" description="배우고 싶은 기능을 고르세요. 실제 화면에서 단계별로 안내해요." size="xl" opener={opener} onClose={onClose}>
      <div className="space-y-5">
        <Callout tone="info">
          튜토리얼을 따라 입력하고 저장한 내용은 <b>실제로 반영</b>돼요. 언제든 <b>끝내기</b>(또는 Esc)로 멈추고, <b>다음</b>으로 건너뛸 수 있어요.
        </Callout>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {TUTORIAL_CHAPTERS.map((chapter) => (
            <section key={chapter.no} aria-labelledby={`tutorial-chapter-${chapter.no}`}>
              <h3 id={`tutorial-chapter-${chapter.no}`} className="flex items-baseline gap-2 border-b border-[var(--crs-line)] pb-1.5 text-[14px] font-black">
                <span className="tabular-nums text-[var(--theme-accent-text)]">{String(chapter.no).padStart(2, '0')}</span>{chapter.title}
              </h3>
              <ul className="mt-1.5 space-y-0.5">
                {chapter.items.map(([no, title]) => {
                  const tutorial = tutorialById(no);
                  const usable = Boolean(tutorial && (!tutorial.ledger || ledgerMode) && (tutorial.page !== 'classes' || classList));
                  const itemClass = 'group flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-[13.5px] font-bold outline-none transition-colors hover:bg-[var(--theme-accent-soft)] focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]';
                  const item = (
                    <>
                      <span className="w-8 shrink-0 tabular-nums text-[var(--theme-accent-text)]">{no}</span>
                      <span className="min-w-0 flex-1">{title}</span>
                      <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-[var(--theme-accent-text)]">시작<Icon name="chevronRight" size={14} /></span>
                    </>
                  );
                  return (
                    <li key={no}>
                      {usable && tutorial?.page ? (
                        // Runs on another page: the link goes there and the tutorial starts on arrival.
                        <a href={TUTORIAL_PAGE_HREF[tutorial.page]} onClick={() => queueTutorial(no)} aria-label={`${no} ${title} 튜토리얼 시작`} className={itemClass}>{item}</a>
                      ) : usable ? (
                        <button type="button" onClick={() => onStart(no)} aria-label={`${no} ${title} 튜토리얼 시작`} className={itemClass}>{item}</button>
                      ) : (
                        <div className={cx('flex items-center gap-2.5 px-2 py-1.5 text-[13.5px] text-[var(--theme-muted-text)]')}>
                          <span className="w-8 shrink-0 tabular-nums opacity-70">{no}</span>
                          <span className="min-w-0 flex-1">{title}</span>
                          <span className="shrink-0 rounded-full bg-[var(--crs-subtle)] px-2 py-0.5 text-[11px] font-semibold">{tutorial ? '이 학급에서는 안 돼요' : '준비 중'}</span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}
