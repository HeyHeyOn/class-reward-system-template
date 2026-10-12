'use client';

import { useState } from 'react';
import {
  Badge, Button, Callout, Card, CardHeader, Checkbox, EmptyState, Icon, IconButton, PageHeader, ProgressBar, SearchInput,
  SegmentedControl, SelectionBar, SelectionBarButton, cx, type IconName,
} from '../../ui';
import { BulkDeleteDialog, BulkRepeatDialog, BulkResetDialog, BulkStagesDialog } from './BulkDialogs';
import { StageCounts, type LedgerStudent } from './LedgerParts';
import { formatInstant, holderCount, money, recurrenceSummary, resetStageSummary, sortTasks, taskStatus } from './ledgerFormat';
import { NewTaskSheet } from './NewTaskSheet';
import { BulkPadletDialog } from './PadletLinking';
import { padletErrorLabel } from './PadletParts';
import { QrStageDialog } from './QrStageDialog';
import { TaskEditSheet } from './TaskEditSheet';
import type { TaskLedger } from './useTaskLedger';

type Filter = 'all' | 'active' | 'hidden';

/** The 과제 tab of a PostgreSQL class: list, search, filter and the selection bar. Dialogs are in `TaskLedgerOverlays`. */
export function TaskLedgerPanel({ ledger, unit, notify }: { ledger: TaskLedger; unit: string; notify: (message: string) => void }) {
  const { board } = ledger;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const tasks = sortTasks(board.tasks);
  const needle = query.trim().toLowerCase();
  const visible = tasks.filter((task) => (filter === 'all' || (filter === 'active' ? task.isActive : !task.isActive))
    && (!needle || `${task.title} ${task.description}`.toLowerCase().includes(needle)));
  const selection = ledger.selection.filter((id) => tasks.some((task) => task.taskId === id));
  const allSelected = tasks.length > 0 && selection.length === tasks.length;

  async function refresh() {
    setRefreshing(true);
    const result = await board.reload();
    setRefreshing(false);
    if (!result.ok && result.error) notify(result.error);
  }

  function toggle(taskId: string) {
    ledger.setSelection((current) => current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]);
  }

  function meta(task: (typeof tasks)[number]): Array<{ icon: IconName; text: string; warn?: boolean }> {
    const parts: Array<{ icon: IconName; text: string; warn?: boolean }> = [];
    if (task.repeat.recurrence.type !== 'NONE') {
      parts.push({ icon: 'repeat', text: `${recurrenceSummary(task.repeat.recurrence)} · ${resetStageSummary(task.repeat.resetStage)}${task.repeat.nextResetAt ? ` · 다음 ${formatInstant(task.repeat.nextResetAt, board.now)}` : ''}` });
    }
    if (task.availableFrom && task.dueAt) parts.push({ icon: 'calendar', text: `${formatInstant(task.availableFrom, board.now)} ~ ${formatInstant(task.dueAt, board.now)}` });
    else if (task.dueAt) parts.push({ icon: 'calendar', text: `${formatInstant(task.dueAt, board.now)}까지` });
    else if (task.availableFrom) parts.push({ icon: 'calendar', text: `${formatInstant(task.availableFrom, board.now)}부터` });
    if (task.prerequisiteTaskId) {
      const prerequisite = board.tasks.find((candidate) => candidate.taskId === task.prerequisiteTaskId);
      parts.push({ icon: 'lock', text: `먼저: ${prerequisite?.title ?? '삭제된 과제'}` });
    }
    if (task.padlet) {
      if (task.padlet.checking) parts.push({ icon: 'refresh', text: '패들렛 확인 중' });
      parts.push(task.padlet.error ? { icon: 'alert', text: `패들렛${task.padlet.checking ? ' 이전 확인' : ''}: ${padletErrorLabel(task.padlet.error)}`, warn: true }
        : { icon: 'link', text: `패들렛: ${task.padlet.boardTitle || '게시판'}${task.padlet.sectionTitle ? ` · ${task.padlet.sectionTitle}` : ''}` });
      if (task.padlet.error || task.padlet.checking) {
        parts.push({ icon: 'link', text: task.padlet.lastReadAt ? `마지막 확인 성공 ${formatInstant(task.padlet.lastReadAt, board.now)}` : '아직 확인 성공 기록 없음' });
      }
      if (task.padlet.error === 'RATE_LIMITED' && task.padlet.retryAt && Date.parse(task.padlet.retryAt) > Date.parse(board.now ?? '')) {
        parts.push({ icon: 'clock', text: `${formatInstant(task.padlet.retryAt, board.now)} 이후 재확인` });
      }
    }
    return parts;
  }

  return (
    <section id="admin-panel-tasks" data-testid="task-panel" role="tabpanel" aria-labelledby="admin-tab-tasks" aria-label="과제" className="space-y-5">
      <PageHeader title="과제" description="학생마다 미부여 → 미완료 → 완료 가능 → 완료 단계로 관리해요. 과제를 누르면 내용, 반복, 학생 현황을 고칠 수 있어요."
        actions={<>
          <IconButton icon="refresh" label="과제 새로고침" variant="secondary" disabled={refreshing} onClick={() => void refresh()} />
          <Button icon="qr" data-tour="task-qr" onClick={(event) => ledger.open({ kind: 'qr', opener: event.currentTarget })}>QR로 단계 바꾸기</Button>
          <Button variant="primary" icon="plus" data-tour="task-new" onClick={(event) => ledger.open({ kind: 'new', opener: event.currentTarget })}>새 과제</Button>
        </>} />

      {board.status === 'loading' ? (
        <div role="status" aria-label="과제 불러오는 중" className="flex items-center gap-3 rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-4 text-[13px] font-semibold text-[var(--theme-muted-text)]">
          <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />과제를 불러오는 중이에요.
        </div>
      ) : board.status === 'error' ? (
        <Callout tone="danger" title="과제를 불러오지 못했어요">
          <p>{board.error}</p>
          <Button size="sm" icon="refresh" className="mt-2.5" disabled={refreshing} onClick={() => void refresh()}>다시 불러오기</Button>
        </Callout>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput value={query} onChange={setQuery} placeholder="과제 검색" ariaLabel="과제 검색" className="w-full sm:w-72" />
            <SegmentedControl<Filter> ariaLabel="과제 공개 상태 필터" value={filter} onChange={setFilter}
              options={[{ value: 'all', label: '전체', count: tasks.length }, { value: 'active', label: '공개', count: tasks.filter((task) => task.isActive).length },
                { value: 'hidden', label: '숨김', count: tasks.filter((task) => !task.isActive).length }]} />
          </div>
          {tasks.length === 0 ? (
            <EmptyState icon="task" title="첫 과제를 만들어 보세요" description="숙제, 청소 당번처럼 학생이 하고 보상을 받을 일을 과제로 등록해요."
              action={<Button variant="primary" icon="plus" data-tour="task-new" onClick={(event) => ledger.open({ kind: 'new', opener: event.currentTarget })}>새 과제</Button>} />
          ) : (
            <Card padded={false} className="overflow-hidden" data-testid="task-list-card">
              <div role="table" aria-label="과제 목록" className="divide-y divide-[var(--crs-line)]">
                <div role="row" className="grid grid-cols-[40px_minmax(0,1fr)_28px] items-center gap-3 bg-[var(--crs-subtle)] px-4 py-2.5 text-xs font-bold text-[var(--theme-muted-text)] md:grid-cols-[40px_minmax(0,1fr)_88px_210px_76px_28px] md:px-5">
                  <span role="columnheader" className="flex"><Checkbox aria-label="전체 과제 선택" checked={allSelected} onChange={(event) => ledger.setSelection(event.target.checked ? tasks.map((task) => task.taskId) : [])} /></span>
                  <span role="columnheader">과제</span>
                  <span role="columnheader" className="hidden text-right md:block">보상</span>
                  <span role="columnheader" className="hidden md:block">완료 단계</span>
                  <span role="columnheader" className="hidden md:block">상태</span>
                  <span role="columnheader" aria-hidden="true" />
                </div>
                {visible.map((task) => {
                  const status = taskStatus(task, board.now);
                  return (
                    <div role="row" data-testid="task-row" key={task.taskId} data-padlet={task.padlet ? '' : undefined}
                      className="group relative grid grid-cols-[40px_minmax(0,1fr)_28px] items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--crs-subtle)] md:grid-cols-[40px_minmax(0,1fr)_88px_210px_76px_28px] md:px-5">
                      <span role="cell" className="relative z-10 flex"><Checkbox aria-label={`${task.title} 선택`} checked={selection.includes(task.taskId)} onChange={() => toggle(task.taskId)} /></span>
                      <span role="cell" className="min-w-0">
                        <button type="button" aria-label={`${task.title} 과제 편집`} onClick={(event) => ledger.open({ kind: 'task', taskId: task.taskId, tab: 'basic', opener: event.currentTarget })}
                          className="block max-w-full truncate text-left text-[15px] font-bold outline-none after:absolute after:inset-0 after:content-[''] focus-visible:underline">
                          {task.title || '(이름 없음)'}
                        </button>
                        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--theme-muted-text)]">
                          <span className="md:hidden">{money(task.reward, unit)}</span>
                          {meta(task).map((item) => <span key={item.text} className={cx('inline-flex items-center gap-1', item.warn && 'font-semibold text-[var(--crs-warning-text)]')}><Icon name={item.icon} size={13} />{item.text}</span>)}
                          <span className="md:hidden"><Badge tone={status.tone}>{status.label}</Badge></span>
                        </span>
                        <span aria-hidden="true" className="mt-2 block md:hidden"><StageCounts task={task} className="block" /></span>
                      </span>
                      <span role="cell" className="hidden text-right text-[15px] font-extrabold tabular-nums md:block">{money(task.reward, unit)}</span>
                      <span role="cell" className="hidden md:block"><StageCounts task={task} className="block" /></span>
                      <span role="cell" className="hidden md:block"><Badge tone={status.tone} dot>{status.label}</Badge></span>
                      <span role="cell" aria-hidden="true" className="text-[var(--theme-muted-text)] opacity-0 transition-opacity group-hover:opacity-100"><Icon name="chevronRight" size={18} /></span>
                    </div>
                  );
                })}
                {visible.length === 0 ? <p className="px-5 py-10 text-center text-[13px] text-[var(--theme-muted-text)]">검색 결과가 없어요.</p> : null}
              </div>
            </Card>
          )}
        </>
      )}
      <SelectionBar count={selection.length} onClear={() => ledger.setSelection([])}>
        <SelectionBarButton icon="repeat" aria-label="선택 과제 반복 설정" onClick={(event) => ledger.open({ kind: 'bulk-repeat', taskIds: selection, opener: event.currentTarget })}>반복 설정</SelectionBarButton>
        <SelectionBarButton icon="users" aria-label="선택 과제 완료 단계" onClick={(event) => ledger.open({ kind: 'bulk-stages', taskIds: selection, opener: event.currentTarget })}>완료 단계</SelectionBarButton>
        <SelectionBarButton icon="link" aria-label="선택 과제 패들렛 연결" onClick={(event) => ledger.open({ kind: 'bulk-padlet', taskIds: selection, opener: event.currentTarget })}>패들렛</SelectionBarButton>
        <SelectionBarButton icon="restore" aria-label="선택 과제 지금 초기화" onClick={(event) => ledger.open({ kind: 'reset', taskIds: selection, opener: event.currentTarget })}>지금 초기화</SelectionBarButton>
        <SelectionBarButton icon="trash" danger aria-label="선택 과제 삭제" onClick={(event) => ledger.open({ kind: 'delete', taskIds: selection, opener: event.currentTarget })}>삭제</SelectionBarButton>
      </SelectionBar>
    </section>
  );
}

