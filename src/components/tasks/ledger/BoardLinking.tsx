'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { BOARD_FORMAT_LABELS, boardActionText, type BoardChoiceDto, type BoardLinkStatusDto } from '@/lib/boardLinkApi';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Button, Callout, Icon, SegmentedControl, Select, cx } from '../../ui';
import { boardLinkClient } from './ledgerClient';
import { runWrite } from './useTaskBoard';
import type { TaskLedger } from './useTaskLedger';

// 딴쌤 보드 in a task's 연결 (ddanssaem-hub/docs/app-links.md 8): the teacher picks one of their boards (and one
// group of a group board); a student's public post or submission there then makes 미완료 into 완료 가능.

export type BoardPick = Readonly<{ boardId: string; groupId: string | null }>;
export type LinkProvider = 'board' | 'padlet';

const BOARD_ERRORS: Readonly<Record<string, string>> = {
  NOT_FOUND: '보드를 찾지 못했어요. 보드가 지워졌거나 관리할 수 없는 보드예요.',
  FORBIDDEN: '보드를 만든 선생님만 명단을 학급과 연결할 수 있어요.',
  LINKED_ELSEWHERE: '이 보드는 다른 학급 명단과 연결됐어요.',
  RATE_LIMITED: '딴쌤 보드가 잠시 바빠요.',
  TIMEOUT: '딴쌤 보드가 늦게 답했어요.',
  UNAVAILABLE: '딴쌤 보드에 연결하지 못했어요.',
};

export function useBoardLinkStatus() {
  const [status, setStatus] = useState<BoardLinkStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setLoading(true);
    const result = await boardLinkClient.status();
    setLoading(false);
    if (result.ok) { setStatus(result.data); setError(''); } else setError(result.error);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void boardLinkClient.status().then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result.ok) setStatus(result.data); else setError(result.error);
    });
    return () => { cancelled = true; };
  }, []);
  return { status, loading, error, reload };
}

/** [딴쌤 보드] or [패들렛]: the kind of link, when the class can link boards. */
export function LinkProviderChoice({ value, onChange, disabled }: Readonly<{ value: LinkProvider; onChange: (value: LinkProvider) => void; disabled?: boolean }>) {
  return (
    <div data-tour="link-provider">
      <SegmentedControl<LinkProvider> ariaLabel="연결할 곳" value={value} onChange={(next) => { if (!disabled) onChange(next); }}
        options={[{ value: 'board', label: '딴쌤 보드' }, { value: 'padlet', label: '패들렛' }]} />
    </div>
  );
}

function boardNote(board: BoardChoiceDto): string {
  if (board.linkedHere) return '이 학급 명단';
  if (board.linkedClassId) return '다른 학급과 연결됨';
  return '명단 연결 전';
}

