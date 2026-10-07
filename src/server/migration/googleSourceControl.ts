import 'server-only';

import type { GoogleSession } from '@/server/googleOAuth';

const GOOGLE_SHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';
const MAX_EVIDENCE_AGE_MS = 5 * 60_000;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const capabilityBrand: unique symbol = Symbol('VerifiedGoogleSourceControlProof');

export type GoogleDriveSourceControlEvidence = Readonly<{
  observedAt: number;
  file: Readonly<{
    id: string;
    mimeType: string;
    trashed?: boolean;
    driveId?: string | null;
    owners?: ReadonlyArray<Readonly<{ emailAddress?: string | null }>>;
  }>;
  permissions: ReadonlyArray<Readonly<{
    type?: string | null;
    role?: string | null;
    emailAddress?: string | null;
    deleted?: boolean | null;
    pendingOwner?: boolean | null;
    permissionDetails?: ReadonlyArray<Readonly<{
      permissionType?: string | null;
      role?: string | null;
      inherited?: boolean | null;
    }>>;
  }>>;
}>;

export type GoogleDriveMetadataPermissionsReader = Readonly<{
  readMetadataAndPermissions(fileId: string): Promise<unknown>;
}>;

export type VerifiedGoogleSourceControlClaims = Readonly<{
  externalSourceId: string;
  googleSubject: string;
  googleEmail: string;
  role: 'OWNER' | 'ORGANIZER';
  verifiedAt: string;
  verificationMethod?: 'OPERATOR_GOOGLE_SHARE_UI';
  evidenceDigest?: string;
}>;

export type VerifiedGoogleSourceControlProof = Readonly<{
  [capabilityBrand]: true;
}>;

type VerifyGoogleSheetSourceControlInput = Readonly<{
  fileId: string;
  session: GoogleSession;
  reader: GoogleDriveMetadataPermissionsReader;
  now?: () => number;
  maxEvidenceAgeMs?: number;
}>;

const mintedCapabilities = new WeakMap<object, VerifiedGoogleSourceControlClaims>();

/** Operator-only alternative when the existing OAuth grant has Sheets but no
 * Drive permission. The reader is a trusted composition dependency, never HTTP
 * input: it must freshly observe Google's sharing UI and check the selected
 * spreadsheet with the same provider-authenticated identity. Do not manufacture
 * Drive metadata/permissions from this observation. This narrow path supports
 * only a restricted, single-owner personal spreadsheet, not shared drives.
 * The observation's digest is retained in the bootstrap audit.
 */
export async function verifyOperatorObservedGoogleSheetControl(input: Readonly<{
  fileId: string;
  session: GoogleSession;
  readObservation: (fileId: string) => Promise<unknown>;
  now?: () => number;
}>): Promise<VerifiedGoogleSourceControlProof> {
  const now = input.now?.() ?? Date.now();
  const fileId = requireBoundedString(input.fileId, 1, 1024);
  const subject = requireBoundedString(input.session?.subject, 1, 255);
  const email = normalizeVerifiedEmail(input.session?.email);
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(input.session?.issuedAt)
    || input.session.issuedAt > now || now - input.session.issuedAt > MAX_EVIDENCE_AGE_MS) {
    throw new Error('Fresh provider-authenticated operator identity required.');
  }
  const evidence = await input.readObservation(fileId);
  if (!isRecord(evidence) || evidence.method !== 'OPERATOR_GOOGLE_SHARE_UI'
    || evidence.fileId !== fileId || evidence.googleSubject !== subject
    || !emailMatches(evidence.ownerEmail, email) || evidence.ownerIsSignedInUser !== true
    || evidence.role !== 'OWNER' || evidence.generalAccess !== 'RESTRICTED'
    || evidence.listedPrincipals !== 1 || evidence.providerSpreadsheetReadSucceeded !== true
    || typeof evidence.observedAt !== 'number' || !Number.isSafeInteger(evidence.observedAt)
    || evidence.observedAt > now || now - evidence.observedAt > MAX_EVIDENCE_AGE_MS
    || typeof evidence.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.evidenceDigest)) {
    throw new Error('Fresh, matching Google sharing observation required.');
  }
  const capability = Object.freeze({ [capabilityBrand]: true as const });
  mintedCapabilities.set(capability, Object.freeze({ externalSourceId: fileId,
    googleSubject: subject, googleEmail: email, role: 'OWNER', verifiedAt: new Date(now).toISOString(),
    verificationMethod: 'OPERATOR_GOOGLE_SHARE_UI', evidenceDigest: evidence.evidenceDigest }));
  return capability;
}

