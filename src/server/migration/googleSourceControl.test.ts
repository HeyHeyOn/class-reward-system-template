import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { GoogleSession } from '@/server/googleOAuth';
import {
  getVerifiedGoogleSourceControlClaims,
  verifyGoogleSheetSourceControl,
} from '@/server/migration/googleSourceControl';

const NOW = Date.parse('2026-09-04T02:00:00.000Z');
const session: GoogleSession = {
  subject: 'google-subject-owner',
  email: 'Teacher@Example.com',
  name: 'Teacher',
  issuedAt: NOW - 60_000,
};

function myDriveEvidence(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: NOW - 1_000,
    file: {
      id: 'sheet-source-one',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      trashed: false,
      owners: [{ emailAddress: 'teacher@example.com' }],
    },
    permissions: [{
      type: 'user',
      role: 'owner',
      emailAddress: 'teacher@example.com',
      deleted: false,
      pendingOwner: false,
    }],
    ...overrides,
  };
}

function verifier(evidence: unknown) {
  const readMetadataAndPermissions = vi.fn().mockResolvedValue(evidence);
  return {
    readMetadataAndPermissions,
    verify: () => verifyGoogleSheetSourceControl({
      fileId: 'sheet-source-one',
      session,
      reader: { readMetadataAndPermissions },
      now: () => NOW,
    }),
  };
}

describe('Google Sheet source control verification', () => {
  it('binds a selected My Drive Sheet to its authenticated owner subject and email', async () => {
    const fake = verifier(myDriveEvidence());

    const capability = await fake.verify();

    expect(fake.readMetadataAndPermissions).toHaveBeenCalledWith('sheet-source-one');
    expect(Object.isFrozen(capability)).toBe(true);
    expect(getVerifiedGoogleSourceControlClaims(capability)).toEqual({
      externalSourceId: 'sheet-source-one',
      googleSubject: 'google-subject-owner',
      googleEmail: 'teacher@example.com',
      role: 'OWNER',
      verifiedAt: new Date(NOW).toISOString(),
    });
  });

  it('accepts explicitly supported Shared Drive organizer control', async () => {
    const fake = verifier(myDriveEvidence({
      file: {
        id: 'sheet-source-one',
        mimeType: 'application/vnd.google-apps.spreadsheet',
        driveId: 'shared-drive-one',
        trashed: false,
        owners: [],
      },
      permissions: [{
        type: 'user',
        role: 'organizer',
        emailAddress: 'teacher@example.com',
        deleted: false,
        permissionDetails: [{ permissionType: 'member', role: 'organizer', inherited: true }],
      }],
    }));

    const capability = await fake.verify();

    expect(getVerifiedGoogleSourceControlClaims(capability).role).toBe('ORGANIZER');
  });

  it.each([
    ['writer permission', myDriveEvidence({ permissions: [{ type: 'user', role: 'writer', emailAddress: 'teacher@example.com' }] })],
    ['editor permission', myDriveEvidence({ permissions: [{ type: 'user', role: 'editor', emailAddress: 'teacher@example.com' }] })],
    ['file organizer permission', myDriveEvidence({
      file: { id: 'sheet-source-one', mimeType: 'application/vnd.google-apps.spreadsheet', driveId: 'shared-drive-one', trashed: false, owners: [] },
      permissions: [{ type: 'user', role: 'fileOrganizer', emailAddress: 'teacher@example.com' }],
    })],
    ['mismatched owner email', myDriveEvidence({
      file: { id: 'sheet-source-one', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, owners: [{ emailAddress: 'other@example.com' }] },
      permissions: [{ type: 'user', role: 'owner', emailAddress: 'other@example.com' }],
    })],
    ['mismatched file id', myDriveEvidence({
      file: { id: 'another-sheet', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: false, owners: [{ emailAddress: 'teacher@example.com' }] },
    })],
    ['non-Sheet metadata', myDriveEvidence({
      file: { id: 'sheet-source-one', mimeType: 'application/vnd.google-apps.document', trashed: false, owners: [{ emailAddress: 'teacher@example.com' }] },
    })],
    ['trashed metadata', myDriveEvidence({
      file: { id: 'sheet-source-one', mimeType: 'application/vnd.google-apps.spreadsheet', trashed: true, owners: [{ emailAddress: 'teacher@example.com' }] },
    })],
    ['malformed metadata', { observedAt: NOW - 1_000, file: null, permissions: [] }],
  ])('rejects %s', async (_label, evidence) => {
    await expect(verifier(evidence).verify()).rejects.toThrow(/verified Google Sheet control/i);
  });

  it.each([
    ['stale', NOW - (5 * 60_000) - 1],
    ['future', NOW + 1],
    ['malformed', '2026-09-04T02:00:00.000Z'],
    ['unverified', undefined],
  ])('rejects %s Drive evidence', async (_label, observedAt) => {
    await expect(verifier(myDriveEvidence({ observedAt })).verify())
      .rejects.toThrow(/fresh Google Drive evidence/i);
  });

  it('rejects capabilities not minted by this verifier module', () => {
    const plainJsonLookalike = Object.freeze({
      externalSourceId: 'sheet-source-one',
      googleSubject: session.subject,
      googleEmail: 'teacher@example.com',
      role: 'OWNER',
      verifiedAt: new Date(NOW).toISOString(),
    });

    expect(() => getVerifiedGoogleSourceControlClaims(plainJsonLookalike))
      .toThrow(/verified Google source control capability/i);
  });
});