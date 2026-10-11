'use client';

import { useState } from 'react';
import type { TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Button, Callout, IconButton, MetaRow, Modal, Sheet, cx } from '../../ui';
import { DefinitionFields } from './DefinitionFields';
import { LedgerHistoryDialog } from './LedgerHistoryDialog';
import { PadletTaskTab } from './PadletLinking';
import { DeleteDialog, ErrorNote, ResetDialog, RewardConfirmDialog, type LedgerStudent } from './LedgerParts';
import { ledgerClient, newOperationId } from './ledgerClient';
import {
  DEFAULT_RESET_STAGE, DEFINITION_FIELDS, definitionFormOf, definitionFromForm, formatInstant, recurrenceSummary,
  repeatFormOf, repeatFromForm, resetStageSummary, sameRepeat, type DefinitionForm, type RepeatForm,
} from './ledgerFormat';
import { RepeatFields } from './RepeatFields';
import { StageBoard, type StageChanges } from './StageBoard';
import { runWrite } from './useTaskBoard';
import type { TaskLedger, TaskSheetTab } from './useTaskLedger';

type Nested = 'history' | 'reset' | 'delete' | 'reward' | 'discard' | null;
type Busy = 'basic' | 'repeat' | 'stages' | 'reset' | 'delete' | 'padlet' | null;
type StageDraft = { baseline: AdminTaskDto; changes: StageChanges } | null;
const NO_ERRORS = { basic: '', repeat: '', stages: '', reset: '', delete: '' };

export function SheetTabs<T extends string>({ tabs, value, onChange }: { tabs: ReadonlyArray<readonly [T, string, boolean]>; value: T; onChange: (tab: T) => void }) {
  return (
    <div role="tablist" aria-label="과제 편집 메뉴" className="flex gap-0.5 rounded-[12px] bg-[var(--crs-subtle-hover)] p-1">
      {tabs.map(([tab, label, dirty]) => (
        <button key={tab} type="button" role="tab" aria-selected={value === tab} onClick={() => onChange(tab)}
          className={cx('relative h-9 flex-1 rounded-[9px] text-[13px] font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
            value === tab ? 'bg-[var(--theme-surface)] text-[var(--theme-text)] shadow-[var(--crs-shadow-sm)]' : 'text-[var(--theme-muted-text)] hover:text-[var(--theme-text)]')}>
          {label}{dirty ? <span aria-label="저장 안 됨" className="ml-1.5 inline-block h-1.5 w-1.5 -translate-y-0.5 rounded-full bg-[var(--crs-warning-text)]" /> : null}
        </button>
      ))}
    </div>
  );
}

export function DiscardDialog({ onCancel, onDiscard }: { onCancel: () => void; onDiscard: () => void }) {
  return (
    <Modal size="sm" tone="warning" title="저장하지 않은 변경 사항이 있어요" onClose={onCancel}
      footer={<>
        <Button variant="ghost" onClick={onCancel}>취소</Button>
        <Button variant="primary" data-autofocus onClick={onDiscard}>저장하지 않고 닫기</Button>
      </>}>
      <p className="text-[13px] leading-relaxed text-[var(--theme-muted-text)]">닫으면 이 과제에서 바꾼 내용이 사라져요.</p>
    </Modal>
  );
}

