import type { TaskCycleHistoryEvent } from '@/domain/taskCycleHistory';
import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import { isPendingAssignmentNote } from '@/domain/taskStage';

/**
 * Turns a task history DTO into what a teacher reads: one plain sentence per action, named
 * students, grouped by cycle (회차) and day, newest first. Bookkeeping rows (carry-overs,
 * seeded target students, legacy checkpoints) are summarised instead of listed.
 */

const DEFAULT_TIME_ZONE = 'Asia/Seoul';
/** Names shown in one sentence before the rest collapse into "외 n명". */
const SHOWN_NAMES = 3;

export type TaskHistoryFilter = 'all' | 'assign' | 'complete' | 'reset';
export type TaskHistoryCategory = Exclude<TaskHistoryFilter, 'all'>;

export type TaskHistoryEntryKind =
  | 'assign' | 'assignPending' | 'toPending' | 'toReady' | 'unassign'
  | 'complete' | 'adminComplete' | 'reset' | 'cancel' | 'other';

export type TaskHistoryStudentRef = {
  studentId: string;
  /** Name to show; for an unknown student this is empty. */
  name: string;
  /** Removed from the class. */
  deleted: boolean;
  /** No name could be found anywhere: shown as "삭제된 학생". */
  unknown: boolean;
};

export type TaskHistoryEntry = {
  key: string;
  kind: TaskHistoryEntryKind;
  category: TaskHistoryCategory;
  occurredAt: string;
  /** e.g. "오전 9:12" */
  time: string;
  /** Every student of this line (one action on several students at once is one line). */
  students: TaskHistoryStudentRef[];
  /** The students named in the sentence; the rest are `hiddenCount`. */
  shownStudents: TaskHistoryStudentRef[];
  hiddenCount: number;
  /** The sentence is `before` + the student phrase + `after`. */
  before: string;
  after: string;
  /** The whole sentence as plain text. */
  text: string;
};

export type TaskHistoryDay = { key: string; label: string; entries: TaskHistoryEntry[] };

export type TaskHistoryCycleView = {
  key: string;
  /** "이번 회차", "지난 회차" or "예전 기록" */
  label: string;
  /** e.g. "10월 5일(월) ~ 10월 11일(일)" or "10월 5일(월)부터"; null when unknown. */
  range: string | null;
  isCurrent: boolean;
  /** The repeat setting changed when this cycle started. */
  scheduleChanged: boolean;
  /** Students whose state simply continued from the previous cycle. */
  carried: TaskHistoryStudentRef[];
  /** Students recorded as the task's original target students. */
  seeded: TaskHistoryStudentRef[];
  days: TaskHistoryDay[];
  entryCount: number;
};

export type TaskHistorySectionView = {
  key: string;
  /** null for the current task; a heading for earlier tasks that used the same ID. */
  title: string | null;
  description: string | null;
  cycles: TaskHistoryCycleView[];
};

export type TaskHistorySummary = {
  label: string;
  range: string | null;
  assigned: number;
  completed: number;
  /** 미완료 students; null when the server predates task stages. */
  pending: number | null;
};

export type TaskHistoryView = {
  summary: TaskHistorySummary | null;
  sections: TaskHistorySectionView[];
  /** Lines per filter, after the name search. */
  counts: Record<TaskHistoryFilter, number>;
  /** Lines shown with the current filter and search. */
  visibleCount: number;
  /** One open-ended cycle only (a task without repeats): its header adds nothing. */
  singlePermanentCycle: boolean;
};

export type TaskHistoryViewOptions = {
  filter?: TaskHistoryFilter;
  query?: string;
  now?: string;
  currencyUnit?: string;
};

type ClassifiedEvent = {
  event: TaskCycleHistoryEvent;
  kind: TaskHistoryEntryKind | 'carry' | 'seed' | 'hidden';
  reward: number | null;
};

type AssignmentState = 'unassigned' | 'pending' | 'ready';

const CATEGORY: Record<TaskHistoryEntryKind, TaskHistoryCategory> = {
  assign: 'assign', assignPending: 'assign', toPending: 'assign', toReady: 'assign', unassign: 'assign',
  complete: 'complete', adminComplete: 'complete', other: 'complete',
  reset: 'reset', cancel: 'reset',
};

