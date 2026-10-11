'use client';

import { useState } from 'react';
import type { TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Button, Callout, Modal, cx } from '../../ui';
import { holderCount, money, stageLabel, TASK_STAGES } from './ledgerFormat';

export type LedgerStudent = { studentId: string; name: string; status?: string };

export const STAGE_TONES: Record<TaskStage, string> = {
  UNASSIGNED: 'bg-[var(--crs-subtle)] text-[var(--theme-muted-text)]',
  PENDING: 'bg-[var(--crs-warning-bg)] text-[var(--crs-warning-text)]',
  READY: 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)]',
  COMPLETED: 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]',
};

const STAGE_BAR: Record<Exclude<TaskStage, 'UNASSIGNED'>, string> = {
  PENDING: 'bg-[var(--crs-warning-text)]',
  READY: 'bg-[var(--theme-accent-text)]',
  COMPLETED: 'bg-[var(--crs-success-text)]',
};

/** Names shown for students; a name shared by two students gets its number added. */
export function studentLabels(students: readonly LedgerStudent[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const student of students) counts.set(student.name, (counts.get(student.name) ?? 0) + 1);
  return new Map(students.map((student) => [student.studentId,
    !student.name ? student.studentId : (counts.get(student.name) ?? 0) > 1 ? `${student.name}(${student.studentId})` : student.name]));
}

type StagePill<T extends string> = { value: T; label: string; tone: string };

const stagePills = (stages: readonly TaskStage[]): StagePill<TaskStage>[] =>
  stages.map((stage) => ({ value: stage, label: stageLabel(stage), tone: STAGE_TONES[stage] }));

/** The one stage picker of the task screen: a row of pills, the chosen one in its stage colour. */
function StagePills<T extends string>({ groupLabel, options, value, onChange, disabled, buttonLabel }: {
  groupLabel: string;
  options: readonly StagePill<T>[];
  /** Null when nothing is chosen yet. */
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
  /** Spoken name of each pill, when the visible word is not enough (rows of students). */
  buttonLabel?: (option: StagePill<T>) => string;
}) {
  return (
    <div role="group" aria-label={groupLabel} className="inline-flex shrink-0 flex-wrap rounded-full border border-[var(--crs-line-strong)] p-0.5">
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button key={option.value} type="button" aria-label={buttonLabel?.(option)} aria-pressed={active} disabled={disabled}
            onClick={() => { if (!active) onChange(option.value); }}
            className={cx('h-7 rounded-full px-2.5 text-[11px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] disabled:cursor-not-allowed disabled:opacity-60',
              active ? option.tone : 'text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)]')}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 미부여 → 미완료 → 완료 가능 → 완료, picked per student. Every stage can be chosen in both directions. */
export function StagePicker({ label, value, onChange, disabled }: { label: string; value: TaskStage; onChange: (stage: TaskStage) => void; disabled?: boolean }) {
  return <StagePills groupLabel={`${label} 단계`} options={stagePills(TASK_STAGES)} value={value} onChange={onChange} disabled={disabled}
    buttonLabel={(option) => `${label} ${option.label}`} />;
}

/** Choose one stage (repeat, QR, reset and bulk dialogs), looking the same as a student's row in 학생 현황. */
export function StageChoice({ label, value, onChange, stages = TASK_STAGES, disabled }: {
  label: string; value: TaskStage | null; onChange: (stage: TaskStage) => void; stages?: readonly TaskStage[]; disabled?: boolean;
}) {
  return <StagePills groupLabel={label} options={stagePills(stages)} value={value} onChange={onChange} disabled={disabled} />;
}

export function MiniStat({ label, value, tone }: { label: string; value: string; tone?: TaskStage }) {
  return (
    <div className="rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-[var(--theme-muted-text)]">
        {tone && tone !== 'UNASSIGNED' ? <span aria-hidden="true" className={cx('h-1.5 w-1.5 rounded-full', STAGE_BAR[tone])} /> : null}{label}
      </p>
      <p className="mt-0.5 text-lg font-black tabular-nums">{value}</p>
    </div>
  );
}

/** Compact 미완료 / 완료 가능 / 완료 counts for one task (미부여 is muted). */
export function StageCounts({ task, className }: { task: Pick<AdminTaskDto, 'counts' | 'title'>; className?: string }) {
  const holders = holderCount(task);
  return (
    <span className={cx('min-w-0', className)}>
      <span role="img" aria-label={`${task.title} 단계: 미완료 ${task.counts.PENDING}명, 완료 가능 ${task.counts.READY}명, 완료 ${task.counts.COMPLETED}명, 미부여 ${task.counts.UNASSIGNED}명`}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--crs-subtle-hover)]">
        {holders > 0 ? (['PENDING', 'READY', 'COMPLETED'] as const).map((stage) => task.counts[stage] > 0 ? (
          <span key={stage} className={cx('h-full', STAGE_BAR[stage])} style={{ width: `${(task.counts[stage] / holders) * 100}%` }} />
        ) : null) : null}
      </span>
      <span aria-hidden="true" className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] font-semibold tabular-nums text-[var(--theme-muted-text)]">
        <span>미완료 {task.counts.PENDING}</span>
        <span className="text-[var(--theme-accent-text)]">완료 가능 {task.counts.READY}</span>
        <span className="text-[var(--crs-success-text)]">완료 {task.counts.COMPLETED}</span>
        <span className="opacity-60">미부여 {task.counts.UNASSIGNED}</span>
      </span>
    </span>
  );
}

