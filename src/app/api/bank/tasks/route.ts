import { isTaskAvailable } from '@/domain/taskAvailability';
import { resolveTaskSchedule } from '@/domain/taskSchedule';
import { createConfiguredSheetsReader } from '@/server/googleSheets';
import { getTasks } from '@/server/sheetsRepository';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const reader = await createConfiguredSheetsReader(request);
    const now = new Date().toISOString();
    const allTasks = await getTasks(reader, { includeInactive: true });
    const visibleTasks = allTasks.filter((task) => task.isActive && isTaskAvailable(task, now));
    const visibleTaskIds = new Set(visibleTasks.map((task) => task.taskId));
    const titleById = new Map(allTasks.map((task) => [task.taskId, task.title]));
    return Response.json(visibleTasks
      .map((task) => {
        const schedule = task.schedule ? resolveTaskSchedule({ currentSchedule: task.schedule, pendingSchedule: task.pendingSchedule ?? null, now }) : undefined;
        return {
          taskId: task.taskId, title: task.title, description: task.description, reward: task.reward,
          sortOrder: task.sortOrder, availableFrom: task.availableFrom, dueAt: task.dueAt,
          recurrence: schedule?.recurrence,
          prerequisiteTaskId: task.prerequisiteTaskId && visibleTaskIds.has(task.prerequisiteTaskId)
            ? task.prerequisiteTaskId
            : undefined,
          prerequisiteTitle: task.prerequisiteTaskId ? titleById.get(task.prerequisiteTaskId) : undefined,
        };
      }));
  } catch {
    return Response.json({ error: '과제 목록을 불러오지 못했습니다.' }, { status: 500 });
  }
}