export function buildTaskHistoryView(detail: TaskHistoryDetailDto, options: TaskHistoryViewOptions = {}): TaskHistoryView {
  const filter = options.filter ?? 'all';
  const query = normalize(options.query ?? '');
  const now = options.now ?? new Date().toISOString();
  const unit = options.currencyUnit ?? '원';
  const resolveStudent = studentResolver(detail);
  const matches = (studentId: string) => !query || studentMatches(resolveStudent(studentId), query);
  const currentCycleId = detail.currentLifecycle?.currentCycleStatus?.cycleId ?? null;
  const counts: Record<TaskHistoryFilter, number> = { all: 0, assign: 0, complete: 0, reset: 0 };
  let visibleCount = 0;

  const lifecycles = [...(detail.cumulativeHistory?.lifecycles ?? [])]
    .sort((left, right) => lifecycleRank(left) - lifecycleRank(right)
      || (right.lastOccurredAt ?? '').localeCompare(left.lastOccurredAt ?? ''));

  const sections = lifecycles.map((lifecycle, lifecycleIndex): TaskHistorySectionView => {
    const classified = classifyEvents(lifecycle.events ?? []);
    const cycleGroups = new Map<string, ClassifiedEvent[]>();
    classified.forEach((item) => {
      const cycleKey = item.event.cycleId ?? '';
      cycleGroups.set(cycleKey, [...(cycleGroups.get(cycleKey) ?? []), item]);
    });

    const chronological = Array.from(cycleGroups, ([cycleKey, items]) => ({ cycleKey, items, first: items[0].event }))
      .sort((left, right) => compareCycles(left.first, right.first)
        || left.items[0].event.occurredAt.localeCompare(right.items[0].event.occurredAt));
    let priorRule: number | null = null;
    const cycles = chronological.map(({ cycleKey, items, first }): TaskHistoryCycleView => {
      const ruleVersion = items.find((item) => item.event.ruleVersion !== undefined)?.event.ruleVersion ?? null;
      const scheduleChanged = priorRule !== null && ruleVersion !== null && ruleVersion !== priorRule;
      if (ruleVersion !== null) priorRule = ruleVersion;
      const timeZone = first.timeZone ?? DEFAULT_TIME_ZONE;
      const isCurrent = Boolean(lifecycle.isCurrentLifecycle) && cycleKey !== '' && cycleKey === currentCycleId;
      const visible = items.filter((item) => matches(item.event.studentId));
      const showSummaries = filter === 'all' || filter === 'assign';
      const carried = showSummaries ? uniqueStudents(visible.filter((item) => item.kind === 'carry'), resolveStudent) : [];
      const seeded = showSummaries ? uniqueStudents(visible.filter((item) => item.kind === 'seed'), resolveStudent) : [];
      const entries = groupEntries(visible, resolveStudent, unit);
      entries.forEach((entry) => {
        counts.all += 1;
        counts[entry.category] += 1;
      });
      const shown = entries.filter((entry) => filter === 'all' || entry.category === filter);
      visibleCount += shown.length;
      return {
        key: `${lifecycleIndex}:${cycleKey || 'legacy'}`,
        label: cycleKey === '' ? '예전 기록' : isCurrent ? '이번 회차' : '지난 회차',
        range: cycleKey === '' ? null : formatCycleRange(first.cycleStartsAt, first.cycleEndsAt, timeZone, now),
        isCurrent,
        scheduleChanged,
        carried,
        seeded,
        days: groupDays(shown, timeZone, now),
        entryCount: shown.length,
      };
    }).filter((cycle) => cycle.entryCount > 0 || cycle.carried.length > 0 || cycle.seeded.length > 0).reverse();

    const current = Boolean(lifecycle.isCurrentLifecycle);
    return {
      key: `${lifecycleIndex}:${lifecycle.taskInstanceId ?? 'legacy'}`,
      title: current ? null : lifecycle.taskInstanceId ? '예전에 같은 번호로 만든 과제' : '반복 설정 전 기록',
      description: current ? null : lifecycle.taskInstanceId
        ? '지금 과제보다 먼저 같은 과제 번호를 쓰던 과제의 기록이에요.'
        : '회차가 생기기 전에 남은 기록이에요.',
      cycles,
    };
  });

  const visibleSections = sections.filter((section) => section.cycles.length > 0);
  const onlySection = visibleSections.length === 1 ? visibleSections[0] : null;
  const onlyCycle = onlySection?.title === null && onlySection.cycles.length === 1 ? onlySection.cycles[0] : null;
  return {
    summary: buildSummary(detail, now),
    sections: visibleSections,
    counts,
    visibleCount,
    singlePermanentCycle: Boolean(onlyCycle && onlyCycle.range?.endsWith('부터')),
  };
}

