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

  it('returns a sanitized retryable status when GET cannot read settings', async () => {
    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(
      new Error('Google credential secret for Settings!A:Z'),
    );

    const response = await GET(new Request('http://localhost/api/settings'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: '설정을 일시적으로 불러오지 못했습니다.',
      code: 'SETTINGS_UNAVAILABLE',
      retryable: true,
    });
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

    expect(verifySpreadsheetAccess).toHaveBeenCalledWith(store);
    expect(saveAppSettings).toHaveBeenCalledWith(expect.objectContaining({
      settingsStore: store,
      spreadsheetIdOrUrl: 'env-sheet-id',
    }));
    expect(vi.mocked(saveAppSettings).mock.calls[0][0]).not.toHaveProperty('classTimeZone');
    await expect(response.json()).resolves.toEqual(saved);
  });

  it.each(['Students', 'Products'])('POST does not write Settings when %s validation fails', async (sheetName) => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(verifySpreadsheetAccess).mockRejectedValueOnce(new Error(`${sheetName} 시트에 필수 컬럼이 없습니다.`));
    const request = new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(500);
    expect(verifySpreadsheetAccess).toHaveBeenCalledWith(store);
    expect(saveAppSettings).not.toHaveBeenCalled();
  });

  it('POST returns Korean 400 for malformed JSON and sanitized 500 for failures', async () => {
    const malformed = await POST(new Request('http://localhost/api/settings', { method: 'POST', body: '{bad-json' }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toMatch(/[가-힣]/);

    vi.mocked(saveAppSettings).mockRejectedValueOnce(new Error('provider secret project_number:123'));
    const failed = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    }));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
  });
});
