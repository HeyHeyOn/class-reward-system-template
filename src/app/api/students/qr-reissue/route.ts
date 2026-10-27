import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { readBoundedRequestText, RequestBodyError } from '@/server/boundedRequestBody';
import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredStudentQrCodes } from '@/server/repositories/configuredStudentQrCodes';
import { StudentQrCodeError } from '@/server/repositories/database/studentQrCodes';
import { logFailure } from '@/server/log';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: NO_STORE });

/** The teacher issues new QR codes for these students (`studentIds`); the cards they have stop working. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();
  const invalid = (status = 400) => json({ error: '요청 형식이 올바르지 않아요. 화면을 새로고침한 뒤 다시 시도해 주세요.', code: 'INVALID_REQUEST' }, status);
  if (new URL(request.url).search !== ''
    || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return invalid();
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedRequestText(request, 200_000));
  } catch (error) {
    return invalid(error instanceof RequestBodyError ? error.status : 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'studentIds') return invalid();
  try {
    const codes = await createConfiguredStudentQrCodes(request);
    return json(await codes.reissue((body as { studentIds: unknown }).studentIds));
  } catch (error) {
    if (error instanceof StudentQrCodeError) return json({ error: error.message, code: error.code }, error.status);
    logFailure('[student-qr:reissue] unexpected failure', error);
    return json({ error: 'QR을 새로 발급하지 못했어요. 잠시 후 다시 시도해 주세요.', code: 'UNEXPECTED' }, 500);
  }
}
