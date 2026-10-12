'use client';

import { useMemo, useState } from 'react';
import type { TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto, TaskStageChangeDto } from '@/lib/taskLedgerApi';
import { Button, Callout, Checkbox, Modal } from '../../ui';
import { DeleteDialog, ErrorNote, ResetDialog, RewardConfirmDialog, StageChoice, studentLabels, type LedgerStudent } from './LedgerParts';
import { ledgerClient, newOperationId } from './ledgerClient';
import { blankRepeatForm, compareStudentIds, DEFAULT_RESET_STAGE, repeatFromForm, stageLabel, toWord, type RepeatForm } from './ledgerFormat';
import { RepeatFields } from './RepeatFields';
import { runWrite } from './useTaskBoard';
import type { TaskLedger } from './useTaskLedger';

export type BulkProps = { ledger: TaskLedger; taskIds: readonly string[]; opener: HTMLElement | null; notify: (message: string) => void };

export function selectedTasks(ledger: TaskLedger, taskIds: readonly string[]): AdminTaskDto[] {
  return ledger.board.tasks.filter((task) => taskIds.includes(task.taskId));
}

export function targetText(tasks: readonly AdminTaskDto[]): string {
  if (tasks.length === 1) return `'${tasks[0].title}' 과제`;
  return `과제 ${tasks.length}개 (${tasks.slice(0, 3).map((task) => task.title).join(', ')}${tasks.length > 3 ? ' 외' : ''})`;
}

export function BulkRepeatDialog({ ledger, taskIds, opener, notify }: BulkProps) {
  const tasks = selectedTasks(ledger, taskIds);
  const [form, setForm] = useState<RepeatForm>(blankRepeatForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const checked = repeatFromForm(form);

  async function save() {
    if (busy || !checked.ok || tasks.length === 0) return;
    setBusy(true); setError('');
    const result = await runWrite(ledger.board, () => ledgerClient.repeat({ operationId: newOperationId(), taskIds: tasks.map((task) => task.taskId), repeat: checked.value }));
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    ledger.board.applyTasks(result.data);
    ledger.close();
    notify(`과제 ${result.data.length}개의 반복 설정을 저장했어요.`);
  }

  return (
    <Modal title="선택한 과제 반복 설정" ariaLabel="선택 과제 반복 설정" description={`대상: ${targetText(tasks)}`} opener={opener} busy={busy} onClose={ledger.close}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={ledger.close}>취소</Button>
        <Button variant="primary" icon="check" loading={busy} disabled={busy || !checked.ok || tasks.length === 0} onClick={() => void save()}>저장</Button>
      </>}>
      <div className="space-y-5">
        <Callout tone="info">고른 과제 모두에 같은 반복을 적용해요. 지금 설정은 덮어써요.</Callout>
        <ErrorNote message={error} />
        <RepeatFields form={form} now={ledger.board.now} onChange={setForm} idPrefix="ledger-bulk-repeat" />
      </div>
    </Modal>
  );
}