export function ErrorNote({ message }: { message: string }) {
  if (!message) return null;
  return <Callout tone="danger" title="저장하지 못했어요"><p>{message}</p><p className="mt-0.5">입력한 내용은 그대로 있어요. 다시 눌러 주세요.</p></Callout>;
}

/** Asked once when a save moves students to 완료. */
export function RewardConfirmDialog({ count, reward, unit, multipleTasks, busy, onCancel, onChoose }: {
  count: number; reward: number | null; unit: string; multipleTasks: boolean; busy: boolean;
  onCancel: () => void; onChoose: (withReward: boolean) => void;
}) {
  const amount = reward !== null ? money(reward, unit) : '과제마다 정한 금액';
  return (
    <Modal size="sm" tone="success" title="보상도 줄까요?" ariaLabel="보상 지급 확인" busy={busy} onClose={onCancel}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>취소</Button>
        <Button disabled={busy} onClick={() => onChoose(false)}>보상 없이 완료</Button>
        <Button variant="primary" data-autofocus disabled={busy} loading={busy} onClick={() => onChoose(true)}>보상도 주기</Button>
      </>}>
      <p className="text-sm font-bold">완료로 바꾼 학생 {count}명에게 보상({amount})도 줄까요?</p>
      <p className="mt-2 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
        보상을 주면 은행에서 완료한 것처럼 학생 잔액이 늘어나요.{multipleTasks ? ' 과제마다 그 과제의 보상을 줍니다.' : ''}
      </p>
    </Modal>
  );
}

/** "지금 초기화": every student who has the task (not 미부여) moves to the chosen stage now. */
export function ResetDialog({ tasks, initialStage, busy, error, onCancel, onConfirm }: {
  tasks: readonly AdminTaskDto[]; initialStage: TaskStage; busy: boolean; error: string;
  onCancel: () => void; onConfirm: (stage: TaskStage) => void;
}) {
  const [stage, setStage] = useState<TaskStage>(initialStage);
  const holders = tasks.reduce((sum, task) => sum + holderCount(task), 0);
  const target = tasks.length === 1 ? `'${tasks[0].title}' 과제` : `과제 ${tasks.length}개`;
  return (
    <Modal size="md" tone="warning" title="지금 초기화" ariaLabel="지금 초기화" busy={busy} onClose={onCancel}
      description={`${target}를 가진 학생을 모두 고른 단계로 바꿔요.`}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>취소</Button>
        <Button variant="primary" icon="restore" loading={busy} disabled={busy || tasks.length === 0} onClick={() => onConfirm(stage)}>지금 초기화</Button>
      </>}>
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-bold">어느 단계로 바꿀까요?</p>
          <StageChoice label="초기화 단계" value={stage} onChange={setStage} />
        </div>
        <ul className="grid gap-1 rounded-[12px] bg-[var(--crs-subtle)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--theme-muted-text)]">
          <li>미부여가 아닌 학생 {holders}명이 모두 <b className="text-[var(--theme-text)]">{stageLabel(stage)}</b> 단계가 돼요.</li>
          <li>미부여인 학생은 그대로예요.</li>
          {stage !== 'COMPLETED' ? <li>이미 받은 보상은 그대로 남아요.</li> : <li>완료로 바꿔도 보상은 주지 않아요.</li>}
        </ul>
        <ErrorNote message={error} />
      </div>
    </Modal>
  );
}

export function DeleteDialog({ tasks, busy, error, onCancel, onConfirm }: {
  tasks: readonly Pick<AdminTaskDto, 'taskId' | 'title'>[]; busy: boolean; error: string; onCancel: () => void; onConfirm: () => void;
}) {
  const title = tasks.length === 1 ? `'${tasks[0].title}' 과제를 삭제할까요?` : `과제 ${tasks.length}개를 삭제할까요?`;
  return (
    <Modal size="sm" tone="danger" title={title} ariaLabel="과제 삭제 확인" busy={busy} onClose={onCancel}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>취소</Button>
        <Button variant="danger" data-autofocus loading={busy} disabled={busy || tasks.length === 0} onClick={onConfirm}>삭제</Button>
      </>}>
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">학생 은행 화면에서 사라져요. 이미 받은 보상은 그대로 남아요. 이 과제를 먼저 끝내야 했던 과제는 그 조건이 없어져요.</p>
        <ErrorNote message={error} />
      </div>
    </Modal>
  );
}
