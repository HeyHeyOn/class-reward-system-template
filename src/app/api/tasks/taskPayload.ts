type TaskPayloadMode = 'create' | 'update';

const COMMON_REQUIRED_KEYS = [
  'title', 'description', 'reward', 'isActive', 'sortOrder', 'allowedStudentIds',
] as const;
const OPTIONAL_KEYS = ['availableFrom', 'dueAt', 'prerequisiteTaskId', 'padletBoardId'] as const;

export type ParsedTaskFields = {
  taskId?: string;
  title: string;
  description: string;
  reward: number;
  isActive: boolean;
  sortOrder: number;
  allowedStudentIds: string[];
  availableFrom?: string;
  dueAt?: string;
  prerequisiteTaskId?: string;
  padletBoardId?: string;
};

export function parseStrictTaskFields(value: unknown, mode: TaskPayloadMode): ParsedTaskFields {
  return parseTaskFields(value, mode);
}

export function parseStrictBatchTaskFields(value: unknown): ParsedTaskFields & { taskId: string } {
  return parseTaskFields(value, 'create') as ParsedTaskFields & { taskId: string };
}

function parseTaskFields(value: unknown, mode: TaskPayloadMode): ParsedTaskFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
  const input = value as Record<string, unknown>;
  const required = mode === 'create' ? ['taskId', ...COMMON_REQUIRED_KEYS] : [...COMMON_REQUIRED_KEYS];
  const allowed = new Set([...required, ...OPTIONAL_KEYS, 'schedule']);
  if (!required.every((key) => Object.hasOwn(input, key)) || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
  }
  for (const key of ['title', 'description', ...(mode === 'create' ? ['taskId'] : [])]) {
    if (typeof input[key] !== 'string') throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
  }
  if (typeof input.reward !== 'number' || !Number.isSafeInteger(input.reward)
    || typeof input.sortOrder !== 'number' || !Number.isSafeInteger(input.sortOrder)
    || typeof input.isActive !== 'boolean'
    || !Array.isArray(input.allowedStudentIds) || input.allowedStudentIds.some((id) => typeof id !== 'string')) {
    throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
  }
  for (const key of OPTIONAL_KEYS) {
    if (Object.hasOwn(input, key) && input[key] !== null && typeof input[key] !== 'string') {
      throw new Error('과제 저장 요청 형식이 올바르지 않습니다.');
    }
  }
  if (typeof input.padletBoardId === 'string' && input.padletBoardId.length > 0
    && !/^[A-Za-z0-9]{16,22}$/.test(input.padletBoardId)) {
    throw new Error('Padlet 게시판 ID 형식이 올바르지 않습니다. URL이 아닌 게시판 ID를 보내 주세요.');
  }
  return {
    ...(mode === 'create' ? { taskId: input.taskId as string } : {}),
    title: input.title as string,
    description: input.description as string,
    reward: input.reward,
    isActive: input.isActive,
    sortOrder: input.sortOrder,
    allowedStudentIds: [...input.allowedStudentIds],
    ...Object.fromEntries(OPTIONAL_KEYS
      .filter((key) => Object.hasOwn(input, key))
      .map((key) => [key, input[key] === null ? undefined : input[key]])),
  };
}
