import type { TaskAssignmentStatus, TaskAssignmentStudentStatus } from '@/domain/types';
import type { NormalizedAdminTask } from './taskRecurrenceEditor';

export type NormalizedTaskAssignmentStatus = TaskAssignmentStatus & {
  statusRows: TaskAssignmentStudentStatus[];
  assignedIds: string[];
  /** Assigned and completable (완료 가능); the other assigned students are 미완료. */
  readyIds: string[];
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
    // Responses from before stages existed have no ready flag: there, assigned meant completable.
    readyIds: statusRows.filter((row) => row.assigned && row.ready !== false).map((row) => row.studentId),
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
          pendingStudentIds: status.assignedIds.filter((id) => !status.readyIds.includes(id) && !status.completedIds.includes(id)),
          readyStudentIds: status.readyIds.filter((id) => !status.completedIds.includes(id)),
          completedStudentIds: status.completedIds,
          students: status.statusRows.map((row) => ({
            studentId: row.studentId,
            assigned: row.assigned,
            ready: row.assigned && row.ready !== false,
            completed: row.completed,
            ...(row.stage ? { stage: row.stage } : {}),
            assignmentOrigin: row.assignmentOrigin ?? 'DEFAULT',
            ...(row.assignmentSource ? { assignmentSource: row.assignmentSource } : {}),
            completionOrigin: row.completionOrigin ?? 'DEFAULT',
          })),
        },
      } : {}),
    };
  });
}
