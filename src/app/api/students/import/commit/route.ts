import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import {
  adminRequiredResponse,
  bulkImportFailure,
  bulkImportJson,
  commitErrorResponse,
  readCommitJson,
} from '@/server/bulkImport/http';
import { parseStudentImportCommitRequest } from '@/server/bulkImport/studentImport';
import { createConfiguredStudentImport } from '@/server/repositories/configuredBulkImport';

export const dynamic = 'force-dynamic';

/** Creates previewed students in one tenant transaction; same operationId replays, never duplicates. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  if (!isAuthorizedAdminRequest(request)) return adminRequiredResponse();
  const body = await readCommitJson(request);
  if (body instanceof Response) return body;
  const input = parseStudentImportCommitRequest(body.value);
  if (!input) return bulkImportFailure(400, 'INVALID_REQUEST', '추가 요청을 확인하지 못했어요. 파일을 다시 올려 주세요.');
  try {
    const importer = await createConfiguredStudentImport(request);
    return bulkImportJson(await importer.commit(input));
  } catch (error) {
    return commitErrorResponse(error, 'student-import-commit');
  }
}
