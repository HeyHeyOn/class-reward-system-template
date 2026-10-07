'use client';

import { Button, Callout, Checkbox, Field, Icon, IconButton, Input, SegmentedControl, Select, Switch, Textarea, cx } from '../ui';
import type { AssignmentFilter, StudentDraft, TaskAssignmentDraft, TaskDraft } from './adminTypes';
import { formatShortDate, isoToSeoulLocal, seoulLocalToIso } from './adminDates';

export function TaskBasicFields({ values, tasks, selfTaskId, unit, onChange }: {
  values: Pick<TaskDraft, 'title' | 'description' | 'reward' | 'isActive' | 'sortOrder' | 'availableFrom' | 'dueAt' | 'prerequisiteTaskId'>;
  tasks: TaskDraft[];
  selfTaskId: string | null;
  unit: string;
  onChange: (patch: Partial<TaskDraft>) => void;
}) {
  const prefix = selfTaskId ?? '새 과제';
  const availableFrom = isoToSeoulLocal(values.availableFrom);
  const dueAt = isoToSeoulLocal(values.dueAt);
  return (
    <div className="space-y-5">
      <Field label="과제 이름" htmlFor="task-sheet-title">
        <Input id="task-sheet-title" aria-label={selfTaskId ? `${prefix} 과제명` : '새 과제명'} data-autofocus placeholder="수학 익힘책 42~45쪽" value={values.title} onChange={(event) => onChange({ title: event.target.value })} />
      </Field>
      <Field label="설명" htmlFor="task-sheet-description" optional hint="학생이 은행에서 과제를 누르면 보이는 안내입니다.">
        <Textarea id="task-sheet-description" aria-label={selfTaskId ? `${prefix} 과제 설명` : '새 과제 설명'} placeholder="풀고 채점까지 끝내기" value={values.description} onChange={(event) => onChange({ description: event.target.value })} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="보상" htmlFor="task-sheet-reward" hint="학생이 은행에서 완료하면 받습니다.">
          <Input id="task-sheet-reward" aria-label={selfTaskId ? `${prefix} 보상` : '새 과제 보상'} type="number" inputMode="numeric" min="0" suffix={unit} value={Number.isFinite(values.reward) ? values.reward : 0} onChange={(event) => onChange({ reward: Number(event.target.value) })} />
        </Field>
        <Field label="목록 순서" htmlFor="task-sheet-order" hint="작은 숫자가 위에 보입니다.">
          <Input id="task-sheet-order" aria-label={selfTaskId ? `${prefix} 정렬` : '새 과제 정렬'} type="number" inputMode="numeric" value={Number.isFinite(values.sortOrder) ? values.sortOrder : 0} onChange={(event) => onChange({ sortOrder: Number(event.target.value) })} />
        </Field>
      </div>
      <Switch checked={Boolean(values.isActive)} ariaLabel={selfTaskId ? `${prefix} 활성` : '새 과제 활성'} onChange={(checked) => onChange({ isActive: checked })}
        label="학생에게 보이기" description="끄면 은행 화면에서 이 과제가 숨겨집니다." />
      <fieldset className="rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)] p-4">
        <legend className="flex items-center gap-1.5 px-1.5 text-[13px] font-bold"><Icon name="calendar" size={15} />기간 <span className="font-medium text-[var(--theme-muted-text)]">선택</span></legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="시작" htmlFor="task-sheet-from" hint={availableFrom ? undefined : '비워 두면 바로 시작합니다.'}>
            <div className="flex gap-1.5">
              <Input id="task-sheet-from" aria-label="시작 시각" type="datetime-local" value={availableFrom} onChange={(event) => onChange({ availableFrom: seoulLocalToIso(event.target.value) || undefined })} />
              {availableFrom ? <IconButton icon="close" size="md" label="시작 시각 지우기" onClick={() => onChange({ availableFrom: undefined })} /> : null}
            </div>
          </Field>
          <Field label="마감" htmlFor="task-sheet-due" hint={dueAt ? undefined : '비워 두면 마감이 없습니다.'}>
            <div className="flex gap-1.5">
              <Input id="task-sheet-due" aria-label="기한" type="datetime-local" value={dueAt} onChange={(event) => onChange({ dueAt: seoulLocalToIso(event.target.value) || undefined })} />
              {dueAt ? <IconButton icon="close" size="md" label="기한 지우기" onClick={() => onChange({ dueAt: undefined })} /> : null}
            </div>
          </Field>
        </div>
      </fieldset>
      <Field label="먼저 끝내야 하는 과제" htmlFor="task-sheet-prerequisite" optional hint="고르면 그 과제를 완료한 학생만 이 과제를 할 수 있습니다.">
        <Select id="task-sheet-prerequisite" aria-label="선행 과제" value={values.prerequisiteTaskId ?? ''} onChange={(event) => onChange({ prerequisiteTaskId: event.target.value || undefined })}>
          <option value="">없음</option>
          {tasks.filter((task) => task.isActive && task.taskId !== selfTaskId).map((task) => <option key={task.taskId} value={task.taskId}>{task.title}</option>)}
        </Select>
      </Field>
    </div>
  );
}

