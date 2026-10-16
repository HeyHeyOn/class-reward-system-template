'use client';

import { useMemo, useState } from 'react';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Button, Callout, Icon, Modal } from '../../ui';
import { selectedTasks, targetText, type BulkProps } from './BulkDialogs';
import { studentLabels, type LedgerStudent } from './LedgerParts';
import { boardLinkClient, ledgerClient, newOperationId, padletClient } from './ledgerClient';
import {
  PadletBoardPicker, PadletKeyBox, PadletLink, PadletPostList, PadletReadState, PadletRules, PadletSharingCallout,
  padletErrorText, usePadletStatus, type PickedBoard,
} from './PadletParts';
import { BoardList, BoardRules, boardMovedText, LinkProviderChoice, useBoardLinkStatus, type BoardPick, type LinkProvider } from './BoardLinking';
import { runWrite } from './useTaskBoard';
import type { TaskLedger } from './useTaskLedger';

function readyCount(tasks: readonly AdminTaskDto[]): number {
  return tasks.reduce((sum, task) => sum + task.counts.READY, 0);
}

function movedText(before: number, after: number): string {
  return after > before ? ` 이미 올라온 글로 ${after - before}명이 완료 가능이 됐어요.` : '';
}

const INTRO = '패들렛 게시판을 연결하면, 학생이 자기 이름으로 글을 올렸을 때 과제가 저절로 ‘완료 가능’이 돼요.';

