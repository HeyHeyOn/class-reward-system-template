import { Temporal } from '@js-temporal/polyfill';
import { getNextNaturalTaskBoundary } from './taskRecurrence';
import { TASK_STAGE_ORDER, type TaskStage } from './taskStage';
import type { TaskRecurrence } from './types';

/**
 * Task progress without cycles: each (task, student) has a plain history of stage changes —
 * when it became 미부여, 미완료, 완료 가능 or 완료 — and the current stage is the latest one.
 * A repeating task adds automatic resets: at each scheduled time every student who has the
 * task (anything but 미부여) moves to the stage the teacher chose. Resets are derived from the
 * schedule when read, so nothing has to run at the reset time.
 */

export type LedgerStageEvent = Readonly<{
  kind: 'STAGE';
  id: string;
  /** Insertion time; the order of events. */
  at: string;
  /** Tie-breaker for events of the same instant (assignments before completions, then sequence). */
  seq: number;
  stage: Exclude<TaskStage, 'COMPLETED'>;
}>;

export type LedgerCompletionEvent = Readonly<{
  kind: 'COMPLETED';
  id: string;
  at: string;
  seq: number;
}>;

/** A completion that was taken back (reward cancellation): the stage before it returns. */
export type LedgerUncompletionEvent = Readonly<{
  kind: 'UNCOMPLETED';
  id: string;
  at: string;
  seq: number;
}>;

export type LedgerEvent = LedgerStageEvent | LedgerCompletionEvent | LedgerUncompletionEvent;

/** One schedule in force from `from` (exclusive of a boundary at exactly `from`) until `until`. */
export type ResetWindow = Readonly<{
  recurrence: TaskRecurrence;
  timeZone: string;
  /** The stage every student who has the task moves to at each reset; null = no automatic reset. */
  resetStage: TaskStage | null;
  from: string;
  until: string | null;
}>;

export type LedgerStageState = Readonly<{
  stage: TaskStage;
  /** When the current stage began (an event or an automatic reset); null when never touched. */
  since: string | null;
  /** True when the current stage comes from an automatic reset rather than an event. */
  byReset: boolean;
  lastEventId: string | null;
  /** The latest completion that still counts (null once a later event replaced it). */
  lastCompletionAt: string | null;
}>;

const KIND_ORDER: Readonly<Record<LedgerEvent['kind'], number>> = { STAGE: 0, COMPLETED: 1, UNCOMPLETED: 2 };

export function compareLedgerEvents(left: LedgerEvent, right: LedgerEvent): number {
  const time = compareInstants(left.at, right.at);
  if (time !== 0) return time;
  const kind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  if (kind !== 0) return kind;
  return left.seq - right.seq;
}

/** Folds one student's events (any order) and the reset windows into the stage at `now`. */
export function projectLedgerStage(input: Readonly<{
  events: readonly LedgerEvent[];
  windows: readonly ResetWindow[];
  now: string;
}>): LedgerStageState {
  const events = [...input.events].filter((event) => compareInstants(event.at, input.now) <= 0)
    .sort(compareLedgerEvents);
  let stage: TaskStage = 'UNASSIGNED';
  let since: string | null = null;
  let beforeCompletion: TaskStage = 'UNASSIGNED';
  let beforeCompletionSince: string | null = null;
  let lastEventId: string | null = null;
  let lastCompletionAt: string | null = null;
  let lastAt: string | null = null;
  for (const event of events) {
    lastEventId = event.id;
    lastAt = event.at;
    if (event.kind === 'STAGE') {
      if (event.stage !== stage) since = event.at;
      stage = event.stage;
      lastCompletionAt = null;
    } else if (event.kind === 'COMPLETED') {
      if (stage !== 'COMPLETED') {
        beforeCompletion = stage;
        beforeCompletionSince = since;
        since = event.at;
      }
      stage = 'COMPLETED';
      lastCompletionAt = event.at;
    } else if (stage === 'COMPLETED') {
      stage = beforeCompletion;
      since = beforeCompletionSince ?? event.at;
      lastCompletionAt = null;
    }
  }

  let byReset = false;
  if (lastAt !== null && stage !== 'UNASSIGNED') {
    let cursor = lastAt;
    for (const window of [...input.windows].sort((a, b) => compareInstants(a.from, b.from))) {
      if (window.until !== null && compareInstants(window.until, cursor) <= 0) continue;
      const reset = firstResetInWindow(window, cursor, input.now);
      if (reset === null) continue;
      if (window.resetStage !== null && stage !== 'UNASSIGNED') {
        if (window.resetStage !== stage) {
          stage = window.resetStage;
          since = reset;
          byReset = true;
          if (stage !== 'COMPLETED') lastCompletionAt = null;
        }
      }
      cursor = reset;
    }
  }
  return { stage, since, byReset, lastEventId, lastCompletionAt };
}

export type LedgerTimelineStep<T extends LedgerEvent> = Readonly<{
  /** The event, or null for an automatic reset. */
  event: T | null;
  at: string;
  stage: TaskStage;
  previousStage: TaskStage;
}>;

/**
 * Every stage change of one student in order, with the automatic resets in between. Resets are
 * only derived after `resetsFrom` (the ledger start): earlier history followed other rules.
 * Events that do not change the stage still appear (previousStage === stage).
 */
