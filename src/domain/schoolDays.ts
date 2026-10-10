/** School days in a week: growth estimates count only these. */
export const SCHOOL_DAYS_PER_WEEK = 5;

/** '약 3주', '약 4일': school days as a teacher reads them. */
export function schoolDaysLabel(days: number): string {
  if (days < SCHOOL_DAYS_PER_WEEK * 2) return `약 ${days}일`;
  const weeks = Math.round((days / SCHOOL_DAYS_PER_WEEK) * 2) / 2;
  return `약 ${weeks.toLocaleString('ko-KR')}주`;
}

/** '약 3주 (평일 14일)', or '평일 약 4일' when it is under two weeks. */
export function schoolDaysEstimate(days: number): string {
  return days < SCHOOL_DAYS_PER_WEEK * 2 ? `평일 약 ${days}일` : `${schoolDaysLabel(days)} (평일 ${days}일)`;
}