/** 완료 단계: picked students × one stage, across every selected task. */
export function BulkStagesDialog({ ledger, taskIds, opener, notify, students, unit }: BulkProps & { students: readonly LedgerStudent[]; unit: string }) {
  const tasks = selectedTasks(ledger, taskIds);
  const [stage, setStage] = useState<TaskStage>('READY');
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [askReward, setAskReward] = useState(false);
  const active = useMemo(() => students.filter((student) => student.status !== 'INACTIVE').sort((a, b) => compareStudentIds(a.studentId, b.studentId)), [students]);
  const names = useMemo(() => studentLabels(students), [students]);
  const changes: TaskStageChangeDto[] = tasks.flatMap((task) => picked
    .filter((studentId) => (task.students.find((row) => row.studentId === studentId)?.stage ?? 'UNASSIGNED') !== stage)
    .map((studentId) => ({ taskId: task.taskId, studentId, stage })));
  const completing = stage === 'COMPLETED' ? changes.length : 0;
  const payable = tasks.some((task) => task.reward > 0 && changes.some((change) => change.taskId === task.taskId));
  const allPicked = active.length > 0 && active.every((student) => picked.includes(student.studentId));

  async function save(withReward?: boolean) {
    if (busy || changes.length === 0) return;
    if (withReward === undefined && completing > 0 && payable) { setAskReward(true); return; }
    setBusy(true); setError('');
    const result = await runWrite(ledger.board, () => ledgerClient.stages({
      operationId: newOperationId(), changes: changes.map((change) => ({ ...change, ...(change.stage === 'COMPLETED' && withReward ? { withReward: true } : {}) })),
    }));
    setBusy(false);
    setAskReward(false);
    if (!result.ok) { setError(result.error); return; }
    ledger.board.applyTasks(result.data);
    ledger.close();
    notify(`완료 단계 ${changes.length}건을 ${toWord(stageLabel(stage))} 저장했어요.`);
  }

  const rewardOf = tasks.length === 1 ? tasks[0].reward : null;
  const uniqueStudents = new Set(changes.map((change) => change.studentId)).size;
  return (
    <>
      <Modal title="선택한 과제의 완료 단계" ariaLabel="선택 과제 완료 단계" description={`대상: ${targetText(tasks)}`} size="lg" opener={opener} busy={busy}
        obscured={askReward} onClose={ledger.close}
        footer={<>
          <span className="mr-auto text-[13px] font-semibold text-[var(--theme-muted-text)]">바뀌는 학생 {uniqueStudents}명{tasks.length > 1 ? ` · ${changes.length}건` : ''}</span>
          <Button variant="ghost" disabled={busy} onClick={ledger.close}>취소</Button>
          <Button variant="primary" icon="check" data-tour="bulk-stages-save" loading={busy && !askReward} disabled={busy || changes.length === 0} onClick={() => void save()}>저장</Button>
        </>}>
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[13px] font-bold">고른 학생을 어느 단계로 바꿀까요?</p>
            <StageChoice label="바꿀 단계" value={stage} onChange={setStage} />
          </div>
          {stage !== 'COMPLETED' ? <p className="text-xs text-[var(--theme-muted-text)]">완료를 되돌려도 이미 받은 보상은 그대로 남아요. 필요하면 거래 내역에서 취소하세요.</p> : null}
          <ErrorNote message={error} />
          <div data-tour="bulk-stage-bar" className="flex items-center gap-2 rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2">
            <label className="flex items-center gap-2 text-[13px] font-bold">
              <Checkbox aria-label="모든 학생 고르기" checked={allPicked} disabled={busy} onChange={(event) => setPicked(event.target.checked ? active.map((student) => student.studentId) : [])} />
              모든 학생
            </label>
            <span className="text-[13px] font-semibold tabular-nums text-[var(--theme-muted-text)]">{picked.length} / {active.length}명</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {active.map((student) => {
              const name = names.get(student.studentId) ?? student.studentId;
              const checked = picked.includes(student.studentId);
              return (
                <label key={student.studentId} className="flex cursor-pointer items-center gap-3 rounded-[12px] border border-[var(--crs-line)] px-3.5 py-2.5 text-sm hover:bg-[var(--crs-subtle)]">
                  <Checkbox aria-label={`${name} 고르기`} checked={checked} disabled={busy}
                    onChange={() => setPicked((current) => checked ? current.filter((id) => id !== student.studentId) : [...current, student.studentId])} />
                  <span className="min-w-0 flex-1 truncate font-bold">{name}</span>
                  <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--theme-muted-text)] opacity-70">{student.studentId}</span>
                </label>
              );
            })}
          </div>
        </div>
      </Modal>
      {askReward ? (
        <RewardConfirmDialog count={uniqueStudents} reward={rewardOf} unit={unit} multipleTasks={tasks.length > 1} busy={busy}
          onCancel={() => setAskReward(false)} onChoose={(withReward) => void save(withReward)} />
      ) : null}
    </>
  );
}

export function BulkResetDialog({ ledger, taskIds, notify }: BulkProps) {
  const tasks = selectedTasks(ledger, taskIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shared = tasks.length > 0 && tasks.every((task) => task.repeat.resetStage === tasks[0].repeat.resetStage) ? tasks[0].repeat.resetStage : null;

  async function reset(stage: TaskStage) {
    if (busy || tasks.length === 0) return;
    setBusy(true); setError('');
    const result = await runWrite(ledger.board, () => ledgerClient.reset({ operationId: newOperationId(), taskIds: tasks.map((task) => task.taskId), stage }));
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    ledger.board.applyTasks(result.data);
    ledger.close();
    notify('지금 초기화 완료');
  }

  return <ResetDialog tasks={tasks} initialStage={shared ?? DEFAULT_RESET_STAGE} busy={busy} error={error} onCancel={ledger.close} onConfirm={(stage) => void reset(stage)} />;
}

export function BulkDeleteDialog({ ledger, taskIds, notify }: BulkProps) {
  const tasks = selectedTasks(ledger, taskIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    if (busy || tasks.length === 0) return;
    setBusy(true); setError('');
    const result = await runWrite(ledger.board, () => ledgerClient.remove({ operationId: newOperationId(), taskIds: tasks.map((task) => task.taskId) }));
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    ledger.board.removeTasks(result.data);
    ledger.setSelection((current) => current.filter((id) => !result.data.includes(id)));
    void ledger.board.reload();
    ledger.close();
    notify(`과제 ${result.data.length}개 삭제 완료`);
  }

  return <DeleteDialog tasks={tasks} busy={busy} error={error} onCancel={ledger.close} onConfirm={() => void remove()} />;
}
