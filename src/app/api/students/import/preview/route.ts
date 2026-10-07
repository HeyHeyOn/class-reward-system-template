import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { adminRequiredResponse, bulkImportJson, previewErrorResponse, readXlsxUpload } from '@/server/bulkImport/http';
import { createConfiguredStudentImport } from '@/server/repositories/configuredBulkImport';

export const dynamic = 'force-dynamic';

/** Parses and checks an uploaded student .xlsx; writes nothing. */
export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return adminRequiredResponse();
  const upload = await readXlsxUpload(request);
  if (upload instanceof Response) return upload;
  try {
    const importer = await createConfiguredStudentImport(request);
    return bulkImportJson(await importer.preview(upload));
  } catch (error) {
    return previewErrorResponse(error, 'student-import-preview');
  }
}
