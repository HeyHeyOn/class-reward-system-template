'use client';

import type { MouseEvent } from 'react';
import { Button, Callout, Card, Icon, Modal, cx } from '../ui';
import { FIRST_TUTORIAL_ID, TUTORIAL_CHAPTERS, tutorialById, tutorialUsable, type TutorialPlace } from './tutorials';

const FIRST = tutorialById(FIRST_TUTORIAL_ID);

/** Home tab block: the first-time tour, and the list of tutorials. */
export function TutorialHomeCard({ onFirst, onOpen }: {
  onFirst: () => void;
  onOpen: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Card data-testid="tutorial-home-card" className="flex flex-wrap items-center gap-4">
      <span aria-hidden="true" className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]">
        <Icon name="sparkle" size={24} />
      </span>
      <div className="min-w-0 flex-1 basis-60">
        <h2 className="text-[17px] font-black tracking-[-0.02em]">튜토리얼</h2>
        <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
          CRS가 처음이라면 <b className="font-bold text-[var(--theme-text)]">처음 시작하기</b>로 꼭 필요한 화면을 한 바퀴 둘러보세요.
          기능마다 튜토리얼을 고르면 이 화면에서 누를 곳과 적을 곳을 한 단계씩 짚어 드려요.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon="sparkle" onClick={onFirst}>처음 시작하기</Button>
        <Button variant="secondary" onClick={onOpen}>튜토리얼 목록</Button>
      </div>
    </Card>
  );
}

/** The guide's table of contents; sections with a tutorial can be started. The first-time tour comes first. */
export function TutorialMenu({ opener, place, onClose, onStart }: {
  opener: HTMLElement | null;
  place: TutorialPlace;
  onClose: () => void;
  onStart: (id: string) => void;
}) {
  return (
    <Modal title="튜토리얼" ariaLabel="튜토리얼 고르기" description="배우고 싶은 기능을 고르세요. 실제 화면에서 메뉴부터 한 단계씩 안내해요." size="xl" opener={opener} onClose={onClose}>
      <div className="space-y-5">
        {FIRST ? (
          <button type="button" onClick={() => onStart(FIRST.id)} aria-label={`${FIRST.id} ${FIRST.title} 튜토리얼 시작`}
            className="flex w-full items-center gap-4 rounded-[16px] border border-[color-mix(in_srgb,var(--theme-accent-text)_35%,transparent)] bg-[var(--theme-accent-soft)] px-4 py-3.5 text-left outline-none transition-colors hover:border-[var(--theme-accent-text)] focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
            <span aria-hidden="true" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)]"><Icon name="sparkle" size={22} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-bold text-[var(--theme-accent-text)]">처음이라면 여기부터</span>
              <span className="block text-[16px] font-black tracking-[-0.02em]">{FIRST.title}</span>
              <span className="mt-0.5 block text-[12.5px] leading-relaxed text-[var(--theme-muted-text)]">{FIRST.goal}</span>
            </span>
            <span className="flex shrink-0 items-center gap-0.5 text-[13px] font-bold text-[var(--theme-accent-text)]">시작<Icon name="chevronRight" size={15} /></span>
          </button>
        ) : null}
        <Callout tone="info">
          기능별 튜토리얼을 따라 입력하고 저장한 내용은 <b>실제로 반영</b>돼요. 언제든 <b>끝내기</b>(또는 Esc)로 멈추고, <b>다음</b>으로 건너뛸 수 있어요.
        </Callout>
        <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2">
          {TUTORIAL_CHAPTERS.filter((chapter) => chapter.items.every(([no]) => no !== FIRST_TUTORIAL_ID)).map((chapter) => (
            <section key={chapter.no} aria-labelledby={`tutorial-chapter-${chapter.no}`}>
              <h3 id={`tutorial-chapter-${chapter.no}`} className="flex items-baseline gap-2 border-b border-[var(--crs-line)] pb-1.5 text-[14px] font-black">
                <span className="tabular-nums text-[var(--theme-accent-text)]">{String(chapter.no).padStart(2, '0')}</span>{chapter.title}
              </h3>
              <ul className="mt-1.5 space-y-0.5">
                {chapter.items.map(([no, title]) => {
                  const tutorial = tutorialById(no);
                  const usable = Boolean(tutorial && tutorialUsable(tutorial, place));
                  return (
                    <li key={no}>
                      {usable ? (
                        <button type="button" onClick={() => onStart(no)} aria-label={`${no} ${title} 튜토리얼 시작`}
                          className="group flex w-full items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left text-[13.5px] font-bold outline-none transition-colors hover:bg-[var(--theme-accent-soft)] focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
                          <span className="w-8 shrink-0 tabular-nums text-[var(--theme-accent-text)]">{no}</span>
                          <span className="min-w-0 flex-1">{title}</span>
                          <span className="flex shrink-0 items-center gap-0.5 text-[12px] text-[var(--theme-accent-text)]">시작<Icon name="chevronRight" size={14} /></span>
                        </button>
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
