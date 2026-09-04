import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createConfiguredSheetsStore } from '@/server/googleSheets';
import { runWithTrustedTenantRequestContext } from '@/server/trustedTenantRequestContext';

const originalSheetId = process.env.GOOGLE_SHEET_ID;

afterEach(() => {
  if (originalSheetId === undefined) delete process.env.GOOGLE_SHEET_ID;
  else process.env.GOOGLE_SHEET_ID = originalSheetId;
});

describe('configured Sheets store tenant boundary', () => {
  it('fails closed instead of falling back to the deployment Sheet in a scoped tenant request', async () => {
    process.env.GOOGLE_SHEET_ID = 'deployment-default-sheet';

    await runWithTrustedTenantRequestContext({
      tenant: {
        id: '20000000-0000-4000-8000-000000000001',
        slug: 'alpha-class',
        displayName: 'Alpha',
        lifecycle: 'ACTIVE',
        timezone: 'Asia/Seoul',
      },
    }, async () => {
      await expect(createConfiguredSheetsStore()).rejects.toThrow(/scoped tenant request/i);
    });
  });
});
