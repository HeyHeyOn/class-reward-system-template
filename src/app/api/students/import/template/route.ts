import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { adminRequiredResponse, bulkImportFailure, xlsxDownloadResponse } from '@/server/bulkImport/http';
import {
  createStudentImportTemplate,
  STUDENT_TEMPLATE_ASCII_FILE_NAME,
  STUDENT_TEMPLATE_FILE_NAME,
} from '@/server/bulkImport/studentImport';

export const dynamic = 'force-dynamic';

/** Admin-only download of the student bulk import template (.xlsx). Reads no class data. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return adminRequiredResponse();
  try {
    const bytes = await createStudentImportTemplate();
    return xlsxDownloadResponse(bytes, STUDENT_TEMPLATE_FILE_NAME, STUDENT_TEMPLATE_ASCII_FILE_NAME);
  } catch {
    return bulkImportFailure(500, 'INTERNAL', '양식 파일을 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}
