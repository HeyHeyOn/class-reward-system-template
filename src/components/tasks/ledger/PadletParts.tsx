'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { padletTaskGroups } from '@/domain/padlet';
import {
  PADLET_ERROR_MESSAGES, type PadletBoardPreviewDto, type PadletErrorCode, type PadletKeyStatusDto, type PadletPostDto,
  type PadletStatusDto,
} from '@/lib/padletLinkApi';
import type { TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Badge, Button, Callout, Field, Icon, Input, cx, type Tone } from '../../ui';
import { padletClient } from './ledgerClient';
import { formatInstant } from './ledgerFormat';

/** Where a Padlet admin copies the API key (paid plans only). */
export const PADLET_KEY_PAGE = 'https://padlet.com/dashboard/settings/developers';

export function padletErrorText(code: string | null): string {
  if (!code) return '';
  return PADLET_ERROR_MESSAGES[code as PadletErrorCode] ?? PADLET_ERROR_MESSAGES.UNAVAILABLE;
}

export function padletErrorLabel(code: string): string {
  const labels: Record<PadletErrorCode, string> = {
    NO_KEY: 'API 키 필요', KEY_UNREADABLE: '저장된 키 확인 필요', INVALID_KEY: 'API 키 오류',
    NOT_PAYING: '유료 계정 필요', NOT_ADMIN: '게시판 관리 권한 필요', NOT_FOUND: '게시판 찾을 수 없음',
    RATE_LIMITED: '요청 제한', TIMEOUT: '응답 시간 초과', UNAVAILABLE: '연결 오류',
  };
  return labels[code as PadletErrorCode] ?? labels.UNAVAILABLE;
}

/** The class's Padlet key, linked boards and recent posts. Loaded when a Padlet screen opens. */
export function usePadletStatus() {
  const [status, setStatus] = useState<PadletStatusDto | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await padletClient.status();
    setLoading(false);
    if (result.ok) { setStatus(result.data); setError(''); } else setError(result.error);
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => { if (active) void reload(); });
    return () => { active = false; };
  }, [reload]);

  return { status, setStatus, error, loading, reload };
}

/** A link that opens Padlet in a new tab. */
export function PadletLink({ href, children, label, className }: { href: string; children: React.ReactNode; label?: string; className?: string }) {
  if (!/^https:\/\//.test(href)) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-label={label}
      className={cx('inline-flex items-center gap-1 font-bold text-[var(--theme-accent-text)] underline-offset-2 hover:underline', className)}>
      {children}<Icon name="external" size={13} />
    </a>
  );
}

/** The class's Padlet API key: asked for when missing, otherwise shown by its last four characters. */
export function PadletKeyBox({ keyStatus, onChange, disabled = false }: {
  keyStatus: PadletKeyStatusDto;
  onChange: (status: PadletStatusDto) => void;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const needsKey = !keyStatus.saved || !keyStatus.readable;

  async function save(next: string | null) {
    if (busy) return;
    setBusy(true); setError('');
    const result = await padletClient.setKey(next);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    setValue(''); setEditing(false); setConfirmRemove(false);
    onChange(result.data);
  }

  if (!needsKey && !editing) {
    return (
      <div data-tour="padlet-key" className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-[12px] bg-[var(--crs-subtle)] px-3.5 py-2 text-[13px]">
        <span className="inline-flex items-center gap-1.5 font-bold"><Icon name="lock" size={14} />Padlet API 키</span>
        <span className="font-semibold tabular-nums text-[var(--theme-muted-text)]">끝자리 {keyStatus.hint}</span>
        <span className="ml-auto flex items-center gap-1">
          {confirmRemove ? (
            <>
              <span className="text-xs font-semibold text-[var(--crs-danger-text)]">지우면 연결된 게시판을 더 읽지 못해요.</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>취소</Button>
              <Button size="sm" variant="danger" loading={busy} disabled={busy || disabled} onClick={() => void save(null)}>키 지우기</Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="ghost" disabled={disabled} onClick={() => setEditing(true)}>바꾸기</Button>
              <Button size="sm" variant="dangerGhost" disabled={disabled} onClick={() => setConfirmRemove(true)}>지우기</Button>
            </>
          )}
        </span>
        {error ? <p role="alert" className="w-full text-xs font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
      </div>
    );
  }

  return (
    <div data-tour="padlet-key" className="space-y-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] p-4">
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-[14px] font-extrabold"><Icon name="lock" size={15} />Padlet API 키 넣기</p>
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
          게시판을 읽으려면 Padlet <b className="font-bold text-[var(--theme-text)]">유료(Gold·Platinum) 계정</b>의 API 키가 필요해요.
          연결할 게시판을 만든 계정(또는 관리자로 초대된 계정)으로 로그인해서 키를 복사해 주세요. 키는 암호화해서 저장하고, 다시 보여 주지 않아요.
        </p>
        <PadletLink href={PADLET_KEY_PAGE} className="text-[13px]">Padlet에서 API 키 보기</PadletLink>
      </div>
      {keyStatus.saved && !keyStatus.readable ? <Callout tone="warning">{PADLET_ERROR_MESSAGES.KEY_UNREADABLE}</Callout> : null}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); if (value.trim()) void save(value); }}>
        <Input id={inputId} type="password" autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          aria-label="Padlet API 키" placeholder="Padlet에서 복사한 키" value={value} disabled={busy || disabled}
          onChange={(event) => setValue(event.target.value)} className="min-w-0 flex-1 basis-56" />
        <Button type="submit" variant="primary" loading={busy} disabled={!value.trim() || busy || disabled}>키 저장</Button>
        {editing ? <Button variant="ghost" disabled={busy} onClick={() => { setEditing(false); setValue(''); setError(''); }}>취소</Button> : null}
      </form>
      {error ? <p role="alert" className="text-xs font-semibold text-[var(--crs-danger-text)]">{error}</p> : null}
    </div>
  );
}

