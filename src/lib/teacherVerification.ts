// 교사 인증 (ddanssaem-hub/docs/account-protocol.md 10): the 딴쌤 hub verifies teachers with a public-service mail
// address and tells the class when the verification ends (`verifiedUntil`) and from when this teacher must be
// verified (`requiredFrom`). The class decides from those two and the clock: the hub's own `required` was only
// true when it answered. Shared by the server (blocking a new class) and the screens (the reminder).

export type TeacherVerification = Readonly<{ verifiedUntil: string | null; requiredFrom: string | null }>;

const DAY_MS = 86_400_000;
/** The reminder shows from this many days before the verification ends. */
export const REMINDER_DAYS = 30;
/** The hub's '내 계정' with the verification box open. */
export const VERIFY_PATH = '/account?verify=1';

const time = (value: string | null) => {
  const at = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(at) ? at : null;
};

export function isVerified(verification: TeacherVerification | null | undefined, now = Date.now()): boolean {
  const until = time(verification?.verifiedUntil ?? null);
  return until !== null && until > now;
}

/** Verification is required now (the teacher's grace ended, or they joined after it started) and missing. */
export function blocksNewClass(verification: TeacherVerification | null | undefined, now = Date.now()): boolean {
  const from = time(verification?.requiredFrom ?? null);
  return from !== null && now >= from && !isVerified(verification, now);
}

/**
 * For the renewal reminder: the days left (1 or more) when a verification ends within REMINDER_DAYS, 0 when it
 * has ended, null otherwise (far from its end, or never verified).
 */
export function reminderDays(verification: TeacherVerification | null | undefined, now = Date.now()): number | null {
  const until = time(verification?.verifiedUntil ?? null);
  if (until === null) return null;
  if (until <= now) return 0;
  const days = Math.ceil((until - now) / DAY_MS);
  return days <= REMINDER_DAYS ? days : null;
}

/** For a teacher not verified yet whose grace is running: the days until verification is required, or null. */
export function daysUntilRequired(verification: TeacherVerification | null | undefined, now = Date.now()): number | null {
  const from = time(verification?.requiredFrom ?? null);
  if (from === null || from <= now || isVerified(verification, now)) return null;
  return Math.ceil((from - now) / DAY_MS);
}

/** What the 내 학급 list says about new classes: blocked, a grace running out, or nothing. */
export type NewClassNote = Readonly<{ kind: 'blocked' }> | Readonly<{ kind: 'soon'; days: number }> | null;

export function newClassNote(verification: TeacherVerification | null | undefined, now = Date.now()): NewClassNote {
  if (blocksNewClass(verification, now)) return { kind: 'blocked' };
  const days = daysUntilRequired(verification, now);
  return days !== null && days <= REMINDER_DAYS ? { kind: 'soon', days } : null;
}

export const NEW_CLASS_BLOCKED = '교사 인증을 하면 새 학급을 만들 수 있어요.';
