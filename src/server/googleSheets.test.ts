import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleSheetsStore } from '@/server/googleSheets';

const googleMocks = vi.hoisted(() => {
  const oauth2SetCredentials = vi.fn();
  const oauth2Instances: Array<{ setCredentials: typeof oauth2SetCredentials }> = [];
  const sheetsValuesGet = vi.fn();
  const sheetsApi = {
    spreadsheets: {
      values: {
        get: sheetsValuesGet,
        batchUpdate: vi.fn(),
        append: vi.fn(),
      },
      batchUpdate: vi.fn(),
      get: vi.fn(),
    },
  };

  return {
    oauth2SetCredentials,
    oauth2Instances,
    sheetsValuesGet,
    sheetsApi,
    OAuth2: vi.fn(function OAuth2(this: { setCredentials: typeof oauth2SetCredentials }) {
      this.setCredentials = oauth2SetCredentials;
      oauth2Instances.push(this);
    }),
    JWT: vi.fn(),
    sheets: vi.fn(() => sheetsApi),
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: googleMocks.OAuth2,
      JWT: googleMocks.JWT,
    },
    sheets: googleMocks.sheets,
  },
}));

describe('GoogleSheetsStore auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    googleMocks.oauth2Instances.length = 0;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
    delete process.env.GOOGLE_PRIVATE_KEY;
    process.env.GOOGLE_CLIENT_ID = 'client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret';
    process.env.GOOGLE_REFRESH_TOKEN = 'refresh-token';
    googleMocks.sheetsValuesGet.mockResolvedValue({ data: { values: [['studentId'], ['S001']] } });
  });

  it('uses a deployment refresh token for public sheet access without service account credentials', async () => {
    const store = new GoogleSheetsStore('sheet-123');

    await expect(store.getRows('Students')).resolves.toEqual([['studentId'], ['S001']]);

    expect(googleMocks.OAuth2).toHaveBeenCalledWith('client-id', 'client-secret');
    expect(googleMocks.oauth2SetCredentials).toHaveBeenCalledWith({ refresh_token: 'refresh-token' });
    expect(googleMocks.JWT).not.toHaveBeenCalled();
    expect(googleMocks.sheets).toHaveBeenCalledWith({ version: 'v4', auth: googleMocks.oauth2Instances[0] });
    expect(googleMocks.sheetsValuesGet).toHaveBeenCalledWith({ spreadsheetId: 'sheet-123', range: 'Students!A:Z' });
  });
});