export function ledgerTimeline<T extends LedgerEvent>(input: Readonly<{
  events: readonly T[];
  windows: readonly ResetWindow[];
  now: string;
  resetsFrom: string;
}>): LedgerTimelineStep<T>[] {
  const events = [...input.events].filter((event) => compareInstants(event.at, input.now) <= 0).sort(compareLedgerEvents);
  const steps: LedgerTimelineStep<T>[] = [];
  let stage: TaskStage = 'UNASSIGNED';
  let beforeCompletion: TaskStage = 'UNASSIGNED';
  let lastAt: string | null = null;
  const windows = [...input.windows].sort((a, b) => compareInstants(a.from, b.from));
  const applyResets = (until: string, inclusive: boolean) => {
    if (lastAt === null || compareInstants(lastAt, input.resetsFrom) < 0) return;
    let cursor: string = lastAt;
    for (;;) {
      if (stage === 'UNASSIGNED') return;
      let next: { at: string; window: ResetWindow } | null = null;
      for (const window of windows) {
        if (window.until !== null && compareInstants(window.until, cursor) <= 0) continue;
        const at = firstResetInWindow(window, cursor, until);
        if (at !== null && (inclusive || compareInstants(at, until) < 0) && (next === null || compareInstants(at, next.at) < 0)) {
          next = { at, window };
        }
      }
      if (next === null || next.window.resetStage === null) return;
      if (next.window.resetStage === stage) {
        // Later resets of the same schedule change nothing: skip to where the schedule ends.
        if (next.window.until === null) return;
        cursor = next.window.until;
        continue;
      }
      {
        steps.push({ event: null, at: next.at, stage: next.window.resetStage, previousStage: stage });
        if (next.window.resetStage === 'COMPLETED') beforeCompletion = stage;
        stage = next.window.resetStage;
      }
      cursor = next.at;
    }
  };
  for (const event of events) {
    applyResets(event.at, false);
    const previousStage = stage;
    if (event.kind === 'STAGE') stage = event.stage;
    else if (event.kind === 'COMPLETED') {
      if (stage !== 'COMPLETED') beforeCompletion = stage;
      stage = 'COMPLETED';
    } else if (stage === 'COMPLETED') stage = beforeCompletion;
    steps.push({ event, at: event.at, stage, previousStage });
    lastAt = event.at;
  }
  applyResets(input.now, true);
  return steps;
}

/** The first automatic reset strictly after `after` (and after the window start), at or before `now`. */
export function firstResetInWindow(window: ResetWindow, after: string, now: string): string | null {
  if (window.recurrence.type === 'NONE' || window.resetStage === null) return null;
  const start = compareInstants(after, window.from) > 0 ? after : window.from;
  const next = getNextNaturalTaskBoundary({ recurrence: window.recurrence, timeZone: window.timeZone, after: start });
  if (compareInstants(next, now) > 0) return null;
  if (window.until !== null && compareInstants(next, window.until) >= 0) return null;
  return iso(next);
}

/** The next automatic reset after `now`, or null when the schedule never resets. */
export function nextResetAt(windows: readonly ResetWindow[], now: string): string | null {
  const live = windowAt(windows, now);
  if (!live || live.recurrence.type === 'NONE' || live.resetStage === null) return null;
  const start = compareInstants(now, live.from) > 0 ? now : live.from;
  const next = getNextNaturalTaskBoundary({ recurrence: live.recurrence, timeZone: live.timeZone, after: start });
  if (live.until !== null && compareInstants(next, live.until) >= 0) return null;
  return iso(next);
}

/** The most recent automatic reset at or before `now` (since the schedule took effect), or null. */
export function lastResetAt(windows: readonly ResetWindow[], now: string): string | null {
  let latest: string | null = null;
  for (const window of windows) {
    if (window.recurrence.type === 'NONE' || window.resetStage === null) continue;
    if (compareInstants(window.from, now) >= 0) continue;
    const candidate = latestBoundaryInWindow(window, now);
    if (candidate !== null && (latest === null || compareInstants(candidate, latest) > 0)) latest = candidate;
  }
  return latest;
}

/** The latest boundary b with from < b <= now and b < until. */
function latestBoundaryInWindow(window: ResetWindow, now: string): string | null {
  const recurrence = window.recurrence;
  if (recurrence.type === 'NONE') return null;
  const days = recurrence.type === 'DAILY' ? 2 : recurrence.type === 'WEEKLY' ? 8 : 63;
  const probe = Temporal.Instant.from(now).subtract({ hours: days * 24 }).toString();
  let cursor = compareInstants(probe, window.from) > 0 ? probe : window.from;
  let latest: string | null = null;
  for (let guard = 0; guard < 80; guard += 1) {
    const next = getNextNaturalTaskBoundary({ recurrence, timeZone: window.timeZone, after: cursor });
    if (compareInstants(next, now) > 0) break;
    if (window.until !== null && compareInstants(next, window.until) >= 0) break;
    latest = next;
    cursor = next;
  }
  return latest === null ? null : iso(latest);
}

function windowAt(windows: readonly ResetWindow[], now: string): ResetWindow | null {
  return [...windows].filter((window) => compareInstants(window.from, now) <= 0
    && (window.until === null || compareInstants(window.until, now) > 0))
    .sort((a, b) => compareInstants(b.from, a.from))[0] ?? null;
}

export function isTaskStage(value: unknown): value is TaskStage {
  return typeof value === 'string' && (TASK_STAGE_ORDER as readonly string[]).includes(value);
}

/** Instants in the millisecond ISO form the database returns. */
export function iso(value: string): string {
  return new Date(Temporal.Instant.from(value).epochMilliseconds).toISOString();
}

export function compareInstants(left: string, right: string): number {
  return Temporal.Instant.compare(Temporal.Instant.from(left), Temporal.Instant.from(right));
}
