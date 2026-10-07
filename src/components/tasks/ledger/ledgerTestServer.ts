import { vi } from 'vitest';
import type { TaskStage } from '@/domain/taskStage';
import type { AdminTaskDto, TaskHistoryDto } from '@/lib/taskLedgerApi';

/* In-memory stand-in for the /api/c/{slug}/task-ledger routes, for component tests only. */

export const SLUG = 'ledger-demo';
export const NOW = '2026-10-06T00:00:00.000Z';
export const STUDENTS = [
  { studentId: 'S1', name: '김민준', balance: 0, status: 'ACTIVE' as const },
  { studentId: 'S2', name: '이서연', balance: 0, status: 'ACTIVE' as const },
  { studentId: 'S3', name: '박지후', balance: 0, status: 'ACTIVE' as const },
  { studentId: 'S4', name: '최하윤', balance: 0, status: 'ACTIVE' as const },
];

export function makeTask(overrides: Partial<AdminTaskDto> & { stages?: Record<string, TaskStage> } = {}): AdminTaskDto {
  const { stages = { S1: 'READY', S2: 'PENDING', S3: 'COMPLETED', S4: 'UNASSIGNED' }, ...rest } = overrides;
  const base: AdminTaskDto = {
    taskId: 'task-1', taskInstanceId: 'instance-1', version: 1, createdAt: NOW, updatedAt: NOW,
    title: '수학 익힘책', description: '42~45쪽', reward: 120, isActive: true, sortOrder: 1,
    availableFrom: null, dueAt: null, prerequisiteTaskId: null,
    repeat: { recurrence: { type: 'NONE' }, resetStage: null, nextResetAt: null, lastResetAt: null },
    students: STUDENTS.map((student) => ({ studentId: student.studentId, stage: stages[student.studentId] ?? 'UNASSIGNED',
      since: (stages[student.studentId] ?? 'UNASSIGNED') === 'UNASSIGNED' ? null : '2026-10-05T23:00:00.000Z', byReset: false })),
    counts: { UNASSIGNED: 0, PENDING: 0, READY: 0, COMPLETED: 0 },
    ...rest,
  };
  return withCounts(base);
}

export function withCounts(task: AdminTaskDto): AdminTaskDto {
  const counts = { UNASSIGNED: 0, PENDING: 0, READY: 0, COMPLETED: 0 };
  for (const row of task.students) counts[row.stage] += 1;
  return { ...task, counts };
}

export type Call = { method: string; path: string; body: Record<string, unknown> | null };
type Failure = { status: number; body?: unknown } | 'network';

export class LedgerServer {
  tasks: AdminTaskDto[];
  calls: Call[] = [];
  /** Next failures per route key ("POST /stages"); consumed one by one. */
  failures = new Map<string, Failure[]>();
  history: TaskHistoryDto | null = null;
  private nextId = 100;

  constructor(tasks: AdminTaskDto[]) { this.tasks = tasks; }

  fail(route: string, ...failures: Failure[]) { this.failures.set(route, [...(this.failures.get(route) ?? []), ...failures]); }

  writes(route?: string) {
    return this.calls.filter((call) => call.method !== 'GET' && (!route || `${call.method} ${call.path}` === route));
  }

  reads() { return this.calls.filter((call) => call.method === 'GET' && call.path === '/'); }

  set(taskId: string, change: (task: AdminTaskDto) => AdminTaskDto) {
    this.tasks = this.tasks.map((task) => task.taskId === taskId ? withCounts(change(task)) : task);
  }

  private setStage(taskId: string, studentId: string, stage: TaskStage) {
    this.set(taskId, (task) => ({ ...task, students: task.students.map((row) => row.studentId === studentId ? { ...row, stage, since: NOW, byReset: false } : row) }));
  }

