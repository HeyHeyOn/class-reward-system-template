import { Temporal } from '@js-temporal/polyfill';

export type TaskAvailability = { availableFrom?: string; dueAt?: string };
export type TaskAvailabilityState = 'UPCOMING' | 'AVAILABLE' | 'EXPIRED';

function instant(value: string, label: string): Temporal.Instant {
  try { return Temporal.Instant.from(value); } catch { throw new Error(`${label}은 ISO 시각이어야 합니다.`); }
}

export function validateTaskAvailability(value: TaskAvailability): TaskAvailability {
  const availableFrom = value.availableFrom?.trim() || undefined;
  const dueAt = value.dueAt?.trim() || undefined;
  const start = availableFrom ? instant(availableFrom, '시작 시각') : null;
  const due = dueAt ? instant(dueAt, '기한') : null;
  if (start && due && Temporal.Instant.compare(start, due) >= 0) throw new Error('시작 시각은 기한보다 빨라야 합니다.');
  return { ...(start ? { availableFrom: start.toString() } : {}), ...(due ? { dueAt: due.toString() } : {}) };
}

export function classifyTaskAvailability(value: TaskAvailability, now = new Date().toISOString()): TaskAvailabilityState {
  const checked = validateTaskAvailability(value);
  const current = instant(now, '현재 시각');
  if (checked.availableFrom && Temporal.Instant.compare(current, instant(checked.availableFrom, '시작 시각')) < 0) return 'UPCOMING';
  if (checked.dueAt && Temporal.Instant.compare(current, instant(checked.dueAt, '기한')) >= 0) return 'EXPIRED';
  return 'AVAILABLE';
}

export const isTaskAvailable = (value: TaskAvailability, now?: string) => classifyTaskAvailability(value, now) === 'AVAILABLE';