export function NewTaskStudentPicker({ students, selectedIds, onChange }: { students: StudentDraft[]; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const all = students.length > 0 && selectedIds.length === students.length;
  return (
    <div className="space-y-4">
      <Callout tone="info">고른 학생만 은행에서 이 과제를 보고 완료할 수 있습니다. 나중에 학생 현황 탭이나 QR로 더 부여할 수 있습니다.</Callout>
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2.5 text-sm font-bold">
          <Checkbox aria-label="전체 학생 행 선택" checked={all} onChange={(event) => onChange(event.target.checked ? students.map((student) => student.studentId) : [])} />
          전체 학생
        </label>
        <span className="text-[13px] font-semibold tabular-nums text-[var(--theme-muted-text)]">{selectedIds.length} / {students.length}명</span>
      </div>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {students.map((student) => {
          const checked = selectedIds.includes(student.studentId);
          return (
            <label key={student.studentId} className={cx('flex cursor-pointer items-center gap-3 rounded-[12px] border px-3.5 py-2.5 text-sm transition-colors',
              checked ? 'border-[var(--theme-accent-text)] bg-[var(--theme-accent-soft)]' : 'border-[var(--crs-line)] hover:bg-[var(--crs-subtle)]')}>
              <Checkbox aria-label={`${student.studentId} ${student.name} 부여 상태`} checked={checked}
                onChange={() => onChange(checked ? selectedIds.filter((id) => id !== student.studentId) : [...selectedIds, student.studentId])} />
              <span className="w-8 shrink-0 text-xs font-semibold tabular-nums text-[var(--theme-muted-text)]">{student.studentId}</span>
              <span className="truncate font-bold">{student.name}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function TaskAssignmentBoard({ editor, task, students, filter, onFilterChange, onToggleRow, onSelectRows, onToggleAssigned, onToggleCompleted, onBulkAssigned, onBulkCompleted }: {
  editor: TaskAssignmentDraft;
  task: TaskDraft | null;
  students: StudentDraft[];
  filter: AssignmentFilter;
  onFilterChange: (filter: AssignmentFilter) => void;
  onToggleRow: (studentId: string) => void;
  onSelectRows: (ids: string[]) => void;
  onToggleAssigned: (studentId: string) => void;
  onToggleCompleted: (studentId: string) => void;
  onBulkAssigned: (status: 'assigned' | 'unassigned') => void;
  onBulkCompleted: (status: 'completed' | 'incomplete') => void;
}) {
  const assignedCount = editor.assignedIds.length;
  const completedCount = editor.completedIds.length;
  const rows = students.filter((student) => {
    const assigned = editor.assignedIds.includes(student.studentId);
    const completed = editor.completedIds.includes(student.studentId);
    if (filter === 'completed') return completed;
    if (filter === 'pending') return assigned && !completed;
    if (filter === 'unassigned') return !assigned;
    return true;
  });
  const visibleIds = rows.map((student) => student.studentId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => editor.selectedIds.includes(id));
  const permanent = task?.currentCycle?.transition === 'PERMANENT';
  const cycle = task?.currentCycle;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="부여" value={`${assignedCount}명`} />
        <MiniStat label="완료" value={`${completedCount}명`} />
        <MiniStat label="남은 학생" value={`${Math.max(0, assignedCount - editor.completedIds.filter((id) => editor.assignedIds.includes(id)).length)}명`} />
      </div>
      {cycle && !permanent ? (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--theme-muted-text)]"><Icon name="repeat" size={14} />이번 회차 · {formatShortDate(cycle.startsAt)}{cycle.endsAt ? ` ~ ${formatShortDate(cycle.endsAt)}` : ''}</p>
      ) : null}
      <p className="text-xs leading-relaxed text-[var(--theme-muted-text)]">
        부여한 학생만 은행에서 이 과제를 완료할 수 있습니다. 여기서 완료로 표시하면 보상은 지급되지 않습니다.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl ariaLabel="학생 현황 필터" size="sm" value={filter} onChange={onFilterChange}
          options={[{ value: 'all', label: '전체', count: students.length }, { value: 'pending', label: '진행 중' }, { value: 'completed', label: '완료' }, { value: 'unassigned', label: '미부여' }]} />
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2">
        <label className="flex items-center gap-2 text-[13px] font-bold">
          <Checkbox aria-label="전체 학생 행 선택" checked={allVisibleSelected}
            onChange={(event) => onSelectRows(event.target.checked ? Array.from(new Set([...editor.selectedIds, ...visibleIds])) : editor.selectedIds.filter((id) => !visibleIds.includes(id)))} />
          {editor.selectedIds.length ? `${editor.selectedIds.length}명 선택` : '전체 선택'}
        </label>
        {editor.selectedIds.length ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => onBulkAssigned('assigned')}>부여</Button>
            <Button size="sm" variant="secondary" onClick={() => onBulkAssigned('unassigned')}>부여 취소</Button>
            <Button size="sm" variant="secondary" onClick={() => onBulkCompleted('completed')}>완료</Button>
            <Button size="sm" variant="secondary" onClick={() => onBulkCompleted('incomplete')}>미완료</Button>
          </div>
        ) : null}
      </div>
      <div className="relative divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)]">
        {editor.isLoading ? (
          <div role="status" aria-label="과제 부여 상태 불러오는 중" className="absolute inset-0 z-10 flex items-center justify-center rounded-[var(--crs-radius-lg)] bg-[color-mix(in_srgb,var(--theme-surface)_85%,transparent)] text-[13px] font-bold text-[var(--theme-muted-text)]">
            학생별 상태를 불러오는 중입니다.
          </div>
        ) : null}
        {rows.map((student) => {
          const selected = editor.selectedIds.includes(student.studentId);
          const assigned = editor.assignedIds.includes(student.studentId);
          const completed = editor.completedIds.includes(student.studentId);
          return (
            <div key={student.studentId} data-testid={`task-assignment-row-${student.studentId}`} className={cx('flex items-center gap-3 px-3.5 py-2.5', selected && 'bg-[var(--crs-subtle)]')}>
              <Checkbox aria-label={`${student.studentId} ${student.name} 행 선택`} checked={selected} onChange={() => onToggleRow(student.studentId)} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="w-8 shrink-0 text-xs font-semibold tabular-nums text-[var(--theme-muted-text)]">{student.studentId}</span>
                  <span className="truncate text-sm font-bold">{student.name}</span>
                </span>
              </span>
              <StatusToggle label={`${student.studentId} ${student.name} 부여 상태`} on={assigned} onText="부여" offText="미부여" tone="accent" onClick={() => onToggleAssigned(student.studentId)} />
              <StatusToggle label={`${student.studentId} ${student.name} 완료 상태`} on={completed} onText="완료" offText="미완료" tone="success" onClick={() => onToggleCompleted(student.studentId)} />
            </div>
          );
        })}
        {rows.length === 0 ? <p className="px-4 py-8 text-center text-[13px] text-[var(--theme-muted-text)]">해당하는 학생이 없습니다.</p> : null}
      </div>
    </div>
  );
}

export function BulkAssignmentBoard({ editor, students, onToggleRow, onSelectRows, onOperation, onBulkAssigned, onBulkCompleted }: {
  editor: TaskAssignmentDraft;
  students: StudentDraft[];
  onToggleRow: (studentId: string) => void;
  onSelectRows: (ids: string[]) => void;
  onOperation: (studentId: string, field: 'assigned' | 'completed', value: string) => void;
  onBulkAssigned: (status: 'assigned' | 'unassigned') => void;
  onBulkCompleted: (status: 'completed' | 'incomplete') => void;
}) {
  const all = students.length > 0 && editor.selectedIds.length === students.length;
  return (
    <div className="space-y-4">
      <Callout tone="info">선택한 모든 과제에 같은 변경을 적용합니다. 바꾸고 싶은 학생만 고르세요. 고르지 않은 학생은 그대로 둡니다.</Callout>
      <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2">
        <label className="flex items-center gap-2 text-[13px] font-bold">
          <Checkbox aria-label="전체 학생 행 선택" checked={all} onChange={(event) => onSelectRows(event.target.checked ? students.map((student) => student.studentId) : [])} />
          {editor.selectedIds.length ? `${editor.selectedIds.length}명 선택` : '전체 선택'}
        </label>
        {editor.selectedIds.length ? (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="sm" onClick={() => onBulkAssigned('assigned')}>부여</Button>
            <Button size="sm" onClick={() => onBulkAssigned('unassigned')}>부여 취소</Button>
            <Button size="sm" onClick={() => onBulkCompleted('completed')}>완료</Button>
            <Button size="sm" onClick={() => onBulkCompleted('incomplete')}>미완료</Button>
          </div>
        ) : null}
      </div>
      <div className="divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius-lg)] border border-[var(--crs-line)]">
        {students.map((student) => {
          const operation = editor.operations[student.studentId];
          return (
            <div key={student.studentId} data-testid={`task-assignment-row-${student.studentId}`} className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <Checkbox aria-label={`${student.studentId} ${student.name} 행 선택`} checked={editor.selectedIds.includes(student.studentId)} onChange={() => onToggleRow(student.studentId)} />
              <span className="w-8 shrink-0 text-xs font-semibold tabular-nums text-[var(--theme-muted-text)]">{student.studentId}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-bold">{student.name}</span>
              <select aria-label={`${student.studentId} ${student.name} 부여 작업`} value={typeof operation?.assigned === 'boolean' ? (operation.assigned ? 'assigned' : 'unassigned') : ''}
                onChange={(event) => onOperation(student.studentId, 'assigned', event.target.value)}
                className="h-8 rounded-[9px] border border-[var(--crs-line-strong)] bg-[var(--theme-input)] px-2 text-xs font-bold">
                <option value="">부여 그대로</option><option value="assigned">부여</option><option value="unassigned">미부여</option>
              </select>
              <select aria-label={`${student.studentId} ${student.name} 완료 작업`} value={typeof operation?.completed === 'boolean' ? (operation.completed ? 'completed' : 'incomplete') : ''}
                onChange={(event) => onOperation(student.studentId, 'completed', event.target.value)}
                className="h-8 rounded-[9px] border border-[var(--crs-line-strong)] bg-[var(--theme-input)] px-2 text-xs font-bold">
                <option value="">완료 그대로</option><option value="completed">완료</option><option value="incomplete">미완료</option>
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[12px] bg-[var(--crs-subtle)] px-3 py-2.5">
      <p className="text-[11px] font-semibold text-[var(--theme-muted-text)]">{label}</p>
      <p className="mt-0.5 text-lg font-black tabular-nums">{value}</p>
    </div>
  );
}

function StatusToggle({ label, on, onText, offText, tone, onClick }: { label: string; on: boolean; onText: string; offText: string; tone: 'accent' | 'success'; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} aria-pressed={on} onClick={onClick}
      className={cx('inline-flex h-8 min-w-[64px] shrink-0 items-center justify-center gap-1 rounded-full px-3 text-xs font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)]',
        on
          ? tone === 'success' ? 'bg-[var(--crs-success-bg)] text-[var(--crs-success-text)]' : 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)]'
          : 'border border-[var(--crs-line-strong)] text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)]')}>
      {on ? <Icon name="check" size={13} strokeWidth={2.6} /> : null}{on ? onText : offText}
    </button>
  );
}