export type PickedBoard = Readonly<{ address: string; preview: PadletBoardPreviewDto; sectionId: string | null }>;

/** Address → 불러오기 → the board's title and sections; the teacher picks the section whose posts count. */
export function PadletBoardPicker({ picked, onPick, disabled = false, initialAddress = '' }: {
  picked: PickedBoard | null;
  onPick: (picked: PickedBoard | null) => void;
  disabled?: boolean;
  initialAddress?: string;
}) {
  const [address, setAddress] = useState(initialAddress);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();

  async function load() {
    const trimmed = address.trim();
    if (!trimmed || busy) return;
    setBusy(true); setError('');
    const result = await padletClient.preview(trimmed);
    setBusy(false);
    if (!result.ok) { setError(result.error); onPick(null); return; }
    // The section the teacher already picked stays when the same board is loaded again.
    const keep = picked?.preview.boardId === result.data.boardId && result.data.sections.some((section) => section.id === picked.sectionId);
    onPick({ address: trimmed, preview: result.data, sectionId: keep ? picked.sectionId : null });
  }

  const sections = picked?.preview.sections ?? [];
  return (
    <div className="space-y-3">
      <Field label="패들렛 게시판 주소" htmlFor={inputId} error={error}
        hint={error ? undefined : '게시판을 열고 주소창의 주소를 그대로 붙여 넣은 뒤 불러오기를 눌러 주세요.'}>
        <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void load(); }}>
          <Input id={inputId} data-tour="padlet-address" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://padlet.com/…" value={address}
            disabled={busy || disabled} className="min-w-0 flex-1"
            onChange={(event) => { setAddress(event.target.value); if (picked) onPick(null); }} />
          <Button type="submit" icon="download" loading={busy} disabled={!address.trim() || busy || disabled}>불러오기</Button>
        </form>
      </Field>
      {picked ? (
        <div className="space-y-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] bg-[var(--crs-subtle)] p-3.5" data-testid="padlet-board-preview">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 text-[var(--crs-success-text)]"><Icon name="check" size={16} /></span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-[14px] font-extrabold">{picked.preview.title || '(제목 없는 게시판)'}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--theme-muted-text)]">
                <span>지금 게시물 {picked.preview.postCount}개</span>
                <PadletLink href={picked.preview.url} label={`${picked.preview.title || '게시판'} 패들렛에서 보기`}>패들렛에서 보기</PadletLink>
              </p>
            </div>
          </div>
          {sections.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[13px] font-bold">어느 칸(섹션)에 올린 글을 셀까요?</p>
              <div role="radiogroup" aria-label="글을 셀 섹션" className="flex flex-wrap gap-1.5">
                {[{ id: null, title: '게시판 전체' }, ...sections].map((section) => {
                  const active = picked.sectionId === section.id;
                  return (
                    <button key={section.id ?? 'all'} type="button" role="radio" aria-checked={active} disabled={disabled}
                      onClick={() => onPick({ ...picked, sectionId: section.id })}
                      className={cx('h-8 max-w-full truncate rounded-full border px-3 text-[12px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] disabled:opacity-60',
                        active ? 'border-transparent bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)]'
                          : 'border-[var(--crs-line-strong)] bg-[var(--theme-surface)] text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]')}>
                      {section.title || '(이름 없는 칸)'}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * How the given tasks share one board's posts: chains (선행 과제) take one post per task in order,
 * separate tasks all count the same post.
 */
export function padletSharingNote(tasks: readonly AdminTaskDto[]): { chains: string[][]; separate: string[] } {
  const groups = padletTaskGroups(tasks.map((task) => ({
    taskId: task.taskId, title: task.title, sortOrder: task.sortOrder, prerequisiteTaskId: task.prerequisiteTaskId,
    sectionId: null, opensAt: task.createdAt, closesAt: null, visible: true,
  })));
  const title = (task: { title: string }) => task.title || '(이름 없음)';
  return {
    chains: groups.filter((group) => group.length > 1).map((group) => group.map(title)),
    separate: groups.filter((group) => group.length === 1).map((group) => title(group[0])),
  };
}

export function PadletSharingCallout({ tasks }: { tasks: readonly AdminTaskDto[] }) {
  if (tasks.length < 2) return null;
  const { chains, separate } = padletSharingNote(tasks);
  const groups = chains.length + separate.length;
  return (
    <div data-tour="padlet-sharing"><Callout tone="info" title={`이 게시판을 함께 쓰는 과제 ${tasks.length}개`}>
      <ul className="mt-0.5 space-y-1">
        {chains.map((chain) => (
          <li key={chain.join('→')}>
            <b className="font-bold">{chain.join(' → ')}</b>
            <span className="block">연계된 과제라서 글을 하나 올릴 때마다 앞 과제부터 하나씩 완료 가능이 돼요.</span>
          </li>
        ))}
        {separate.length > 0 && groups > 1 ? (
          <li>
            <b className="font-bold">{separate.join(', ')}</b>
            <span className="block">{chains.length > 0 ? '연계가 없어서 다른 과제와 같은 글 하나로 함께 완료 가능이 돼요.' : '서로 연계되지 않아서 글 하나로 모두 함께 완료 가능이 돼요.'}</span>
          </li>
        ) : null}
      </ul>
    </Callout></div>
  );
}

/** The rules, in the teacher's words. */
export function PadletRules() {
  return (
    <ul data-tour="padlet-rules" className="space-y-1 text-xs leading-relaxed text-[var(--theme-muted-text)]">
      <li className="flex gap-1.5"><span aria-hidden="true">·</span>학생이 ‘미완료’가 된 뒤(과제를 받거나, 초기화·단계 변경으로 미완료가 된 뒤) 마감 전까지 올린 글만 세요. 그 전에 쓴 글은 세지 않아요.</li>
      <li className="flex gap-1.5"><span aria-hidden="true">·</span>글쓴이 이름에서 학생 이름을 찾고, 없으면 글 제목에서 찾아요. 로그인하지 않은 학생은 제목에 이름을 써 주세요.</li>
      <li className="flex gap-1.5"><span aria-hidden="true">·</span>이 과제가 ‘미완료’인 학생만 ‘완료 가능’으로 바뀌어요. 글 하나는 한 번만 세요.</li>
      <li className="flex gap-1.5"><span aria-hidden="true">·</span>과제 화면이나 학생 화면을 열면 저절로 확인해요. 바로 확인하려면 ‘지금 확인’을 눌러 주세요.</li>
    </ul>
  );
}

const RESULT_BADGE: Record<string, { text: string; tone: Tone }> = {
  MOVED: { text: '완료 가능으로 바꿈', tone: 'success' },
  OTHER_TASK: { text: '연계된 다른 과제에 씀', tone: 'neutral' },
  NOT_ASSIGNED: { text: '과제 없는 학생(미부여)', tone: 'warning' },
  DONE: { text: '이미 완료 가능·완료', tone: 'neutral' },
  EARLIER: { text: '미완료가 되기 전에 쓴 글', tone: 'neutral' },
  WAITING: { text: '연계된 앞 과제 차례', tone: 'neutral' },
  OUTSIDE: { text: '세는 기간·칸 밖', tone: 'neutral' },
};

const ISSUE_BADGE: Record<NonNullable<PadletPostDto['issue']>, { text: string; tone: Tone }> = {
  NO_NAME: { text: '이름 없는 글', tone: 'warning' },
  UNKNOWN: { text: '학생 이름을 못 찾음', tone: 'warning' },
  AMBIGUOUS: { text: '여러 학생 이름과 겹침', tone: 'warning' },
  AWAITING_APPROVAL: { text: '승인 기다리는 글', tone: 'info' },
  INACTIVE_STUDENT: { text: '비활성 학생', tone: 'neutral' },
};

/** Recent posts of the board and what each did for this task, newest first. */
export function PadletPostList({ posts, taskId, now, stageOf, busyStudentId, onMakeReady }: {
  posts: readonly PadletPostDto[];
  taskId: string;
  now: string;
  /** The student's stage on this task now (the list itself is from the last read). */
  stageOf: (studentId: string) => TaskStage;
  busyStudentId: string | null;
  /** For a student who posted but does not have the task: give it as 완료 가능. */
  onMakeReady: (studentId: string) => void;
}) {
  const relevant = posts.filter((post) => post.issue !== null || taskId in post.results);
  if (relevant.length === 0) {
    return <p className="rounded-[12px] border border-dashed border-[var(--crs-line-strong)] px-4 py-5 text-center text-[13px] font-semibold text-[var(--theme-muted-text)]">아직 확인한 글이 없어요.</p>;
  }
  return (
    <ul className="divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius)] border border-[var(--crs-line)]" aria-label="최근 패들렛 글">
      {relevant.map((post) => {
        const result = post.issue ? null : post.results[taskId];
        const badge = post.issue ? ISSUE_BADGE[post.issue] : result ? RESULT_BADGE[result] : null;
        const who = post.studentName ?? (post.author || post.subject || '(이름 없음)');
        // What the post itself says, when it adds to the student's name.
        const written = [post.author !== post.studentName ? post.author : '', post.subject].filter(Boolean).join(' · ');
        return (
          <li key={post.postId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5" data-testid="padlet-post">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-bold">{who}</p>
              <p className="truncate text-[11px] text-[var(--theme-muted-text)]">
                {formatInstant(post.at, now)}{post.studentName && written ? ` · ${written}` : ''}
              </p>
            </div>
            {badge ? <Badge tone={badge.tone}>{badge.text}</Badge> : null}
            {result === 'NOT_ASSIGNED' && post.studentId && stageOf(post.studentId) === 'UNASSIGNED' ? (
              <Button size="sm" variant="soft" loading={busyStudentId === post.studentId} disabled={busyStudentId !== null}
                aria-label={`${who} 완료 가능으로 바꾸기`} onClick={() => onMakeReady(post.studentId!)}>완료 가능으로</Button>
            ) : null}
            {post.url ? <PadletLink href={post.url} label={`${who} 글 보기`} className="text-xs">글</PadletLink> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Keep the last successful read visible even while a later check is pending or failed. */
export function PadletReadState({ lastReadAt, error, now, checking = false, retryAt }: {
  lastReadAt: string | null; error: string | null; now: string; checking?: boolean; retryAt?: string | null;
}) {
  const waiting = error === 'RATE_LIMITED' && retryAt && Date.parse(retryAt) > Date.parse(now);
  return (
    <div className="space-y-1 text-xs" aria-live="polite">
      {checking ? <p className="font-semibold text-[var(--theme-muted-text)]">패들렛 확인 중이에요. 결과를 기다려 주세요.</p> : null}
      {error ? (
        <p className="flex items-start gap-1.5 font-semibold text-[var(--crs-warning-text)]">
          <Icon name="alert" size={14} /><span>{checking ? '이전 확인: ' : ''}{padletErrorText(error)}</span>
        </p>
      ) : null}
      {waiting ? <p className="text-[var(--theme-muted-text)]">{formatInstant(retryAt, now)} 이후 다시 확인할 수 있어요.</p> : null}
      <p className="text-[var(--theme-muted-text)]">
        {lastReadAt ? `마지막 확인 성공 ${formatInstant(lastReadAt, now)}` : '아직 확인에 성공한 기록이 없어요.'}
      </p>
    </div>
  );
}
