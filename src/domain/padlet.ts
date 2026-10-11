import type { TaskStage } from './taskStage';

/*
 * Padlet links: when a student's post appears on a task's Padlet board while the task is open, the
 * student's 미완료 becomes 완료 가능. Pure rules only — reading Padlet and writing stages live elsewhere.
 */

export type PadletPostStatus = 'approved' | 'pending_moderation' | 'scheduled';

export type PadletPost = Readonly<{
  id: string;
  /** ISO instant. */
  createdAt: string;
  status: PadletPostStatus | null;
  /** Padlet's name for the author (full name, else short name); '' when the post is anonymous. */
  authorName: string;
  subject: string;
  sectionId: string | null;
  url: string | null;
}>;

export type PadletSection = Readonly<{ id: string; title: string }>;

const BOARD_ID = /^[A-Za-z0-9]{8,32}$/;

export function isPadletBoardId(value: unknown): value is string {
  return typeof value === 'string' && BOARD_ID.test(value);
}

/**
 * The board ID from what a teacher pastes: the board address (…/name-of-board-abcd1234efgh5678,
 * …/padlets/abcd1234efgh5678), its slideshow or a post address, or the bare ID.
 */
export function padletBoardIdFromAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (isPadletBoardId(text)) return text;
  let path: string;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (!/(^|\.)padlet\.(com|org|dev)$/i.test(url.hostname) && !/padlet/i.test(url.hostname)) return null;
    path = url.pathname;
  } catch {
    return null;
  }
  const segments = path.split('/').filter(Boolean);
  const padletsIndex = segments.indexOf('padlets');
  if (padletsIndex >= 0 && isPadletBoardId(segments[padletsIndex + 1] ?? '')) return segments[padletsIndex + 1];
  // /user/board-slug-<id>[/slideshow|/wish/<post>]
  for (const segment of segments.length >= 2 ? [segments[1]] : segments) {
    const last = segment.split('-').at(-1) ?? '';
    // Board IDs are 16–22 letters and digits; a shorter last word is part of the title.
    if (/^[A-Za-z0-9]{12,32}$/.test(last)) return last;
  }
  return null;
}

const ANONYMOUS = new Set(['', '익명', 'anonymous', 'anon', '게스트', 'guest']);

/** A name for comparing: no spaces, numbers, '번' or punctuation (‘3번 김민준’, ‘김민준(03)’ → ‘김민준’). */
export function normalizePersonName(text: string): string {
  return text.normalize('NFC').toLowerCase()
    .replace(/\d+\s*번/g, '')
    .replace(/[\s\d\p{P}\p{S}]+/gu, '');
}

export type PadletMatch =
  | Readonly<{ studentId: string; by: 'AUTHOR' | 'SUBJECT' }>
  | Readonly<{ studentId: null; issue: 'NO_NAME' | 'UNKNOWN' | 'AMBIGUOUS' }>;

export type PadletStudent = Readonly<{ studentId: string; name: string }>;

/**
 * Whose post it is: the author's name first; when the author is anonymous or not a student, the
 * title. Two students with the same name, or a title naming two students, are never guessed.
 */
export function matchPadletStudent(post: Pick<PadletPost, 'authorName' | 'subject'>, students: readonly PadletStudent[]): PadletMatch {
  const byName = new Map<string, string[]>();
  for (const student of students) {
    const name = normalizePersonName(student.name);
    if (name.length < 2) continue;
    byName.set(name, [...(byName.get(name) ?? []), student.studentId]);
  }
  const author = normalizePersonName(post.authorName);
  let ambiguous = false;
  if (!ANONYMOUS.has(author)) {
    const ids = byName.get(author);
    if (ids?.length === 1) return { studentId: ids[0], by: 'AUTHOR' };
    if (ids && ids.length > 1) ambiguous = true;
  }
  const subject = normalizePersonName(post.subject);
  if (subject) {
    const exact = byName.get(subject);
    if (exact?.length === 1) return { studentId: exact[0], by: 'SUBJECT' };
    if (exact && exact.length > 1) return { studentId: null, issue: 'AMBIGUOUS' };
    // A title like ‘김민준의 칭찬 일기’: the one student name inside it (김민 inside 김민준 does not count).
    const inside = [...byName.keys()].filter((name) => subject.includes(name));
    const longest = inside.filter((name) => !inside.some((other) => other !== name && other.includes(name)));
    if (longest.length === 1) {
      const ids = byName.get(longest[0])!;
      if (ids.length === 1) return { studentId: ids[0], by: 'SUBJECT' };
      return { studentId: null, issue: 'AMBIGUOUS' };
    }
    if (longest.length > 1) return { studentId: null, issue: 'AMBIGUOUS' };
  }
  if (ambiguous) return { studentId: null, issue: 'AMBIGUOUS' };
  return { studentId: null, issue: ANONYMOUS.has(author) && !subject ? 'NO_NAME' : 'UNKNOWN' };
}

