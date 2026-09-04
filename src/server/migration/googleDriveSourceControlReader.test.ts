import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { createGoogleDriveV3SourceControlReader } from '@/server/migration/googleDriveSourceControlReader';

const NOW = Date.parse('2026-09-04T03:00:00.000Z');

describe('Google Drive v3 source-control evidence reader', () => {
  it('reads the selected file with only the metadata and permission fields required for control verification', async () => {
    const request = vi.fn(async () => ({
      data: {
        id: 'sheet/source one',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        trashed: false,
        driveId: 'shared-drive-one',
        owners: [{ emailAddress: 'teacher@example.com' }],
        permissions: [{
          type: 'user',
          role: 'organizer',
          emailAddress: 'teacher@example.com',
          deleted: false,
          pendingOwner: false,
          permissionDetails: [{ permissionType: 'member', role: 'organizer', inherited: true }],
        }],
      },
    }));
    const reader = createGoogleDriveV3SourceControlReader({ request }, () => NOW);

    await expect(reader.readMetadataAndPermissions('sheet/source one')).resolves.toEqual({
      observedAt: NOW,
      file: {
        id: 'sheet/source one',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        trashed: false,
        driveId: 'shared-drive-one',
        owners: [{ emailAddress: 'teacher@example.com' }],
      },
      permissions: [{
        type: 'user',
        role: 'organizer',
        emailAddress: 'teacher@example.com',
        deleted: false,
        pendingOwner: false,
        permissionDetails: [{ permissionType: 'member', role: 'organizer', inherited: true }],
      }],
    });
    expect(request).toHaveBeenCalledWith({
      url: 'https://www.googleapis.com/drive/v3/files/sheet%2Fsource%20one',
      method: 'GET',
      params: {
        supportsAllDrives: true,
        fields: 'id,mimeType,trashed,driveId,owners(emailAddress),permissions(type,role,emailAddress,deleted,pendingOwner,permissionDetails(permissionType,role,inherited))',
      },
    });
  });
});
