import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore, verifySpreadsheetAccess } from '@/server/googleSheets';
import { getAppSettings, saveAppSettings } from '@/server/settings';
import { GET, PATCH, POST } from './route';

vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: vi.fn(() => true),
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/googleSheets', () => ({
  createConfiguredSheetsStore: vi.fn(),
  verifySpreadsheetAccess: vi.fn(),
}));
vi.mock('@/server/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/settings')>();
  return { ...actual, getAppSettings: vi.fn(), saveAppSettings: vi.fn() };
});

describe('/api/settings Seoul-only policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(verifySpreadsheetAccess).mockResolvedValue(undefined);
  });

  it('keeps GET read-only and reports the Seoul compatibility value', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(getAppSettings).mockResolvedValue({ classTimeZone: 'Asia/Seoul' } as never);
    const request = new Request('http://localhost/api/settings');

    const response = await GET(request);

    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(getAppSettings).toHaveBeenCalledWith({ settingsReader: store });
    await expect(response.json()).resolves.toEqual({ classTimeZone: 'Asia/Seoul' });
  });

  it('disables the legacy user-configurable PATCH route without opening Sheets', async () => {
    const response = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'UTC' }),
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, POST');
    expect(isAuthorizedAdminRequest).not.toHaveBeenCalled();
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
    expect(getAppSettings).not.toHaveBeenCalled();
  });

  it('POST ignores an extra timezone field and preserves the ordinary save contract', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    const saved = { classTimeZone: 'Asia/Seoul', appTitle: 'saved' };
    vi.mocked(saveAppSettings).mockResolvedValue(saved as never);
    const request = new Request('http://localhost/api/settings', {
      method: 'POST',
      body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id', classTimeZone: 'UTC' }),
    });

    const response = await POST(request);

    expect(verifySpreadsheetAccess).toHaveBeenCalledWith('env-sheet-id', request);
    expect(saveAppSettings).toHaveBeenCalledWith(expect.objectContaining({
      settingsStore: store,
      spreadsheetIdOrUrl: 'env-sheet-id',
    }));
    expect(vi.mocked(saveAppSettings).mock.calls[0][0]).not.toHaveProperty('classTimeZone');
    await expect(response.json()).resolves.toEqual(saved);
  });

  it('POST returns Korean 400 for malformed JSON and sanitized 500 for failures', async () => {
    const malformed = await POST(new Request('http://localhost/api/settings', { method: 'POST', body: '{bad-json' }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toMatch(/[가-힣]/);

    vi.mocked(verifySpreadsheetAccess).mockRejectedValue(new Error('provider secret'));
    const failed = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    }));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
  });
});