/** One task: 기본 정보 / 반복 / 학생 현황 / 패들렛, each saved on its own. Unsaved input survives refreshes and failures. */
export function TaskEditSheet({ ledger, taskId, initialTab, opener, students, unit, notify }: {
  ledger: TaskLedger;
  taskId: string;
  initialTab: TaskSheetTab;
  opener: HTMLElement | null;
  students: readonly LedgerStudent[];
  unit: string;
  notify: (message: string) => void;
}) {
  const { board } = ledger;
  const live = board.tasks.find((task) => task.taskId === taskId) ?? null;
  const [tab, setTab] = useState<TaskSheetTab>(initialTab);
  const [edits, setEdits] = useState<Partial<DefinitionForm>>({});
  const [repeatDraft, setRepeatDraft] = useState<RepeatForm | null>(null);
  const [stageDraft, setStageDraft] = useState<StageDraft>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [errors, setErrors] = useState(NO_ERRORS);
  const [nested, setNested] = useState<Nested>(null);
  const [historyOpener, setHistoryOpener] = useState<HTMLElement | null>(null);

  const baseForm = live ? definitionFormOf(live) : null;
  const form: DefinitionForm | null = baseForm ? { ...baseForm, ...edits } : null;
  const basicDirty = Boolean(baseForm && DEFINITION_FIELDS.some((field) => field in edits && edits[field] !== baseForm[field]));
  const repeatForm = repeatDraft ?? (live ? repeatFormOf(live.repeat) : null);
  const repeatChecked = repeatForm ? repeatFromForm(repeatForm) : null;
  const repeatDirty = Boolean(live && repeatDraft && (!repeatChecked?.ok || !sameRepeat(repeatChecked.value, live.repeat)));
  const stageTask = stageDraft?.baseline ?? live;
  const stageChanges = stageDraft?.changes ?? {};
  const stagesDirty = Object.keys(stageChanges).length > 0;
  const dirty = basicDirty || repeatDirty || stagesDirty;
  const title = live?.title ?? '과제';

  function setError(key: keyof typeof NO_ERRORS, message: string) {
    setErrors((current) => ({ ...current, [key]: message }));
  }

  function close(force = false) {
    if (busy) return;
    if (!force && dirty) { setNested('discard'); return; }
    ledger.close();
  }

  async function saveBasic() {
    if (!live || !form || busy) return;
    const checked = definitionFromForm(form);
    if (!checked.ok) { setError('basic', checked.error); return; }
    setBusy('basic'); setError('basic', '');
    const result = await runWrite(board, () => ledgerClient.update(taskId, { operationId: newOperationId(), task: checked.value }));
    setBusy(null);
    if (!result.ok) { setError('basic', result.error); return; }
    board.applyTasks([result.data]);
    // Typing that happened while saving stays as an unsaved edit.
    setEdits((current) => Object.fromEntries(Object.entries(current).filter(([field, value]) => form[field as keyof DefinitionForm] !== value)));
    notify('과제 내용을 저장했어요.');
  }

  async function saveRepeat() {
    if (!live || !repeatChecked || busy) return;
    if (!repeatChecked.ok) { setError('repeat', repeatChecked.error); return; }
    setBusy('repeat'); setError('repeat', '');
    const result = await runWrite(board, () => ledgerClient.repeat({ operationId: newOperationId(), taskIds: [taskId], repeat: repeatChecked.value }));
    setBusy(null);
    if (!result.ok) { setError('repeat', result.error); return; }
    board.applyTasks(result.data);
    const submitted = repeatForm;
    setRepeatDraft((current) => current === submitted ? null : current);
    notify('반복 설정을 저장했어요.');
  }

  function changeStages(studentIds: readonly string[], stage: TaskStage) {
    if (!live) return;
    setStageDraft((current) => {
      const baseline = current?.baseline ?? live;
      const changes: Record<string, TaskStage> = { ...(current?.changes ?? {}) };
      for (const studentId of studentIds) {
        const saved = baseline.students.find((row) => row.studentId === studentId)?.stage;
        if (saved === stage) delete changes[studentId];
        else changes[studentId] = stage;
      }
      return Object.keys(changes).length ? { baseline, changes } : null;
    });
  }

  async function saveStages(withReward?: boolean) {
    if (!live || !stageDraft || busy) return;
    const entries = Object.entries(stageDraft.changes);
    const completing = entries.filter(([, stage]) => stage === 'COMPLETED').length;
    if (withReward === undefined && completing > 0 && live.reward > 0) { setNested('reward'); return; }
    setBusy('stages'); setError('stages', '');
    const result = await runWrite(board, () => ledgerClient.stages({
      operationId: newOperationId(),
      changes: entries.map(([studentId, stage]) => ({ taskId, studentId, stage, ...(stage === 'COMPLETED' && withReward ? { withReward: true } : {}) })),
    }));
    setBusy(null);
    setNested(null);
    if (!result.ok) { setError('stages', result.error); return; }
    board.applyTasks(result.data);
    setStageDraft(null);
    notify(`학생 ${entries.length}명의 단계를 저장했어요.${completing && withReward ? ' 보상도 줬어요.' : ''}`);
  }

  async function resetNow(stage: TaskStage) {
    if (!live || busy) return;
    setBusy('reset'); setError('reset', '');
    const result = await runWrite(board, () => ledgerClient.reset({ operationId: newOperationId(), taskIds: [taskId], stage }));
    setBusy(null);
    if (!result.ok) { setError('reset', result.error); return; }
    board.applyTasks(result.data);
    setNested(null);
    notify('지금 초기화 완료');
  }

  async function deleteTask() {
    if (!live || busy) return;
    setBusy('delete'); setError('delete', '');
    const result = await runWrite(board, () => ledgerClient.remove({ operationId: newOperationId(), taskIds: [taskId] }));
    setBusy(null);
    if (!result.ok) { setError('delete', result.error); return; }
    board.removeTasks(result.data);
    ledger.setSelection((current) => current.filter((id) => !result.data.includes(id)));
    void board.reload();
    ledger.close();
    notify('과제 삭제 완료');
  }

  const footer = !live ? <Button variant="ghost" className="ml-auto" onClick={() => ledger.close()}>닫기</Button>
    : tab === 'basic' ? (
      <>
        <Button variant="dangerGhost" icon="trash" aria-label={`${title} 과제 삭제`} disabled={Boolean(busy)} onClick={() => { setError('delete', ''); setNested('delete'); }}>삭제</Button>
        <div className="ml-auto" />
        <Button variant="ghost" disabled={!basicDirty || Boolean(busy)} onClick={() => { setEdits({}); setError('basic', ''); }}>되돌리기</Button>
        <Button variant="primary" icon="check" loading={busy === 'basic'} disabled={!basicDirty || Boolean(busy)} onClick={() => void saveBasic()}>저장</Button>
      </>
    ) : tab === 'repeat' ? (
      <>
        <div className="ml-auto" />
        <Button variant="ghost" disabled={!repeatDraft || Boolean(busy)} onClick={() => { setRepeatDraft(null); setError('repeat', ''); }}>되돌리기</Button>
        <Button variant="primary" icon="check" loading={busy === 'repeat'} disabled={!repeatDirty || Boolean(busy)} onClick={() => void saveRepeat()}>저장</Button>
      </>
    ) : tab === 'padlet' ? (
      <Button variant="ghost" className="ml-auto" disabled={Boolean(busy)} onClick={() => close()}>닫기</Button>
    ) : (
      <>
        <Button variant="ghost" icon="restore" disabled={stagesDirty || Boolean(busy)} title={stagesDirty ? '바꾼 단계를 저장하거나 되돌린 뒤에 초기화할 수 있어요.' : undefined}
          onClick={() => { setError('reset', ''); setNested('reset'); }}>지금 초기화…</Button>
        <div className="ml-auto" />
        <Button variant="ghost" disabled={!stagesDirty || Boolean(busy)} onClick={() => { setStageDraft(null); setError('stages', ''); }}>되돌리기</Button>
        <Button variant="primary" icon="check" loading={busy === 'stages'} disabled={!stagesDirty || Boolean(busy)} onClick={() => void saveStages()}>
          {stagesDirty ? `${Object.keys(stageChanges).length}명 저장` : '저장'}
        </Button>
      </>
    );

  return (
    <>
      <Sheet title={title} eyebrow="과제 편집" ariaLabel={`${title} 과제 편집`} opener={opener} onClose={() => close()}
        busy={Boolean(busy)} obscured={nested !== null}
        headerActions={live ? <IconButton icon="history" label={`${title} 기록 보기`} onClick={(event) => { setHistoryOpener(event.currentTarget); setNested('history'); }} /> : null}
        toolbar={live ? <SheetTabs<TaskSheetTab> value={tab} onChange={setTab}
          tabs={[['basic', '기본 정보', basicDirty], ['repeat', '반복', repeatDirty], ['students', '학생 현황', stagesDirty], ['padlet', '패들렛', false]]} /> : undefined}
        footer={footer}>
        {!live ? (
          <Callout tone="warning" title="이 과제를 찾을 수 없어요">다른 곳에서 삭제됐을 수 있어요. 닫고 목록을 확인해 주세요.</Callout>
        ) : tab === 'basic' && form ? (
          <div className="space-y-5">
            <ErrorNote message={errors.basic} />
            <DefinitionFields form={form} tasks={board.tasks} selfTaskId={taskId} unit={unit} labelPrefix={title}
              onChange={(patch) => setEdits((current) => ({ ...current, ...patch }))} />
          </div>
        ) : tab === 'repeat' && repeatForm ? (
          <div className="space-y-6">
            <ErrorNote message={errors.repeat} />
            <dl className="divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius)] border border-[var(--crs-line)] px-4">
              <MetaRow label="지금 설정">{recurrenceSummary(live.repeat.recurrence)}{live.repeat.recurrence.type !== 'NONE' ? ` · ${resetStageSummary(live.repeat.resetStage)}` : ''}</MetaRow>
              <MetaRow label="다음 초기화">{live.repeat.nextResetAt ? formatInstant(live.repeat.nextResetAt, board.now) : '없음'}</MetaRow>
              {live.repeat.lastResetAt ? <MetaRow label="마지막 초기화">{formatInstant(live.repeat.lastResetAt, board.now)}</MetaRow> : null}
            </dl>
            <RepeatFields form={repeatForm} now={board.now} onChange={setRepeatDraft} showNextReset={repeatDirty} />
          </div>
        ) : tab === 'students' && stageTask ? (
          <div className="space-y-4">
            <ErrorNote message={errors.stages} />
            {stagesDirty ? <p className="text-xs font-semibold text-[var(--theme-muted-text)]">저장하기 전에는 다른 기기의 변경을 다시 불러오지 않아요.</p> : null}
            <StageBoard task={stageTask} students={students} changes={stageChanges} onChange={changeStages} disabled={busy === 'stages'} />
          </div>
        ) : tab === 'padlet' ? (
          <PadletTaskTab ledger={ledger} task={live} students={students} notify={notify} busy={Boolean(busy)}
            onBusy={(next) => setBusy(next ? 'padlet' : null)} />
        ) : null}
      </Sheet>

      {nested === 'discard' ? <DiscardDialog onCancel={() => setNested(null)} onDiscard={() => { setNested(null); close(true); }} /> : null}
      {nested === 'history' && live ? (
        <LedgerHistoryDialog taskId={taskId} title={title} students={students} unit={unit} now={board.now} opener={historyOpener} onClose={() => setNested(null)} />
      ) : null}
      {nested === 'reward' && live ? (
        <RewardConfirmDialog count={Object.values(stageChanges).filter((stage) => stage === 'COMPLETED').length} reward={live.reward} unit={unit}
          multipleTasks={false} busy={busy === 'stages'} onCancel={() => setNested(null)} onChoose={(withReward) => void saveStages(withReward)} />
      ) : null}
      {nested === 'reset' && live ? (
        <ResetDialog tasks={[live]} initialStage={live.repeat.resetStage ?? DEFAULT_RESET_STAGE} busy={busy === 'reset'} error={errors.reset}
          onCancel={() => setNested(null)} onConfirm={(stage) => void resetNow(stage)} />
      ) : null}
      {nested === 'delete' && live ? (
        <DeleteDialog tasks={[live]} busy={busy === 'delete'} error={errors.delete} onCancel={() => setNested(null)} onConfirm={() => void deleteTask()} />
      ) : null}
    </>
  );
}
