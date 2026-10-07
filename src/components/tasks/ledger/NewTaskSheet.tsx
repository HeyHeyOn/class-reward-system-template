'use client';

import { useMemo, useState, useRef } from 'react';
import type { TaskStage } from '@/domain/taskStage';
import { Button, Callout, Checkbox, Sheet, cx } from '../../ui';
import { DefinitionFields } from './DefinitionFields';
import { ErrorNote, studentLabels, type LedgerStudent } from './LedgerParts';
import { ledgerClient, newOperationId } from './ledgerClient';
import { compareStudentIds, definitionFromForm, repeatFormOf, repeatFromForm, stageLabel, type DefinitionForm, type RepeatForm } from './ledgerFormat';
import { RepeatFields } from './RepeatFields';
import { DiscardDialog, SheetTabs } from './TaskEditSheet';
import { runWrite } from './useTaskBoard';
import type { TaskLedger } from './useTaskLedger';

type NewTab = 'basic' | 'repeat' | 'students';
const STARTING_STAGES: readonly TaskStage[] = ['PENDING', 'READY', 'COMPLETED'];
const DEFAULT_STARTING_STAGE: TaskStage = 'READY';

/** 새 과제: 기본 정보 + 반복 + 대상 학생 (each picked student starts at 완료 가능 unless changed). */
export function NewTaskSheet({ ledger, opener, students, unit, notify }: {
  ledger: TaskLedger;
  opener: HTMLElement | null;
  students: readonly LedgerStudent[];
  unit: string;
  notify: (message: string) => void;
}) {
  const { board } = ledger;
  const [initialForm] = useState<DefinitionForm>(() => ({
    title: '', description: '', reward: '0', isActive: true, availableFrom: '', dueAt: '', prerequisiteTaskId: '',
    sortOrder: String(board.tasks.reduce((max, task) => Math.max(max, task.sortOrder), 0) + 1),
  }));
  const [form, setForm] = useState<DefinitionForm>(initialForm);
  const [repeat, setRepeat] = useState<RepeatForm>(() => repeatFormOf(null));
  const [picks, setPicks] = useState<Readonly<Record<string, TaskStage>>>({});
  const [tab, setTab] = useState<NewTab>('basic');
  const attempt = useRef<{ key: string; operationId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [discarding, setDiscarding] = useState(false);

  const active = useMemo(() => students.filter((student) => student.status !== 'INACTIVE').sort((a, b) => compareStudentIds(a.studentId, b.studentId)), [students]);
  const names = useMemo(() => studentLabels(students), [students]);
  const pickedIds = Object.keys(picks);
  const basicDirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const repeatDirty = repeat.type !== 'NONE';
  const dirty = basicDirty || repeatDirty || pickedIds.length > 0;

  function close(force = false) {
    if (busy) return;
    if (!force && dirty) { setDiscarding(true); return; }
    ledger.close();
  }

  function pick(studentIds: readonly string[], stage: TaskStage | null) {
    setPicks((current) => {
      const next = { ...current };
      for (const id of studentIds) {
        if (stage) next[id] = stage;
        else delete next[id];
      }
      return next;
    });
  }

  async function create() {
    if (busy) return;
    const definition = definitionFromForm(form);
    if (!definition.ok) { setTab('basic'); setError(definition.error); return; }
    const setting = repeatFromForm(repeat);
    if (!setting.ok) { setTab('repeat'); setError(setting.error); return; }
    setBusy(true); setError('');
    const body = { task: definition.value, repeat: setting.value,
      students: Object.entries(picks).map(([studentId, stage]) => ({ studentId, stage })) };
    // Pressing again after a failure re-sends the same request number, so the server either
    // creates the task once or returns the one it already made — never a duplicate.
    const key = JSON.stringify(body);
    if (attempt.current?.key !== key) attempt.current = { key, operationId: newOperationId() };
    const operationId = attempt.current.operationId;
    const result = await runWrite(board, () => ledgerClient.create({ operationId, ...body }));
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    attempt.current = null;
    board.applyTasks([result.data]);
    ledger.close();
    notify(`'${result.data.title}' 과제를 추가했어요.`);
  }

  const allPicked = active.length > 0 && active.every((student) => student.studentId in picks);
  return (
    <>
      <Sheet title="새 과제" eyebrow="과제 만들기" ariaLabel="새 과제" opener={opener} onClose={() => close()} busy={busy} obscured={discarding}
        toolbar={<SheetTabs<NewTab> value={tab} onChange={setTab} tabs={[['basic', '기본 정보', basicDirty], ['repeat', '반복', repeatDirty], ['students', '대상 학생', pickedIds.length > 0]]} />}
        footer={<>
          <Button variant="ghost" disabled={busy} onClick={() => close()}>취소</Button>
          <div className="ml-auto" />
          <Button variant="primary" icon="check" loading={busy} disabled={busy} onClick={() => void create()}>과제 만들기</Button>
        </>}>
        <div className="space-y-5">
          <ErrorNote message={error} />
          {tab === 'basic' ? (
            <DefinitionFields form={form} tasks={board.tasks} selfTaskId={null} unit={unit} labelPrefix="새 과제"
              onChange={(patch) => setForm((current) => ({ ...current, ...patch }))} />
          ) : tab === 'repeat' ? (
            <RepeatFields form={repeat} now={board.now} onChange={setRepeat} idPrefix="ledger-new-repeat" />
          ) : (
            <div className="space-y-4">
              <Callout tone="info">고른 학생에게 바로 과제를 줘요. 처음 단계는 학생마다 바꿀 수 있고, 고르지 않은 학생은 미부여예요.</Callout>
              <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2">
                <label className="flex items-center gap-2 text-[13px] font-bold">
                  <Checkbox aria-label="모든 학생 고르기" checked={allPicked}
                    onChange={(event) => pick(active.map((student) => student.studentId).filter((id) => event.target.checked ? !(id in picks) : true), event.target.checked ? DEFAULT_STARTING_STAGE : null)} />
                  모든 학생
                </label>
                <span className="text-[13px] font-semibold tabular-nums text-[var(--theme-muted-text)]">{pickedIds.length} / {active.length}명</span>
                {pickedIds.length ? (
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-[var(--theme-muted-text)]">고른 학생 모두</span>
                    {STARTING_STAGES.map((stage) => <Button key={stage} size="sm" onClick={() => pick(pickedIds, stage)}>{stageLabel(stage)}</Button>)}
                  </div>
                ) : null}
              </div>
              <div className="divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)]">
                {active.map((student) => {
                  const name = names.get(student.studentId) ?? student.studentId;
                  const stage = picks[student.studentId];
                  return (
                    <div key={student.studentId} className={cx('flex flex-wrap items-center gap-3 px-3.5 py-2.5', stage && 'bg-[var(--theme-accent-soft)]')}>
                      <Checkbox aria-label={`${name} 대상`} checked={Boolean(stage)} onChange={() => pick([student.studentId], stage ? null : DEFAULT_STARTING_STAGE)} />
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className="truncate text-sm font-bold">{name}</span>
                        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--theme-muted-text)] opacity-70">{student.studentId}</span>
                      </span>
                      {stage ? (
                        <select aria-label={`${name} 처음 단계`} value={stage} onChange={(event) => pick([student.studentId], event.target.value as TaskStage)}
                          className="h-8 rounded-[9px] border border-[var(--crs-line-strong)] bg-[var(--theme-input)] px-2 text-xs font-bold">
                          {STARTING_STAGES.map((option) => <option key={option} value={option}>{stageLabel(option)}</option>)}
                        </select>
                      ) : <span className="text-xs font-semibold text-[var(--theme-muted-text)]">미부여</span>}
                    </div>
                  );
                })}
                {active.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-[var(--theme-muted-text)]">먼저 학생을 등록해 주세요.</p> : null}
              </div>
            </div>
          )}
        </div>
      </Sheet>
      {discarding ? <DiscardDialog onCancel={() => setDiscarding(false)} onDiscard={() => { setDiscarding(false); close(true); }} /> : null}
    </>
  );
}
