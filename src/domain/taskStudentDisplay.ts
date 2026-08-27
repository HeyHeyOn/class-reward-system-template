import type { TaskRecurrence } from './types';

const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
export function formatStudentTaskDue(dueAt?: string): string {
  if (!dueAt) return '기한: 없음';
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(dueAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  const dayPeriod = part('dayPeriod');
  const koreanDayPeriod = dayPeriod === 'AM' ? '오전' : dayPeriod === 'PM' ? '오후' : dayPeriod;
  return `기한: ${part('year')}년 ${part('month')}월 ${part('day')}일 ${koreanDayPeriod} ${part('hour')}:${part('minute')}까지`;
}
export function formatStudentTaskRecurrence(recurrence?: TaskRecurrence): string {
  if (!recurrence || recurrence.type === 'NONE') return '반복: 없음';
  if (recurrence.type === 'DAILY') return '반복: 매일';
  if (recurrence.type === 'WEEKLY') return `반복: 매주 ${recurrence.weekdays.map((day) => DAYS[day - 1]).join(', ')}`;
  return `반복: 매월 ${recurrence.dayOfMonth}일`;
}