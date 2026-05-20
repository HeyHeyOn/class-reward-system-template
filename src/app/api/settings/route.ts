import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import { getAppSettings, saveAppSettings, validateSpreadsheetId } from '@/server/settings';
import { createConfiguredSheetsStore, verifySpreadsheetAccess } from '@/server/googleSheets';

export const dynamic = 'force-dynamic';

export async function GET() {
  const store = await createConfiguredSheetsStore();
  const settings = await getAppSettings({ settingsReader: store });

  return Response.json(settings);
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  try {
    const body = (await request.json()) as { spreadsheetIdOrUrl?: unknown; currencyUnit?: unknown; appTitle?: unknown; adminPassword?: unknown; themeColor?: unknown };

    if (typeof body.spreadsheetIdOrUrl !== 'string') {
      return Response.json({ error: '시트 ID 또는 주소를 입력해 주세요.' }, { status: 400 });
    }

    const validation = validateSpreadsheetId(body.spreadsheetIdOrUrl);
    if (validation.ok === false) {
      return Response.json({ error: validation.message }, { status: 400 });
    }

    await verifySpreadsheetAccess(validation.spreadsheetId);
    const store = await createConfiguredSheetsStore();
    const settings = await saveAppSettings({
      settingsStore: store,
      spreadsheetIdOrUrl: validation.spreadsheetId,
      currencyUnit: typeof body.currencyUnit === 'string' ? body.currencyUnit : undefined,
      appTitle: typeof body.appTitle === 'string' ? body.appTitle : undefined,
      themeColor: typeof body.themeColor === 'string' ? body.themeColor : undefined,
      adminPassword: typeof body.adminPassword === 'string' ? body.adminPassword : undefined,
    });

    return Response.json(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : '설정을 저장하지 못했습니다.';

    return Response.json({ error: message }, { status: 400 });
  }
}
