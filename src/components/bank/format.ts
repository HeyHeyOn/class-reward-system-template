const SEOUL = 'Asia/Seoul';

export function formatMoney(value: number, unit: string): string {
  return `${value.toLocaleString('ko-KR')}${unit}`;
}

export function formatSignedMoney(value: number, unit: string): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toLocaleString('ko-KR')}${unit}`;
}

function validDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Calendar day in Seoul, used to group the transaction history. */
export function seoulDayKey(value: string): string {
  const date = validDate(value);
  if (!date) return 'unknown';
  return new Intl.DateTimeFormat('en-CA', { timeZone: SEOUL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function formatSeoulDay(value: string, now = new Date()): string {
  const date = validDate(value);
  if (!date) return '날짜 없음';
  const key = seoulDayKey(value);
  if (key === seoulDayKey(now.toISOString())) return '오늘';
  if (key === seoulDayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString())) return '어제';
  const sameYear = key.slice(0, 4) === seoulDayKey(now.toISOString()).slice(0, 4);
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: SEOUL, ...(sameYear ? {} : { year: 'numeric' }), month: 'long', day: 'numeric', weekday: 'short',
  }).format(date);
}

export function formatSeoulTime(value: string): string {
  const date = validDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat('ko-KR', { timeZone: SEOUL, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

export function formatSeoulDateTime(value: string): string {
  const date = validDate(value);
  if (!date) return value;
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: SEOUL, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(date);
}
