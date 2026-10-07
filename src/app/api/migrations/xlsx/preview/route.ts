import { createConfiguredXlsxImport } from '@/server/migration/xlsx/xlsxImportService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Parses and validates an uploaded CRS workbook (.xlsx) without writing anything. */
export async function POST(request: Request) {
  return createConfiguredXlsxImport().preview(request);
}
