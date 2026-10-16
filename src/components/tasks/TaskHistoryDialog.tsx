'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import {
  buildTaskHistoryView,
  studentLabel,
  type TaskHistoryCycleView,
  type TaskHistoryEntry,
  type TaskHistoryEntryKind,
  type TaskHistoryFilter,
  type TaskHistoryStudentRef,
  type TaskHistorySummary,
} from '../adminTaskHistory';
import { Badge, EmptyState, Icon, SearchInput, SegmentedControl, cx, type IconName } from '../ui';
import { focusRing } from '../ui/classes';
import { themeStyles, type ThemeColor } from '../uiTheme';

export type TaskHistoryDialogState = {
  taskId: string;
  title: string;
  loading: boolean;
  error: string;
  detail: TaskHistoryDetailDto | null;
};

type ToneName = 'info' | 'accent' | 'neutral' | 'success' | 'warning' | 'danger';

const TONE_CLASS: Record<ToneName, string> = {
  info: 'bg-[var(--crs-info-bg)] text-[var(--crs-info-text)]',
  accent: 'bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]',
  neutral: 'bg-[var(--crs-subtle-hover)] text-[var(--theme-muted-text)]',
  success: 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]',
  warning: 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]',
  danger: 'bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]',
};

const KIND_STYLE: Record<TaskHistoryEntryKind, { icon: IconName; tone: ToneName }> = {
  assign: { icon: 'plus', tone: 'info' },
  assignPending: { icon: 'clock', tone: 'info' },
  toPending: { icon: 'clock', tone: 'accent' },
  toReady: { icon: 'arrowRight', tone: 'accent' },
  unassign: { icon: 'minus', tone: 'neutral' },
  complete: { icon: 'check', tone: 'success' },
  adminComplete: { icon: 'check', tone: 'success' },
  reset: { icon: 'restore', tone: 'warning' },
  cancel: { icon: 'close', tone: 'danger' },
  other: { icon: 'info', tone: 'neutral' },
};

const FILTER_LABELS: Record<TaskHistoryFilter, string> = {
  all: '전체', assign: '부여', complete: '완료', reset: '초기화, 취소',
};

