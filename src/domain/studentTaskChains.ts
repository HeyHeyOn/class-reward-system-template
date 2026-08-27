export type StudentTaskChainItem = {
  taskId: string;
  sortOrder: number;
  prerequisiteTaskId?: string;
  completed?: boolean;
};

export type StudentTaskChain<T extends StudentTaskChainItem> = {
  tasks: T[];
  initialIndex: number;
  allCompleted: boolean;
};

const compareTasks = <T extends StudentTaskChainItem>(left: T, right: T) => {
  if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
  if (left.taskId === right.taskId) return 0;
  return left.taskId < right.taskId ? -1 : 1;
};

export function buildStudentTaskChains<T extends StudentTaskChainItem>(
  tasks: readonly T[],
  getCompleted: (task: T) => boolean | undefined = (task) => task.completed,
): StudentTaskChain<T>[] {
  const tasksById = new Map(tasks.map((task) => [task.taskId, task]));
  const adjacency = new Map(tasks.map((task) => [task.taskId, new Set<string>()]));
  const dependents = new Map(tasks.map((task) => [task.taskId, new Set<string>()]));
  const prerequisites = new Map(tasks.map((task) => [task.taskId, new Set<string>()]));

  for (const task of tasks) {
    const prerequisiteId = task.prerequisiteTaskId;
    if (!prerequisiteId || prerequisiteId === task.taskId || !tasksById.has(prerequisiteId)) continue;
    adjacency.get(task.taskId)?.add(prerequisiteId);
    adjacency.get(prerequisiteId)?.add(task.taskId);
    dependents.get(prerequisiteId)?.add(task.taskId);
    prerequisites.get(task.taskId)?.add(prerequisiteId);
  }

  const sortedTasks = [...tasks].sort(compareTasks);
  const visited = new Set<string>();
  const components: T[][] = [];

  for (const first of sortedTasks) {
    if (visited.has(first.taskId)) continue;
    const component: T[] = [];
    const pending = [first.taskId];
    visited.add(first.taskId);

    while (pending.length > 0) {
      const taskId = pending.pop()!;
      const task = tasksById.get(taskId);
      if (task) component.push(task);
      const neighbors = [...(adjacency.get(taskId) ?? [])]
        .map((id) => tasksById.get(id))
        .filter((item): item is T => item !== undefined)
        .sort(compareTasks)
        .reverse();
      for (const neighbor of neighbors) {
        if (visited.has(neighbor.taskId)) continue;
        visited.add(neighbor.taskId);
        pending.push(neighbor.taskId);
      }
    }
    components.push(component);
  }

  const chains = components.map((component): StudentTaskChain<T> => {
    const componentIds = new Set(component.map((task) => task.taskId));
    const remaining = new Set(componentIds);
    const indegree = new Map(component.map((task) => [
      task.taskId,
      [...(prerequisites.get(task.taskId) ?? [])].filter((id) => componentIds.has(id)).length,
    ]));
    const ordered: T[] = [];

    while (remaining.size > 0) {
      const ready = component
        .filter((task) => remaining.has(task.taskId) && indegree.get(task.taskId) === 0)
        .sort(compareTasks);
      const next = ready[0] ?? component
        .filter((task) => remaining.has(task.taskId))
        .sort(compareTasks)[0];
      ordered.push(next);
      remaining.delete(next.taskId);
      for (const dependentId of dependents.get(next.taskId) ?? []) {
        if (remaining.has(dependentId)) {
          indegree.set(dependentId, Math.max(0, (indegree.get(dependentId) ?? 0) - 1));
        }
      }
    }

    const allCompleted = ordered.every((task) => getCompleted(task) === true);
    const firstIncomplete = ordered.findIndex((task) => getCompleted(task) !== true);
    return {
      tasks: ordered,
      initialIndex: firstIncomplete === -1 ? Math.max(0, ordered.length - 1) : firstIncomplete,
      allCompleted,
    };
  });

  return [
    ...chains.filter((chain) => !chain.allCompleted),
    ...chains.filter((chain) => chain.allCompleted),
  ];
}