/** Assignment states are followed per cycle and student, so 미완료/완료 가능 changes read as such. */
function classifyEvents(events: readonly TaskCycleHistoryEvent[]): ClassifiedEvent[] {
  const states = new Map<string, AssignmentState>();
  return [...events]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.occurredAt.localeCompare(right.event.occurredAt) || left.index - right.index)
    .map(({ event }): ClassifiedEvent => {
      if (event.eventType === 'ASSIGNMENT') {
        const key = `${event.cycleId ?? ''}\u0000${event.studentId}`;
        const previous = states.get(key);
        const next: AssignmentState = event.assignmentStatus !== 'ASSIGNED' ? 'unassigned'
          : isPendingAssignmentNote(event.note) ? 'pending' : 'ready';
        states.set(key, next);
        if (event.assignmentSource === 'CARRY_FORWARD') return { event, kind: 'carry', reward: null };
        if (event.assignmentSource === 'LEGACY_SEED') return { event, kind: 'seed', reward: null };
        const kind: TaskHistoryEntryKind = next === 'unassigned' ? 'unassign'
          : next === 'pending' ? (previous === 'ready' ? 'toPending' : 'assignPending')
            : previous === 'pending' ? 'toReady' : 'assign';
        return { event, kind, reward: null };
      }
      const reward = typeof event.reward === 'number' && Number.isFinite(event.reward) ? event.reward : null;
      if (event.completionSource === 'CARRY_FORWARD') return { event, kind: 'carry', reward };
      // Legacy Sheets bank completions wrote in-progress checkpoints before their SUCCESS row.
      if (event.completionStatus === 'PENDING' || event.completionStatus === 'BALANCE_APPLIED') {
        return { event, kind: 'hidden', reward };
      }
      if (event.completionSource === 'ADMIN_RESET' || event.completionStatus === 'RESET') {
        const cancellation = event.note.startsWith('cancels-completion:')
          || (reward !== null && reward > 0 && event.balanceAfter < event.balanceBefore);
        return { event, kind: cancellation ? 'cancel' : 'reset', reward };
      }
      if (event.completionStatus === 'SUCCESS') {
        return { event, kind: event.completionSource === 'ADMIN' ? 'adminComplete' : 'complete', reward };
      }
      return { event, kind: 'other', reward };
    });
}

/** Consecutive lines of the same action at the same minute become one line naming every student. */
function groupEntries(
  items: readonly ClassifiedEvent[],
  resolveStudent: (studentId: string) => TaskHistoryStudentRef,
  unit: string,
): TaskHistoryEntry[] {
  const groups: Array<{ kind: TaskHistoryEntryKind; reward: number | null; minute: string; items: ClassifiedEvent[] }> = [];
  items.forEach((item) => {
    if (item.kind === 'carry' || item.kind === 'seed' || item.kind === 'hidden') return;
    const kind = item.kind;
    const minute = minuteKey(item.event.occurredAt, item.event.timeZone ?? DEFAULT_TIME_ZONE);
    const reward = kind === 'complete' || kind === 'cancel' ? item.reward : null;
    const last = groups.at(-1);
    if (last && last.kind === kind && last.minute === minute && last.reward === reward) last.items.push(item);
    else groups.push({ kind, reward, minute, items: [item] });
  });
  return groups.map((group) => {
    const latest = group.items[group.items.length - 1].event;
    const students = uniqueStudents(group.items, resolveStudent);
    const shownStudents = students.slice(0, SHOWN_NAMES);
    const hiddenCount = students.length - shownStudents.length;
    const { before, after } = sentence(group.kind, group.reward, unit);
    return {
      key: group.items[0].event.eventId,
      kind: group.kind,
      category: CATEGORY[group.kind],
      occurredAt: latest.occurredAt,
      time: formatTime(latest.occurredAt, latest.timeZone ?? DEFAULT_TIME_ZONE),
      students,
      shownStudents,
      hiddenCount,
      before,
      after,
      text: `${before}${studentPhrase(shownStudents, hiddenCount)}${after}`,
    };
  });
}

function sentence(kind: TaskHistoryEntryKind, reward: number | null, unit: string): { before: string; after: string } {
  switch (kind) {
    case 'assign': return { before: '', after: '에게 과제를 부여했어요' };
    case 'assignPending': return { before: '', after: '에게 과제를 미완료로 부여했어요' };
    case 'toPending': return { before: '', after: '을 미완료로 바꿨어요' };
    case 'toReady': return { before: '', after: '을 완료 가능으로 바꿨어요' };
    case 'unassign': return { before: '', after: '의 과제 부여를 해제했어요' };
    case 'complete': return reward !== null && reward > 0
      ? { before: '', after: `이 완료해서 보상 ${withObjectParticle(formatMoney(reward, unit))} 받았어요` }
      : { before: '', after: '이 과제를 완료했어요' };
    case 'adminComplete': return { before: '선생님이 ', after: '을 완료 처리했어요(보상 없음)' };
    case 'reset': return { before: '', after: '의 완료 기록을 초기화했어요' };
    case 'cancel': return reward !== null && reward > 0
      ? { before: '', after: `의 보상 ${withObjectParticle(formatMoney(reward, unit))} 취소했어요` }
      : { before: '', after: '의 보상을 취소했어요' };
    default: return { before: '', after: '의 과제 기록이 있어요' };
  }
}