/** Everything the task screen opens on top of the page. Render it outside the page's inert background. */
export function TaskLedgerOverlays({ ledger, students, unit, notify, qrManualInputEnabled }: {
  ledger: TaskLedger;
  students: readonly LedgerStudent[];
  unit: string;
  notify: (message: string) => void;
  qrManualInputEnabled: boolean;
}) {
  const overlay = ledger.overlay;
  if (!overlay) return null;
  switch (overlay.kind) {
    case 'task':
      return <TaskEditSheet key={`task:${overlay.taskId}`} ledger={ledger} taskId={overlay.taskId} initialTab={overlay.tab} opener={overlay.opener} students={students} unit={unit} notify={notify} />;
    case 'new':
      return <NewTaskSheet ledger={ledger} opener={overlay.opener} students={students} unit={unit} notify={notify} />;
    case 'qr':
      return <QrStageDialog ledger={ledger} opener={overlay.opener} unit={unit} manualInputEnabled={qrManualInputEnabled} />;
    case 'bulk-repeat':
      return <BulkRepeatDialog ledger={ledger} taskIds={overlay.taskIds} opener={overlay.opener} notify={notify} />;
    case 'bulk-stages':
      return <BulkStagesDialog ledger={ledger} taskIds={overlay.taskIds} opener={overlay.opener} notify={notify} students={students} unit={unit} />;
    case 'bulk-padlet':
      return <BulkPadletDialog ledger={ledger} taskIds={overlay.taskIds} opener={overlay.opener} notify={notify} />;
    case 'reset':
      return <BulkResetDialog ledger={ledger} taskIds={overlay.taskIds} opener={overlay.opener} notify={notify} />;
    case 'delete':
      return <BulkDeleteDialog ledger={ledger} taskIds={overlay.taskIds} opener={overlay.opener} notify={notify} />;
    default:
      return null;
  }
}

