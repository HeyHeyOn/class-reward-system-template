export type TaskTargetItem = Readonly<{ taskId: string; title: string }>;

export type TaskDialogTarget = Readonly<{
  kind: 'new' | 'single' | 'bulk';
  tasks: readonly TaskTargetItem[];
}>;

export function createTaskDialogTarget(
  kind: TaskDialogTarget['kind'],
  tasks: ReadonlyArray<{ taskId: string; title: string }> = [],
): TaskDialogTarget {
  const snapshot = Object.freeze(tasks.map((task) => Object.freeze({ taskId: task.taskId, title: task.title })));
  return Object.freeze({ kind, tasks: snapshot });
}

export function taskTargetSummary(target: TaskDialogTarget, maxTitles = 3) {
  if (target.kind === 'new') return { short: '새 과제', full: '새 과제', count: 0 };
  const titles = target.tasks.map((task) => task.title);
  const shown = titles.slice(0, maxTitles);
  const remaining = Math.max(0, titles.length - shown.length);
  return {
    short: `${shown.join(', ')}${remaining ? ` 외 ${remaining}개` : ''}`,
    full: titles.join(', '),
    count: titles.length,
  };
}
