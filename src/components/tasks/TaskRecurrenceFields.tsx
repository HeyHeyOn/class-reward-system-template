'use client';

import type { TaskCurrentCycleStatusDto } from '@/domain/taskHistoryDtos';
import type { TaskSchedule } from '@/domain/types';
import { formatAdminHistoryDate } from '../adminTaskHistory';
import { formatRecurrenceSummary, resolveEffectiveAdminTaskSchedule, type TaskRecurrenceForm } from '../taskRecurrenceEditor';

const WEEKDAYS = [{ label: '일', iso: 7 }, { label: '월', iso: 1 }, { label: '화', iso: 2 }, { label: '수', iso: 3 }, { label: '목', iso: 4 }, { label: '금', iso: 5 }, { label: '토', iso: 6 }] as const;

type RecurrenceStyles = { detail?: string; preview?: string };

export function TaskRecurrenceFields({ form, onChange, styles = {} }: { form: TaskRecurrenceForm; onChange: (form: TaskRecurrenceForm) => void; styles?: RecurrenceStyles }) {
  return (
    <div className="mt-4 space-y-3">
      <label className="block text-sm font-bold text-slate-700">
        <span>반복 주기</span>
        <select aria-label="반복 주기" value={form.type ?? 'NONE'} onChange={(event) => onChange({ ...form, type: event.target.value as TaskRecurrenceForm['type'] })} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-3 text-slate-950">
          <option value="NONE">반복 없음</option><option value="DAILY">매일</option><option value="WEEKLY">매주</option><option value="MONTHLY">매월</option>
        </select>
      </label>
      {form.type !== 'NONE' ? <label className="block text-sm font-bold text-slate-700"><span>실행 시간</span><input aria-label="반복 시간" type="time" value={form.time ?? ''} onChange={(event) => onChange({ ...form, time: event.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-3 text-slate-950" /></label> : null}
      {form.type === 'WEEKLY' ? <fieldset aria-label="반복 요일"><legend className="text-sm font-bold text-slate-700">요일</legend><div className="mt-1 flex flex-wrap gap-2">{WEEKDAYS.map(({ label, iso }) => { const selected = form.weekdays.includes(String(iso)); return <button key={iso} type="button" aria-label={`${label}요일`} aria-pressed={selected} onClick={() => {
        if (selected && form.weekdays.length === 1) return;
        const weekdays = (selected ? form.weekdays.filter((value) => value !== String(iso)) : [...form.weekdays, String(iso)])
          .sort((a, b) => Number(a) - Number(b));
        onChange({ ...form, weekdays });
      }} className={`h-11 w-11 rounded-full border font-black ${selected ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-400 bg-white text-slate-700'}`}>{label}</button>; })}</div></fieldset> : null}
      {form.type === 'MONTHLY' ? <div><label className="block text-sm font-bold text-slate-700"><span>날짜 (1~31)</span><input aria-label="반복 날짜" type="number" min="1" max="31" value={form.dayOfMonth ?? ''} onChange={(event) => onChange({ ...form, dayOfMonth: event.target.value })} className="mt-1 w-full rounded-xl border border-slate-200 bg-white p-3 text-slate-950" /></label><p className={`mt-1 text-xs font-bold ${styles.detail ?? 'text-slate-500'}`}>29/30/31일이 없는 달은 해당 월 말일로 당겨집니다.</p></div> : null}
      <div className="grid gap-2 sm:grid-cols-2"><label className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm font-bold"><input aria-label="회차마다 완료 초기화" type="checkbox" checked={Boolean(form.resetCompletionOnCycle)} onChange={(event) => onChange({ ...form, resetCompletionOnCycle: event.target.checked })} />완료 초기화</label><label className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm font-bold"><input aria-label="회차마다 부여 초기화" type="checkbox" checked={Boolean(form.resetAssignmentOnCycle)} onChange={(event) => onChange({ ...form, resetAssignmentOnCycle: event.target.checked })} />부여 초기화</label></div>
      <p className={`text-sm font-black ${styles.preview ?? 'text-slate-700'}`}>미리보기: {formatRecurrenceSummary(form)}</p>
    </div>
  );
}

export function TaskScheduleProjection({ task, className = '' }: { task: { schedule?: TaskSchedule; pendingSchedule?: TaskSchedule | null; currentCycle?: TaskCurrentCycleStatusDto }; className?: string }) {
  const schedule = resolveEffectiveAdminTaskSchedule(task);
  const cycle = task.currentCycle;
  const timeZone = schedule?.timeZone;
  const boundary = schedule?.recurrence.type === 'NONE'
    ? '없음 (상시 과제)'
    : cycle?.endsAt ? formatAdminHistoryDate(cycle.endsAt, timeZone) : '정보 없음';
  const resetTargets = schedule
    ? [schedule.resetCompletionOnCycle ? '완료 상태 초기화' : '완료 상태 유지', schedule.resetAssignmentOnCycle ? '부여 상태 초기화' : '부여 상태 유지'].join(' · ')
    : '완료 상태 유지 · 부여 상태 유지';
  const cycleRange = schedule?.recurrence.type === 'NONE'
    ? '상시'
    : cycle ? `${formatAdminHistoryDate(cycle.startsAt, timeZone)} ~ ${cycle.endsAt ? formatAdminHistoryDate(cycle.endsAt, timeZone) : '계속'}` : '정보 없음';

  return (
    <div className={`mt-3 rounded-xl p-3 text-xs font-bold ${className}`}>
      <p>현재 일정: {formatRecurrenceSummary(schedule)}</p>
      <p>현재 회차: {cycleRange}</p>
      <p>다음 자연 경계: {boundary} · 다음 초기화 시각: {boundary} · 초기화 대상: {resetTargets}</p>
    </div>
  );
}
