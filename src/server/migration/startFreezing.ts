import 'server-only';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import { readVerifiedStartFreezingConsent } from './freezingConsentIntake';
import { readVerifiedFinalBridgeAcquisition, type VerifiedFinalBridgeAcquisition, type createFinalBridgeIntake } from './finalBridgeIntake';
import { dispatchStartFreezing, readLiveStartDispatch, equalStartBinding, START_FREEZING_PURPOSE, type StartFreezingDispatchOutcome } from './startFreezingCeremony';
import { createLegacyNormalizationManifest } from './manifest';
import { canonicalJson, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';
import { readFreezingConsentSession, revalidateFreezingConsentSession } from './freezingConsentSession';

type Continuation = Parameters<typeof dispatchStartFreezing>[0] & Readonly<{
  bridgeIntake: ReturnType<typeof createFinalBridgeIntake>;
}>;
type StartInput = Pick<Continuation, 'request' | 'consent' | 'intake' | 'runTransaction'> & Readonly<{
  dispatch: StartFreezingDispatchOutcome; bridge: VerifiedFinalBridgeAcquisition;
}>;
const attempted = new WeakSet<object>();
export type StartedFreezing = Readonly<{
  status: 'STARTED'; ceremonyId: string; migrationJobId: string; stateVersion: string;
  exclusion: 'NOT_PROVEN'; automaticRetry: false; automaticEnable: false;
}>;

/** Same callback invocation, after fresh consent cleanup and capture COMMIT ACK.
 * Registered dispatch is side-effecting. Any later refusal leaves its disable and
 * intake tombstones intact. No automatic retry, enable or authority recovery. */
export async function continueStartFreezing(input: Continuation): Promise<StartedFreezing | StartFreezingDispatchOutcome> {
  readVerifiedStartFreezingConsent(input.consent);
  const request = detachRequest(input.request);
  const { consent, intake, runTransaction, bridgeIntake, adapter } = input;
  const dispatch = await dispatchStartFreezing({ request, consent, intake, runTransaction, adapter });
  if (dispatch.status === 'UNKNOWN') return dispatch;
  const bridge = await bridgeIntake.accept({ challengeId: dispatch.bridgeChallenge.challengeId, manifest: dispatch.response });
  return startFreezing({ request, consent, intake, runTransaction, dispatch, bridge });
}

/** Atomic local consumer. Three private registries precede the first await.
 * Persisted matching receipts/dispatches never substitute for these capabilities.
 * The caller supplies a canonical tenant-bound intake and single-attempt runner. */
export async function startFreezing(input: StartInput): Promise<StartedFreezing> {
  const live = readVerifiedStartFreezingConsent(input.consent);
  const acquired = readVerifiedFinalBridgeAcquisition(input.bridge);
  const sent = readLiveStartDispatch(input.dispatch, input.consent);
  const { consent, intake, runTransaction, dispatch } = input;
  const request = detachRequest(input.request);
  if (attempted.has(dispatch)) refused();
  attempted.add(dispatch); // failure/uncertain ACK is terminal, even in this process
  const { intent, binding: b } = live;
  const bridge = acquired.challenge;
  equalStartBinding(bridge, sent.challenge);
  if (bridge.tenantId !== b.tenantId || bridge.migrationJobId !== b.migrationJobId || bridge.sourceId !== b.sourceId
    || bridge.actorUserId !== b.actorUserId || bridge.actorSubject !== b.actorSubject
    || bridge.expectedStateVersion !== b.expectedStateVersion || bridge.spreadsheetIdDigest !== b.externalSourceId
    || bridge.jobSemanticFingerprint !== b.jobSemanticFingerprint || bridge.sourceAcquisitionDigest !== b.sourceAcquisitionDigest
    || bridge.deploymentId !== intent.display.deploymentId || acquired.sheets.spreadsheetId !== b.spreadsheetId
    || BigInt(b.expectedStateVersion) >= BigInt(Number.MAX_SAFE_INTEGER)) refused();
  const normalization = createLegacyNormalizationManifest({ tenantId: b.tenantId, migrationJobId: b.migrationJobId,
    sheets: acquired.sheets, redis: acquired.redis });
  equalStartBinding(normalization, acquired.normalization);
  if (normalization.status !== 'READY_FOR_IMPORT' || normalization.quarantines.length || normalization.blockingConflicts.length) refused();
  // Complete bridge pair is the candidate; OAuth Sheet-only diagnostics do NOT
  // decide complete-pair eligibility. OAuth provenance remains separately linked.
  const acquisition = deepFreeze({ kind: 'AUTHENTIC_START_ACQUISITION', exclusion: 'NOT_PROVEN',
    sheets: acquired.sheets, redis: acquired.redis, normalization });
  const acquisitionBytes = canonicalJson(acquisition);
  if (Buffer.byteLength(acquisitionBytes) > 8_000_000) refused();
  const acquisitionDigest = sha256(acquisitionBytes);
  const auditEventId = `start-acquisition:${intent.ceremonyId}:${acquisitionDigest}`;
  const execution = deepFreeze({ purpose: 'CLASS_STORE_START_EXECUTION_V1', status: 'STARTED', exclusion: 'NOT_PROVEN',
    tenantId: b.tenantId, ceremonyId: intent.ceremonyId, migrationJobId: b.migrationJobId, sourceId: b.sourceId,
    expectedStateVersion: b.expectedStateVersion, stateVersion: String(BigInt(b.expectedStateVersion) + BigInt(1)),
    actorUserId: b.actorUserId, actorSubject: b.actorSubject, actorEmail: b.actorEmail, sessionBinding: b.sessionBinding,
    intentDigest: sha256(canonicalJson(intent)), consentChallengeId: b.challengeId, consentChallengeDigest: live.consent.challengeDigest,
    consentCaptureDigest: live.consent.captureDigest, consentAcquisitionDigest: live.consent.acquisitionDigest,
    consentNormalizationDigest: live.consent.normalizationDigest,
    jobSemanticFingerprint: b.jobSemanticFingerprint, sourceAcquisitionDigest: b.sourceAcquisitionDigest,
    preflightSnapshotId: b.preflightSnapshotId, preflightDigest: b.preflightDigest,
    bridgeChallengeId: bridge.challengeId, bridgeChallengeDigest: sha256(canonicalJson(bridge)),
    envelopeDigest: acquired.envelopeDigest, nonceDigest: acquired.nonceDigest,
    envelopeIssuedAt: acquired.envelopeIssuedAt, envelopeExpiresAt: acquired.envelopeExpiresAt,
    bridgeSheetsDigest: acquired.sheets.digest, bridgeRedisDigest: acquired.redis.digest,
    bridgeNormalizationDigest: normalization.manifestDigest, writerEvidenceDigest: acquired.writerEvidenceDigest,
    registrationDigest: intent.display.registrationDigest, requestDigest: sent.requestDigest, auditEventId, acquisitionDigest });
  const expectedDispatch = { purpose: START_FREEZING_PURPOSE, tenantId: b.tenantId, ceremonyId: intent.ceremonyId,
    intentDigest: execution.intentDigest, bridgeChallengeId: bridge.challengeId,
    registrationDigest: execution.registrationDigest, requestDigest: sent.requestDigest };
  async function fresh(tx: TenantTransaction) {
    const rows = (await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows;
    const now = Number(rows[0]?.ms);
    if (rows.length !== 1 || !Number.isSafeInteger(now) || now < Math.max(intent.issuedAt, b.issuedAt, bridge.issuedAt, acquired.envelopeIssuedAt)
      || now >= Math.min(intent.expiresAt, b.expiresAt, bridge.expiresAt, acquired.envelopeExpiresAt)) refused();
  }
  let transactionEntered = false;
  return runTransaction(b.tenantId, async tx => {
    if (transactionEntered) refused();
    transactionEntered = true;
    // Actual READ COMMITTED, tenant/job/source FOR UPDATE, user/membership and
    // exact-one PREFLIGHT, actual session and all original bindings after waits.
    await intake.revalidateStart(tx, request, consent);
    const dispatches = (await tx.execute(sql`SELECT binding FROM migration_start_dispatches WHERE tenant_id=${b.tenantId} AND ceremony_id=${intent.ceremonyId}`)).rows;
    if (dispatches.length !== 1) refused();
    equalStartBinding(dispatches[0].binding, expectedDispatch);
    const challenges = (await tx.execute(sql`SELECT binding FROM migration_bridge_challenges WHERE tenant_id=${b.tenantId} AND challenge_id=${bridge.challengeId}`)).rows;
    if (challenges.length !== 1) refused();
    equalStartBinding(challenges[0].binding, bridge);
    const consumed = (await tx.execute(sql`SELECT nonce_digest FROM migration_bridge_consumptions WHERE tenant_id=${b.tenantId} AND challenge_id=${bridge.challengeId}`)).rows;
    if (consumed.length !== 1 || consumed[0].nonce_digest !== acquired.nonceDigest) refused();
    const captures = (await tx.execute(sql`SELECT capture FROM migration_consent_captures WHERE tenant_id=${b.tenantId} AND challenge_id=${b.challengeId}`)).rows;
    if (captures.length !== 1 || sha256(canonicalJson(captures[0].capture)) !== live.consent.captureDigest) refused();
    await fresh(tx);
    await tx.execute(sql`INSERT INTO audit_events(tenant_id,event_id,job_id,actor_user_id,event_type,entity_type,entity_id,redacted_details)
      VALUES(${b.tenantId},${auditEventId},${b.migrationJobId},${b.actorUserId},'AUTHENTIC_START_ACQUISITION','MIGRATION_JOB',${b.migrationJobId},${acquisitionBytes}::jsonb)`);
    const audits = (await tx.execute(sql`SELECT job_id,actor_user_id,event_type,entity_type,entity_id,redacted_details FROM audit_events WHERE tenant_id=${b.tenantId} AND event_id=${auditEventId}`)).rows;
    if (audits.length !== 1) refused();
    equalStartBinding(audits[0], { job_id: b.migrationJobId, actor_user_id: b.actorUserId, event_type: 'AUTHENTIC_START_ACQUISITION', entity_type: 'MIGRATION_JOB', entity_id: b.migrationJobId, redacted_details: acquisition });
    await tx.execute(sql`INSERT INTO migration_start_executions(tenant_id,ceremony_id,consent_challenge_id,bridge_challenge_id,job_id,audit_event_id,binding)
      VALUES(${b.tenantId},${intent.ceremonyId},${b.challengeId},${bridge.challengeId},${b.migrationJobId},${auditEventId},${JSON.stringify(execution)}::jsonb)`);
    const executions = (await tx.execute(sql`SELECT binding FROM migration_start_executions WHERE tenant_id=${b.tenantId} AND ceremony_id=${intent.ceremonyId}`)).rows;
    if (executions.length !== 1) refused();
    equalStartBinding(executions[0].binding, execution);
    await intake.revalidateStart(tx, request, consent);
    await fresh(tx);
    const changed = (await tx.execute(sql`UPDATE migration_jobs SET status='FREEZING',state_version=state_version+1,
      freeze_started_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=${b.tenantId} AND job_id=${b.migrationJobId} AND status='READY' AND state_version=${b.expectedStateVersion}::bigint
      AND source_fingerprint=${b.jobSemanticFingerprint} AND state_version<9007199254740991
      AND freeze_started_at IS NULL AND freeze_verified_at IS NULL AND final_fingerprint IS NULL AND completed_at IS NULL RETURNING job_id`)).rows;
    if (changed.length !== 1 || changed[0].job_id !== b.migrationJobId) refused();
    const jobs = (await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint,freeze_started_at,freeze_verified_at,final_fingerprint,completed_at FROM migration_jobs WHERE tenant_id=${b.tenantId} AND job_id=${b.migrationJobId}`)).rows;
    if (jobs.length !== 1 || jobs[0].status !== 'FREEZING' || jobs[0].version !== execution.stateVersion
      || jobs[0].source_fingerprint !== b.jobSemanticFingerprint || !jobs[0].freeze_started_at
      || jobs[0].freeze_verified_at !== null || jobs[0].final_fingerprint !== null || jobs[0].completed_at !== null) refused();
    await intake.revalidateStart(tx, request, consent, 'FREEZING');
    await fresh(tx);
    return Object.freeze({ status: 'STARTED', ceremonyId: intent.ceremonyId, migrationJobId: b.migrationJobId,
      stateVersion: execution.stateVersion, exclusion: 'NOT_PROVEN', automaticRetry: false, automaticEnable: false });
  }); // Only acknowledged COMMIT returns a fact, not a reusable authority handle.
}
function detachRequest(request: Request) { return new Request(request.url, { method: request.method, headers: new Headers(request.headers) }); }
function refused(): never { throw Error('Start freezing refused; external writer state requires separate verification.'); }

/** Read-only fact after uncertainty. Current authenticated membership is required,
 * but expired ceremonies are readable. This path never touches a private registry,
 * sends a bridge request, exchanges OAuth, retries start or returns acquisitions. */
export async function readStartFreezingStatus(input: Readonly<{
  tenantId: string; migrationJobId: string; ceremonyId: string; intentDigest: string;
  request: Request; origin: string; env?: Readonly<Record<string,string | undefined>>;
  runTransaction: Continuation['runTransaction'];
}>) {
  const { tenantId, migrationJobId, ceremonyId, intentDigest, origin, runTransaction } = input;
  const request = detachRequest(input.request); const env = Object.freeze({ ...(input.env ?? process.env) });
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !/^[0-9a-f-]{36}$/.test(ceremonyId)
    || !migrationJobId || migrationJobId.length > 1024 || !/^[0-9a-f]{64}$/.test(intentDigest)) refused();
  const session = readFreezingConsentSession(request, origin, env);
  return runTransaction(tenantId, async tx => {
    const members = (await tx.execute(sql`SELECT u.id,u.canonical_email FROM users u JOIN tenant_memberships m ON m.user_id=u.id
      WHERE m.tenant_id=${tenantId} AND u.google_subject=${session.subject} AND m.role IN ('OWNER','ADMIN') FOR SHARE OF u,m`)).rows;
    if (members.length !== 1 || members[0].canonical_email !== session.email) refused();
    const rows = (await tx.execute(sql`SELECT e.binding,j.status AS job_status,a.redacted_details FROM migration_start_executions e
      JOIN migration_jobs j ON j.tenant_id=e.tenant_id AND j.job_id=e.job_id
      JOIN audit_events a ON a.tenant_id=e.tenant_id AND a.event_id=e.audit_event_id
      WHERE e.tenant_id=${tenantId} AND e.ceremony_id=${ceremonyId} AND e.job_id=${migrationJobId}`)).rows;
    const nowRows = (await tx.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS ms`)).rows;
    const now = Number(nowRows[0]?.ms);
    if (nowRows.length !== 1 || !Number.isSafeInteger(now)) refused();
    revalidateFreezingConsentSession(session, request, origin, now, env);
    if (!rows.length) return Object.freeze({ scope: 'ARCHIVAL_ONLY' as const, status: 'ABSENT' as const });
    if (rows.length !== 1) refused();
    const b = rows[0].binding as Record<string, unknown>;
    if (b.purpose !== 'CLASS_STORE_START_EXECUTION_V1' || b.status !== 'STARTED' || b.exclusion !== 'NOT_PROVEN'
      || b.tenantId !== tenantId || b.migrationJobId !== migrationJobId || b.ceremonyId !== ceremonyId || b.intentDigest !== intentDigest
      || b.actorUserId !== members[0].id || b.actorSubject !== session.subject || b.actorEmail !== session.email
      || b.acquisitionDigest !== sha256(canonicalJson(rows[0].redacted_details))) refused();
    return Object.freeze({ scope: 'ARCHIVAL_ONLY' as const, status: 'STARTED' as const, jobStatus: String(rows[0].job_status),
      ceremonyId, migrationJobId, executionDigest: sha256(canonicalJson(b)), exclusion: 'NOT_PROVEN' as const });
  });
}
