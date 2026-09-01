import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import {
  createConfiguredStudentCreation,
  type ConfiguredStudentCreationInput,
} from '@/server/repositories/configuredStudentCreation';
import { createConfiguredStudentReader } from '@/server/repositories/configuredStudents';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const reader = await createConfiguredStudentReader();
    const students = await reader.getStudents();

    return Response.json(students);
  } catch (error) {
    const message = error instanceof Error ? error.message : '학생 목록을 불러오지 못했습니다.';

    return Response.json({ error: message }, { status: 500 });
  }
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CREATE_KEYS = ['operationId', 'studentId', 'name', 'balance', 'status'] as const;
const CREATE_KEY_SET = new Set<string>(CREATE_KEYS);
const CREATE_ERROR = '학생을 추가하지 못했습니다.';

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const payload = await parseStudentCreationBody(request);
  if (!payload) return Response.json({ error: CREATE_ERROR }, { status: 400 });

  try {
    const command = await createConfiguredStudentCreation(request);
    const student = await command.create(payload);
    return Response.json(student, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : CREATE_ERROR;
    return Response.json({ error: message }, { status: 400 });
  }
}

async function parseStudentCreationBody(
  request: Request,
): Promise<ConfiguredStudentCreationInput | null> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json') return null;
  try {
    const body: unknown = await request.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length !== CREATE_KEYS.length
      || keys.some((key) => !CREATE_KEY_SET.has(key))
      || CREATE_KEYS.some((key) => !Object.hasOwn(record, key))
      || typeof record.operationId !== 'string'
      || !CANONICAL_UUID.test(record.operationId)
      || typeof record.studentId !== 'string'
      || !record.studentId.trim()
      || typeof record.name !== 'string'
      || !record.name.trim()
      || !Number.isSafeInteger(record.balance)
      || (record.status !== 'ACTIVE' && record.status !== 'INACTIVE')) {
      return null;
    }
    return record as ConfiguredStudentCreationInput;
  } catch {
    return null;
  }
}