/** "김민준 학생", "김민준, 이서연 학생 외 2명"; names are followed by "학생" so particles stay 이/을. */
export function studentPhrase(shown: readonly TaskHistoryStudentRef[], hiddenCount: number): string {
  const names = shown.map(studentMarkedName).join(', ');
  return `${names} 학생${hiddenCount > 0 ? ` 외 ${hiddenCount}명` : ''}`;
}

/** The name with its removal mark, without the "학생" suffix. */
export function studentMarkedName(student: TaskHistoryStudentRef): string {
  if (student.unknown) return '삭제된';
  return student.deleted ? `${student.name}(삭제됨)` : student.name;
}

/** A standalone label for lists of names. */
export function studentLabel(student: TaskHistoryStudentRef): string {
  return student.unknown ? '삭제된 학생' : studentMarkedName(student);
}

function studentResolver(detail: TaskHistoryDetailDto): (studentId: string) => TaskHistoryStudentRef {
  const directory = Array.isArray(detail.students) ? new Map(detail.students.map((student) => [student.studentId, student])) : null;
  const snapshots = new Map<string, string>();
  (detail.cumulativeHistory?.lifecycles ?? [])
    .flatMap((lifecycle) => lifecycle.events ?? [])
    .filter((event) => event.eventType === 'COMPLETION')
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
    .forEach((event) => {
      if (event.eventType === 'COMPLETION' && event.studentName?.trim()) snapshots.set(event.studentId, event.studentName.trim());
    });
  const cache = new Map<string, TaskHistoryStudentRef>();
  return (studentId) => {
    const cached = cache.get(studentId);
    if (cached) return cached;
    const known = directory?.get(studentId);
    const snapshot = snapshots.get(studentId);
    const resolved: TaskHistoryStudentRef = known?.name.trim()
      ? { studentId, name: known.name.trim(), deleted: Boolean(known.deleted), unknown: false }
      : snapshot ? { studentId, name: snapshot, deleted: directory !== null, unknown: false }
        // Without a name list (older servers, Sheets mode) the ID is still the best label.
        : directory === null ? { studentId, name: studentId, deleted: false, unknown: false }
          : { studentId, name: '', deleted: true, unknown: true };
    cache.set(studentId, resolved);
    return resolved;
  };
}

function uniqueStudents(
  items: readonly ClassifiedEvent[],
  resolveStudent: (studentId: string) => TaskHistoryStudentRef,
): TaskHistoryStudentRef[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    if (seen.has(item.event.studentId)) return [];
    seen.add(item.event.studentId);
    return [resolveStudent(item.event.studentId)];
  });
}

function studentMatches(student: TaskHistoryStudentRef, query: string): boolean {
  return normalize(student.name).includes(query) || normalize(student.studentId).includes(query)
    || (student.unknown && normalize('삭제된 학생').includes(query));
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase('ko-KR');
}

function buildSummary(detail: TaskHistoryDetailDto, now: string): TaskHistorySummary | null {
  const status = detail.currentLifecycle?.currentCycleStatus;
  if (!status) return null;
  return {
    label: status.endsAt ? '이번 회차' : '지금 상태',
    range: formatCycleRange(status.startsAt, status.endsAt, DEFAULT_TIME_ZONE, now),
    assigned: status.assignedStudentIds?.length ?? 0,
    completed: status.completedStudentIds?.length ?? 0,
    pending: Array.isArray(status.pendingStudentIds) ? status.pendingStudentIds.length : null,
  };
}

function lifecycleRank(lifecycle: { isCurrentLifecycle?: boolean; taskInstanceId?: string | null }): number {
  if (lifecycle.isCurrentLifecycle) return 0;
  return lifecycle.taskInstanceId ? 1 : 2;
}

function compareCycles(left: TaskCycleHistoryEvent, right: TaskCycleHistoryEvent): number {
  if (!left.cycleId !== !right.cycleId) return left.cycleId ? 1 : -1;
  return (left.cycleStartsAt ?? '').localeCompare(right.cycleStartsAt ?? '')
    || (left.ruleVersion ?? 0) - (right.ruleVersion ?? 0);
}

