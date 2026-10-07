import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { adminRequiredResponse, bulkImportFailure, xlsxDownloadResponse } from '@/server/bulkImport/http';
import {
  createProductImportTemplate,
  PRODUCT_TEMPLATE_ASCII_FILE_NAME,
  PRODUCT_TEMPLATE_FILE_NAME,
} from '@/server/bulkImport/productImport';

export const dynamic = 'force-dynamic';

/** Admin-only download of the product bulk import template (.xlsx). Reads no class data. */
export async function GET(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return adminRequiredResponse();
  try {
    const bytes = await createProductImportTemplate();
    return xlsxDownloadResponse(bytes, PRODUCT_TEMPLATE_FILE_NAME, PRODUCT_TEMPLATE_ASCII_FILE_NAME);
  } catch {
    return bulkImportFailure(500, 'INTERNAL', '양식 파일을 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}
