import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import {
  saveAppSettings,
  validateSpreadsheetId,
} from '@/server/settings';
import { createConfiguredSheetsStore, verifySpreadsheetAccess } from '@/server/googleSheets';
import { createConfiguredSettingsReader } from '@/server/repositories/configuredSettings';

export const dynamic = 'force-dynamic';

const SAVE_SETTINGS_ERROR = '설정을 저장하지 못했습니다.';
const INVALID_JSON_ERROR = '올바른 요청 내용을 입력해 주세요.';

async function parseRequestJson(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  try {
    const value: unknown = await request.json();
    return { ok: true, body: value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {} };
  } catch {
    return { ok: false };
  }
}

export async function GET(request: Request) {
  try {
    void request;
    const settingsReader = await createConfiguredSettingsReader(request);
    const settings = await settingsReader.getAppSettings();
    return Response.json(settings);
  } catch {
    return Response.json({
      error: '설정을 일시적으로 불러오지 못했습니다.',
      code: 'SETTINGS_UNAVAILABLE',
      retryable: true,
    }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  void request;
  return Response.json(
    { error: '지원하지 않는 요청 방식입니다.' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export async function POST(request: Request) {
  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const parsed = await parseRequestJson(request);
  if (!parsed.ok) return Response.json({ error: INVALID_JSON_ERROR }, { status: 400 });
  const body = parsed.body;

  if (typeof body.spreadsheetIdOrUrl !== 'string') {
    return Response.json({ error: '시트 ID 또는 주소를 입력해 주세요.' }, { status: 400 });
  }

  const validation = validateSpreadsheetId(body.spreadsheetIdOrUrl);
  if (validation.ok === false) {
    return Response.json({ error: validation.message }, { status: 400 });
  }

  try {
    const store = await createConfiguredSheetsStore(request);
    await verifySpreadsheetAccess(store);
    const settings = await saveAppSettings({
      settingsStore: store,
      spreadsheetIdOrUrl: validation.spreadsheetId,
      currencyUnit: typeof body.currencyUnit === 'string' ? body.currencyUnit : undefined,
      appTitle: typeof body.appTitle === 'string' ? body.appTitle : undefined,
      bankTitle: typeof body.bankTitle === 'string' ? body.bankTitle : undefined,
      themeColor: typeof body.themeColor === 'string' ? body.themeColor : undefined,
      fontFamily: typeof body.fontFamily === 'string' ? body.fontFamily : undefined,
      qrManualInputEnabled: typeof body.qrManualInputEnabled === 'boolean' ? body.qrManualInputEnabled : undefined,
      adminPassword: typeof body.adminPassword === 'string' ? body.adminPassword : undefined,
    });

    return Response.json(settings);
  } catch {
    return Response.json({ error: SAVE_SETTINGS_ERROR }, { status: 500 });
  }
}
