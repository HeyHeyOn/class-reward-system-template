import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { readVerifiedStartFreezingConsent, type FreezingConsentBinding, type VerifiedFreezingConsent, type createFreezingConsentIntake } from './freezingConsentIntake';
import { parseFinalBridgeChallenge, type FinalBridgeChallenge } from '../legacyMigrationBridge';
import type { TenantImportTransactionRunner } from './importer';
import { canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

export const START_FREEZING_PURPOSE = 'CLASS_STORE_START_FREEZING_V1';
export const START_FREEZING_ACTION = 'DISABLE_LOCAL_WRITER_AND_START_FREEZING';
export type StartFreezingRegistration = Readonly<{
  tenantId: string; sourceId: string; spreadsheetId: string;
  deploymentId: string; registrationVersion: string; registrationDigest: string;
}>;
export type StartFreezingDisplay = Readonly<{
  action: typeof START_FREEZING_ACTION; automaticEnable: false; ceremonyId: string; consentChallengeId: string;
  tenantId: string; migrationJobId: string; sourceId: string; spreadsheetId: string; expectedStateVersion: string;
  jobSemanticFingerprint: string; sourceAcquisitionDigest: string; preflightSnapshotId: string; preflightDigest: string;
  deploymentId: string; registrationVersion: string; registrationDigest: string; expiresAt: number;
}>;
export type StartFreezingIntent = Readonly<{
  purpose: typeof START_FREEZING_PURPOSE; tenantId: string; ceremonyId: string; consentChallengeDigest: string;
  sessionBinding: string; issuedAt: number; expiresAt: number; display: StartFreezingDisplay;
}>;
const DISPLAY_KEYS = ['action','automaticEnable','ceremonyId','consentChallengeId','tenantId','migrationJobId','sourceId',
  'spreadsheetId','expectedStateVersion','jobSemanticFingerprint','sourceAcquisitionDigest','preflightSnapshotId',
  'preflightDigest','deploymentId','registrationVersion','registrationDigest','expiresAt'];

/** Configuration only. The registration digest must be the bridge client's exact
 * server-owned configuration digest; it is never calculated from browser fields. */
export function detachStartFreezingRegistration(raw: StartFreezingRegistration): StartFreezingRegistration {
  const r = detachScalars(raw, ['tenantId','sourceId','spreadsheetId','deploymentId','registrationVersion','registrationDigest']);
  for (const field of Object.keys(r)) if (typeof r[field] !== 'string' || !r[field] || (r[field] as string).trim() !== r[field]) refused();
  if (!/^[0-9a-f-]{36}$/.test(r.tenantId as string) || (r.sourceId as string).length > 1024
    || (r.spreadsheetId as string).length > 512 || (r.deploymentId as string).length > 128
    || !/^[1-9][0-9]{0,15}$/.test(r.registrationVersion as string)
    || BigInt(r.registrationVersion as string) > BigInt(Number.MAX_SAFE_INTEGER)
    || !/^[0-9a-f]{64}$/.test(r.registrationDigest as string)) refused();
  return Object.freeze(r) as StartFreezingRegistration;
}
export function detachStartFreezingDisplay(raw: unknown): StartFreezingDisplay {
  return Object.freeze(detachScalars(raw, DISPLAY_KEYS)) as StartFreezingDisplay;
}
export function makeStartFreezingIntent(b: FreezingConsentBinding, r: StartFreezingRegistration): StartFreezingIntent {
  if (r.tenantId !== b.tenantId || r.sourceId !== b.sourceId || r.spreadsheetId !== b.spreadsheetId) refused();
  return deepFreeze({ purpose: START_FREEZING_PURPOSE, tenantId: b.tenantId, ceremonyId: b.challengeId,
    consentChallengeDigest: sha256(canonicalJson(b)), sessionBinding: b.sessionBinding, issuedAt: b.issuedAt, expiresAt: b.expiresAt,
    display: { action: START_FREEZING_ACTION, automaticEnable: false, ceremonyId: b.challengeId, consentChallengeId: b.challengeId,
      tenantId: b.tenantId, migrationJobId: b.migrationJobId, sourceId: b.sourceId, spreadsheetId: b.spreadsheetId,
      expectedStateVersion: b.expectedStateVersion, jobSemanticFingerprint: b.jobSemanticFingerprint,
      sourceAcquisitionDigest: b.sourceAcquisitionDigest, preflightSnapshotId: b.preflightSnapshotId, preflightDigest: b.preflightDigest,
      deploymentId: r.deploymentId, registrationVersion: r.registrationVersion, registrationDigest: r.registrationDigest, expiresAt: b.expiresAt } });
}
/** Consistency-only storage helpers. None mint a capability or recover authority. */
export async function appendStartFreezingIntent(tx: TenantTransaction, intent: StartFreezingIntent) {
  await tx.execute(sql`INSERT INTO migration_start_intents(tenant_id,ceremony_id,binding)
    VALUES(${intent.tenantId},${intent.ceremonyId},${JSON.stringify(intent)}::jsonb)`);
  await readStartFreezingIntent(tx, intent);
}
export async function readStartFreezingIntent(tx: TenantTransaction, intent: StartFreezingIntent) {
  const rows = (await tx.execute(sql`SELECT binding FROM migration_start_intents
    WHERE tenant_id=${intent.tenantId} AND ceremony_id=${intent.ceremonyId}`)).rows;
  if (rows.length !== 1) refused();
  equalStartBinding(rows[0].binding, intent);
}
function confirmation(intent: StartFreezingIntent, stateDigest: string) {
  return { purpose: START_FREEZING_PURPOSE, tenantId: intent.tenantId, ceremonyId: intent.ceremonyId,
    intentDigest: sha256(canonicalJson(intent)), stateDigest };
}
export async function confirmStartFreezingIntent(tx: TenantTransaction, intent: StartFreezingIntent, display: StartFreezingDisplay, stateDigest: string) {
  equalStartBinding(display, intent.display);
  await readStartFreezingIntent(tx, intent);
  const binding = confirmation(intent, stateDigest);
  await tx.execute(sql`INSERT INTO migration_start_confirmations(tenant_id,ceremony_id,binding)
    VALUES(${intent.tenantId},${intent.ceremonyId},${JSON.stringify(binding)}::jsonb)`);
  await readStartFreezingConfirmation(tx, intent, stateDigest);
}
export async function readStartFreezingConfirmation(tx: TenantTransaction, intent: StartFreezingIntent, stateDigest: string) {
  await readStartFreezingIntent(tx, intent);
  const rows = (await tx.execute(sql`SELECT binding FROM migration_start_confirmations
    WHERE tenant_id=${intent.tenantId} AND ceremony_id=${intent.ceremonyId}`)).rows;
  if (rows.length !== 1) refused();
  equalStartBinding(rows[0].binding, confirmation(intent, stateDigest));
}
export function equalStartBinding(actual: unknown, expected: unknown) {
  if (canonicalJson(actual) !== canonicalJson(expected)) refused();
}
function detachScalars(raw: unknown, keys: readonly string[]): Record<string, string | number | boolean> {
  if (!raw || typeof raw !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).length !== keys.length) refused();
  const result: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !('value' in d) || !['string','number','boolean'].includes(typeof d.value)) refused();
    result[key] = d.value;
  }
  return result;
}