/** The 패들렛 tab of one task: link a board, or see the linked one and what its posts did. */
export function PadletTaskTab({ ledger, task, students, notify, busy, onBusy }: {
  ledger: TaskLedger;
  task: AdminTaskDto;
  students: readonly LedgerStudent[];
  notify: (message: string) => void;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const { board } = ledger;
  const padlet = usePadletStatus();
  const [changing, setChanging] = useState(false);
  const [picked, setPicked] = useState<PickedBoard | null>(null);
  const [action, setAction] = useState<'link' | 'unlink' | 'sync' | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [readyBusy, setReadyBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const names = useMemo(() => studentLabels(students), [students]);
  const link = task.padlet ?? null;
  const boardStatus = link ? padlet.status?.boards.find((item) => item.boardId === link.boardId) ?? null : null;
  // The open tab's status request and the regular task-board poll can finish at different times.
  const statusIsNewer = padlet.status && (!board.now || Date.parse(padlet.status.now) >= Date.parse(board.now));
  const readState = boardStatus && statusIsNewer
    ? { lastReadAt: boardStatus.succeededAt, error: boardStatus.error, checking: boardStatus.checking, retryAt: boardStatus.retryAt }
    : link;
  const key = padlet.status?.key ?? null;
  const keyReady = Boolean(key?.saved && key.readable);
  const sharing = picked
    ? [task, ...board.tasks.filter((other) => other.taskId !== task.taskId && other.padlet?.boardId === picked.preview.boardId)]
    : link ? board.tasks.filter((other) => other.padlet?.boardId === link.boardId) : [];

  async function run<T>(kind: 'link' | 'unlink' | 'sync', work: () => Promise<T>): Promise<T> {
    setAction(kind); onBusy(true); setError('');
    try {
      return await work();
    } finally {
      setAction(null); onBusy(false);
    }
  }

  async function connect() {
    if (!picked || busy) return;
    const before = task.counts.READY;
    const result = await run('link', () => runWrite(board, () => padletClient.link({ taskIds: [task.taskId], address: picked.address, sectionId: picked.sectionId })));
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    setChanging(false); setPicked(null);
    void padlet.reload();
    notify(`패들렛 ‘${picked.preview.title || '게시판'}’에 연결했어요.${movedText(before, readyCount(result.data))}`);
  }

  async function unlink() {
    if (busy) return;
    const result = await run('unlink', () => runWrite(board, () => padletClient.unlink([task.taskId])));
    setConfirmUnlink(false);
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    void padlet.reload();
    notify('패들렛 연결을 끊었어요. 이미 바뀐 단계는 그대로예요.');
  }

  async function syncNow() {
    if (busy) return;
    const before = task.counts.READY;
    await run('sync', () => runWrite(board, async () => {
      const result = await padletClient.sync();
      if (!result.ok) { setError(result.error); return result; }
      let status = result.data;
      let after = before;
      const fresh = await ledgerClient.board();
      if (fresh.ok) {
        board.applyTasks(fresh.data.tasks);
        after = fresh.data.tasks.find((item) => item.taskId === task.taskId)?.counts.READY ?? before;
        status = { ...status, now: fresh.data.now, boards: status.boards.map((item) => {
          const latest = fresh.data.tasks.find((candidate) => candidate.padlet?.boardId === item.boardId)?.padlet;
          return latest ? { ...item, succeededAt: latest.lastReadAt, error: latest.error as typeof item.error,
            checking: latest.checking, retryAt: latest.retryAt } : item;
        }) };
      }
      padlet.setStatus(status);
      const current = status.boards.find((item) => item.boardId === link?.boardId);
      notify(current?.checking ? '패들렛을 확인 중이에요. 결과를 기다려 주세요.'
        : current?.error ? padletErrorText(current.error) : `패들렛을 확인했어요.${movedText(before, after)}`);
      return result;
    }));
  }

  async function makeReady(studentId: string) {
    if (busy || readyBusy) return;
    setReadyBusy(studentId); setError('');
    const result = await runWrite(board, () => ledgerClient.stages({ operationId: newOperationId(), changes: [{ taskId: task.taskId, studentId, stage: 'READY' }] }));
    setReadyBusy(null);
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    notify(`${names.get(studentId) ?? studentId} 학생을 완료 가능으로 바꿨어요.`);
  }

  if (!padlet.status) {
    return padlet.loading ? (
      <div role="status" className="flex items-center gap-3 rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-4 text-[13px] font-semibold text-[var(--theme-muted-text)]">
        <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />패들렛 연결 정보를 불러오는 중이에요.
      </div>
    ) : (
      <Callout tone="danger" title="패들렛 연결 정보를 불러오지 못했어요">
        <p>{padlet.error}</p>
        <Button size="sm" icon="refresh" className="mt-2.5" onClick={() => void padlet.reload()}>다시 불러오기</Button>
      </Callout>
    );
  }

  const now = statusIsNewer ? padlet.status.now : board.now ?? padlet.status.now;
  const stageOf = (studentId: string) => task.students.find((row) => row.studentId === studentId)?.stage ?? 'UNASSIGNED';

  if (link && !changing) {
    return (
      <div className="space-y-5" data-testid="padlet-linked">
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <section data-tour="padlet-linked-board" className="space-y-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] p-4">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--theme-accent-soft,var(--crs-subtle))] text-[var(--theme-accent-text)]"><Icon name="link" size={18} /></span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold text-[var(--theme-muted-text)]">연결된 패들렛</p>
              <p className="break-words text-[15px] font-extrabold leading-snug">{link.boardTitle || '(제목 없는 게시판)'}</p>
              <p className="mt-0.5 text-xs text-[var(--theme-muted-text)]">{link.sectionTitle ? `‘${link.sectionTitle}’ 칸에 올린 글만 세요.` : '게시판 전체의 글을 세요.'}</p>
            </div>
            <PadletLink href={link.boardUrl} label={`${link.boardTitle || '게시판'} 패들렛 열기`} className="shrink-0 text-[13px]">열기</PadletLink>
          </div>
          <PadletReadState lastReadAt={readState?.lastReadAt ?? null} error={readState?.error ?? null}
            checking={action === 'sync' || readState?.checking} retryAt={readState?.retryAt} now={now} />
          {key && !keyReady ? <PadletKeyBox keyStatus={key} onChange={padlet.setStatus} disabled={busy} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon="refresh" data-tour="padlet-sync" loading={action === 'sync'} disabled={busy} onClick={() => void syncNow()}>지금 확인</Button>
            <Button size="sm" variant="ghost" data-tour="padlet-change" disabled={busy} onClick={() => { setChanging(true); setConfirmUnlink(false); }}>다른 게시판으로 바꾸기</Button>
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
          <p className="text-xs text-[var(--theme-muted-text)]">‘지금 확인’은 이 학급의 모든 연결 게시판을 확인해요. 이미 확인 중이거나 요청 제한을 기다리는 게시판은 중복 요청하지 않아요.</p>
        </section>
        <PadletSharingCallout tasks={sharing} />
        <PadletRules />
        <section aria-labelledby="padlet-posts-heading">
          <h3 id="padlet-posts-heading" className="mb-2 text-[14px] font-extrabold">최근 글</h3>
          <PadletPostList posts={boardStatus?.posts ?? []} taskId={task.taskId} now={now} stageOf={stageOf}
            busyStudentId={readyBusy} onMakeReady={(studentId) => void makeReady(studentId)} />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="padlet-link-form">
      {error ? <Callout tone="danger">{error}</Callout> : null}
      {link ? (
        <Callout tone="info" title="다른 게시판으로 바꿔요">지금은 ‘{link.boardTitle || '게시판'}’에 연결돼 있어요. 바꿔도 이미 바뀐 단계는 그대로예요.</Callout>
      ) : (
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{INTRO}</p>
      )}
      {key ? <PadletKeyBox keyStatus={key} onChange={padlet.setStatus} disabled={busy} /> : null}
      {keyReady ? <PadletBoardPicker picked={picked} onPick={setPicked} disabled={busy} /> : null}
      {picked ? <PadletSharingCallout tasks={sharing} /> : null}
      <PadletRules />
      <div className="flex flex-wrap justify-end gap-2">
        {link ? <Button variant="ghost" disabled={busy} onClick={() => { setChanging(false); setPicked(null); setError(''); }}>취소</Button> : null}
        <Button variant="primary" icon="link" data-tour="padlet-connect" loading={action === 'link'} disabled={!picked || !keyReady || busy} onClick={() => void connect()}>
          이 게시판에 연결
        </Button>
      </div>
    </div>
  );
}

/** 연결 for the selected tasks: link them all to one 딴쌤 board or one Padlet board, or unlink the linked ones. */
export function BulkPadletDialog(props: BulkProps) {
  const boards = useBoardLinkStatus();
  const [chosen, setChosen] = useState<LinkProvider | null>(null);
  const enabled = boards.status?.enabled === true;
  const provider: LinkProvider = enabled ? chosen ?? 'board' : 'padlet';
  return provider === 'board'
    ? <BulkBoardDialog {...props} boards={boards} onProvider={setChosen} />
    : <BulkPadletOnlyDialog {...props} providerChoice={enabled ? <LinkProviderChoice value="padlet" onChange={setChosen} /> : null} />;
}

/** 딴쌤 보드 for the selected tasks. */
function BulkBoardDialog({ ledger, taskIds, opener, notify, boards, onProvider }: BulkProps & {
  boards: ReturnType<typeof useBoardLinkStatus>; onProvider: (provider: LinkProvider) => void;
}) {
  const { board } = ledger;
  const tasks = selectedTasks(ledger, taskIds);
  const [pick, setPick] = useState<BoardPick | null>(null);
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [error, setError] = useState('');
  const linked = tasks.filter((task) => task.board);
  const moving = tasks.filter((task) => task.padlet || (task.board && pick && (task.board.boardId !== pick.boardId || task.board.groupId !== pick.groupId)));
  const chosen = pick ? boards.status?.boards.find((item) => item.id === pick.boardId) : undefined;

  async function connect() {
    if (!pick || busy || tasks.length === 0) return;
    const before = readyCount(tasks);
    setBusy('link'); setError('');
    const result = await runWrite(board, () => boardLinkClient.link({ taskIds: tasks.map((task) => task.taskId), boardId: pick.boardId, groupId: pick.groupId }));
    setBusy(null);
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    ledger.close();
    notify(`과제 ${result.data.length}개를 딴쌤 보드 ‘${chosen?.title || '보드'}’에 연결했어요.${boardMovedText(before, readyCount(result.data))}`);
  }

  async function unlink() {
    if (busy || linked.length === 0) return;
    setBusy('unlink'); setError('');
    const result = await runWrite(board, () => boardLinkClient.unlink(linked.map((task) => task.taskId)));
    setBusy(null);
    if (!result.ok) { setError(result.error); setConfirmUnlink(false); return; }
    board.applyTasks(result.data);
    ledger.close();
    notify(`과제 ${linked.length}개의 딴쌤 보드 연결을 끊었어요. 이미 바뀐 단계는 그대로예요.`);
  }

  return (
    <Modal title="선택한 과제 연결" ariaLabel="선택 과제 연결" description={`대상: ${targetText(tasks)}`} size="lg" opener={opener}
      busy={busy !== null} onClose={ledger.close}
      footer={<>
        {linked.length > 0 ? (
          confirmUnlink ? (
            <span className="mr-auto flex items-center gap-1.5">
              <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmUnlink(false)}>그대로 두기</Button>
              <Button variant="danger" loading={busy === 'unlink'} disabled={busy !== null} onClick={() => void unlink()}>{linked.length}개 연결 끊기</Button>
            </span>
          ) : (
            <Button variant="dangerGhost" className="mr-auto" disabled={busy !== null} onClick={() => setConfirmUnlink(true)}>연결 끊기({linked.length}개)</Button>
          )
        ) : null}
        <Button variant="ghost" disabled={busy !== null} onClick={ledger.close}>취소</Button>
        <Button variant="primary" icon="link" data-tour="board-bulk-connect" loading={busy === 'link'} disabled={!pick || busy !== null || tasks.length === 0}
          onClick={() => void connect()}>{tasks.length}개 연결</Button>
      </>}>
      <div className="space-y-5">
        <LinkProviderChoice value="board" onChange={onProvider} disabled={busy !== null} />
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">학생이 딴쌤 보드에 글을 올리거나 제출하면 과제가 저절로 ‘완료 가능’이 돼요. 고른 과제를 모두 같은 보드에 연결해요.</p>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <BoardList status={boards} pick={pick} onPick={setPick} disabled={busy !== null} />
        {moving.length > 0 ? (
          <Callout tone="warning" title={`이미 다른 곳에 연결된 과제 ${moving.length}개`}>
            연결하면 이 보드로 바뀌어요: {moving.map((task) => task.title).join(', ')}
          </Callout>
        ) : null}
        <BoardRules />
      </div>
    </Modal>
  );
}

/** 패들렛 for the selected tasks. */
function BulkPadletOnlyDialog({ ledger, taskIds, opener, notify, providerChoice }: BulkProps & { providerChoice: React.ReactNode }) {
  const { board } = ledger;
  const tasks = selectedTasks(ledger, taskIds);
  const padlet = usePadletStatus();
  const [picked, setPicked] = useState<PickedBoard | null>(null);
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [error, setError] = useState('');
  const linked = tasks.filter((task) => task.padlet);
  const moving = (picked ? linked.filter((task) => task.padlet?.boardId !== picked.preview.boardId) : linked).concat(tasks.filter((task) => task.board));
  const key = padlet.status?.key ?? null;
  const keyReady = Boolean(key?.saved && key.readable);
  const sharing = picked
    ? [...tasks, ...board.tasks.filter((task) => !taskIds.includes(task.taskId) && task.padlet?.boardId === picked.preview.boardId)]
    : tasks;

  async function connect() {
    if (!picked || busy || tasks.length === 0) return;
    const before = readyCount(tasks);
    setBusy('link'); setError('');
    const result = await runWrite(board, () => padletClient.link({ taskIds: tasks.map((task) => task.taskId), address: picked.address, sectionId: picked.sectionId }));
    setBusy(null);
    if (!result.ok) { setError(result.error); return; }
    board.applyTasks(result.data);
    ledger.close();
    notify(`과제 ${result.data.length}개를 패들렛 ‘${picked.preview.title || '게시판'}’에 연결했어요.${movedText(before, readyCount(result.data))}`);
  }

  async function unlink() {
    if (busy || linked.length === 0) return;
    setBusy('unlink'); setError('');
    const result = await runWrite(board, () => padletClient.unlink(linked.map((task) => task.taskId)));
    setBusy(null);
    if (!result.ok) { setError(result.error); setConfirmUnlink(false); return; }
    board.applyTasks(result.data);
    ledger.close();
    notify(`과제 ${linked.length}개의 패들렛 연결을 끊었어요. 이미 바뀐 단계는 그대로예요.`);
  }

  return (
    <Modal title="선택한 과제 연결" ariaLabel="선택 과제 연결" description={`대상: ${targetText(tasks)}`} size="lg" opener={opener}
      busy={busy !== null} onClose={ledger.close}
      footer={<>
        {linked.length > 0 ? (
          confirmUnlink ? (
            <span className="mr-auto flex items-center gap-1.5">
              <Button variant="ghost" disabled={busy !== null} onClick={() => setConfirmUnlink(false)}>그대로 두기</Button>
              <Button variant="danger" loading={busy === 'unlink'} disabled={busy !== null} onClick={() => void unlink()}>{linked.length}개 연결 끊기</Button>
            </span>
          ) : (
            <Button variant="dangerGhost" className="mr-auto" disabled={busy !== null} onClick={() => setConfirmUnlink(true)}>연결 끊기({linked.length}개)</Button>
          )
        ) : null}
        <Button variant="ghost" disabled={busy !== null} onClick={ledger.close}>취소</Button>
        <Button variant="primary" icon="link" data-tour="padlet-bulk-connect" loading={busy === 'link'} disabled={!picked || !keyReady || busy !== null || tasks.length === 0}
          onClick={() => void connect()}>{tasks.length}개 연결</Button>
      </>}>
      <div className="space-y-5">
        {providerChoice}
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">{INTRO} 고른 과제를 모두 같은 게시판에 연결해요.</p>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {!padlet.status ? (
          padlet.loading ? <p role="status" className="text-[13px] font-semibold text-[var(--theme-muted-text)]">패들렛 연결 정보를 불러오는 중이에요.</p> : (
            <Callout tone="danger" title="패들렛 연결 정보를 불러오지 못했어요">
              <p>{padlet.error}</p>
              <Button size="sm" icon="refresh" className="mt-2.5" onClick={() => void padlet.reload()}>다시 불러오기</Button>
            </Callout>
          )
        ) : (
          <>
            {key ? <PadletKeyBox keyStatus={key} onChange={padlet.setStatus} disabled={busy !== null} /> : null}
            {keyReady ? <PadletBoardPicker picked={picked} onPick={setPicked} disabled={busy !== null} /> : null}
          </>
        )}
        {moving.length > 0 ? (
          <Callout tone="warning" title={`이미 다른 게시판에 연결된 과제 ${moving.length}개`}>
            {picked ? '이 게시판으로 바뀌어요' : '연결하면 새 게시판으로 바뀌어요'}: {moving.map((task) => task.title).join(', ')}
          </Callout>
        ) : null}
        <PadletSharingCallout tasks={sharing} />
        <PadletRules />
      </div>
    </Modal>
  );
}