/* ---------------- allocation ---------------- */

export type PadletLinkedTask = Readonly<{
  taskId: string;
  title: string;
  sortOrder: number;
  /** The task's 선행 과제 (any task; only linked ones on the same board chain with it). */
  prerequisiteTaskId: string | null;
  /** Only posts in this section count; null = the whole board. */
  sectionId: string | null;
  /** Posts count from here (the later of: created, 시작, the latest automatic reset)… */
  opensAt: string;
  /** …until here (마감), exclusive; null = no end. */
  closesAt: string | null;
  /** Hidden from students (학생에게 보이기 off): no post counts. */
  visible: boolean;
}>;

export type PadletUse = Readonly<{ taskId: string; postId: string; studentId: string }>;

export type PadletMove = Readonly<{ taskId: string; studentId: string; postId: string; postCreatedAt: string }>;

/** What a post did for one linked task. */
export type PadletPostResult =
  | 'MOVED'        // made the student 완료 가능 (now or earlier)
  | 'OTHER_TASK'   // used by an earlier task of the same chain
  | 'NOT_ASSIGNED' // the student does not have the task (미부여)
  | 'DONE'         // the student was already 완료 가능 or 완료
  | 'EARLIER'      // written before the student's current 미완료 began (a reset or the teacher's change)
  | 'WAITING'      // a chain's earlier task is still 미완료 and this post cannot count for it
  | 'OUTSIDE';     // before the task opened, after it closed, hidden, or another section

export type PadletPostOutcome = Readonly<{
  postId: string;
  at: string;
  author: string;
  subject: string;
  url: string | null;
  studentId: string | null;
  match: 'AUTHOR' | 'SUBJECT' | null;
  issue: 'NO_NAME' | 'UNKNOWN' | 'AMBIGUOUS' | 'AWAITING_APPROVAL' | 'INACTIVE_STUDENT' | null;
  results: Readonly<Record<string, PadletPostResult>>;
}>;

export type PadletAllocation = Readonly<{ moves: PadletMove[]; outcomes: PadletPostOutcome[] }>;

/**
 * Groups of linked tasks that share posts: tasks joined by 선행 과제 form one chain (prerequisites
 * first, then 목록 순서); a task with no linked prerequisite or follower is a group of its own.
 */
export function padletTaskGroups(tasks: readonly PadletLinkedTask[]): PadletLinkedTask[][] {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root)) root = parent.get(root)!;
    return root;
  };
  for (const task of tasks) {
    if (task.prerequisiteTaskId && byId.has(task.prerequisiteTaskId) && task.prerequisiteTaskId !== task.taskId) {
      const a = find(task.taskId), b = find(task.prerequisiteTaskId);
      if (a !== b) parent.set(a, b);
    }
  }
  const depth = (task: PadletLinkedTask): number => {
    let level = 0;
    let cursor: PadletLinkedTask | undefined = task;
    const seen = new Set<string>();
    while (cursor?.prerequisiteTaskId && byId.has(cursor.prerequisiteTaskId) && !seen.has(cursor.taskId)) {
      seen.add(cursor.taskId);
      cursor = byId.get(cursor.prerequisiteTaskId);
      level += 1;
    }
    return level;
  };
  const groups = new Map<string, PadletLinkedTask[]>();
  for (const task of tasks) groups.set(find(task.taskId), [...(groups.get(find(task.taskId)) ?? []), task]);
  return [...groups.values()].map((group) => group.sort((a, b) => depth(a) - depth(b) || a.sortOrder - b.sortOrder
    || a.taskId.localeCompare(b.taskId, 'en', { numeric: true })))
    .sort((a, b) => a[0].sortOrder - b[0].sortOrder || a[0].taskId.localeCompare(b[0].taskId, 'en', { numeric: true }));
}

const instant = (value: string) => Date.parse(value);

/** True when the post was written at or after `since` (or `since` is unknown). */
function writtenSince(post: PadletPost, since: string | null): boolean {
  if (since === null) return true;
  const start = micros(since);
  return start === null || (micros(post.createdAt) ?? Number.NEGATIVE_INFINITY) >= start;
}

/** An ISO instant in microseconds (ledger times carry microseconds; Date keeps milliseconds). */
function micros(value: string): number | null {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)/.exec(value)?.[1] ?? '';
  return ms * 1000 + Number(fraction.padEnd(6, '0').slice(3, 6));
}

function postFits(task: PadletLinkedTask, post: PadletPost): boolean {
  if (!task.visible) return false;
  if (task.sectionId !== null && post.sectionId !== task.sectionId) return false;
  const at = instant(post.createdAt);
  if (at < instant(task.opensAt)) return false;
  return task.closesAt === null || at < instant(task.closesAt);
}