export function TaskHistoryDialog({
  history, onClose, opener = null, themeColor = 'white', currencyUnit = '원', now,
}: {
  history: TaskHistoryDialogState;
  onClose: () => void;
  opener?: HTMLElement | null;
  themeColor?: ThemeColor;
  /** The class currency unit for reward amounts. */
  currencyUnit?: string;
  /** Fixes "오늘/어제" labels in tests; defaults to the time the dialog opened. */
  now?: string;
}) {
  const semantic = themeStyles(themeColor);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [openedAt] = useState(() => new Date().toISOString());
  const [filter, setFilter] = useState<TaskHistoryFilter>('all');
  const [query, setQuery] = useState('');
  const [cycleToggles, setCycleToggles] = useState<Record<string, boolean>>({});
  const [openLists, setOpenLists] = useState<Record<string, boolean>>({});
  const today = now ?? openedAt;
  const detail = history.detail;
  const view = useMemo(
    () => detail ? buildTaskHistoryView(detail, { filter, query, now: today, currencyUnit }) : null,
    [detail, filter, query, today, currencyUnit],
  );
  const narrowed = filter !== 'all' || query.trim() !== '';
  const firstCycleKey = view?.sections[0]?.cycles[0]?.key ?? null;

  useEffect(() => {
    closeRef.current?.focus();
    return () => opener?.focus();
  }, [opener]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? []);
    if (controls.length === 0) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (controls.length === 1 || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  function changeFilter(next: TaskHistoryFilter) {
    setFilter(next);
    setCycleToggles({});
  }

  function changeQuery(next: string) {
    setQuery(next);
    setCycleToggles({});
  }

  const cycleOpen = (cycle: TaskHistoryCycleView) => cycleToggles[cycle.key] ?? (narrowed || cycle.key === firstCycleKey);
  const toggleCycle = (cycle: TaskHistoryCycleView) => setCycleToggles((current) => ({ ...current, [cycle.key]: !cycleOpen(cycle) }));
  const toggleList = (key: string) => setOpenLists((current) => ({ ...current, [key]: !current[key] }));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(15_23_42/0.42)] backdrop-blur-[2px] sm:items-center sm:p-4">
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-label="과제 기록" onKeyDown={handleKeyDown} style={semantic.variables} className={`flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-[22px] border ${semantic.border} ${semantic.surface} ${semantic.text} shadow-[var(--crs-shadow-lg)] sm:rounded-[22px]`}>
        <div className="flex items-start justify-between gap-3 border-b border-[var(--crs-line)] px-4 pb-4 pt-5 sm:px-6">
          <div className="min-w-0"><h2 className="text-lg font-black tracking-[-0.025em]">과제 기록</h2><p className={`mt-0.5 truncate text-[13px] ${semantic.mutedText}`}>{history.title} ({history.taskId})</p></div>
          <button ref={closeRef} type="button" aria-label="닫기" onClick={onClose} className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${semantic.mutedText} hover:bg-[var(--crs-subtle)] focus:outline-none focus:ring-2 ${semantic.ring}`}><Icon name="close" size={18} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          {history.loading ? <p role="status" aria-label="과제 기록 불러오는 중" className={`rounded-[14px] ${semantic.surfaceRaised} p-6 text-center text-sm font-semibold ${semantic.mutedText}`}>기록을 불러오는 중이에요.</p> : null}
          {history.error ? <p role="alert" className={`rounded-[14px] border ${semantic.border} ${semantic.surfaceRaised} p-4 text-sm font-semibold ${semantic.text}`}>{history.error}</p> : null}
          {detail && view && detail.cumulativeHistory.eventCount === 0 ? (
            <div className="space-y-4">
              {view.summary ? <SummaryCard summary={view.summary} /> : null}
              <EmptyState icon="history" title="아직 기록이 없어요" description="학생에게 과제를 부여하거나 학생이 과제를 완료하면 여기에 남아요." />
            </div>
          ) : null}
          {detail && view && detail.cumulativeHistory.eventCount > 0 ? (
            <div className="space-y-4">
              {view.summary ? <SummaryCard summary={view.summary} /> : null}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <SegmentedControl<TaskHistoryFilter> ariaLabel="기록 종류" size="sm" value={filter} onChange={changeFilter}
                  options={(Object.keys(FILTER_LABELS) as TaskHistoryFilter[]).map((value) => ({ value, label: FILTER_LABELS[value], count: view.counts[value] }))} />
                <SearchInput value={query} onChange={changeQuery} placeholder="학생 이름 검색" ariaLabel="학생 이름 검색" className="sm:w-56" />
              </div>
              {view.sections.length === 0 ? (
                <p role="status" className={`rounded-[14px] ${semantic.surfaceRaised} p-6 text-center text-sm font-semibold ${semantic.mutedText}`}>{narrowed ? '조건에 맞는 기록이 없어요.' : '보여 줄 기록이 없어요.'}</p>
              ) : view.sections.map((section) => (
                <section key={section.key} aria-label={section.title ?? '지금 과제 기록'} className="space-y-3">
                  {section.title ? (
                    <div className="pt-2">
                      <h3 className="text-sm font-black">{section.title}</h3>
                      {section.description ? <p className={`mt-0.5 text-xs ${semantic.mutedText}`}>{section.description}</p> : null}
                    </div>
                  ) : null}
                  {section.cycles.map((cycle) => view.singlePermanentCycle ? (
                    <CycleBody key={cycle.key} cycle={cycle} openLists={openLists} onToggleList={toggleList} />
                  ) : (
                    <CycleCard key={cycle.key} cycle={cycle} open={cycleOpen(cycle)} onToggle={() => toggleCycle(cycle)} headingLevel={section.title ? 4 : 3}>
                      <CycleBody cycle={cycle} openLists={openLists} onToggleList={toggleList} />
                    </CycleCard>
                  ))}
                </section>
              ))}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function SummaryCard({ summary }: { summary: TaskHistorySummary }) {
  return (
    <section aria-label={`${summary.label} 요약`} className="rounded-[14px] bg-[var(--crs-subtle)] px-4 py-3">
      <p className="text-[13px] font-bold">
        {summary.label}
        {summary.range ? <span className="font-semibold text-[var(--theme-muted-text)]">, {summary.range}</span> : null}
      </p>
      <dl className="mt-2 flex flex-wrap gap-2">
        <SummaryStat label="부여" value={summary.assigned} />
        <SummaryStat label="완료" value={summary.completed} />
        {summary.pending ? <SummaryStat label="미완료" value={summary.pending} /> : null}
      </dl>
    </section>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5 rounded-[10px] border border-[var(--crs-line)] bg-[var(--theme-surface)] px-3 py-1.5">
      <dt className="text-xs font-semibold text-[var(--theme-muted-text)]">{label}</dt>
      <dd className="text-[15px] font-black tabular-nums">{value.toLocaleString('ko-KR')}명</dd>
    </div>
  );
}

function CycleCard({ cycle, open, onToggle, headingLevel, children }: {
  cycle: TaskHistoryCycleView;
  open: boolean;
  onToggle: () => void;
  headingLevel: 3 | 4;
  children: React.ReactNode;
}) {
  const bodyId = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h4';
  return (
    <div className="overflow-hidden rounded-[14px] border border-[var(--crs-line)]">
      <Heading>
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
          className={cx('flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-[var(--crs-subtle-hover)]', focusRing, open && 'bg-[var(--crs-subtle)]')}>
          <Badge tone={cycle.isCurrent ? 'accent' : 'neutral'}>{cycle.label}</Badge>
          {cycle.range ? <span className="text-sm font-bold">{cycle.range}</span> : null}
          {cycle.scheduleChanged ? <Badge tone="warning">반복 설정 바뀜</Badge> : null}
          <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-[var(--theme-muted-text)]">
            {cycle.entryCount > 0 ? `기록 ${cycle.entryCount}건` : '변경 없음'}
            <Icon name="chevronDown" size={16} className={cx('transition-transform duration-150', open && 'rotate-180')} />
          </span>
        </button>
      </Heading>
      {open ? <div id={bodyId} className="border-t border-[var(--crs-line)] px-4 pb-2 pt-3">{children}</div> : null}
    </div>
  );
}

function CycleBody({ cycle, openLists, onToggleList }: {
  cycle: TaskHistoryCycleView;
  openLists: Record<string, boolean>;
  onToggleList: (key: string) => void;
}) {
  return (
    <div className="space-y-3">
      {cycle.seeded.length > 0 ? (
        <GroupNote icon="users" text={`과제를 만들 때 정한 대상 학생 ${cycle.seeded.length}명`} students={cycle.seeded}
          listKey={`${cycle.key}:seeded`} open={Boolean(openLists[`${cycle.key}:seeded`])} onToggle={onToggleList} />
      ) : null}
      {cycle.carried.length > 0 ? (
        <GroupNote icon="repeat" text={`지난 회차에서 이어진 학생 ${cycle.carried.length}명`} students={cycle.carried}
          listKey={`${cycle.key}:carried`} open={Boolean(openLists[`${cycle.key}:carried`])} onToggle={onToggleList} />
      ) : null}
      {cycle.days.map((day) => (
        <div key={day.key}>
          <p className="text-xs font-bold text-[var(--theme-muted-text)]">{day.label}</p>
          <ol className="mt-1 divide-y divide-[var(--crs-line)]">
            {day.entries.map((entry) => (
              <EntryRow key={entry.key} entry={entry} open={Boolean(openLists[entry.key])} onToggle={() => onToggleList(entry.key)} />
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function EntryRow({ entry, open, onToggle }: { entry: TaskHistoryEntry; open: boolean; onToggle: () => void }) {
  const listId = useId();
  const style = KIND_STYLE[entry.kind];
  return (
    <li data-testid="task-history-entry" data-kind={entry.kind} className="flex items-start gap-3 py-2.5">
      <span aria-hidden="true" className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full', TONE_CLASS[style.tone])}>
        <Icon name={style.icon} size={16} strokeWidth={2.2} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] leading-relaxed">
          {entry.before}<StudentNames students={entry.shownStudents} hiddenCount={entry.hiddenCount} />{entry.after}
        </p>
        {entry.hiddenCount > 0 ? (
          <>
            <button type="button" aria-expanded={open} aria-controls={listId} onClick={onToggle}
              className={cx('mt-0.5 rounded-[6px] text-xs font-bold text-[var(--theme-accent-text)] hover:underline', focusRing)}>
              {open ? '명단 접기' : `${entry.students.length}명 모두 보기`}
            </button>
            {open ? <p id={listId} className="mt-1 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{entry.students.map(studentLabel).join(', ')}</p> : null}
          </>
        ) : null}
      </div>
      <time dateTime={entry.occurredAt} className="shrink-0 pt-1 text-xs font-semibold tabular-nums text-[var(--theme-muted-text)]">{entry.time}</time>
    </li>
  );
}

function StudentNames({ students, hiddenCount }: { students: readonly TaskHistoryStudentRef[]; hiddenCount: number }) {
  return (
    <>
      {students.map((student, index) => (
        <span key={student.studentId}>
          {index > 0 ? ', ' : ''}
          {student.unknown ? <span className="font-semibold text-[var(--theme-muted-text)]">삭제된</span> : <strong className="font-extrabold">{student.name}</strong>}
          {!student.unknown && student.deleted ? <span className="text-[var(--theme-muted-text)]">(삭제됨)</span> : null}
        </span>
      ))}
      {' 학생'}
      {hiddenCount > 0 ? ` 외 ${hiddenCount}명` : ''}
    </>
  );
}

function GroupNote({ icon, text, students, listKey, open, onToggle }: {
  icon: IconName;
  text: string;
  students: readonly TaskHistoryStudentRef[];
  listKey: string;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const listId = useId();
  return (
    <div className="flex items-start gap-3 rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2.5">
      <span aria-hidden="true" className="mt-0.5 text-[var(--theme-muted-text)]"><Icon name={icon} size={16} /></span>
      <div className="min-w-0 flex-1 text-[13px]">
        <p className="font-semibold">{text}</p>
        <button type="button" aria-expanded={open} aria-controls={listId} onClick={() => onToggle(listKey)}
          className={cx('mt-0.5 rounded-[6px] text-xs font-bold text-[var(--theme-accent-text)] hover:underline', focusRing)}>
          {open ? '명단 접기' : '명단 보기'}
        </button>
        {open ? <p id={listId} className="mt-1 leading-relaxed text-[var(--theme-muted-text)]">{students.map(studentLabel).join(', ')}</p> : null}
      </div>
    </div>
  );
}
