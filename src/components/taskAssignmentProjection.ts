import type { TaskAssignmentStatus, TaskAssignmentStudentStatus } from '@/domain/types';
import type { NormalizedAdminTask } from './taskRecurrenceEditor';

export type NormalizedTaskAssignmentStatus = TaskAssignmentStatus & {
  statusRows: TaskAssignmentStudentStatus[];
  assignedIds: string[];
  completedIds: string[];
};

export function normalizeTaskAssignmentStatus(payload: TaskAssignmentStatus): NormalizedTaskAssignmentStatus {
  const statusRows = Array.isArray(payload.students)
    ? payload.students.map((row) => ({
        ...row,
        assignmentOrigin: row.assignmentOrigin ?? 'DEFAULT' as const,
        completionOrigin: row.completionOrigin ?? 'DEFAULT' as const,
      }))
    : [];
  return {
    ...payload,
    statusRows,
    assignedIds: statusRows.filter((row) => row.assigned).map((row) => row.studentId),
    completedIds: statusRows.filter((row) => row.completed).map((row) => row.studentId),
  };
}

export function reconcileTaskAssignmentProjection(
  tasks: NormalizedAdminTask[],
  taskId: string,
  status: NormalizedTaskAssignmentStatus,
): NormalizedAdminTask[] {
  return tasks.map((task) => {
    if (task.taskId !== taskId) return task;
    const currentCycle = task.currentCycle;
    const canProjectCycle = Boolean(status.cycleId && status.startsAt && status.transition);
    return {
      ...task,
      allowedStudentIds: status.assignedIds,
      ...(currentCycle || canProjectCycle ? {
        currentCycle: {
          cycleId: status.cycleId ?? currentCycle!.cycleId,
          startsAt: status.startsAt ?? currentCycle!.startsAt,
          endsAt: status.endsAt !== undefined ? status.endsAt : currentCycle!.endsAt,
          transition: status.transition ?? currentCycle!.transition,
          assignedStudentIds: status.assignedIds,
          completedStudentIds: status.completedIds,
          students: status.statusRows.map((row) => ({
            studentId: row.studentId,
            assigned: row.assigned,
            completed: row.completed,
            assignmentOrigin: row.assignmentOrigin ?? 'DEFAULT',
            ...(row.assignmentSource ? { assignmentSource: row.assignmentSource } : {}),
            completionOrigin: row.completionOrigin ?? 'DEFAULT',
          })),
        },
      } : {}),
    };
  });
}
