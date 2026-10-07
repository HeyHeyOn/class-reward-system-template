/**
 * A student's place in one task cycle, in the order it progresses:
 * 미부여(UNASSIGNED) → 미완료(PENDING) → 완료 가능(READY) → 완료(COMPLETED).
 *
 * - UNASSIGNED: the task is not the student's; they cannot even see it.
 * - PENDING: assigned and visible, but the completion condition is not met yet.
 * - READY: the condition is met; the student can complete it and receive the reward.
 * - COMPLETED: completed (reward received), whatever the assignment says.
 */
export type TaskStage = 'UNASSIGNED' | 'PENDING' | 'READY' | 'COMPLETED';

/** The stages a teacher can assign directly; COMPLETED comes from a completion. */
export type TaskAssignableStage = Exclude<TaskStage, 'COMPLETED'>;

/**
 * Assignment events carry this note when the task is assigned but not yet completable (미완료).
 * Every other ASSIGNED event — including all history written before stages existed — means
 * 완료 가능, so earlier assigned-and-incomplete students keep being able to complete.
 */
export const PENDING_ASSIGNMENT_NOTE = 'stage:pending';

export function isPendingAssignmentNote(note: string | null | undefined): boolean {
  return note === PENDING_ASSIGNMENT_NOTE;
}

export function taskStage(state: Readonly<{ assigned: boolean; ready: boolean; completed: boolean }>): TaskStage {
  if (state.completed) return 'COMPLETED';
  if (!state.assigned) return 'UNASSIGNED';
  return state.ready ? 'READY' : 'PENDING';
}

export const TASK_STAGE_LABELS: Readonly<Record<TaskStage, string>> = {
  UNASSIGNED: '미부여',
  PENDING: '미완료',
  READY: '완료 가능',
  COMPLETED: '완료',
};

export const TASK_STAGE_ORDER: readonly TaskStage[] = ['UNASSIGNED', 'PENDING', 'READY', 'COMPLETED'];