export async function verifyGoogleSheetSourceControl(
  input: VerifyGoogleSheetSourceControlInput,
): Promise<VerifiedGoogleSourceControlProof> {
  const now = input.now?.() ?? Date.now();
  const fileId = requireBoundedString(input.fileId, 1, 1024);
  const subject = requireBoundedString(input.session?.subject, 1, 255);
  const email = normalizeVerifiedEmail(input.session?.email);
  if (!Number.isSafeInteger(now)
    || !Number.isSafeInteger(input.session?.issuedAt)
    || input.session.issuedAt > now
    || now - input.session.issuedAt > MAX_SESSION_AGE_MS) {
    throw new Error('An authenticated, current Google session is required.');
  }

  const evidence = await input.reader.readMetadataAndPermissions(fileId);
  const maxAge = input.maxEvidenceAgeMs ?? MAX_EVIDENCE_AGE_MS;
  if (!isRecord(evidence)) {
    throw new Error('Fresh Google Drive evidence is required.');
  }
  const observedAt = evidence.observedAt;
  if (typeof observedAt !== 'number'
    || !Number.isSafeInteger(observedAt)
    || !Number.isSafeInteger(maxAge)
    || maxAge < 0
    || observedAt > now
    || now - observedAt > maxAge) {
    throw new Error('Fresh Google Drive evidence is required.');
  }

  const role = determineControlRole(evidence, fileId, email);
  const claims = Object.freeze({
    externalSourceId: fileId,
    googleSubject: subject,
    googleEmail: email,
    role,
    verifiedAt: new Date(now).toISOString(),
  });
  const capability = Object.freeze({ [capabilityBrand]: true as const });
  mintedCapabilities.set(capability, claims);
  return capability;
}

export function getVerifiedGoogleSourceControlClaims(
  capability: unknown,
): VerifiedGoogleSourceControlClaims {
  if (!isRecord(capability)) {
    throw new Error('A verified Google source control capability is required.');
  }
  const claims = mintedCapabilities.get(capability);
  if (!claims) {
    throw new Error('A verified Google source control capability is required.');
  }
  return claims;
}

export function assertVerifiedGoogleSourceControlProof(
  capability: unknown,
): asserts capability is VerifiedGoogleSourceControlProof {
  getVerifiedGoogleSourceControlClaims(capability);
}

function determineControlRole(
  evidence: Record<string, unknown>,
  selectedFileId: string,
  sessionEmail: string,
): 'OWNER' | 'ORGANIZER' {
  if (!isRecord(evidence.file)
    || evidence.file.id !== selectedFileId
    || evidence.file.mimeType !== GOOGLE_SHEET_MIME_TYPE
    || evidence.file.trashed !== false
    || !Array.isArray(evidence.permissions)) {
    throw new Error('Verified Google Sheet control is required.');
  }

  const permissions = evidence.permissions.filter(isRecord);
  const driveId = evidence.file.driveId;
  if (driveId === undefined || driveId === null) {
    const owners = Array.isArray(evidence.file.owners) ? evidence.file.owners : [];
    const metadataNamesSessionAsOwner = owners.some((owner) =>
      isRecord(owner) && emailMatches(owner.emailAddress, sessionEmail));
    const ownerPermission = permissions.some((permission) =>
      permission.type === 'user'
      && permission.role === 'owner'
      && permission.deleted !== true
      && permission.pendingOwner !== true
      && emailMatches(permission.emailAddress, sessionEmail));
    if (metadataNamesSessionAsOwner && ownerPermission) return 'OWNER';
  } else if (requireOptionalDriveId(driveId)) {
    const organizerPermission = permissions.some((permission) => {
      if (permission.type !== 'user'
        || permission.role !== 'organizer'
        || permission.deleted === true
        || !emailMatches(permission.emailAddress, sessionEmail)
        || !Array.isArray(permission.permissionDetails)) return false;
      return permission.permissionDetails.some((detail) =>
        isRecord(detail)
        && detail.permissionType === 'member'
        && detail.role === 'organizer');
    });
    if (organizerPermission) return 'ORGANIZER';
  }

  throw new Error('Verified Google Sheet control is required.');
}

function requireOptionalDriveId(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value;
}

function requireBoundedString(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string'
    || value.length < min
    || value.length > max
    || value.trim() !== value) {
    throw new Error('Verified Google Sheet control is required.');
  }
  return value;
}

function normalizeVerifiedEmail(value: unknown): string {
  const email = requireBoundedString(value, 3, 320);
  if (!EMAIL.test(email)) throw new Error('An authenticated Google email is required.');
  return email.toLowerCase();
}

function emailMatches(value: unknown, expected: string): boolean {
  return typeof value === 'string'
    && value.trim() === value
    && EMAIL.test(value)
    && value.toLowerCase() === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
