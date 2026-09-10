import 'server-only';
import { deepFreeze } from './sensitiveRedaction';

export const FREEZING_REACQUISITION_PURPOSE = 'CLASS_STORE_FREEZING_REACQUISITION';
export const FREEZING_REACQUISITION_SCOPE = 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE';
export const FREEZING_REACQUISITION_PATH = '/api/internal/migrations/freezing-reacquisition';
export type FreezingReacquisitionChallenge = Readonly<{
  purpose: typeof FREEZING_REACQUISITION_PURPOSE; bindingVersion: 1; expectedStatus: 'FREEZING';
  challengeId: string; tenantId: string; migrationJobId: string; expectedStateVersion: string;
  sourceId: string; spreadsheetIdDigest: string; jobSemanticFingerprint: string; sourceAcquisitionDigest: string;
  deploymentId: string; actorUserId: string; actorSubject: string; sessionBinding: string;
  startCeremonyId: string; executionDigest: string; preflightSnapshotId: string; preflightSnapshotDigest: string;
  registrationDigest: string; registrationVersion: string; issuedAt: number; expiresAt: number;
}>;
export function refuseFreezingReacquisition(): never { throw new Error('Freezing reacquisition refused.'); }
export function exactFreezingData(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).length !== keys.length) refuseFreezingReacquisition();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) refuseFreezingReacquisition();
    result[key] = descriptor.value;
  }
  return result;
}
const KEYS = ['purpose', 'bindingVersion', 'expectedStatus', 'challengeId', 'tenantId', 'migrationJobId',
  'expectedStateVersion', 'sourceId', 'spreadsheetIdDigest', 'jobSemanticFingerprint', 'sourceAcquisitionDigest',
  'deploymentId', 'actorUserId', 'actorSubject', 'sessionBinding', 'startCeremonyId', 'executionDigest',
  'preflightSnapshotId', 'preflightSnapshotDigest', 'registrationDigest', 'registrationVersion', 'issuedAt', 'expiresAt'];
/** Immutable signed binding data, never a current membership or execution capability. */
export function parseFreezingReacquisitionChallenge(raw: unknown): FreezingReacquisitionChallenge {
  const value = exactFreezingData(raw, KEYS);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const key of ['challengeId', 'tenantId', 'migrationJobId', 'actorUserId', 'startCeremonyId']) {
    if (typeof value[key] !== 'string' || !uuid.test(value[key])) refuseFreezingReacquisition();
  }
  for (const key of ['spreadsheetIdDigest', 'jobSemanticFingerprint', 'sourceAcquisitionDigest', 'sessionBinding',
    'executionDigest', 'preflightSnapshotDigest', 'registrationDigest']) {
    if (typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key])) refuseFreezingReacquisition();
  }
  for (const key of ['expectedStateVersion', 'registrationVersion']) {
    if (typeof value[key] !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value[key])
      || BigInt(value[key]) > BigInt(Number.MAX_SAFE_INTEGER)) refuseFreezingReacquisition();
  }
  // SQL importer uses import:<manifestDigest>, not a UUID. Preserve it literally.
  for (const key of ['sourceId', 'deploymentId', 'actorSubject', 'preflightSnapshotId']) {
    const text = value[key];
    if (typeof text !== 'string' || !text || text.trim() !== text || text.length > (key === 'actorSubject' ? 255 : 512)
      || /[\x00-\x1f\x7f]/.test(text)) refuseFreezingReacquisition();
  }
  if (value.purpose !== FREEZING_REACQUISITION_PURPOSE || value.bindingVersion !== 1 || value.expectedStatus !== 'FREEZING'
    || !Number.isSafeInteger(value.issuedAt) || Number(value.issuedAt) < 0 || !Number.isSafeInteger(value.expiresAt)
    || Number(value.expiresAt) - Number(value.issuedAt) !== 60_000) refuseFreezingReacquisition();
  return deepFreeze(value as FreezingReacquisitionChallenge);
}
export function assertFreezingLifetime(issuedAt: number, expiresAt: number): void {
  const now = Date.now();
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt < 0
    || issuedAt > now || now >= expiresAt || expiresAt - issuedAt > 60_000) refuseFreezingReacquisition();
}