  install() {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => this.handle(String(input), init));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async handle(url: string, init?: RequestInit): Promise<Response> {
    const prefix = `/api/c/${SLUG}/task-ledger`;
    if (!url.startsWith(prefix)) return Response.json({ error: `unexpected ${url}` }, { status: 500 });
    const parsed = new URL(url, 'https://crs.example');
    const path = parsed.pathname.slice(prefix.length) || '/';
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    this.calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const queued = this.failures.get(key);
    if (queued?.length) {
      const failure = queued.shift()!;
      if (failure === 'network') throw new TypeError('Failed to fetch');
      return Response.json(failure.body ?? { error: '서버 오류예요.', code: 'INTERNAL' }, { status: failure.status });
    }
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    const affected = (ids: readonly string[]) => this.tasks.filter((task) => ids.includes(task.taskId));

    if (method === 'GET' && path === '/') return json({ now: NOW, tasks: this.tasks });
    if (method === 'GET' && path.endsWith('/history')) {
      const history = this.history ?? { taskId: path.split('/')[2], title: '', entries: [], truncated: false };
      const studentId = parsed.searchParams.get('studentId');
      return json({ ...history, entries: studentId ? history.entries.filter((entry) => entry.studentId === studentId) : history.entries });
    }
    if (method === 'POST' && path === '/stages') {
      const changes = body!.changes as Array<{ taskId: string; studentId: string; stage: TaskStage }>;
      for (const change of changes) this.setStage(change.taskId, change.studentId, change.stage);
      return json({ tasks: affected([...new Set(changes.map((change) => change.taskId))]) });
    }
    if (method === 'POST' && path === '/reset') {
      const ids = body!.taskIds as string[];
      for (const id of ids) this.set(id, (task) => ({ ...task, students: task.students.map((row) => row.stage === 'UNASSIGNED' ? row : { ...row, stage: body!.stage as TaskStage, since: NOW }) }));
      return json({ tasks: affected(ids) });
    }
    if (method === 'POST' && path === '/repeat') {
      const ids = body!.taskIds as string[];
      const repeat = body!.repeat as AdminTaskDto['repeat'];
      for (const id of ids) this.set(id, (task) => ({ ...task, version: task.version + 1, repeat: { ...repeat, nextResetAt: repeat.resetStage ? '2026-10-07T00:00:00.000Z' : null, lastResetAt: null } }));
      return json({ tasks: affected(ids) });
    }
    if (method === 'POST' && path === '/tasks') {
      const id = `task-${this.nextId++}`;
      const definition = body!.task as Partial<AdminTaskDto>;
      const picked = new Map((body!.students as Array<{ studentId: string; stage: TaskStage }> ?? []).map((row) => [row.studentId, row.stage]));
      const created = makeTask({ ...definition, taskId: id, taskInstanceId: `instance-${id}`,
        repeat: { ...(body!.repeat as AdminTaskDto['repeat']), nextResetAt: null, lastResetAt: null },
        stages: Object.fromEntries(STUDENTS.map((student) => [student.studentId, picked.get(student.studentId) ?? 'UNASSIGNED'])) });
      this.tasks = [...this.tasks, created];
      return json({ task: created });
    }
    if (method === 'PATCH' && path.startsWith('/tasks/')) {
      const id = decodeURIComponent(path.slice('/tasks/'.length));
      if (!this.tasks.some((task) => task.taskId === id)) return json({ error: '과제를 찾을 수 없어요.', code: 'TASK_NOT_FOUND' }, 404);
      this.set(id, (task) => ({ ...task, ...(body!.task as Partial<AdminTaskDto>), version: task.version + 1 }));
      return json({ task: this.tasks.find((task) => task.taskId === id) });
    }
    if (method === 'POST' && path === '/tasks/delete') {
      const ids = body!.taskIds as string[];
      this.tasks = this.tasks.filter((task) => !ids.includes(task.taskId))
        .map((task) => ids.includes(task.prerequisiteTaskId ?? '') ? { ...task, prerequisiteTaskId: null } : task);
      return json({ deletedTaskIds: ids });
    }
    if (method === 'POST' && path === '/qr') {
      const studentId = String(body!.studentQr).replace(/^qr-/, '');
      const student = STUDENTS.find((candidate) => candidate.studentId === studentId);
      if (!student) return json({ error: '등록되지 않은 QR이에요.', code: 'STUDENT_NOT_FOUND' }, 404);
      const taskId = body!.taskId as string;
      const previousStage = this.tasks.find((task) => task.taskId === taskId)!.students.find((row) => row.studentId === studentId)!.stage;
      const stage = body!.stage as TaskStage;
      if (previousStage !== stage) this.setStage(taskId, studentId, stage);
      return json({ task: this.tasks.find((task) => task.taskId === taskId), student: { studentId, name: student.name }, previousStage, stage, changed: previousStage !== stage });
    }
    return json({ error: `unhandled ${key}` }, 500);
  }
}
