import type { ClassTask } from './types';

type PrerequisiteTask = Pick<ClassTask, 'taskId' | 'prerequisiteTaskId' | 'isActive'>;

export function validateTaskPrerequisiteGraph(tasks: readonly PrerequisiteTask[]): void {
  const normalized = tasks.map((task) => ({
    taskId: task.taskId.trim(),
    prerequisiteTaskId: task.prerequisiteTaskId?.trim(),
    isActive: task.isActive,
  }));
  const byId = new Map(normalized.map((task) => [task.taskId, task]));
  for (const task of normalized) {
    const prerequisite = task.prerequisiteTaskId;
    if (!prerequisite) continue;
    if (prerequisite === task.taskId) throw new Error('과제는 자기 자신을 선행 과제로 지정할 수 없습니다.');
    if (!byId.has(prerequisite)) throw new Error('선행 과제를 찾을 수 없습니다.');
    if (!byId.get(prerequisite)!.isActive) throw new Error('비활성 과제는 선행 과제로 지정할 수 없습니다.');
  }
  for (const task of normalized) {
    const seen = new Set<string>();
    let current: PrerequisiteTask | undefined = task;
    while (current?.prerequisiteTaskId) {
      if (seen.has(current.taskId)) throw new Error('선행 과제에 순환 참조가 있습니다.');
      seen.add(current.taskId);
      current = byId.get(current.prerequisiteTaskId.trim());
    }
  }
}