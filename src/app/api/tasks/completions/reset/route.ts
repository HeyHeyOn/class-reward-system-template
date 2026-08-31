import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredTaskResetCommand } from '@/server/repositories/configuredTaskReset';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const input = parseTaskResetInput(await request.json());
    const command = await createConfiguredTaskResetCommand(request);
    const result = await command.resetBatch(input);

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : '과제 완료 기록을 초기화하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}

function parseTaskResetInput(raw: unknown): { operationId: string; taskIds: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Task reset input is malformed.');
  }
  const keys = Object.keys(raw);
  if (keys.length !== 2 || !keys.includes('operationId') || !keys.includes('taskIds')) {
    throw new Error('Task reset input is malformed.');
  }
  const { operationId, taskIds } = raw as Record<string, unknown>;
  if (typeof operationId !== 'string' || !UUID.test(operationId)) {
    throw new Error('A canonical lowercase UUID operation ID is required.');
  }
  if (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > 100) {
    throw new Error('Task reset task IDs are malformed.');
  }
  if (taskIds.some((taskId) => typeof taskId !== 'string'
    || taskId.length === 0 || taskId.trim() !== taskId)) {
    throw new Error('Task reset task ID is invalid.');
  }
  if (new Set(taskIds).size !== taskIds.length) {
    throw new Error('Duplicate task reset task ID.');
  }
  return { operationId, taskIds } as { operationId: string; taskIds: string[] };
}