/** Server-only adapter contract, NOT a production implementation. prepare may
 * issue a real fresh bridge challenge and sign a bounded request, but MUST NOT
 * call the producer. send is exactly one authenticated registered producer call.
 * No browser credential, endpoint, reader, writer control or key is accepted. */
export type StartFreezingBridgeAdapter = Readonly<{
  registration: StartFreezingRegistration;
  prepare(intent: StartFreezingIntent): Promise<Readonly<{
    challenge: FinalBridgeChallenge; requestDigest: string; send(): Promise<unknown>;
  }>>;
}>;
export type StartFreezingDispatchOutcome = Readonly<{
  status: 'UNKNOWN'; externalEffect: 'UNKNOWN'; automaticRetry: false; automaticEnable: false;
}> | Readonly<{
  status: 'BRIDGE_RESPONDED'; response: unknown; bridgeChallenge: FinalBridgeChallenge;
  requestDigest: string; externalEffect: 'UNVERIFIED'; automaticRetry: false; automaticEnable: false;
}>;
/** Same callback continuation only. This checkpoint reserves and sends; it does
 * NOT authenticate a response, consume a bridge capability or commit FREEZING.
 * A caller must not serialize response as authority or retry after uncertainty. */
export async function dispatchStartFreezing(input: Readonly<{
  request: Request; consent: VerifiedFreezingConsent; intake: ReturnType<typeof createFreezingConsentIntake>;
  runTransaction: TenantImportTransactionRunner; adapter: StartFreezingBridgeAdapter;
}>): Promise<StartFreezingDispatchOutcome> {
  const live = readVerifiedStartFreezingConsent(input.consent); // before first await
  const request = new Request(input.request.url, { method: input.request.method, headers: new Headers(input.request.headers) });
  const { consent, intake, runTransaction } = input;
  const registration = detachStartFreezingRegistration(input.adapter.registration);
  const prepare = input.adapter.prepare.bind(input.adapter);
  const { intent } = live;
  const d = intent.display;
  equalStartBinding(registration, { tenantId: intent.tenantId, sourceId: d.sourceId, spreadsheetId: d.spreadsheetId,
    deploymentId: d.deploymentId, registrationVersion: d.registrationVersion, registrationDigest: d.registrationDigest });
  // Cleanup/capture ACK has already happened. No producer work in a transaction.
  const bridgeNotBefore = await runTransaction(intent.tenantId, async tx => {
    await intake.revalidateStart(tx, request, consent);
    const rows = (await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows;
    const now = Number(rows[0]?.ms);
    if (rows.length !== 1 || !Number.isSafeInteger(now) || now < intent.issuedAt || now >= intent.expiresAt) refused();
    return now;
  });
  const prepared = await prepare(intent);
  const bridge = parseFinalBridgeChallenge(prepared.challenge);
  const requestDigest = prepared.requestDigest;
  const send = prepared.send.bind(prepared);
  if (!/^[0-9a-f]{64}$/.test(requestDigest) || bridge.tenantId !== intent.tenantId || bridge.migrationJobId !== d.migrationJobId
    || bridge.sourceId !== d.sourceId || bridge.expectedStateVersion !== d.expectedStateVersion || bridge.deploymentId !== d.deploymentId
    || bridge.actorUserId !== live.binding.actorUserId || bridge.actorSubject !== live.binding.actorSubject
    || bridge.spreadsheetIdDigest !== live.binding.externalSourceId || bridge.jobSemanticFingerprint !== d.jobSemanticFingerprint
    || bridge.sourceAcquisitionDigest !== d.sourceAcquisitionDigest || bridge.issuedAt < bridgeNotBefore) refused();
  const binding = Object.freeze({ purpose: START_FREEZING_PURPOSE, tenantId: intent.tenantId, ceremonyId: intent.ceremonyId,
    intentDigest: sha256(canonicalJson(intent)), bridgeChallengeId: bridge.challengeId,
    registrationDigest: registration.registrationDigest, requestDigest });
  async function freshBridge(tx: TenantTransaction) {
    const rows = (await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows;
    const now = Number(rows[0]?.ms);
    if (rows.length !== 1 || !Number.isSafeInteger(now) || now < bridge.issuedAt || now >= bridge.expiresAt || now >= intent.expiresAt) refused();
  }
  await runTransaction(intent.tenantId, async tx => {
    await intake.revalidateStart(tx, request, consent);
    const challenges = (await tx.execute(sql`SELECT binding FROM migration_bridge_challenges
      WHERE tenant_id=${intent.tenantId} AND challenge_id=${bridge.challengeId}`)).rows;
    if (challenges.length !== 1) refused();
    equalStartBinding(challenges[0].binding, bridge);
    await freshBridge(tx);
    await tx.execute(sql`INSERT INTO migration_start_dispatches(tenant_id,ceremony_id,bridge_challenge_id,binding)
      VALUES(${intent.tenantId},${intent.ceremonyId},${bridge.challengeId},${JSON.stringify(binding)}::jsonb)`);
    const rows = (await tx.execute(sql`SELECT binding FROM migration_start_dispatches
      WHERE tenant_id=${intent.tenantId} AND ceremony_id=${intent.ceremonyId}`)).rows;
    if (rows.length !== 1) refused();
    equalStartBinding(rows[0].binding, binding);
    await intake.revalidateStart(tx, request, consent);
    await freshBridge(tx);
  }); // A lost COMMIT ACK throws before send. Never retry this reservation.
  await runTransaction(intent.tenantId, async tx => {
    await intake.revalidateStart(tx, request, consent);
    await freshBridge(tx);
  });
  if (Date.now() < bridge.issuedAt || Date.now() >= Math.min(bridge.expiresAt, intent.expiresAt)) refused();
  try {
    const transport = await send(); // exactly one invocation, no open transaction
    // The registered client reports uncertain transport as data, not only throws.
    // NOT_SENT is conservatively terminal too; no automatic retry or enable.
    if (!transport || typeof transport !== 'object' || !('outcome' in transport)
      || transport.outcome !== 'RECEIVED' || !('manifest' in transport)) refused();
    const response = transport.manifest;
    await runTransaction(intent.tenantId, async tx => {
      await intake.revalidateStart(tx, request, consent);
      await freshBridge(tx);
    });
    return Object.freeze({ status: 'BRIDGE_RESPONDED', response, bridgeChallenge: bridge, requestDigest,
      externalEffect: 'UNVERIFIED', automaticRetry: false, automaticEnable: false });
  } catch {
    // It may already have disabled its writer. Never report NOT_PERFORMED, retry,
    // enable, leak upstream details or roll back the acknowledged reservation.
    return Object.freeze({ status: 'UNKNOWN', externalEffect: 'UNKNOWN', automaticRetry: false, automaticEnable: false });
  }
}

function refused(): never { throw Error('Start freezing ceremony refused.'); }