/**
 * Which posts move which students, and what every post did (for the teacher). Posts are taken
 * oldest first. Each group (chain) uses a post at most once: it goes to the first task of the
 * chain that the post fits and the student still has at 미완료 — after that task is 완료 가능, the
 * next post goes to the next task. Separate groups use the same post independently.
 */
export function allocatePadletPosts(input: Readonly<{
  tasks: readonly PadletLinkedTask[];
  students: readonly (PadletStudent & Readonly<{ active: boolean }>)[];
  /** The student's current stage on a task. */
  stageOf: (taskId: string, studentId: string) => TaskStage;
  /**
   * When the student's current stage began (the task was given, a reset, or the teacher's change);
   * null when unknown. A post written before it never moves the student: after being sent back to
   * 미완료 the student needs a new post.
   */
  sinceOf?: (taskId: string, studentId: string) => string | null;
  posts: readonly PadletPost[];
  uses: readonly PadletUse[];
  now: string;
}>): PadletAllocation {
  const groups = padletTaskGroups(input.tasks);
  const activeStudents = input.students.filter((student) => student.active);
  const inactive = new Set(input.students.filter((student) => !student.active).map((student) => student.studentId));
  const allStudents = input.students.map(({ studentId, name }) => ({ studentId, name }));
  const usedBy = new Map<string, Set<string>>(); // postId -> taskIds
  for (const use of input.uses) usedBy.set(use.postId, new Set([...(usedBy.get(use.postId) ?? []), use.taskId]));
  const stages = new Map<string, TaskStage>();
  const stage = (taskId: string, studentId: string) => stages.get(`${taskId}\u0000${studentId}`) ?? input.stageOf(taskId, studentId);
  const now = instant(input.now);
  const moves: PadletMove[] = [];
  const outcomes: PadletPostOutcome[] = [];
  const posts = [...input.posts].filter((post) => instant(post.createdAt) <= now)
    .sort((a, b) => instant(a.createdAt) - instant(b.createdAt) || a.id.localeCompare(b.id));

  for (const post of posts) {
    const base = { postId: post.id, at: post.createdAt, author: post.authorName, subject: post.subject, url: post.url };
    if (post.status !== 'approved') {
      if (post.status === 'pending_moderation') outcomes.push({ ...base, studentId: null, match: null, issue: 'AWAITING_APPROVAL', results: {} });
      continue;
    }
    const match = matchPadletStudent(post, allStudents);
    if (match.studentId === null) {
      outcomes.push({ ...base, studentId: null, match: null, issue: match.issue, results: {} });
      continue;
    }
    const studentId = match.studentId;
    if (inactive.has(studentId) || !activeStudents.some((student) => student.studentId === studentId)) {
      outcomes.push({ ...base, studentId, match: match.by, issue: 'INACTIVE_STUDENT', results: {} });
      continue;
    }
    const results: Record<string, PadletPostResult> = {};
    for (const group of groups) {
      const used = group.find((task) => usedBy.get(post.id)?.has(task.taskId));
      let taker: PadletLinkedTask | undefined = used;
      // The chain's first task that is still 미완료 for this student and that the post fits.
      const next = used ? undefined : group.find((task) => postFits(task, post) && stage(task.taskId, studentId) === 'PENDING');
      // Written before that 미완료 began: it counts for nothing, and never skips ahead to a later task.
      const early = next && !writtenSince(post, input.sinceOf?.(next.taskId, studentId) ?? null) ? next : undefined;
      if (next && !early) {
        taker = next;
        moves.push({ taskId: next.taskId, studentId, postId: post.id, postCreatedAt: post.createdAt });
        stages.set(`${next.taskId}\u0000${studentId}`, 'READY');
        usedBy.set(post.id, new Set([...(usedBy.get(post.id) ?? []), next.taskId]));
      }
      for (const task of group) {
        const current = stage(task.taskId, studentId);
        if (taker && task.taskId === taker.taskId) results[task.taskId] = 'MOVED';
        else if (taker) results[task.taskId] = 'OTHER_TASK';
        else if (!postFits(task, post)) results[task.taskId] = 'OUTSIDE';
        else if (early && task.taskId === early.taskId) results[task.taskId] = 'EARLIER';
        else if (early && current === 'PENDING') results[task.taskId] = 'WAITING';
        else if (current === 'UNASSIGNED') results[task.taskId] = 'NOT_ASSIGNED';
        else results[task.taskId] = 'DONE';
      }
    }
    outcomes.push({ ...base, studentId, match: match.by, issue: null, results });
  }
  return { moves, outcomes: outcomes.reverse() };
}

/** The newest outcomes kept for the teacher (the board summary holds at most this many). */
export const PADLET_SUMMARY_LIMIT = 30;
