import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAuthorizedAdminRequest } from '@/server/apiAuth';
import { createConfiguredSheetsStore, verifySpreadsheetAccess } from '@/server/googleSheets';
import { getAppSettings, saveAppSettings, updateClassTimeZone } from '@/server/settings';
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
  return {
    ...actual,
    getAppSettings: vi.fn(),
    saveAppSettings: vi.fn(),
    updateClassTimeZone: vi.fn(),
  };
});

describe('/api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(verifySpreadsheetAccess).mockResolvedValue(undefined);
  });

  it('keeps GET read-only and uses the request-aware configured store', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(getAppSettings).mockResolvedValue({ classTimeZone: 'Asia/Seoul' } as never);
    const request = new Request('http://localhost/api/settings');

    const response = await GET(request);

    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(getAppSettings).toHaveBeenCalledWith({ settingsReader: store });
    expect(updateClassTimeZone).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ classTimeZone: 'Asia/Seoul' });
  });

  it('PATCH validates, pre-reads full settings, then runs the timezone command as its final fallible operation', async () => {
    const invalid = new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: '+09:00' }),
    });
    const invalidResponse = await PATCH(invalid);
    expect(invalidResponse.status).toBe(400);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();

    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(updateClassTimeZone).mockResolvedValue({ classTimeZone: 'UTC', changedAt: 'now', updatedTaskCount: 2 });
    const prior = { classTimeZone: 'Asia/Seoul', appTitle: 'Full shape', currencyUnit: '별' };
    vi.mocked(getAppSettings).mockResolvedValue(prior as never);
    const request = new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'UTC' }),
    });
    const response = await PATCH(request);

    expect(response.status).toBe(200);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(updateClassTimeZone).toHaveBeenCalledWith(store, 'UTC');
    expect(getAppSettings).toHaveBeenCalledWith({ settingsReader: store });
    await expect(response.json()).resolves.toEqual({ ...prior, classTimeZone: 'UTC' });
    expect(getAppSettings).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getAppSettings).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(updateClassTimeZone).mock.invocationCallOrder[0]);
  });

  it('PATCH does not mutate when its pre-read fails and never reads after a successful command', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(getAppSettings).mockRejectedValue(new Error('read failed'));
    const failed = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'UTC' }),
    }));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
    expect(updateClassTimeZone).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(getAppSettings).mockResolvedValue({ classTimeZone: 'Asia/Seoul', appTitle: 'kept' } as never);
    vi.mocked(updateClassTimeZone).mockResolvedValue({ classTimeZone: 'UTC', changedAt: 'now', updatedTaskCount: 1 });
    const success = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'UTC' }),
    }));
    expect(success.status).toBe(200);
    expect(getAppSettings).toHaveBeenCalledTimes(1);
  });

  it('PATCH returns command failure rather than success', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(getAppSettings).mockResolvedValue({ classTimeZone: 'Asia/Seoul' } as never);
    vi.mocked(updateClassTimeZone).mockRejectedValue(new Error('atomic failed'));
    const response = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'UTC' }),
    }));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
  });

  it('PATCH treats malformed JSON as a Korean 400 validation error without opening the store', async () => {
    const response = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH', body: '{not-json',
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/[가-힣]/);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });

  it('PATCH sanitizes configured-store failures as operational 500 responses', async () => {
    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(new Error('provider credential secret'));
    const response = await PATCH(new Request('http://localhost/api/settings', {
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'UTC' }),
    }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
  });

  it('POST ignores an extra timezone field and preserves the legacy save contract', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    const saved = { classTimeZone: 'Asia/Seoul', appTitle: 'saved' };
    vi.mocked(saveAppSettings).mockResolvedValue(saved as never);
    const request = new Request('http://localhost/api/settings', {
      method: 'POST',
      body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id', classTimeZone: '+09:00' }),
    });

    const response = await POST(request);

    expect(verifySpreadsheetAccess).toHaveBeenCalledWith('env-sheet-id', request);
    expect(createConfiguredSheetsStore).toHaveBeenCalledWith(request);
    expect(updateClassTimeZone).not.toHaveBeenCalled();
    expect(saveAppSettings).toHaveBeenCalledWith(expect.objectContaining({
      settingsStore: store,
      spreadsheetIdOrUrl: 'env-sheet-id',
    }));
    expect(vi.mocked(saveAppSettings).mock.calls[0][0]).not.toHaveProperty('classTimeZone');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(saved);
  });

  it('POST sanitizes verify and save failures as operational 500 responses', async () => {
    const store = {};
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(saveAppSettings).mockRejectedValue(new Error('save failed'));
    const failed = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    }));
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });

    vi.clearAllMocks();
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(true);
    vi.mocked(verifySpreadsheetAccess).mockRejectedValue(new Error('provider token detail'));
    const verifyFailed = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    }));
    expect(verifyFailed.status).toBe(500);
    await expect(verifyFailed.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
  });

  it('POST returns Korean 400 for malformed JSON and sanitized 500 for store creation failures', async () => {
    const malformed = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: '{bad-json',
    }));
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toMatch(/[가-힣]/);
    expect(verifySpreadsheetAccess).not.toHaveBeenCalled();

    vi.mocked(createConfiguredSheetsStore).mockRejectedValue(new Error('provider internals'));
    const storeFailed = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    }));
    expect(storeFailed.status).toBe(500);
    await expect(storeFailed.json()).resolves.toEqual({ error: '설정을 저장하지 못했습니다.' });
  });

  it('POST without a timezone preserves the save result and skips the atomic command', async () => {
    const store = {};
    const saved = { classTimeZone: 'Europe/Paris', appTitle: 'saved' };
    vi.mocked(createConfiguredSheetsStore).mockResolvedValue(store as never);
    vi.mocked(saveAppSettings).mockResolvedValue(saved as never);

    const response = await POST(new Request('http://localhost/api/settings', {
      method: 'POST', body: JSON.stringify({ spreadsheetIdOrUrl: 'env-sheet-id' }),
    }));

    expect(response.status).toBe(200);
    expect(updateClassTimeZone).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual(saved);
  });

  it('requires admin auth for timezone mutations', async () => {
    vi.mocked(isAuthorizedAdminRequest).mockReturnValue(false);
    const response = await PATCH(new Request('http://localhost/api/settings', { method: 'PATCH' }));
    expect(response.status).toBe(401);
    expect(createConfiguredSheetsStore).not.toHaveBeenCalled();
  });
});
