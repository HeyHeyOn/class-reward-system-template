import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredTaskReader } from '@/server/repositories/configuredTasks';

type RouteContext = { params: Promise<{ taskId: string }> };
const INVALID_HISTORY_QUERY = '과제 기록 조회 요청 형식이 올바르지 않습니다.';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const url = new URL(request.url);
    const keys = Array.from(url.searchParams.keys());
    const taskInstanceIds = url.searchParams.getAll('taskInstanceId');
    if (
      keys.some((key) => key !== 'taskInstanceId')
      || taskInstanceIds.length > 1
      || (taskInstanceIds.length === 1 && taskInstanceIds[0].trim().length === 0)
    ) {
      return Response.json({ error: INVALID_HISTORY_QUERY }, { status: 400 });
    }

    const { taskId } = await context.params;
    const reader = await createConfiguredTaskReader(request);
    const filter = {
      taskId: decodeURIComponent(taskId),
      ...(taskInstanceIds.length === 1 ? { taskInstanceId: taskInstanceIds[0] } : {}),
    };
    const detail = await reader.getTaskHistoryDetail(filter);
    if (!detail.currentLifecycle.taskDefinitionExists && detail.cumulativeHistory.eventCount === 0) {
      return Response.json({ error: '과제를 찾을 수 없습니다.' }, { status: 404 });
    }
    return Response.json(detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 기록을 불러오지 못했습니다.';
    return Response.json({ error: message }, { status: 500 });
  }
}
