import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { createConfiguredSheetsStore } from '@/server/googleSheets';
import {
  type TaskBatchAssignmentOperation,
  type TaskBatchAssignmentTarget,
  updateTaskAssignmentsBatch,
} from '@/server/sheetsRepository';

const MAX_BATCH_TASKS = 20;
const MAX_BATCH_OPERATIONS = 40;
const MAX_BATCH_TOTAL_OPERATIONS = 100;
const ROOT_KEYS = new Set(['targets']);
const TARGET_KEYS = new Set(['taskId', 'operations']);
const OPERATION_KEYS = new Set(['studentId', 'assigned', 'completed', 'source']);
const INVALID_REQUEST = '과제 부여 일괄 요청 형식이 올바르지 않습니다.';
const STORE_UNAVAILABLE = '과제 저장소에 연결할 수 없습니다.';
const COMMAND_FAILED = '과제 부여 일괄 처리에 실패했습니다.';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  let targets: TaskBatchAssignmentTarget[];
  try {
    const payload: unknown = await request.json();
    if (!isPlainObject(payload)
      || Object.keys(payload).length !== ROOT_KEYS.size
      || Object.keys(payload).some((key) => !ROOT_KEYS.has(key))) {
      throw new Error(INVALID_REQUEST);
    }
    targets = parseTargets(payload.targets);
  } catch {
    return Response.json({ error: INVALID_REQUEST }, { status: 400 });
  }

  let store: Awaited<ReturnType<typeof createConfiguredSheetsStore>>;
  try {
    store = await createConfiguredSheetsStore(request);
  } catch {
    return Response.json({ error: STORE_UNAVAILABLE }, { status: 503 });
  }

  try {
    return Response.json(await updateTaskAssignmentsBatch(store, targets));
  } catch {
    return Response.json({ error: COMMAND_FAILED }, { status: 500 });
  }
}

function parseTargets(value: unknown): TaskBatchAssignmentTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_TASKS) {
    throw new Error(INVALID_REQUEST);
  }
  const taskIds = new Set<string>();
  let operationCount = 0;
  const targets = value.map((target): TaskBatchAssignmentTarget => {
    if (!isPlainObject(target)
      || Object.keys(target).length !== TARGET_KEYS.size
      || Object.keys(target).some((key) => !TARGET_KEYS.has(key))
      || typeof target.taskId !== 'string' || !target.taskId
      || target.taskId !== target.taskId.trim() || taskIds.has(target.taskId)) {
      throw new Error(INVALID_REQUEST);
    }
    taskIds.add(target.taskId);
    const operations = parseOperations(target.operations);
    operationCount += operations.length;
    return { taskId: target.taskId, operations };
  });
  if (operationCount > MAX_BATCH_TOTAL_OPERATIONS) throw new Error(INVALID_REQUEST);
  return targets;
}

function parseOperations(value: unknown): TaskBatchAssignmentOperation[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BATCH_OPERATIONS) {
    throw new Error(INVALID_REQUEST);
  }
  const studentIds = new Set<string>();
  return value.map((operation): TaskBatchAssignmentOperation => {
    if (!isPlainObject(operation)
      || Object.keys(operation).some((key) => !OPERATION_KEYS.has(key))
      || typeof operation.studentId !== 'string' || !operation.studentId
      || operation.studentId !== operation.studentId.trim()
      || operation.source !== 'ADMIN'
      || (operation.assigned !== undefined && typeof operation.assigned !== 'boolean')
      || (operation.completed !== undefined && typeof operation.completed !== 'boolean')
      || (operation.assigned === undefined && operation.completed === undefined)
      || studentIds.has(operation.studentId)) {
      throw new Error(INVALID_REQUEST);
    }
    studentIds.add(operation.studentId);
    return {
      studentId: operation.studentId,
      ...(operation.assigned !== undefined ? { assigned: operation.assigned } : {}),
      ...(operation.completed !== undefined ? { completed: operation.completed } : {}),
      source: 'ADMIN',
    };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
