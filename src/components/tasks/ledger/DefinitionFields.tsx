'use client';

import type { AdminTaskDto } from '@/lib/taskLedgerApi';
import { Field, Icon, IconButton, Input, Select, Switch, Textarea } from '../../ui';
import type { DefinitionForm } from './ledgerFormat';

/** 기본 정보: title, description, reward, order, visibility, period (Seoul time) and prerequisite. */
export function DefinitionFields({ form, onChange, tasks, selfTaskId, unit, labelPrefix }: {
  form: DefinitionForm;
  onChange: (patch: Partial<DefinitionForm>) => void;
  tasks: readonly AdminTaskDto[];
  selfTaskId: string | null;
  unit: string;
  /** Accessible-name prefix: '새 과제' or the task title. */
  labelPrefix: string;
}) {
  const id = selfTaskId ? `ledger-task-${selfTaskId.replace(/[^A-Za-z0-9_-]/g, '_')}` : 'ledger-new-task';
  const prerequisites = tasks.filter((task) => task.taskId !== selfTaskId);
  const missingPrerequisite = form.prerequisiteTaskId && !prerequisites.some((task) => task.taskId === form.prerequisiteTaskId);
  return (
    <div className="space-y-5">
      <Field label="과제 이름" htmlFor={`${id}-title`}>
        <Input id={`${id}-title`} aria-label={`${labelPrefix} 과제 이름`} data-autofocus placeholder="수학 익힘책 42~45쪽" value={form.title}
          onChange={(event) => onChange({ title: event.target.value })} />
      </Field>
      <Field label="설명" htmlFor={`${id}-description`} optional hint="미완료, 완료 가능 단계의 학생이 은행에서 볼 수 있어요.">
        <Textarea id={`${id}-description`} aria-label={`${labelPrefix} 설명`} placeholder="풀고 채점까지 끝내기" value={form.description}
          onChange={(event) => onChange({ description: event.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="보상" htmlFor={`${id}-reward`} hint="학생이 은행에서 완료하면 받아요.">
          <Input id={`${id}-reward`} aria-label={`${labelPrefix} 보상`} type="number" inputMode="numeric" min="0" suffix={unit} value={form.reward}
            onChange={(event) => onChange({ reward: event.target.value })} />
        </Field>
        <Field label="목록 순서" htmlFor={`${id}-order`} hint="작은 숫자가 위에 보여요.">
          <Input id={`${id}-order`} aria-label={`${labelPrefix} 목록 순서`} type="number" inputMode="numeric" value={form.sortOrder}
            onChange={(event) => onChange({ sortOrder: event.target.value })} />
        </Field>
      </div>
      <Switch checked={form.isActive} ariaLabel={`${labelPrefix} 학생에게 보이기`} onChange={(checked) => onChange({ isActive: checked })}
        label="학생에게 보이기" description="끄면 은행 화면에서 이 과제가 숨겨져요." />
      <fieldset className="rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] p-4">
        <legend className="flex items-center gap-1.5 px-1.5 text-[13px] font-bold"><Icon name="calendar" size={15} />기간 <span className="font-medium text-[var(--theme-muted-text)]">선택</span></legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="시작" htmlFor={`${id}-from`} hint={form.availableFrom ? '서울 시각이에요.' : '비워 두면 바로 시작해요.'}>
            <div className="flex gap-1.5">
              <Input id={`${id}-from`} aria-label={`${labelPrefix} 시작 시각`} type="datetime-local" value={form.availableFrom}
                onChange={(event) => onChange({ availableFrom: event.target.value })} />
              {form.availableFrom ? <IconButton icon="close" label="시작 시각 지우기" onClick={() => onChange({ availableFrom: '' })} /> : null}
            </div>
          </Field>
          <Field label="마감" htmlFor={`${id}-due`} hint={form.dueAt ? '서울 시각이에요.' : '비워 두면 마감이 없어요.'}>
            <div className="flex gap-1.5">
              <Input id={`${id}-due`} aria-label={`${labelPrefix} 마감 시각`} type="datetime-local" value={form.dueAt}
                onChange={(event) => onChange({ dueAt: event.target.value })} />
              {form.dueAt ? <IconButton icon="close" label="마감 시각 지우기" onClick={() => onChange({ dueAt: '' })} /> : null}
            </div>
          </Field>
        </div>
      </fieldset>
      <Field label="먼저 끝내야 하는 과제" htmlFor={`${id}-prerequisite`} optional hint="고르면 그 과제를 완료한 학생만 이 과제를 완료할 수 있어요.">
        <Select id={`${id}-prerequisite`} aria-label={`${labelPrefix} 선행 과제`} value={form.prerequisiteTaskId}
          onChange={(event) => onChange({ prerequisiteTaskId: event.target.value })}>
          <option value="">없음</option>
          {missingPrerequisite ? <option value={form.prerequisiteTaskId}>삭제된 과제</option> : null}
          {prerequisites.map((task) => <option key={task.taskId} value={task.taskId}>{task.title}{task.isActive ? '' : ' (숨김)'}</option>)}
        </Select>
      </Field>
    </div>
  );
}
