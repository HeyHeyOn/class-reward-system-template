'use client';

import type { TaskCurrentCycleStatusDto } from '@/domain/taskHistoryDtos';
import type { TaskSchedule } from '@/domain/types';
import { formatAdminHistoryDate } from '../adminTaskHistory';
import { formatRecurrenceSummary, resolveEffectiveAdminTaskSchedule, type TaskRecurrenceForm } from '../taskRecurrenceEditor';
import { Field, Icon, Input, SegmentedControl, Switch, cx } from '../ui';

const WEEKDAYS = [{ label: '월', iso: 1 }, { label: '화', iso: 2 }, { label: '수', iso: 3 }, { label: '목', iso: 4 }, { label: '금', iso: 5 }, { label: '토', iso: 6 }, { label: '일', iso: 7 }] as const;

const TYPE_OPTIONS: Array<{ value: TaskRecurrenceForm['type']; label: string }> = [
  { value: 'NONE', label: '반복 없음' },
  { value: 'DAILY', label: '매일' },
  { value: 'WEEKLY', label: '매주' },
  { value: 'MONTHLY', label: '매월' },
];

/** Recurrence rule editor. Every change is reported through `onChange`; saving is the caller's job. */
export function TaskRecurrenceFields({ form, onChange, allowUnset = false }: { form: TaskRecurrenceForm; onChange: (form: TaskRecurrenceForm) => void; allowUnset?: boolean }) {
  const type = (form.type || (allowUnset ? '' : 'NONE')) as TaskRecurrenceForm['type'];
  const repeating = type === 'DAILY' || type === 'WEEKLY' || type === 'MONTHLY';
  return (
    <div className="space-y-5">
      <div>
        <p id="task-recurrence-type-label" className="mb-1.5 text-[13px] font-bold">반복 주기</p>
        <SegmentedControl ariaLabel="반복 주기" value={type} options={TYPE_OPTIONS}
          onChange={(next) => onChange({ ...form, type: next, ...(next === 'WEEKLY' && form.weekdays.length === 0 ? { weekdays: ['1'] } : {}), ...(next === 'MONTHLY' && !form.dayOfMonth ? { dayOfMonth: '1' } : {}), ...(next !== 'NONE' && !form.time ? { time: '09:00' } : {}) })} />
        {allowUnset && !type ? <p className="mt-2 text-xs text-[var(--theme-muted-text)]">선택한 과제 모두에 같은 반복 규칙을 적용합니다. 주기를 골라 주세요.</p> : null}
      </div>

      {type === 'WEEKLY' ? (
        <fieldset aria-label="반복 요일">
          <legend className="mb-1.5 text-[13px] font-bold">요일</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map(({ label, iso }) => {
              const selected = form.weekdays.includes(String(iso));
              return (
                <button key={iso} type="button" aria-label={`${label}요일`} aria-pressed={selected}
                  onClick={() => {
                    if (selected && form.weekdays.length === 1) return;
                    const weekdays = (selected ? form.weekdays.filter((value) => value !== String(iso)) : [...form.weekdays, String(iso)])
                      .sort((a, b) => Number(a) - Number(b));
                    onChange({ ...form, weekdays });
                  }}
                  className={cx('h-10 w-10 rounded-full text-sm font-bold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[var(--theme-focus-ring)] focus-visible:ring-offset-2',
                    selected ? 'bg-[var(--theme-accent-solid)] text-[var(--theme-accent-on-solid)]' : 'border border-[var(--crs-line-strong)] text-[var(--theme-muted-text)] hover:bg-[var(--crs-subtle-hover)]')}>
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {repeating ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {type === 'MONTHLY' ? (
            <Field label="날짜" htmlFor="task-recurrence-day" hint="29~31일이 없는 달은 그 달 마지막 날로 바뀝니다.">
              <Input id="task-recurrence-day" aria-label="반복 날짜" type="number" min="1" max="31" inputMode="numeric" suffix="일" value={form.dayOfMonth ?? ''} onChange={(event) => onChange({ ...form, dayOfMonth: event.target.value })} />
            </Field>
          ) : null}
          <Field label="새 회차 시작 시각" htmlFor="task-recurrence-time" hint="이 시각에 새 회차가 시작됩니다.">
            <Input id="task-recurrence-time" aria-label="반복 시간" type="time" value={form.time ?? ''} onChange={(event) => onChange({ ...form, time: event.target.value })} />
          </Field>
        </div>
      ) : null}

      {repeating ? (
        <div className="space-y-2">
          <p className="text-[13px] font-bold">새 회차가 시작되면</p>
          <Switch checked={Boolean(form.resetCompletionOnCycle)} ariaLabel="회차마다 완료 초기화"
            onChange={(checked) => onChange({ ...form, resetCompletionOnCycle: checked })}
            label="완료 기록 지우기" description="학생이 이 과제를 다시 완료하고 보상을 또 받을 수 있습니다." />
          <Switch checked={Boolean(form.resetAssignmentOnCycle)} ariaLabel="회차마다 부여 초기화"
            onChange={(checked) => onChange({ ...form, resetAssignmentOnCycle: checked })}
            label="부여 지우기" description="회차마다 과제를 받을 학생을 새로 정해야 합니다." />
        </div>
      ) : type === 'NONE' ? (
        <p className="rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-3 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
          한 번 완료하면 끝나는 과제입니다. 매주 하는 숙제처럼 되풀이되는 과제라면 주기를 골라 주세요.
        </p>
      ) : null}

      {type ? (
        <p className="flex items-center gap-2 text-[13px] font-semibold text-[var(--theme-accent-text)]">
          <Icon name="repeat" size={15} /> 미리보기: {formatRecurrenceSummary(form)}
        </p>
      ) : null}
    </div>
  );
}

export function TaskScheduleProjection({ task, className = '' }: { task: { schedule?: TaskSchedule; pendingSchedule?: TaskSchedule | null; currentCycle?: TaskCurrentCycleStatusDto }; className?: string }) {
  const schedule = resolveEffectiveAdminTaskSchedule(task);
  const cycle = task.currentCycle;
  const timeZone = schedule?.timeZone;
  const permanent = !schedule || schedule.recurrence.type === 'NONE';
  const boundary = permanent
    ? '없음 (상시 과제)'
    : cycle?.endsAt ? formatAdminHistoryDate(cycle.endsAt, timeZone) : '정보 없음';
  const resetTargets = schedule
    ? [schedule.resetCompletionOnCycle ? '완료 지움' : '완료 유지', schedule.resetAssignmentOnCycle ? '부여 지움' : '부여 유지'].join(' · ')
    : '완료 유지 · 부여 유지';
  const cycleRange = permanent
    ? '상시'
    : cycle ? `${formatAdminHistoryDate(cycle.startsAt, timeZone)} ~ ${cycle.endsAt ? formatAdminHistoryDate(cycle.endsAt, timeZone) : '계속'}` : '정보 없음';

  return (
    <dl className={cx('divide-y divide-[var(--crs-line)] rounded-[var(--crs-radius)] border border-[var(--crs-line)] px-4', className)}>
      <div className="flex justify-between gap-4 py-2.5 text-[13px]"><dt className="text-[var(--theme-muted-text)]">현재 일정</dt><dd className="text-right font-semibold">{formatRecurrenceSummary(schedule)}</dd></div>
      <div className="flex justify-between gap-4 py-2.5 text-[13px]"><dt className="text-[var(--theme-muted-text)]">현재 회차</dt><dd className="text-right font-semibold">{cycleRange}</dd></div>
      <div className="flex justify-between gap-4 py-2.5 text-[13px]"><dt className="text-[var(--theme-muted-text)]">다음 회차 시작</dt><dd className="text-right font-semibold">{boundary}</dd></div>
      <div className="flex justify-between gap-4 py-2.5 text-[13px]"><dt className="text-[var(--theme-muted-text)]">새 회차 처리</dt><dd className="text-right font-semibold">{resetTargets}</dd></div>
    </dl>
  );
}
