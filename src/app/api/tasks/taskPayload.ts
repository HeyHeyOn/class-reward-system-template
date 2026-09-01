type TaskPayloadMode = 'create' | 'update';

const COMMON_REQUIRED_KEYS = [
  'title', 'description', 'reward', 'isActive', 'sortOrder', 'allowedStudentIds',
] as const;
const OPTIONAL_KEYS = ['availableFrom', 'dueAt', 'prerequisiteTaskId'] as const;

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
};

export type ParsedTaskCreate = Omit<ParsedTaskFields, 'taskId' | 'availableFrom' | 'dueAt' | 'prerequisiteTaskId'> & {
  operationId: string;
  taskId: string;
  availableFrom: string | null;
  dueAt: string | null;
  prerequisiteTaskId: string | null;
};

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function invalidTaskPayload(): Error {
  return new Error('과제 저장 요청 형식이 올바르지 않습니다.');
}

export function parseStrictTaskCreate(value: unknown): ParsedTaskCreate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidTaskPayload();
  const input = value as Record<string, unknown>;
  const required = ['operationId', 'taskId', ...COMMON_REQUIRED_KEYS];
  const allowed = new Set([...required, ...OPTIONAL_KEYS, 'schedule']);
  if (!required.every((key) => Object.hasOwn(input, key))
    || Object.keys(input).some((key) => !allowed.has(key))) throw invalidTaskPayload();
  if (typeof input.operationId !== 'string' || !CANONICAL_UUID.test(input.operationId)
    || typeof input.taskId !== 'string' || !input.taskId.trim()
    || typeof input.title !== 'string' || !input.title.trim()
    || typeof input.description !== 'string'
    || !Number.isSafeInteger(input.reward) || (input.reward as number) < 0
    || typeof input.isActive !== 'boolean'
    || !Number.isInteger(input.sortOrder) || (input.sortOrder as number) < INT32_MIN
    || (input.sortOrder as number) > INT32_MAX
    || !Array.isArray(input.allowedStudentIds)
    || input.allowedStudentIds.some((id) => typeof id !== 'string' || !id.trim())) {
    throw invalidTaskPayload();
  }
  const allowedStudentIds = (input.allowedStudentIds as string[]).map((id) => id.trim()).sort();
  if (new Set(allowedStudentIds).size !== allowedStudentIds.length) throw invalidTaskPayload();
  for (const key of OPTIONAL_KEYS) {
    if (Object.hasOwn(input, key) && input[key] !== null && typeof input[key] !== 'string') {
      throw invalidTaskPayload();
    }
  }
  const optionalText = (key: typeof OPTIONAL_KEYS[number]) => {
    const optionalValue = input[key];
    return typeof optionalValue === 'string' && optionalValue.trim() ? optionalValue.trim() : null;
  };
  const optionalInstant = (key: 'availableFrom' | 'dueAt') => {
    const value = optionalText(key);
    if (value === null) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw invalidTaskPayload();
    return parsed.toISOString();
  };
  const availableFrom = optionalInstant('availableFrom');
  const dueAt = optionalInstant('dueAt');
  if (availableFrom !== null && dueAt !== null && Date.parse(dueAt) <= Date.parse(availableFrom)) {
    throw invalidTaskPayload();
  }
  return {
    operationId: input.operationId,
    taskId: input.taskId.trim(),
    title: input.title.trim(),
    description: input.description.trim(),
    reward: input.reward as number,
    isActive: input.isActive,
    sortOrder: input.sortOrder as number,
    allowedStudentIds,
    availableFrom,
    dueAt,
    prerequisiteTaskId: optionalText('prerequisiteTaskId'),
  };
}

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