/** Home tab card: how many students who have each active task finished it. */
export function TaskLedgerHomeCard({ ledger, onShowAll, onOpenTask }: {
  ledger: TaskLedger;
  onShowAll: () => void;
  onOpenTask: (taskId: string, opener: HTMLElement) => void;
}) {
  const { board } = ledger;
  const active = sortTasks(board.tasks).filter((task) => task.isActive);
  return (
    <Card data-tour="home-progress">
      <CardHeader title="과제 진행 현황" description="과제를 받은 학생 중 완료한 학생 수예요." actions={<Button size="sm" variant="ghost" iconRight="chevronRight" onClick={onShowAll}>전체 보기</Button>} />
      <div className="mt-4 divide-y divide-[var(--crs-line)]">
        {board.status === 'loading' ? <p role="status" className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">과제를 불러오는 중이에요.</p> : null}
        {board.status === 'error' ? <p className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">과제를 불러오지 못했어요.</p> : null}
        {active.slice(0, 6).map((task) => {
          const holders = holderCount(task);
          return (
            <button key={task.taskId} type="button" onClick={(event) => onOpenTask(task.taskId, event.currentTarget)}
              className="flex w-full items-center gap-4 py-3 text-left outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{task.title}</p>
                <div className="mt-2"><ProgressBar value={task.counts.COMPLETED} max={holders} label={`${task.title} 진행률`} /></div>
              </div>
              <span className="shrink-0 text-[13px] font-bold tabular-nums text-[var(--theme-muted-text)]">{task.counts.COMPLETED} / {holders}명</span>
            </button>
          );
        })}
        {board.status === 'ready' && active.length === 0 ? <p className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">진행 중인 과제가 없어요.</p> : null}
      </div>
    </Card>
  );
}

/** Active and total task counts for the home tab, or null while the board is not loaded yet. */
export function ledgerTaskSummary(ledger: TaskLedger): { active: number; total: number } | null {
  if (ledger.board.status !== 'ready') return null;
  return { active: ledger.board.tasks.filter((task) => task.isActive).length, total: ledger.board.tasks.length };
}
