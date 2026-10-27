import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentGroups } from '@/server/repositories/configuredStudentGroups';
import { StudentGroupError } from '@/server/repositories/database/studentGroups';
import { logFailure } from '@/server/log';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

function failure(error: unknown, label: string) {
  if (error instanceof StudentGroupError) return json({ error: error.message, code: error.code }, error.status);
  logFailure(`[student-groups:${label}] unexpected failure`, error);
  return json({ error: '모둠을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', code: 'UNEXPECTED' }, 500);
}

/** The class's 모둠 with the students in use in each. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();
  try {
    return json({ groups: await (await createConfiguredStudentGroups(request)).list() });
  } catch (error) {
    return failure(error, 'list');
  }
}

const ACTIONS: Record<string, readonly string[]> = {
  create: ['action', 'name'],
  rename: ['action', 'groupId', 'name'],
  delete: ['action', 'groupId'],
  assign: ['action', 'groupId', 'studentIds'],
};

/** { action: 'create', name } | { action: 'rename', groupId, name } | { action: 'delete', groupId }
 *  | { action: 'assign', groupId (null for none), studentIds } */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();
  const invalid = (status = 400) => json({ error: '요청 형식이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, status);
  if (new URL(request.url).search !== ''
    || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return invalid();
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readBoundedRequestText(request, 200_000));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
    body = parsed as Record<string, unknown>;
  } catch (error) {
    return invalid(error instanceof RequestBodyError ? error.status : 400);
  }
  const keys = typeof body.action === 'string' ? ACTIONS[body.action] : undefined;
  if (!keys || Object.keys(body).sort().join() !== [...keys].sort().join()) return invalid();
  try {
    const groups = await createConfiguredStudentGroups(request);
    if (body.action === 'create') return json({ group: await groups.create(body.name) }, 201);
    if (body.action === 'rename') await groups.rename(body.groupId, body.name);
    else if (body.action === 'delete') await groups.remove(body.groupId);
    else await groups.assign(body.groupId, body.studentIds);
    return json({ groups: await groups.list() });
  } catch (error) {
    return failure(error, String(body.action));
  }
}
