'use client';

import { useId, useState, type ReactNode } from 'react';
import { formatStudentTaskDue, formatStudentTaskRecurrence } from '@/domain/taskStudentDisplay';
import { Badge, Button, Callout, Icon, Spinner, cx } from '../ui';
import type { PendingCompletion, StudentBankTaskDto } from './bankClient';
import { formatMoney } from './format';

type BankTasksProps = Readonly<{
  tasks: StudentBankTaskDto[] | null;
  loading: boolean;
  error: string;
  currencyUnit: string;
  pending: PendingCompletion | null;
  busy: boolean;
  onComplete: (task: StudentBankTaskDto) => void;
  onRecheck: () => void;
  onRetry: () => void;
}>;

/** '내 과제': the student's tasks from 미완료 upward, grouped 완료 가능 → 미완료 → 완료. */
export function BankTasks({ tasks, loading, error, currencyUnit, pending, busy, onComplete, onRecheck, onRetry, showHeading = true }: BankTasksProps & { showHeading?: boolean }) {
  const headingId = useId();
  const ready = (tasks ?? []).filter((task) => task.stage === 'READY');
  const waiting = (tasks ?? []).filter((task) => task.stage === 'PENDING');
  const completed = (tasks ?? []).filter((task) => task.stage === 'COMPLETED');
  const completableCount = ready.filter((task) => task.completable).length;

  return (
    <section aria-labelledby={showHeading ? headingId : undefined} aria-label={showHeading ? undefined : '내 과제 목록'} className={showHeading ? 'mt-8' : 'mt-4'}>
      <div className="flex items-end justify-between gap-3">
        {showHeading ? <h2 id={headingId} className="text-[22px] font-black tracking-[-0.03em]">내 과제</h2> : <span />}
        {tasks && completableCount > 0 ? <Badge tone="accent" icon="sparkle">완료 가능 {completableCount}개</Badge> : null}
      </div>

      {pending ? (
        <div className="mt-3">
          <Callout tone="warning" title="확인 중인 과제 완료가 있어요">
            <p>&lsquo;{pending.taskTitle}&rsquo;을(를) 완료했는지 아직 확인하지 못했어요. [다시 확인]을 눌러 주세요. 다른 과제는 그대로 완료할 수 있어요.</p>
            <Button variant="secondary" size="sm" icon="refresh" className="mt-2" onClick={onRecheck} disabled={busy}>다시 확인</Button>
          </Callout>
        </div>
      ) : null}

      {tasks === null && loading ? (
        <p role="status" className="mt-4 flex items-center gap-2 rounded-[var(--crs-radius)] bg-[var(--theme-surface)] px-4 py-5 text-sm font-semibold text-[var(--theme-muted-text)]">
          <Spinner size={18} />과제를 불러오는 중이에요.
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="mt-4">
          <Callout tone="danger" title="과제를 불러오지 못했어요">
            <p>{error}</p>
            <Button variant="secondary" size="sm" icon="refresh" className="mt-2" onClick={onRetry} disabled={loading}>다시 불러오기</Button>
          </Callout>
        </div>
      ) : null}

      {tasks ? (
        <div className="mt-4 space-y-7">
          <TaskGroup stage="READY" title="완료 가능" description="지금 완료하고 보상을 받을 수 있어요." empty="지금 완료할 수 있는 과제가 없어요.">
            {ready.map((task) => (
              <ReadyTaskCard key={task.taskId} task={task} currencyUnit={currencyUnit}
                pendingHere={pending?.taskId === task.taskId}
                busy={busy} onComplete={onComplete} onRecheck={onRecheck} />
            ))}
          </TaskGroup>
          <TaskGroup stage="PENDING" title="미완료" description="선생님이 확인하면 완료할 수 있어요." empty="기다리는 과제가 없어요.">
            {waiting.map((task) => <PendingTaskCard key={task.taskId} task={task} currencyUnit={currencyUnit} />)}
          </TaskGroup>
          <TaskGroup stage="COMPLETED" title="완료" description="보상을 받은 과제예요." empty="아직 완료한 과제가 없어요.">
            {completed.map((task) => <CompletedTaskCard key={task.taskId} task={task} currencyUnit={currencyUnit} />)}
          </TaskGroup>
        </div>
      ) : null}
    </section>
  );
}