/** The teacher's boards; a board linked to another class's roster cannot be picked. */
export function BoardPicker({ boards, pick, onPick, disabled, className = '' }: Readonly<{
  boards: readonly BoardChoiceDto[]; pick: BoardPick | null; onPick: (pick: BoardPick) => void; disabled?: boolean; className?: string;
}>) {
  const name = useId();
  const chosen = pick ? boards.find((board) => board.id === pick.boardId) ?? null : null;
  if (boards.length === 0) {
    return <p className="rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-5 text-center text-[13px] text-[var(--theme-muted-text)]">아직 만든 딴쌤 보드가 없어요. 딴쌤 보드에서 보드를 만든 뒤 다시 불러와 주세요.</p>;
  }
  return (
    <div className={cx('space-y-3', className)} data-tour="board-picker">
      <div role="radiogroup" aria-label="연결할 보드" className="grid gap-2">
        {boards.map((board) => {
          const selected = pick?.boardId === board.id;
          return (
            <label key={board.id} className={cx('flex items-center gap-3 rounded-[12px] border px-3.5 py-2.5',
              !board.selectable ? 'cursor-not-allowed border-[var(--crs-line)] opacity-50'
                : selected ? 'cursor-pointer border-[var(--theme-accent-text)] bg-[var(--theme-accent-soft)]' : 'cursor-pointer border-[var(--crs-line)] hover:border-[var(--crs-line-strong)]')}>
              <input type="radio" name={name} value={board.id} checked={selected} disabled={disabled || !board.selectable}
                aria-label={`${board.title}, ${BOARD_FORMAT_LABELS[board.format]}, ${boardNote(board)}`}
                onChange={() => onPick({ boardId: board.id, groupId: null })} className="accent-[var(--theme-accent-solid)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-bold">{board.title || '(제목 없는 보드)'}</span>
                <span className="block text-xs text-[var(--theme-muted-text)]">{BOARD_FORMAT_LABELS[board.format]}, {boardNote(board)}</span>
              </span>
            </label>
          );
        })}
      </div>
      {chosen && chosen.format === 'group' && chosen.groups.length > 0 ? (
        <label className="block text-[13px] font-bold">
          글을 셀 그룹
          <Select aria-label="글을 셀 그룹" value={pick?.groupId ?? ''} disabled={disabled} className="mt-1.5"
            onChange={(event) => onPick({ boardId: chosen.id, groupId: event.target.value || null })}>
            <option value="">보드 전체</option>
            {chosen.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </Select>
        </label>
      ) : null}
      {chosen && !chosen.linkedHere ? (
        <Callout tone="info" title="이 보드 명단을 이 학급과 연결해요">
          연결하면 이 학급 학생이 보드에 이름이나 QR 카드로 들어올 수 있고, 은행의 [보드 열기]로 바로 들어가요.
        </Callout>
      ) : null}
    </div>
  );
}

function readyCount(tasks: readonly AdminTaskDto[]): number {
  return tasks.reduce((sum, task) => sum + task.counts.READY, 0);
}

export function boardMovedText(before: number, after: number): string {
  return after > before ? ` 이미 있는 글로 ${after - before}명이 완료 가능이 됐어요.` : '';
}

export function boardErrorText(code: string | null | undefined): string {
  return code ? BOARD_ERRORS[code] ?? BOARD_ERRORS.UNAVAILABLE : '';
}

/** 딴쌤 보드 in one task's 연결 tab. */
export function BoardTaskTab({ ledger, task, notify, busy, onBusy, status }: Readonly<{
  ledger: TaskLedger; task: AdminTaskDto; notify: (message: string) => void; busy: boolean; onBusy: (busy: boolean) => void;
  status: ReturnType<typeof useBoardLinkStatus>;
}>) {
  const { board } = ledger;
  const link = task.board ?? null;
  const [changing, setChanging] = useState(false);
  const [pick, setPick] = useState<BoardPick | null>(null);
  const [action, setAction] = useState<'link' | 'unlink' | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [error, setError] = useState('');

  async function connect() {
    if (!pick || busy) return;
    const before = task.counts.READY;
    const chosen = status.status?.boards.find((item) => item.id === pick.boardId);
    setAction('link'); onBusy(true); setError('');
    const result = await runWrite(board, () => boardLinkClient.link({ taskIds: [task.taskId], boardId: pick.boardId, groupId: pick.groupId }));
    setAction(null); onBusy(false);
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    setChanging(false); setPick(null);
    void status.reload();
    notify(`딴쌤 보드 ‘${chosen?.title || '보드'}’에 연결했어요.${boardMovedText(before, readyCount(result.data))}`);
  }

  async function unlink() {
    if (busy) return;
    setAction('unlink'); onBusy(true); setError('');
    const result = await runWrite(board, () => boardLinkClient.unlink([task.taskId]));
    setAction(null); onBusy(false); setConfirmUnlink(false);
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    notify('딴쌤 보드 연결을 끊었어요. 이미 바뀐 단계는 그대로예요.');
  }

  if (link && !changing) {
    return (
      <div className="space-y-5" data-testid="board-linked">
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <section data-tour="board-linked-board" className="space-y-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] p-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--theme-accent-soft)] text-[var(--theme-accent-text)]"><Icon name="link" size={18} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-[var(--theme-muted-text)]">연결된 딴쌤 보드</p>
              <p className="break-words text-[15px] font-extrabold leading-snug">{link.boardTitle || '(제목 없는 보드)'}</p>
              <p className="mt-0.5 text-xs text-[var(--theme-muted-text)]">
                {link.groupName ? `‘${link.groupName}’ 그룹에서 ` : ''}학생이 {boardActionText(link.boardFormat)} 완료 가능이 돼요.
              </p>
            </div>
          </div>
          {link.error ? <p className="text-xs font-semibold text-[var(--crs-warning-text)]">{boardErrorText(link.error)} 조금 뒤에 다시 확인해요.</p>
            : <p className="text-xs text-[var(--theme-muted-text)]">{link.lastReadAt ? '목록을 열거나 학생이 은행을 볼 때 보드를 확인해요.' : '아직 확인 전이에요.'}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" data-tour="board-change" disabled={busy} onClick={() => { setChanging(true); setConfirmUnlink(false); }}>다른 보드로 바꾸기</Button>
            {confirmUnlink ? (
              <span className="ml-auto flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-[var(--theme-muted-text)]">이미 바뀐 단계는 그대로 남아요.</span>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmUnlink(false)}>취소</Button>
                <Button size="sm" variant="danger" loading={action === 'unlink'} disabled={busy} onClick={() => void unlink()}>연결 끊기</Button>
              </span>
            ) : (
              <Button size="sm" variant="dangerGhost" className="ml-auto" disabled={busy} onClick={() => setConfirmUnlink(true)}>연결 끊기</Button>
            )}
          </div>
        </section>
        <BoardRules />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="board-link-form">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {link ? (
        <Callout tone="info" title="다른 보드로 바꿔요">지금은 ‘{link.boardTitle || '보드'}’에 연결돼 있어요. 바꿔도 이미 바뀐 단계는 그대로예요.</Callout>
      ) : task.padlet ? (
        <Callout tone="info" title="패들렛 연결이 바뀌어요">딴쌤 보드에 연결하면 지금 연결된 패들렛 ‘{task.padlet.boardTitle || '게시판'}’ 연결은 끊겨요.</Callout>
      ) : (
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">딴쌤 보드를 연결하면, 학생이 보드에 글을 올리거나 제출했을 때 과제가 저절로 ‘완료 가능’이 돼요.</p>
      )}
      <BoardList status={status} pick={pick} onPick={setPick} disabled={busy} />
      <BoardRules />
      <div className="flex flex-wrap justify-end gap-2">
        {link ? <Button variant="ghost" disabled={busy} onClick={() => { setChanging(false); setPick(null); setError(''); }}>취소</Button> : null}
        <Button variant="primary" icon="link" data-tour="board-connect" loading={action === 'link'} disabled={!pick || busy} onClick={() => void connect()}>
          이 보드에 연결
        </Button>
      </div>
    </div>
  );
}

/** The board list with its loading and error states. */
export function BoardList({ status, pick, onPick, disabled }: Readonly<{
  status: ReturnType<typeof useBoardLinkStatus>; pick: BoardPick | null; onPick: (pick: BoardPick) => void; disabled?: boolean;
}>) {
  if (!status.status) {
    return status.loading ? (
      <p role="status" className="text-[13px] font-semibold text-[var(--theme-muted-text)]">딴쌤 보드 목록을 불러오는 중이에요.</p>
    ) : (
      <Callout tone="danger" title="딴쌤 보드 목록을 불러오지 못했어요">
        <p>{status.error}</p>
        <Button size="sm" icon="refresh" className="mt-2.5" onClick={() => void status.reload()}>다시 불러오기</Button>
      </Callout>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-bold">내 딴쌤 보드</p>
        <Button size="sm" variant="ghost" icon="refresh" disabled={disabled || status.loading} onClick={() => void status.reload()}>새로고침</Button>
      </div>
      <BoardPicker boards={status.status.boards} pick={pick} onPick={onPick} disabled={disabled} />
    </div>
  );
}

export function BoardRules() {
  return (
    <ul data-tour="board-rules" className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-[var(--theme-muted-text)]">
      <li>과제를 받은 뒤 학생이 보드에 올린 공개된 글만 세요. 승인 대기 글은 승인되면 그때 세요.</li>
      <li>퀴즈와 설문 보드는 제출을 세요. 글이나 제출 하나는 과제 하나에만 한 번 쓰여요.</li>
      <li>학생은 은행의 과제에서 [보드 열기]를 누르면 따로 입장하지 않고 들어가요.</li>
    </ul>
  );
}
