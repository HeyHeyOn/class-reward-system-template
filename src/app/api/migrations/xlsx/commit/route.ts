import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { createConfiguredXlsxImport } from '@/server/migration/xlsx/xlsxImportService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Imports the previewed workbook's current state into the class in one tenant transaction. */
export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;
  return createConfiguredXlsxImport().commit(request);
}
