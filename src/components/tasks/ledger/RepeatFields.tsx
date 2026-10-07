'use client';

import type { TaskStage } from '@/domain/taskStage';
import type { IsoWeekday } from '@/domain/types';
import { Field, Icon, Input, SegmentedControl, Select, cx } from '../../ui';
import {
  formatInstant, previewNextReset, recurrenceSummary, repeatFromForm, resetStageSummary, stageLabel, TASK_STAGES, toWord,
  type RepeatForm, type RepeatType,
} from './ledgerFormat';

const WEEKDAYS: Array<{ label: string; iso: IsoWeekday }> = [
  { label: '월', iso: 1 }, { label: '화', iso: 2 }, { label: '수', iso: 3 }, { label: '목', iso: 4 }, { label: '금', iso: 5 }, { label: '토', iso: 6 }, { label: '일', iso: 7 },
];

const TYPE_OPTIONS: Array<{ value: RepeatType; label: string }> = [
  { value: 'NONE', label: '반복 없음' },
  { value: 'DAILY', label: '매일' },
  { value: 'WEEKLY', label: '매주' },
  { value: 'MONTHLY', label: '매월' },
];

/**
 * Repeat rule + what happens at each reset. Seoul time. Every change goes through `onChange`;
 * saving is the caller's job.
 */
export function RepeatFields({ form, onChange, now, idPrefix = 'ledger-repeat', showNextReset = true }: {
  form: RepeatForm;
  onChange: (form: RepeatForm) => void;
  now: string | null;
  idPrefix?: string;
  /** Show "저장하면 다음 초기화" (only meaningful while the form differs from what is saved). */
  showNextReset?: boolean;
}) {
  const repeating = form.type === 'DAILY' || form.type === 'WEEKLY' || form.type === 'MONTHLY';
  const checked = repeatFromForm(form);
  const next = showNextReset && checked.ok && now ? previewNextReset(checked.value, now) : null;
  return (
    <div className="space-y-5">
      <div>
        <p className="mb-1.5 text-[13px] font-bold">반복 주기</p>
        <SegmentedControl<RepeatType | ''> ariaLabel="반복 주기" value={form.type} options={TYPE_OPTIONS}
          onChange={(type) => onChange({ ...form, type })} />
        {!form.type ? <p className="mt-2 text-xs text-[var(--theme-muted-text)]">고른 과제 모두에 같은 반복을 적용해요. 주기를 골라 주세요.</p> : null}
      </div>

      {form.type === 'WEEKLY' ? (
        <fieldset aria-label="반복 요일">
          <legend className="mb-1.5 text-[13px] font-bold">요일</legend>
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map(({ label, iso }) => {
              const selected = form.weekdays.includes(iso);
              return (
                <button key={iso} type="button" aria-label={`${label}요일`} aria-pressed={selected}
                  onClick={() => {
                    if (selected && form.weekdays.length === 1) return;
                    const weekdays = (selected ? form.weekdays.filter((day) => day !== iso) : [...form.weekdays, iso]).sort((a, b) => a - b);
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
          {form.type === 'MONTHLY' ? (
            <Field label="날짜" htmlFor={`${idPrefix}-day`} hint="29~31일이 없는 달은 그 달 마지막 날에 초기화해요.">
              <Input id={`${idPrefix}-day`} aria-label="반복 날짜" type="number" min="1" max="31" inputMode="numeric" suffix="일"
                value={form.dayOfMonth} onChange={(event) => onChange({ ...form, dayOfMonth: event.target.value })} />
            </Field>
          ) : null}
          <Field label="초기화 시각" htmlFor={`${idPrefix}-time`} hint="서울 시각이에요.">
            <Input id={`${idPrefix}-time`} aria-label="반복 시간" type="time" value={form.time} onChange={(event) => onChange({ ...form, time: event.target.value })} />
          </Field>
        </div>
      ) : null}

      {repeating ? (
        <Field label="초기화하면" htmlFor={`${idPrefix}-reset-stage`}
          hint="이 과제를 가진 학생(미부여가 아닌 학생)이 모두 고른 단계로 바뀌어요. 미부여인 학생은 그대로예요.">
          <Select id={`${idPrefix}-reset-stage`} aria-label="초기화하면" value={form.resetStage}
            onChange={(event) => onChange({ ...form, resetStage: event.target.value as TaskStage | 'NONE' })}>
            {TASK_STAGES.map((stage) => <option key={stage} value={stage}>{toWord(stageLabel(stage))} 바꾸기</option>)}
            <option value="NONE">초기화 안 함</option>
          </Select>
        </Field>
      ) : form.type === 'NONE' ? (
        <p className="rounded-[var(--crs-radius)] bg-[var(--crs-subtle)] px-4 py-3 text-[13px] leading-relaxed text-[var(--theme-muted-text)]">
          저절로 초기화되지 않아요. 매주 하는 숙제처럼 다시 해야 하는 과제라면 주기를 골라 주세요.
        </p>
      ) : null}

      {checked.ok ? (
        <p className="flex items-start gap-2 text-[13px] font-semibold text-[var(--theme-accent-text)]">
          <Icon name="repeat" size={15} className="mt-0.5 shrink-0" />
          <span>
            {recurrenceSummary(checked.value.recurrence)}
            {checked.value.recurrence.type !== 'NONE' ? ` · ${resetStageSummary(checked.value.resetStage)}` : ''}
            {next ? <span className="block text-xs font-medium text-[var(--theme-muted-text)]">저장하면 다음 초기화: {formatInstant(next, now)}</span> : null}
          </span>
        </p>
      ) : form.type ? <p role="alert" className="text-xs font-semibold text-[var(--crs-danger-text)]">{checked.error}</p> : null}
    </div>
  );
}
