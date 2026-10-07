import 'server-only';
import { types } from 'node:util';
import { sql } from 'drizzle-orm';
import type { TenantTransaction } from '@/server/db/transaction';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { inspectLegacyImport, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { stageLocalStudentCheckedPreparation, inspectLocalStudentPreparationEnvelopes } from './localStudentCheckedPreparation';
import { canonicalJson, clonePlainData, sha256 } from './validators';
import { deepFreeze } from './sensitiveRedaction';

type Input = FinalGenerationPreparationInput;
type Binding = Omit<Input, 'original' | 'candidate'>;
type Stage = Awaited<ReturnType<typeof stageLocalStudentCheckedPreparation>>['preparation'];
type Inspection = ReturnType<typeof inspectLocalStudentPreparationEnvelopes>;
type Selection = Omit<Binding, 'tenantId'> & Pick<Stage, 'originalGenerationId' | 'candidateGenerationId' | 'planId'> & { attestationId: string };
const BINDING_KEYS = ['tenantId', 'migrationJobId', 'expectedStateVersion', 'originalSnapshotId', 'originalSourceId', 'exclusionGenerationReference'];
const SELECTION_KEYS = [...BINDING_KEYS.filter((key) => key !== 'tenantId'), 'originalGenerationId', 'candidateGenerationId', 'planId', 'attestationId'];
const ROW_KEYS = ['tenant_id', 'event_id', 'job_id', 'event_type', 'operation_id', 'actor_user_id', 'entity_type', 'entity_id', 'redacted_details'];
const EVENT = 'MIGRATION_LOCAL_STUDENT_ATTESTATION';
const SCOPE = 'LOCAL_CAPTURED_STUDENT_REVALIDATION_ONLY';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FLAGS = { authority: 'NONAUTHORITY', complete: false, activationAllowed: false, exclusion: 'NOT_PROVEN',
  sourceAuthenticity: 'NOT_PROVEN', fullReconciliation: 'NOT_PERFORMED' } as const;
type Evidence = { prepared: Stage; inspection: Inspection; receipt: ReturnType<typeof buildReceipt> };
type Result = ReturnType<typeof publish>;

/** Opt-in design A ONLY. Four immutable local audit records, not an approval.
 * The unchanged actual student wrapper gates append; every read executes actual
 * inspectors/normalizers again. A generic audit writer can reproduce the record:
 * hashes/append-only storage authenticate neither issuer nor source acquisition.
 * Existing direct callers remain unchanged; this does NOT embargo activation.
 * Explicit honest same-connection/await/rollback runner and driver required.
 * Postcommit ACK loss/substitution cannot undo already committed records.
 */
export async function stageLocalStudentAttestedPreparation(raw: Input,
  runTransaction: TenantImportTransactionRunner): Promise<Result> {
  try {
    runner(runTransaction);
    const root = object(raw, [...BINDING_KEYS, 'original', 'candidate']);
    const binding = parseBinding(Object.fromEntries(BINDING_KEYS.map((key) => [key, root[key]])));
    // Reject nested proxies/accessors BEFORE the unchanged stage's admission.
    // Separate acquisition snapshots preserve ordinary original===candidate use.
    admit(root.original); admit(root.candidate);
    const input = { ...binding, original: clonePlainData(root.original), candidate: clonePlainData(root.candidate) } as Input;
    let checked: Evidence | undefined;
    const result = await stageLocalStudentCheckedPreparation(input, (tenantId, callback) => runTransaction(tenantId, async (tx) => {
      checked = undefined; // Never reuse a rolled-back attempt's evidence.
      await lockCurrent(tx, binding);
      const rawPrepared = await callback(tx); // Real stage, full and BOTH actual student gates.
      const prepared = rawPrepared as unknown as Stage;
      const records = await readEnvelopes(tx, binding, prepared);
      const inspection = inspectLocalStudentPreparationEnvelopes(binding, prepared, records);
      const receipt = buildReceipt(binding, prepared, inspection, records);
      await tx.execute(sql`INSERT INTO audit_events
        (tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details)
        VALUES(${tenantId},${receipt.id},${binding.migrationJobId},${EVENT},NULL,NULL,NULL,NULL,${receipt.bytes}::jsonb)
        ON CONFLICT(tenant_id,event_id) DO NOTHING`);
      exactReceipt(await readReceipt(tx, binding, receipt.id), binding, receipt);
      checked = { prepared, inspection, receipt };
      return rawPrepared; // Original identity required by the unchanged wrappers.
    }));
    if (!checked || canonicalJson(result.preparation) !== canonicalJson(checked.prepared)
      || canonicalJson(result.reports) !== canonicalJson(checked.inspection.reports)
      || canonicalJson(result.deltaCoverage) !== canonicalJson(checked.inspection.deltaCoverage)
      || canonicalJson(result.studentProjection) !== canonicalJson(checked.inspection.studentProjection)) refused();
    return publish(binding, checked);
  } catch { refused(); }
}

/** Internal canonical tenant context, NOT public authentication. Business-data
 * read-only, but uses FOR UPDATE: do not run as a PostgreSQL READ ONLY tx.
 * Missing receipt is refused, never created/backfilled. Stored results are not
 * trusted; current READY/original targets and BOTH retained captures are checked.
 */
export async function readCurrentLocalStudentAttestation(context: { tenantId: string; runTransaction: TenantImportTransactionRunner },
  rawSelection: Selection): Promise<Result> {
  try {
    const ctx = object(context, ['tenantId', 'runTransaction']); runner(ctx.runTransaction);
    const selected = object(rawSelection, SELECTION_KEYS);
    const binding = parseBinding({ tenantId: ctx.tenantId, ...Object.fromEntries(BINDING_KEYS.slice(1).map((key) => [key, selected[key]])) });
    for (const [key, prefix] of [['originalGenerationId', 'preparation:original:'], ['candidateGenerationId', 'preparation:candidate:'],
      ['planId', 'preparation:plan:'], ['attestationId', 'local-student-attestation:']]) tagged(selected[key], prefix);
    // No caller-owned object survives the first await.
    const selection = { ...selected } as Selection;
    const runTransaction = ctx.runTransaction as TenantImportTransactionRunner;
    let observed: Result | undefined;
    const result = await runTransaction(binding.tenantId, async (tx) => {
      observed = undefined;
      await lockCurrent(tx, binding);
      const storedReceipt = await readReceipt(tx, binding, selection.attestationId);
      const records = await readEnvelopes(tx, binding, selection);
      // Bounded descriptor admission precedes PLAN property reads; actual shape,
      // hashes, pointers and closed plan checks still belong to the real inspector.
      admit(records);
      const planRow = records.find((row) => row.event_id === selection.planId);
      if (!planRow) refused();
      const plan = object(planRow.redacted_details);
      const prepared = { storage: 'UNTRUSTED_PREPARATION', originalGenerationId: selection.originalGenerationId,
        candidateGenerationId: selection.candidateGenerationId, planId: selection.planId,
        plan: { status: plan.status, changes: plan.changes, blockers: plan.blockers } } as Stage;
      const inspection = inspectLocalStudentPreparationEnvelopes(binding, prepared, records);
      // Both acquisition/manifest pairs were admitted by the actual inspectors.
      const originals: LegacyNormalizationManifest[] = [];
      for (const id of [prepared.originalGenerationId, prepared.candidateGenerationId]) {
        const { acquisition, manifest } = records.find((row) => row.event_id === id)!.redacted_details as {
          acquisition: Input['original']; manifest: LegacyNormalizationManifest;
        };
        const rebuilt = createLegacyNormalizationManifest({ tenantId: binding.tenantId, migrationJobId: binding.migrationJobId,
          sheets: acquisition.sheets, redis: acquisition.redis });
        if (canonicalJson(rebuilt) !== canonicalJson(manifest)) refused();
        originals.push(rebuilt);
      }
      const original = originals[0];
      if ((await inspectLegacyImport(tx, { tenantId: binding.tenantId, migrationJobId: binding.migrationJobId, manifest: original }, original)).length) refused();
      const receipt = buildReceipt(binding, prepared, inspection, records);
      if (receipt.id !== selection.attestationId) refused();
      exactReceipt(storedReceipt, binding, receipt);
      observed = publish(binding, { prepared, inspection, receipt });
      return observed;
    });
    if (!observed || result !== observed) refused();
    return observed;
  } catch { refused(); }
}

async function lockCurrent(tx: TenantTransaction, b: Binding) {
  const { rows: session } = await tx.execute(sql`SELECT current_setting('app.tenant_id',true) AS tenant_id`);
  if (session.length !== 1 || session[0].tenant_id !== b.tenantId) refused();
  const { rows: tenants } = await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${b.tenantId} FOR UPDATE`);
  if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING') refused();
  const { rows: jobs } = await tx.execute(sql`SELECT status,state_version::text AS version FROM migration_jobs
    WHERE tenant_id=${b.tenantId} AND job_id=${b.migrationJobId} FOR UPDATE`);
  if (jobs.length !== 1 || jobs[0].status !== 'READY' || jobs[0].version !== b.expectedStateVersion) refused();
}
async function readEnvelopes(tx: TenantTransaction, b: Binding, ids: Pick<Stage, 'originalGenerationId' | 'candidateGenerationId' | 'planId'>) {
  const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details
    FROM audit_events WHERE tenant_id=${b.tenantId} AND job_id=${b.migrationJobId}
    AND event_id IN (${ids.originalGenerationId},${ids.candidateGenerationId},${ids.planId})`);
  if (rows.length !== 3) refused();
  return rows;
}
async function readReceipt(tx: TenantTransaction, b: Binding, id: string) {
  const { rows } = await tx.execute(sql`SELECT tenant_id,event_id,job_id,event_type,operation_id,actor_user_id,entity_type,entity_id,redacted_details
    FROM audit_events WHERE tenant_id=${b.tenantId} AND job_id=${b.migrationJobId} AND event_id=${id}`);
  if (rows.length !== 1) refused();
  const row = object(rows[0], ROW_KEYS);
  smallBytes(row.redacted_details); // Before later reads/revalidation; no lazy getters.
  return row;
}
function buildReceipt(binding: Binding, prepared: Stage, inspection: Inspection, records: Record<string, unknown>[]) {
  // Private: invoked only AFTER actual pointer/full/student inspection.
  const capture = (id: string) => (records.find((row) => row.event_id === id)!.redacted_details as { acquisition: Input['original'] }).acquisition;
  const original = capture(prepared.originalGenerationId), candidate = capture(prepared.candidateGenerationId);
  const details = { attestationVersion: 1, verifierContract: 'CAPTURED_STUDENTS_V1', scope: SCOPE, ...FLAGS,
    binding: { ...binding, expectedStatus: 'READY' }, originalGenerationId: prepared.originalGenerationId,
    candidateGenerationId: prepared.candidateGenerationId, planId: prepared.planId,
    originalManifestDigest: inspection.reports.original.manifestDigest, candidateManifestDigest: inspection.reports.candidate.manifestDigest,
    originalSheetsDigest: original.sheets.digest, candidateSheetsDigest: candidate.sheets.digest,
    originalRedisDigest: original.redis.digest, candidateRedisDigest: candidate.redis.digest,
    studentProjection: inspection.studentProjection, fullDeltaDigest: sha256(canonicalJson(inspection.deltaCoverage)) };
  const bytes = smallBytes(details);
  return { id: `local-student-attestation:${sha256(bytes)}`, details, bytes };
}
function exactReceipt(row: Record<string, unknown>, binding: Binding, expected: ReturnType<typeof buildReceipt>) {
  if (row.tenant_id !== binding.tenantId || row.job_id !== binding.migrationJobId || row.event_id !== expected.id
    || row.event_type !== EVENT || row.operation_id !== null || row.actor_user_id !== null
    || row.entity_type !== null || row.entity_id !== null || smallBytes(row.redacted_details) !== expected.bytes) refused();
  // Equality to freshly built closed payload rejects every added/missing key,
  // unsupported version, altered count/flags and same-ID conflicting payload.
}
function publish(binding: Binding, { prepared, inspection, receipt }: Evidence) {
  const selectionBinding = { migrationJobId: binding.migrationJobId, expectedStateVersion: binding.expectedStateVersion,
    originalSourceId: binding.originalSourceId, originalSnapshotId: binding.originalSnapshotId,
    exclusionGenerationReference: binding.exclusionGenerationReference };
  return deepFreeze({ scope: SCOPE, status: 'CURRENT_LOCAL_STUDENT_REVALIDATED' as const, ...FLAGS,
    issuerAuthenticity: 'NOT_PROVEN' as const, attestationId: receipt.id,
    selection: { ...selectionBinding, originalGenerationId: prepared.originalGenerationId,
      candidateGenerationId: prepared.candidateGenerationId, planId: prepared.planId, attestationId: receipt.id },
    preparation: prepared, reports: inspection.reports, deltaCoverage: inspection.deltaCoverage,
    studentProjection: inspection.studentProjection });
}
function parseBinding(raw: unknown): Binding {
  const value = object(raw, BINDING_KEYS);
  for (const key of BINDING_KEYS) if (typeof value[key] !== 'string' || (value[key] as string).length > 512) refused();
  if (!UUID.test(value.tenantId as string) || !UUID.test(value.migrationJobId as string)
    || !/^[1-9][0-9]{0,15}$/.test(value.expectedStateVersion as string)
    || BigInt(value.expectedStateVersion as string) > BigInt(Number.MAX_SAFE_INTEGER)) refused();
  tagged(value.originalSourceId, 'sheet:'); tagged(value.originalSnapshotId, 'import:'); tagged(value.exclusionGenerationReference, '');
  return { ...value } as Binding;
}
function tagged(raw: unknown, prefix: string): asserts raw is string {
  if (typeof raw !== 'string' || raw.length !== prefix.length + 64 || !raw.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(raw.slice(prefix.length))) refused();
}
function runner(raw: unknown) {
  if (typeof raw !== 'function' || types.isProxy(raw)) refused();
}
function object(raw: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || types.isProxy(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) refused();
  const own = Reflect.ownKeys(raw);
  if (own.length > 256 || (keys && (own.length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key))))) refused();
  for (const key of own) {
    if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) refused();
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) refused();
  }
  return raw as Record<string, unknown>;
}
/** Local in-process pre-admission only, not a streaming DB allocation/time bound.
 * Existing narrower semantic inspectors still apply after this. Native ownKeys
 * allocation and the driver have already allocated inputs; no BudgetContext claim.
 */
function admit(raw: unknown, maxText = 4_000_000, maxNodes = 300_000) {
  let nodes = 0, text = 0;
  const ancestors = new WeakSet<object>();
  const charge = (s: string) => { text += Buffer.byteLength(s, 'utf8'); if (text > maxText) refused(); };
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > maxNodes || depth > 32) refused();
    if (typeof value === 'string') { charge(value); return; }
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value)) refused();
    ancestors.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) refused();
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > 8192 || nodes + length > maxNodes
        || Reflect.ownKeys(value).length !== length + 1) refused();
      for (let i = 0; i < length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !d.enumerable || !('value' in d)) refused();
        visit(d.value, depth + 1);
      }
    } else {
      const record = object(value);
      for (const key of Object.keys(record)) { charge(key); visit(record[key], depth + 1); }
    }
    ancestors.delete(value);
  };
  visit(raw, 0);
}
function smallBytes(raw: unknown) {
  admit(raw, 16_384, 4096);
  const bytes = canonicalJson(raw);
  if (Buffer.byteLength(bytes, 'utf8') > 16_384) refused();
  return bytes;
}
function refused(): never { throw new Error('Local student attestation refused.'); }
