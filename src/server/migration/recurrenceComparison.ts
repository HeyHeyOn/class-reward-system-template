import { projectTaskCycleState } from '@/domain/taskCycleState';
import type { ClassTask, TaskAssignment, TaskCompletion } from '@/domain/types';
import { buildTaskCycleProjection } from '@/server/taskReadProjection';
import type { LegacyNormalizationManifest } from './manifest';

/** Only called after full importer validation. Deliberately reads sourceRecords,
 * never manifest.records, SQL rows, importer projections or target query results.
 * The shared pure domain/DTO functions are the actual legacy Sheets consumer:
 * sheets/taskHistoryQueries -> projectTaskCycleStateFromSnapshot -> domain.
 * Source physical order is retained, including same-timestamp event tie breaks.
 */
export function* sourceRecurrenceProjections(manifest: LegacyNormalizationManifest, now: string) {
  const rows = (tab: string) => manifest.sourceRecords.filter((row) => row.source.kind === 'SHEET'
    && row.source.tab === tab && row.canonicalRecord !== null)
    .sort((a, b) => (a.source.kind === 'SHEET' ? a.source.rowNumber : 0)
      - (b.source.kind === 'SHEET' ? b.source.rowNumber : 0)).map((row) => row.canonicalRecord!);
  const tasks = rows('Tasks').map((row): ClassTask => {
    // Normalize only representation differences, not schedule/rule/history semantics.
    const { taskId, taskInstanceId, title, description, reward, isActive, sortOrder,
      createdAt, allowedStudentIds, currentSchedule, pendingSchedule } = row;
    return { taskId, taskInstanceId, title, description, reward, isActive, sortOrder,
      createdAt, allowedStudentIds, schedule: currentSchedule, pendingSchedule,
      ...(row.availableFrom ? { availableFrom: row.availableFrom } : {}),
      ...(row.dueAt ? { dueAt: row.dueAt } : {}),
      ...(row.prerequisiteTaskId ? { prerequisiteTaskId: row.prerequisiteTaskId } : {}),
    } as ClassTask;
  });
  const assignments = rows('TaskAssignments').map((row) => ({ ...row,
    previousAssignmentId: row.previousAssignmentId ?? '',
  })) as unknown as TaskAssignment[];
  const completions = rows('TaskCompletions') as unknown as TaskCompletion[];
  // Include students even without events: DEFAULT/LEGACY are meaningful DTO states.
  const students = rows('Students').map((row) => String(row.studentId)).sort();
  // Stream student groups; do not allocate the students × tasks DTO product.
  for (const studentId of [undefined, ...students]) {
    yield { studentId, projections: tasks.map((task) => buildTaskCycleProjection(task,
      projectTaskCycleState({ task, now, assignments, completions }), studentId)) };
  }
}