function TaskGroup({ stage, title, description, empty, children }: { stage: StudentBankTaskDto['stage']; title: string; description: string; empty: string; children: ReactNode[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-testid={`bank-task-group-${stage}`}>
      <div className="flex items-baseline gap-2">
        <h3 id={headingId} className="text-[17px] font-extrabold tracking-[-0.02em]">{title}</h3>
        <span className="text-[13px] font-bold tabular-nums text-[var(--theme-muted-text)]">{children.length}</span>
      </div>
      <p className="mt-0.5 text-[13px] text-[var(--theme-muted-text)]">{description}</p>
      {children.length ? (
        <ul className="mt-3 space-y-3">{children.map((child, index) => <li key={index}>{child}</li>)}</ul>
      ) : (
        <p className="mt-3 rounded-[var(--crs-radius)] border border-dashed border-[var(--crs-line-strong)] px-4 py-5 text-center text-sm font-semibold text-[var(--theme-muted-text)]">{empty}</p>
      )}
    </section>
  );
}

const cardBase = 'rounded-[20px] border bg-[var(--theme-surface)] p-4 text-[var(--theme-text)] sm:p-5';

function ReadyTaskCard({ task, currencyUnit, pendingHere, busy, onComplete, onRecheck }: {
  task: StudentBankTaskDto; currencyUnit: string; pendingHere: boolean; busy: boolean;
  onComplete: (task: StudentBankTaskDto) => void; onRecheck: () => void;
}) {
  const titleId = useId();
  if (!task.completable) {
    return (
      <article aria-labelledby={titleId} data-testid="bank-task-card" data-stage="READY" data-completable="false"
        className={cx(cardBase, 'border-[var(--crs-line)] shadow-[var(--crs-shadow-sm)]')}>
        <div className="flex items-start justify-between gap-3">
          <Badge tone="warning" icon="lock">아직 완료할 수 없어요</Badge>
          <Reward value={task.reward} currencyUnit={currencyUnit} muted />
        </div>
        <TaskTitle id={titleId} title={task.title} />
        <TaskDescription text={task.description} />
        <TaskMeta task={task} />
        <p className="mt-3 flex items-start gap-2 rounded-[var(--crs-radius)] bg-[var(--crs-warning-bg)] px-3.5 py-2.5 text-[13px] font-semibold leading-relaxed text-[var(--crs-warning-text)]">
          <span className="mt-0.5 shrink-0"><Icon name="lock" size={15} /></span>
          <span>{task.blockedReason ?? '지금은 완료할 수 없어요.'}</span>
        </p>
      </article>
    );
  }
  return (
    <article aria-labelledby={titleId} data-testid="bank-task-card" data-stage="READY" data-completable="true"
      className={cx(cardBase, 'border-2 border-[var(--theme-accent-text)] shadow-[var(--crs-shadow)]')}>
      <div className="flex items-start justify-between gap-3">
        <Badge tone="accent" icon="sparkle">완료 가능</Badge>
        <Reward value={task.reward} currencyUnit={currencyUnit} />
      </div>
      <TaskTitle id={titleId} title={task.title} />
      <TaskDescription text={task.description} />
      <TaskMeta task={task} />
      {pendingHere ? (
        <Button variant="primary" size="lg" block icon="refresh" className="mt-4 h-14 text-[16px]" onClick={onRecheck} disabled={busy}
          aria-label={`${task.title} 완료 상태 다시 확인`}>다시 확인</Button>
      ) : (
        <Button variant="primary" size="lg" block icon="gift" className="mt-4 h-14 text-[16px]" onClick={() => onComplete(task)}
          disabled={busy} aria-label={`${task.title} 완료하고 보상 받기`}>완료하고 보상 받기</Button>
      )}
    </article>
  );
}

function PendingTaskCard({ task, currencyUnit }: { task: StudentBankTaskDto; currencyUnit: string }) {
  const titleId = useId();
  return (
    <article aria-labelledby={titleId} data-testid="bank-task-card" data-stage="PENDING"
      className={cx(cardBase, 'border-[var(--crs-line)] shadow-[var(--crs-shadow-sm)]')}>
      <div className="flex items-start justify-between gap-3">
        <Badge tone="neutral" icon="clock">미완료</Badge>
        <Reward value={task.reward} currencyUnit={currencyUnit} muted />
      </div>
      <TaskTitle id={titleId} title={task.title} />
      <TaskDescription text={task.description} />
      <TaskMeta task={task} />
      {task.padlet ? <PadletHint padlet={task.padlet} title={task.title} /> : (
        <p className="mt-3 flex items-start gap-2 rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-3.5 py-2.5 text-[13px] font-semibold leading-relaxed text-[var(--theme-muted-text)]">
          <span className="mt-0.5 shrink-0"><Icon name="clock" size={15} /></span>
          <span>선생님이 확인하면 완료할 수 있어요. 조금만 기다려 주세요.</span>
        </p>
      )}
    </article>
  );
}

/** A task linked to a Padlet board: a post in the student's own name makes it 완료 가능. */
function PadletHint({ padlet, title }: { padlet: NonNullable<StudentBankTaskDto['padlet']>; title: string }) {
  const where = padlet.sectionTitle ? `‘${padlet.sectionTitle}’ 칸에` : '';
  return (
    <div className="mt-3 rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-3.5 py-3 text-[13px] font-semibold leading-relaxed text-[var(--theme-muted-text)]">
      <p className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0"><Icon name="link" size={15} /></span>
        <span>패들렛 <b className="font-extrabold text-[var(--theme-text)]">{padlet.title || '게시판'}</b>{where ? ` ${where}` : '에'} 내 이름으로 글을 올리면 완료할 수 있어요. 올린 뒤 새로고침해 보세요.</span>
      </p>
      {/^https:\/\//.test(padlet.url) ? (
        <a href={padlet.url} target="_blank" rel="noopener noreferrer" aria-label={`${title} 패들렛 열기`}
          className="mt-2.5 inline-flex h-10 items-center gap-1.5 rounded-full border border-[var(--crs-line-strong)] bg-[var(--theme-surface)] px-4 text-[14px] font-bold text-[var(--theme-text)] hover:border-[var(--theme-accent-text)]">
          패들렛 열기<Icon name="external" size={14} />
        </a>
      ) : null}
    </div>
  );
}

