'use client';

import { useMemo, useState } from 'react';
import type { TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Button, Callout, Checkbox, SegmentedControl, cx } from '../../ui';
import { compareStudentIds, formatSince, stageLabel, TASK_STAGES } from './ledgerFormat';
import { MiniStat, StagePicker, studentLabels, type LedgerStudent } from './LedgerParts';

export type StageChanges = Readonly<Record<string, TaskStage>>;
type Filter = 'all' | TaskStage;

/**
 * 학생 현황: every student's stage for one task. Stages are chosen freely in both directions; the
 * caller keeps the unsaved changes (`changes`) and saves only those rows.
 */
export function StageBoard({ task, students, changes, onChange, disabled }: {
  /** The task as it was when editing started (or the live task while nothing is changed). */
  task: AdminTaskDto;
  students: readonly LedgerStudent[];
  changes: StageChanges;
  onChange: (studentIds: readonly string[], stage: TaskStage) => void;
  disabled?: boolean;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const names = useMemo(() => studentLabels(students), [students]);
  const statusById = useMemo(() => new Map(students.map((student) => [student.studentId, student.status])), [students]);
  const rows = useMemo(() => [...task.students].sort((a, b) => compareStudentIds(a.studentId, b.studentId)), [task.students]);
  const stageOf = (studentId: string, saved: TaskStage) => changes[studentId] ?? saved;
  const activeRows = rows.filter((row) => statusById.get(row.studentId) !== 'INACTIVE');
  const count = (stage: TaskStage) => activeRows.filter((row) => stageOf(row.studentId, row.stage) === stage).length;
  const shown = rows.filter((row) => filter === 'all' || stageOf(row.studentId, row.stage) === filter);
  const shownIds = shown.map((row) => row.studentId);
  const pickedShown = picked.filter((id) => shownIds.includes(id));
  const allShownPicked = shownIds.length > 0 && shownIds.every((id) => picked.includes(id));
  const undoesCompletion = rows.some((row) => row.stage === 'COMPLETED' && changes[row.studentId] && changes[row.studentId] !== 'COMPLETED');

  return (
    <div className="space-y-4">
      <div data-tour="stage-counts" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TASK_STAGES.map((stage) => <MiniStat key={stage} label={stageLabel(stage)} value={`${count(stage)}명`} tone={stage} />)}
      </div>
      <ul data-tour="stage-legend" className="grid gap-1 rounded-[12px] bg-[var(--crs-subtle)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--theme-muted-text)]">
        <li><b className="text-[var(--theme-text)]">미부여</b> 학생에게 보이지 않아요.</li>
        <li><b className="text-[var(--theme-text)]">미완료</b> 학생이 과제를 볼 수 있지만 아직 완료할 수 없어요.</li>
        <li><b className="text-[var(--theme-text)]">완료 가능</b> 학생이 은행에서 완료하고 보상을 받을 수 있어요.</li>
        <li><b className="text-[var(--theme-text)]">완료</b> 끝낸 과제예요. 여기서 완료로 바꿀 때 보상을 줄지 물어봐요.</li>
      </ul>
      {undoesCompletion ? (
        <Callout tone="warning">완료를 되돌려도 이미 받은 보상은 그대로 남아요. 필요하면 거래 내역에서 취소하세요.</Callout>
      ) : null}
      <SegmentedControl<Filter> ariaLabel="학생 현황 필터" size="sm" value={filter} onChange={setFilter}
        options={[{ value: 'all', label: '전체', count: rows.length }, ...TASK_STAGES.map((stage) => ({ value: stage, label: stageLabel(stage), count: count(stage) }))]} />
      <div data-tour="stage-pick-bar" className="flex flex-wrap items-center gap-2 rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2">
        <label className="flex items-center gap-2 text-[13px] font-bold">
          <Checkbox aria-label="보이는 학생 모두 선택" checked={allShownPicked} disabled={disabled}
            onChange={(event) => setPicked(event.target.checked ? Array.from(new Set([...picked, ...shownIds])) : picked.filter((id) => !shownIds.includes(id)))} />
          {pickedShown.length ? `${pickedShown.length}명 선택` : '모두 선택'}
        </label>
        {pickedShown.length ? (
          <div role="group" aria-label="선택한 학생 단계 바꾸기" className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-[var(--theme-muted-text)]">선택한 학생을</span>
            {TASK_STAGES.map((stage) => (
              <Button key={stage} size="sm" variant="secondary" disabled={disabled} onClick={() => onChange(pickedShown, stage)}>{stageLabel(stage)}</Button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)]">
        {shown.map((row) => {
          const name = names.get(row.studentId) ?? row.studentId;
          const stage = stageOf(row.studentId, row.stage);
          const changed = row.studentId in changes && changes[row.studentId] !== row.stage;
          const selected = picked.includes(row.studentId);
          const inactive = statusById.get(row.studentId) === 'INACTIVE';
          return (
            <div key={row.studentId} data-testid={`ledger-stage-row-${row.studentId}`} data-tour="stage-row"
              className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5', selected && 'bg-[var(--crs-subtle)]', changed && 'bg-[var(--theme-accent-soft)]')}>
              <Checkbox aria-label={`${name} 선택`} checked={selected} disabled={disabled}
                onChange={() => setPicked((current) => current.includes(row.studentId) ? current.filter((id) => id !== row.studentId) : [...current, row.studentId])} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-sm font-bold">{name}</span>
                  <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--theme-muted-text)] opacity-70">{row.studentId}</span>
                  {inactive ? <span className="shrink-0 text-[11px] font-semibold text-[var(--theme-muted-text)]">비활성</span> : null}
                  {changed ? <span className="shrink-0 rounded-full bg-[var(--theme-accent-solid)] px-1.5 py-px text-[10px] font-bold text-[var(--theme-accent-on-solid)]">변경</span> : null}
                </span>
                <span className="mt-0.5 block text-[11px] text-[var(--theme-muted-text)]">
                  {changed ? `${stageLabel(row.stage)} → ${stageLabel(stage)} (저장 전)`
                    : [row.since ? formatSince(row.since) : '', row.byReset ? '자동 초기화' : ''].filter(Boolean).join(' · ')}
                </span>
              </span>
              <StagePicker label={name} value={stage} disabled={disabled} onChange={(next) => onChange([row.studentId], next)} />
            </div>
          );
        })}
        {shown.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-[var(--theme-muted-text)]">해당하는 학생이 없어요.</p> : null}
      </div>
    </div>
  );
}
