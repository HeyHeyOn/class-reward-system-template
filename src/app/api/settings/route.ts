import { legacyWriteFreezeResponse } from '@/server/legacyDeploymentMode';
import { isAuthorizedAdminRequest, unauthorizedAdminResponse } from '@/server/apiAuth';
import {
  saveAppSettings,
  validateSpreadsheetId,
} from '@/server/settings';
import { createConfiguredSheetsStore, verifySpreadsheetAccess } from '@/server/googleSheets';
import { createConfiguredSettingsReader } from '@/server/repositories/configuredSettings';
import { getOptionalTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

export const dynamic = 'force-dynamic';

const SAVE_SETTINGS_ERROR = '설정을 저장하지 못했어요.';
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
    const context = getOptionalTrustedTenantRequestContext();
    if (context) {
      if (context.tenant.lifecycle !== 'ACTIVE') throw new Error('Inactive class.');
      const [{ createDatabaseSettingsCommands }, { withTenantSnapshot }] = await Promise.all([
        import('@/server/repositories/database/settingsCommands'), import('@/server/db/transaction'),
      ]);
      const settings = await createDatabaseSettingsCommands({ tenantId: context.tenant.id, runTenantTransaction: withTenantSnapshot }).get();
      return Response.json(settings, { headers: { 'cache-control': 'no-store' } });
    }
    void request;
    const settingsReader = await createConfiguredSettingsReader(request);
    const settings = await settingsReader.getAppSettings();
    return Response.json(settings);
  } catch {
    return Response.json({
      error: '설정을 일시적으로 불러오지 못했어요.',
      code: 'SETTINGS_UNAVAILABLE',
      retryable: true,
    }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  void request;
  return Response.json(
    { error: '지원하지 않는 요청 방식이에요.' },
    { status: 405, headers: { Allow: 'GET, POST' } },
  );
}

export async function POST(request: Request) {
  const frozen = legacyWriteFreezeResponse();
  if (frozen) return frozen;

  if (!isAuthorizedAdminRequest(request)) return unauthorizedAdminResponse();

  const context = getOptionalTrustedTenantRequestContext();
  if (context) {
    const [{ createDatabaseSettingsCommands, SettingsInputError, SettingsConflictError }, { withTenantTransaction }, { hasSameOrigin }] = await Promise.all([
      import('@/server/repositories/database/settingsCommands'), import('@/server/db/transaction'), import('@/server/classMutationRequest'),
    ]);
    const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
    const url = new URL(request.url);
    if (url.search || !hasSameOrigin(request, url) || request.headers.get('sec-fetch-site') !== 'same-origin'
      || request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json' || request.headers.has('content-encoding')) {
      return reply({ error: '같은 사이트의 설정 화면에서 저장해 주세요.' }, 403);
    }
    const reader = request.body?.getReader();
    if (!reader) return reply({ error: INVALID_JSON_ERROR }, 400);
    let body: unknown;
    try {
      const parts: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 8192) { await reader.cancel(); return reply({ error: '입력이 너무 커요.' }, 413); }
        parts.push(value);
      }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
    } catch { return reply({ error: INVALID_JSON_ERROR }, 400); }
    finally { reader.releaseLock(); }
    try {
      const saved = await createDatabaseSettingsCommands({ tenantId: context.tenant.id, runTenantTransaction: withTenantTransaction }).save(body);
      return reply(saved, 200);
    } catch (error) {
      if (error instanceof SettingsInputError) return reply({ error: error.message }, 400);
      if (error instanceof SettingsConflictError) return reply({ error: error.message, code: 'SETTINGS_CONFLICT' }, 409);
      return reply({ error: '설정 저장 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.', retryable: true }, 503);
    }
  }

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
