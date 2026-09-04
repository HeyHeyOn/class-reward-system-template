import 'server-only';

import type { GoogleDriveMetadataPermissionsReader } from '@/server/migration/googleSourceControl';

const DRIVE_FILE_FIELDS = 'id,mimeType,trashed,driveId,owners(emailAddress),permissions(type,role,emailAddress,deleted,pendingOwner,permissionDetails(permissionType,role,inherited))';

type GoogleDriveFileRequest = Readonly<{
  url: string;
  method: 'GET';
  params: Readonly<{
    supportsAllDrives: true;
    fields: typeof DRIVE_FILE_FIELDS;
  }>;
}>;

export type AuthenticatedGoogleDriveRequestClient = Readonly<{
  request(options: GoogleDriveFileRequest): PromiseLike<Readonly<{ data: unknown }>>;
}>;

export function createGoogleDriveV3SourceControlReader(
  client: AuthenticatedGoogleDriveRequestClient,
  now: () => number = Date.now,
): GoogleDriveMetadataPermissionsReader {
  return {
    async readMetadataAndPermissions(fileId: string): Promise<unknown> {
      const response = await client.request({
        url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`,
        method: 'GET',
        params: {
          supportsAllDrives: true,
          fields: DRIVE_FILE_FIELDS,
        },
      });
      const data = isRecord(response.data) ? response.data : {};
      return {
        observedAt: now(),
        file: {
          id: data.id,
          mimeType: data.mimeType,
          trashed: data.trashed,
          driveId: data.driveId,
          owners: data.owners,
        },
        permissions: data.permissions,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