function CompletedTaskCard({ task, currencyUnit }: { task: StudentBankTaskDto; currencyUnit: string }) {
  const titleId = useId();
  return (
    <article aria-labelledby={titleId} data-testid="bank-task-card" data-stage="COMPLETED"
      className={cx(cardBase, 'border-[var(--crs-line)] bg-[var(--crs-subtle)]')}>
      <div className="flex items-start justify-between gap-3">
        <Badge tone="success" icon="check">완료</Badge>
      </div>
      <TaskTitle id={titleId} title={task.title} />
      <p className="mt-2 flex items-center gap-1.5 text-[14px] font-bold text-[var(--crs-success-text)]">
        <Icon name="coins" size={16} />보상 {formatMoney(task.reward, currencyUnit)} 받았어요
      </p>
    </article>
  );
}

function TaskTitle({ id, title }: { id: string; title: string }) {
  return <h4 id={id} className="mt-3 break-words text-[18px] font-extrabold leading-snug tracking-[-0.02em]">{title}</h4>;
}

function Reward({ value, currencyUnit, muted = false }: { value: number; currencyUnit: string; muted?: boolean }) {
  return (
    <span className={cx('shrink-0 text-right', muted ? 'text-[var(--theme-muted-text)]' : 'text-[var(--theme-accent-text)]')}>
      <span className="block text-[11px] font-bold">보상</span>
      <span className="block text-[20px] font-black leading-tight tabular-nums tracking-[-0.03em]">{formatMoney(value, currencyUnit)}</span>
    </span>
  );
}

const LONG_DESCRIPTION = 90;

function TaskDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const descriptionId = useId();
  const trimmed = text.trim();
  if (!trimmed) return null;
  const long = trimmed.length > LONG_DESCRIPTION || trimmed.split('\n').length > 3;
  return (
    <div className="mt-1.5">
      <p id={descriptionId} className={cx('whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[var(--theme-text)]', long && !expanded && 'line-clamp-3')}>{trimmed}</p>
      {long ? (
        <button type="button" aria-expanded={expanded} aria-controls={descriptionId} onClick={() => setExpanded((value) => !value)}
          className="mt-1 -ml-1 rounded-md px-1 py-1 text-[13px] font-bold text-[var(--theme-accent-text)] underline-offset-2 hover:underline">
          {expanded ? '접기' : '더 보기'}
        </button>
      ) : null}
    </div>
  );
}

function TaskMeta({ task }: { task: StudentBankTaskDto }) {
  const repeats = task.recurrence && task.recurrence.type !== 'NONE';
  if (!task.dueAt && !repeats && !task.prerequisiteTitle) return null;
  return (
    <ul className="mt-2.5 space-y-1 text-[13px] font-semibold text-[var(--theme-muted-text)]">
      {task.dueAt ? <li className="flex items-center gap-1.5"><Icon name="calendar" size={14} />{formatStudentTaskDue(task.dueAt)}</li> : null}
      {repeats ? <li className="flex items-center gap-1.5"><Icon name="repeat" size={14} />{formatStudentTaskRecurrence(task.recurrence)}</li> : null}
      {task.prerequisiteTitle ? <li className="flex items-center gap-1.5"><Icon name="link" size={14} />먼저 할 과제: {task.prerequisiteTitle}</li> : null}
    </ul>
  );
}