function groupDays(entries: readonly TaskHistoryEntry[], timeZone: string, now: string): TaskHistoryDay[] {
  const days = new Map<string, TaskHistoryEntry[]>();
  [...entries]
    .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .forEach((entry) => {
      const key = dayKey(entry.occurredAt, timeZone);
      days.set(key, [...(days.get(key) ?? []), entry]);
    });
  return Array.from(days, ([key, dayEntries]) => ({
    key,
    label: formatDayLabel(dayEntries[0].occurredAt, timeZone, now),
    entries: dayEntries,
  }));
}

/* ------------------------------------------------------------------ */
/* Korean wording and dates                                            */
/* ------------------------------------------------------------------ */

export function formatMoney(amount: number, unit: string): string {
  return `${amount.toLocaleString('ko-KR')}${unit}`;
}

/** "120원을", "30포인트를": the object particle follows the last syllable. */
export function withObjectParticle(word: string): string {
  const last = word.trim().at(-1) ?? '';
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return `${word}${(code - 0xac00) % 28 === 0 ? '를' : '을'}`;
  if (/[0-9]/.test(last)) return `${word}${'2459'.includes(last) ? '를' : '을'}`;
  return `${word}을(를)`;
}

type DateParts = { year: number; month: number; day: number; weekday: string; hour: number; minute: number };

function dateParts(instant: string, timeZone: string): DateParts | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short',
      hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    return {
      year: Number(value('year')),
      month: Number(value('month')),
      day: Number(value('day')),
      weekday: value('weekday'),
      hour: Number(value('hour')) % 24,
      minute: Number(value('minute')),
    };
  } catch {
    return null;
  }
}

function dayKey(instant: string, timeZone: string): string {
  const parts = dateParts(instant, timeZone);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : instant.slice(0, 10);
}

function minuteKey(instant: string, timeZone: string): string {
  const parts = dateParts(instant, timeZone);
  return parts ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` : instant;
}

function formatDate(parts: DateParts, now: DateParts | null): string {
  const year = now && now.year !== parts.year ? `${parts.year}년 ` : '';
  return `${year}${parts.month}월 ${parts.day}일(${parts.weekday})`;
}

/** "오전 9:12": built from parts because newer ICU data abbreviates the Korean day period as AM/PM. */
export function formatTime(instant: string, timeZone = DEFAULT_TIME_ZONE): string {
  const parts = dateParts(instant, timeZone);
  if (!parts) return instant;
  const hour = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${parts.hour < 12 ? '오전' : '오후'} ${hour}:${String(parts.minute).padStart(2, '0')}`;
}

/** "오늘 · 10월 6일(화)", "어제 · 10월 5일(월)", "10월 3일(토)" */
export function formatDayLabel(instant: string, timeZone: string, now: string): string {
  const parts = dateParts(instant, timeZone);
  if (!parts) return instant;
  const today = dateParts(now, timeZone);
  const label = formatDate(parts, today);
  if (dayKey(instant, timeZone) === dayKey(now, timeZone)) return `오늘 · ${label}`;
  const yesterday = new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString();
  if (dayKey(instant, timeZone) === dayKey(yesterday, timeZone)) return `어제 · ${label}`;
  return label;
}

/**
 * "10월 5일(월) ~ 10월 11일(일)" for cycles that turn over at midnight (the end instant belongs to
 * the next cycle), with times when they turn over during the day, and "10월 5일(월)부터" when open.
 */
export function formatCycleRange(
  startsAt: string | undefined,
  endsAt: string | null | undefined,
  timeZone: string,
  now: string,
): string | null {
  if (!startsAt) return null;
  const start = dateParts(startsAt, timeZone);
  if (!start) return null;
  const today = dateParts(now, timeZone);
  if (!endsAt) return `${formatDate(start, today)}부터`;
  const midnight = start.hour === 0 && start.minute === 0;
  const end = dateParts(midnight ? new Date(new Date(endsAt).getTime() - 1).toISOString() : endsAt, timeZone);
  if (!end) return `${formatDate(start, today)}부터`;
  if (midnight) {
    const startLabel = formatDate(start, today);
    const endLabel = formatDate(end, today);
    return startLabel === endLabel ? startLabel : `${startLabel} ~ ${endLabel}`;
  }
  return `${formatDate(start, today)} ${formatTime(startsAt, timeZone)} ~ ${formatDate(end, today)} ${formatTime(endsAt, timeZone)}`;
}

export function formatAdminHistoryDate(instant: string, timeZone = 'Asia/Seoul'): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      dateStyle: 'short', timeStyle: 'short', timeZone,
    }).format(new Date(instant));
  } catch {
    return instant;
  }
}
