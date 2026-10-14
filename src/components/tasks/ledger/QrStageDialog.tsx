'use client';

import { useRef, useState } from 'react';
import type { TaskStage } from '@/domain/taskStage';
import { withObjectParticle } from '../../adminTaskHistory';
import { QrScanner } from '../../QrScanner';
import { Badge, Button, Field, Icon, Input, Modal, Switch, cx } from '../../ui';
import { ledgerClient, newOperationId } from './ledgerClient';
import { holderCount, isWord, money, sortTasks, stageLabel } from './ledgerFormat';
import { StageChoice } from './LedgerParts';
import { runWrite } from './useTaskBoard';
import type { TaskLedger } from './useTaskLedger';

type Step = { kind: 'task' } | { kind: 'stage'; taskId: string } | { kind: 'scan'; taskId: string };
type Line = { id: number; tone: 'pending' | 'changed' | 'same' | 'failed'; text: string };

/**
 * QR로 단계 바꾸기: pick a task and a stage, then every scanned student moves to that stage.
 * Each scan is its own request; a failure is shown and scanning simply continues.
 */
export function QrStageDialog({ ledger, opener, unit, manualInputEnabled }: {
  ledger: TaskLedger;
  opener: HTMLElement | null;
  unit: string;
  manualInputEnabled: boolean;
}) {
  const { board } = ledger;
  const [step, setStep] = useState<Step>({ kind: 'task' });
  const [stage, setStage] = useState<TaskStage>('PENDING');
  const [withReward, setWithReward] = useState(false);
  const [manual, setManual] = useState('');
  const [lines, setLines] = useState<readonly Line[]>([]);
  const lineSeq = useRef(0);
  const tasks = sortTasks(board.tasks);
  const task = step.kind === 'task' ? null : board.tasks.find((candidate) => candidate.taskId === step.taskId) ?? null;
  const rewarding = stage === 'COMPLETED' && withReward && (task?.reward ?? 0) > 0;

  async function scan(raw: string) {
    const studentQr = raw.trim();
    if (!studentQr || step.kind !== 'scan') return;
    const id = ++lineSeq.current;
    const taskId = step.taskId;
    setLines((current) => [{ id, tone: 'pending' as const, text: '확인 중…' }, ...current].slice(0, 50));
    const result = await runWrite(board, () => ledgerClient.qr({
      operationId: newOperationId(), taskId, studentQr, stage, ...(rewarding ? { withReward: true } : {}),
    }));
    let line: Line;
    if (result.ok) {
      board.applyTasks([result.data.task]);
      const name = result.data.student.name || result.data.student.studentId;
      line = result.data.changed
        ? { id, tone: 'changed', text: `${name}: ${stageLabel(result.data.previousStage)} → ${stageLabel(result.data.stage)}${rewarding && result.data.stage === 'COMPLETED' ? ` (보상 ${money(result.data.task.reward, unit)})` : ''}` }
        : { id, tone: 'same', text: `${name}: 이미 ${isWord(stageLabel(result.data.stage))}` };
    } else {
      line = { id, tone: 'failed', text: result.error };
    }
    setLines((current) => current.map((item) => item.id === id ? line : item));
  }

  const title = 'QR로 단계 바꾸기';
  let body: React.ReactNode;
  let footer: React.ReactNode;
  if (step.kind === 'task') {
    footer = <Button variant="ghost" onClick={ledger.close}>닫기</Button>;
    body = (
      <div className="space-y-2">
        <p className="text-[13px] text-[var(--theme-muted-text)]">어떤 과제의 단계를 바꿀까요?</p>
        {tasks.map((candidate) => (
          <button key={candidate.taskId} type="button" aria-label={`${candidate.title} 과제 선택`} onClick={() => setStep({ kind: 'stage', taskId: candidate.taskId })}
            className="flex w-full items-center gap-3 rounded-[var(--crs-radius)] border border-[var(--crs-line)] px-4 py-3 text-left transition-colors hover:bg-[var(--crs-subtle)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2"><span className="truncate text-[15px] font-bold">{candidate.title}</span>{candidate.isActive ? null : <Badge>숨김</Badge>}</span>
              <span className="mt-0.5 block text-xs text-[var(--theme-muted-text)]">보상 {money(candidate.reward, unit)}, 받은 학생 {holderCount(candidate)}명</span>
            </span>
            <Icon name="chevronRight" size={18} className="shrink-0 text-[var(--theme-muted-text)]" />
          </button>
        ))}
        {tasks.length === 0 ? <p className="py-6 text-center text-[13px] text-[var(--theme-muted-text)]">먼저 과제를 만들어 주세요.</p> : null}
      </div>
    );
  } else if (step.kind === 'stage') {
    footer = <>
      <Button variant="ghost" onClick={() => setStep({ kind: 'task' })}>과제 다시 고르기</Button>
      <Button variant="primary" icon="qr" data-tour="task-qr-start" disabled={!task} onClick={() => { setLines([]); setManual(''); setStep({ kind: 'scan', taskId: step.taskId }); }}>QR 찍기 시작</Button>
    </>;
    body = (
      <div className="space-y-4">
        <p className="text-sm font-bold">{task?.title ?? '삭제된 과제'}</p>
        <div>
          <p className="mb-1.5 text-[13px] font-bold">QR을 찍은 학생을 어느 단계로 바꿀까요?</p>
          <StageChoice label="바꿀 단계" value={stage} onChange={setStage} />
        </div>
        {stage === 'COMPLETED' && task && task.reward > 0 ? (
          <Switch checked={withReward} onChange={setWithReward} ariaLabel="보상도 주기" label="보상도 주기"
            description={`완료로 바꾼 학생에게 ${withObjectParticle(money(task.reward, unit))} 줘요. 끄면 보상 없이 완료로만 바꿔요.`} />
        ) : null}
        <p className="text-xs leading-relaxed text-[var(--theme-muted-text)]">이미 그 단계인 학생은 그대로 두고 알려 드려요.</p>
      </div>
    );
  } else {
    footer = <>
      <Button variant="ghost" onClick={() => setStep({ kind: 'stage', taskId: step.taskId })}>단계 바꾸기</Button>
      <Button variant="primary" onClick={ledger.close}>닫기</Button>
    </>;
    body = (
      <div className="space-y-4">
        <p className="text-sm"><b>{task?.title ?? '삭제된 과제'}</b> → <b>{stageLabel(stage)}</b>{rewarding ? ' (보상도 주기)' : ''}</p>
        <div className="flex justify-center overflow-hidden rounded-[var(--crs-radius-lg)] bg-[var(--crs-subtle)]"><QrScanner onScan={(text) => void scan(text)} /></div>
        {manualInputEnabled ? (
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); const value = manual; setManual(''); void scan(value); }}>
            <Field label="학생 QR 직접 입력" htmlFor="ledger-qr-manual" className="flex-1">
              <Input id="ledger-qr-manual" aria-label="학생 QR 직접 입력" value={manual} onChange={(event) => setManual(event.target.value)} placeholder="S001" />
            </Field>
            <Button type="submit" disabled={!manual.trim()}>적용</Button>
          </form>
        ) : null}
        <ol role="log" aria-label="QR 결과" className="space-y-1.5">
          {lines.map((line) => (
            <li key={line.id} className={cx('flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13px] font-semibold',
              line.tone === 'changed' ? 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]'
                : line.tone === 'failed' ? 'bg-[var(--crs-danger-bg)] text-[var(--crs-danger-text)]'
                  : 'bg-[var(--crs-subtle)] text-[var(--theme-muted-text)]')}>
              <Icon name={line.tone === 'changed' ? 'check' : line.tone === 'failed' ? 'alert' : line.tone === 'same' ? 'info' : 'clock'} size={15} className="shrink-0" />
              <span className="min-w-0 flex-1">{line.text}</span>
            </li>
          ))}
          {lines.length === 0 ? <li className="text-center text-[13px] text-[var(--theme-muted-text)]">학생 QR을 찍으면 결과가 여기에 보여요.</li> : null}
        </ol>
      </div>
    );
  }

  return (
    <Modal title={title} ariaLabel={title} size="md" opener={opener} onClose={ledger.close} footer={footer}>
      {body}
    </Modal>
  );
}
