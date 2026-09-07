import 'server-only';
import { unsupportedOperationalRecords } from './operationalProjection';

import { sql } from 'drizzle-orm';
import { parseCheckoutLineSnapshot } from '@/lib/checkoutSnapshotClient';
import type { TenantTransaction } from '@/server/db/transaction';
import { withTenantTransaction } from '@/server/db/transaction';
import type { LegacyNormalizationManifest } from './manifest';
import type { ReconciliationDiagnostic } from './report';
import { canonicalTransactionItem, adjustmentKey, adjustmentTransactionKey, sameAssignmentCompletionTuple, cancellationOriginalId } from './semanticValidators';
import { canonicalJson, isHexDigest, isPlainRecord, sha256 } from './validators';

const MAX_BATCH_SIZE = 500;
const DEFAULT_BATCH_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DEFERRED_TABLES = new Set(['padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'legacy_operation_bindings']);
const OPERATIONAL_SETTINGS = new Set([
  'schemaVersion', 'systemVersion', 'systemName', 'appTitle', 'bankTitle', 'currencyUnit',
  'classTimeZone', 'themeColor', 'qrManualInputEnabled',
]);

export type TenantImportTransactionRunner = <TResult>(
  tenantId: string,
  callback: (transaction: TenantTransaction) => Promise<TResult>,
) => Promise<TResult>;

export type MigrationImportResult = Readonly<{
  tenantId: string;
  migrationJobId: string;
  status: 'IMPORTING';
  totalSourceRecords: number;
  importedSourceRecords: number;
  deferredSourceRecords: number;
  skippedSourceRecords: number;
  targetRecords: number;
  importedTargetRecords: number;
  deferredTargetRecords: number;
}>;

export type LegacyMigrationImportInput = Readonly<{
  tenantId: string;
  migrationJobId: string;
  manifest: LegacyNormalizationManifest;
  batchSize?: number;
  runTransaction?: TenantImportTransactionRunner;
}>;

type WorkRecord = Readonly<{ table: string; id: string; value: Record<string, unknown> }>;
type SourceRecord = Readonly<{
  recordId: string;
  sourceId: string;
  sourceCollection: string;
  sourceRecordId: string;
  sourceRowNumber: number | null;
  sourceRowHash: string;
  redactedRecord: Record<string, unknown>;
  canonicalRecord: Record<string, unknown> | null;
  targetTable: string | null;
  targetId: string | null;
  warningDetails: readonly string[];
  errorDetails: readonly string[];
  deferred: boolean;
}>;

type Descriptor = Readonly<{
  physicalTable: string;
  idColumns: readonly string[];
  project: (value: Record<string, unknown>, tenantId: string) => Record<string, unknown>;
}>;

const direct = (physicalTable: string, idColumns: readonly string[], fields: Readonly<Record<string, string>>): Descriptor => ({
  physicalTable,
  idColumns,
  project: (value, tenantId) => Object.fromEntries([
    ...(Object.values(fields).includes('tenant_id') ? [['tenant_id', tenantId] as const] : []),
    ...Object.entries(fields)
      .filter(([property]) => property !== 'tenantId' && value[property] !== undefined)
      .map(([property, column]) => [column, value[property]] as const),
  ]),
});

const DESCRIPTORS: Readonly<Record<string, Descriptor>> = {
  students: direct('students', ['tenant_id', 'student_id'], { tenantId: 'tenant_id', studentId: 'student_id', name: 'name', status: 'status' }),
  accounts: direct('accounts', ['tenant_id', 'student_id'], { tenantId: 'tenant_id', studentId: 'student_id', balance: 'balance' }),
  products: direct('products', ['tenant_id', 'product_id'], { tenantId: 'tenant_id', productId: 'product_id', name: 'name', price: 'price', stock: 'stock', isActive: 'is_active', imageUrl: 'image_url', category: 'category', sortOrder: 'sort_order' }),
  promotions: {
    physicalTable: 'promotions', idColumns: ['tenant_id', 'promotion_id'],
    project: (value, tenantId) => ({
      tenant_id: tenantId, promotion_id: value.promotionId, name: value.name, description: value.description,
      type: value.type, n_plus_one_buy_quantity: value.buyQuantity ?? null,
      n_plus_one_free_quantity: value.freeQuantity ?? null,
      promotional_price: value.promotionalUnitPrice ?? null,
      percent_discount: value.percent ?? null, fixed_discount: value.discountAmount ?? null,
      starts_at: value.startsAt, ends_at: value.endsAt, is_active: value.isActive,
      sort_order: value.sortOrder, schema_version: value.schemaVersion,
      created_at: value.createdAt, updated_at: value.updatedAt,
    }),
  },
  promotion_products: direct('promotion_products', ['tenant_id', 'promotion_product_id'], { tenantId: 'tenant_id', promotionProductId: 'promotion_product_id', promotionId: 'promotion_id', productId: 'product_id', createdAt: 'created_at', schemaVersion: 'schema_version' }),
  tasks: direct('tasks', ['tenant_id', 'task_instance_id'], { tenantId: 'tenant_id', taskInstanceId: 'task_instance_id', taskId: 'task_id', title: 'title', description: 'description', reward: 'reward', isActive: 'is_active', sortOrder: 'sort_order', availableFrom: 'available_from', dueAt: 'due_at', prerequisiteTaskInstanceId: 'prerequisite_task_instance_id', currentSchedule: 'current_schedule', pendingSchedule: 'pending_schedule', schemaVersion: 'schedule_schema_version', createdAt: 'created_at', updatedAt: 'updated_at' }),
  task_allowed_students: direct('task_allowed_students', ['tenant_id', 'task_instance_id', 'student_id'], { tenantId: 'tenant_id', taskInstanceId: 'task_instance_id', studentId: 'student_id' }),
  task_assignments: direct('task_assignments', ['tenant_id', 'assignment_id'], { tenantId: 'tenant_id', assignmentId: 'assignment_id', taskId: 'task_id_snapshot', taskInstanceId: 'task_instance_id', cycleId: 'cycle_id', cycleStartsAt: 'cycle_start_at', cycleEndsAt: 'cycle_end_at', ruleVersion: 'rule_version', timeZone: 'timezone', studentId: 'student_id', status: 'event_type', source: 'source', previousAssignmentId: 'previous_assignment_id', createdAt: 'created_at', schemaVersion: 'schema_version', note: 'note' }),
  transactions: direct('transactions', ['tenant_id', 'transaction_id'], { tenantId: 'tenant_id', transactionId: 'transaction_id', occurredAt: 'occurred_at', studentId: 'student_id', studentNameSnapshot: 'student_name_snapshot', kind: 'kind', legacyTotalAmount: 'legacy_total_amount', balanceDelta: 'balance_delta', balanceBefore: 'balance_before', balanceAfter: 'balance_after', operatorSnapshot: 'operator_snapshot', legacyStatusSnapshot: 'legacy_status_snapshot', reversesTransactionId: 'reverses_transaction_id' }),
  transaction_items: direct('transaction_items', ['tenant_id', 'item_id'], { tenantId: 'tenant_id', itemId: 'item_id', transactionId: 'transaction_id', lineNumber: 'line_number', productIdSnapshot: 'product_id_snapshot', currentProductId: 'current_product_id', productNameSnapshot: 'product_name_snapshot', quantity: 'quantity', unitPriceSnapshot: 'unit_price_snapshot', subtotalSnapshot: 'subtotal_snapshot', regularUnitPrice: 'regular_unit_price', regularTotal: 'regular_total', totalQuantity: 'total_quantity', paidQuantity: 'paid_quantity', freeQuantity: 'free_quantity', finalTotal: 'final_total', totalDiscount: 'total_discount', adjustmentsSnapshot: 'adjustments_snapshot', appliedPromotionsSnapshot: 'applied_promotions_snapshot' }),
  adjustments: direct('adjustments', ['tenant_id', 'adjustment_id'], { tenantId: 'tenant_id', adjustmentId: 'adjustment_id', transactionId: 'transaction_id', mode: 'mode', requestedAmount: 'requested_amount', operatorSnapshot: 'operator_snapshot', legacyAdjustmentId: 'legacy_adjustment_id' }),
  task_completions: {
    ...direct('task_completions', ['tenant_id', 'completion_id'], { tenantId: 'tenant_id', completionId: 'completion_id', timestamp: 'completed_at', taskInstanceId: 'task_instance_id', taskId: 'task_id_snapshot', taskNameSnapshot: 'task_name_snapshot', studentId: 'student_id', studentName: 'student_name_snapshot', reward: 'reward_snapshot', balanceBefore: 'balance_before', balanceAfter: 'balance_after', status: 'status', note: 'note', cycleId: 'cycle_id', cycleStartsAt: 'cycle_start_at', cycleEndsAt: 'cycle_end_at', ruleVersion: 'rule_version', timeZone: 'timezone', source: 'source', assignmentId: 'assignment_id', operationId: 'operation_id', schemaVersion: 'schema_version', evidenceProvider: 'evidence_provider', evidenceBoardId: 'evidence_board_id', evidencePostId: 'evidence_post_id', evidenceCreatedAt: 'evidence_created_at', evidenceAuthorFullName: 'evidence_author_full_name' }),
    project: (value, tenantId) => ({
      ...direct('task_completions', [], { tenantId: 'tenant_id', completionId: 'completion_id', timestamp: 'completed_at', taskInstanceId: 'task_instance_id', taskId: 'task_id_snapshot', taskNameSnapshot: 'task_name_snapshot', studentId: 'student_id', studentName: 'student_name_snapshot', reward: 'reward_snapshot', balanceBefore: 'balance_before', balanceAfter: 'balance_after', status: 'status', note: 'note', cycleId: 'cycle_id', cycleStartsAt: 'cycle_start_at', cycleEndsAt: 'cycle_end_at', ruleVersion: 'rule_version', timeZone: 'timezone', source: 'source', assignmentId: 'assignment_id', operationId: 'operation_id', schemaVersion: 'schema_version', evidenceProvider: 'evidence_provider', evidenceBoardId: 'evidence_board_id', evidencePostId: 'evidence_post_id', evidenceCreatedAt: 'evidence_created_at', evidenceAuthorFullName: 'evidence_author_full_name' }).project(value, tenantId),
      operation_hash: value.operationPayloadHash === null ? null : rawOperationDigest(value.operationPayloadHash),
    }),
  },
  legacy_operation_bindings: {
    physicalTable: 'operations', idColumns: ['tenant_id', 'operation_id'],
    project: () => { throw new Error('Legacy operation bindings are staging-only evidence.'); },
  },
  padlet_evidence_claims: {
    physicalTable: 'padlet_evidence_claims', idColumns: ['provider', 'board_id', 'post_id'],
    project: (value, tenantId) => ({ provider: 'PADLET', board_id: value.boardId, post_id: value.postId, tuple_digest: value.tupleDigest, claimed_by_tenant_id: tenantId, claimed_by_operation_id: value.operationId, evidence_created_at: value.evidenceCreatedAt, evidence_author_full_name: value.evidenceAuthorFullName }),
  },
  padlet_claim_digest_tombstones: {
    physicalTable: 'padlet_claim_digest_tombstones', idColumns: ['tuple_digest'],
    project: (value) => ({ tuple_digest: value.tupleDigest, owner_digest: value.ownerDigest ?? null, source_provenance: value.provenance }),
  },
};

const TABLE_ORDER = [
  'settings', 'students', 'accounts', 'products', 'promotions', 'promotion_products',
  'tasks', 'task_allowed_students', 'legacy_operation_bindings', 'task_assignments',
  'transactions', 'transaction_items', 'adjustments', 'task_completions',
] as const;

export async function importLegacyNormalizationManifest(input: LegacyMigrationImportInput): Promise<MigrationImportResult> {
  assertInput(input);
  const runTransaction = input.runTransaction ?? withTenantTransaction;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const sourceRecords = projectSourceRecords(input.manifest, input.tenantId, input.migrationJobId);
  const work = projectTargets(input.manifest, input.tenantId);

  await runTransaction(input.tenantId, async (transaction) => {
    await bindImport(transaction, input);
    await assertHistoricalOrder(transaction, input.tenantId, work);
  });
  for (const batch of batches(sourceRecords, batchSize)) {
    await runTransaction(input.tenantId, async (transaction) => {
      await assertBoundImport(transaction, input);
      for (const record of batch) await stageSourceRecord(transaction, input, record);
    });
  }
  for (const batch of batches(work, batchSize)) {
    await runTransaction(input.tenantId, async (transaction) => {
      await assertBoundImport(transaction, input);
      await assertHistoricalOrder(transaction, input.tenantId, work);
      for (const record of batch) await insertIdenticalOrFail(transaction, record);
      await assertHistoricalOrder(transaction, input.tenantId, work);
    });
  }
  for (const batch of batches(sourceRecords, batchSize)) {
    await runTransaction(input.tenantId, async (transaction) => {
      await assertBoundImport(transaction, input);
      for (const record of batch) await finishSourceRecord(transaction, input, record);
    });
  }

  return {
    tenantId: input.tenantId,
    migrationJobId: input.migrationJobId,
    status: 'IMPORTING',
    totalSourceRecords: sourceRecords.length,
    importedSourceRecords: sourceRecords.filter((record) => record.targetTable !== null && !record.deferred).length,
    deferredSourceRecords: sourceRecords.filter((record) => record.deferred).length,
    skippedSourceRecords: sourceRecords.filter((record) => record.targetTable === null && !record.deferred).length,
    targetRecords: work.length,
    importedTargetRecords: work.length,
    deferredTargetRecords: [...DEFERRED_TABLES].reduce((count, table) => count + (input.manifest.records[table]?.length ?? 0), 0),
  };
}

/** Read-only verification; not an import bypass or READY capability. All callers
 * get the same full semantic validation before any database evidence is trusted. */
export async function inspectLegacyImport(
  transaction: TenantTransaction, input: LegacyMigrationImportInput,
  currentManifest: LegacyNormalizationManifest,
): Promise<ReconciliationDiagnostic[]> {
  const issues: ReconciliationDiagnostic[] = [];
  try {
    assertInput(input);
  } catch {
    return [{ category: 'INTEGRITY', code: 'INVALID_MANIFEST' }];
  }
  try {
    assertInput({ ...input, manifest: currentManifest });
    // Both complete manifests have passed shape/digest/semantic validation.
    // Fingerprints/artifact summaries alone cannot authenticate normalized bytes.
    if (!equalJson(currentManifest, input.manifest)) {
      issues.push({ category: 'SOURCES', code: 'SOURCE_MUTATION' });
    }
  } catch {
    issues.push({ category: 'SOURCES', code: 'INVALID_CURRENT_MANIFEST' });
  }
  // Match the importer's lock order, including competing nonterminal jobs.
  const { rows: tenants } = await transaction.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
  try {
    if (tenants.length !== 1 || tenants[0].lifecycle !== 'IMPORTING') throw new Error('binding');
    await assertBoundImport(transaction, input, true);
  } catch {
    return [...issues, { category: 'INTEGRITY', code: 'BINDING_MISMATCH' }];
  }
  const { rows: snapshots } = await transaction.execute(sql`SELECT artifact_digest,redacted_manifest,source_id,snapshot_id,row_count::text AS row_count FROM migration_snapshots WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND phase='PREFLIGHT' AND redacted_manifest->>'bindingKind'='LEGACY_NORMALIZATION_IMPORT' FOR UPDATE`);
  if (snapshots.length !== 1 || snapshots[0].artifact_digest !== input.manifest.manifestDigest
    || snapshots[0].source_id !== sourceIdFor('SHEET', input.manifest.sourceArtifacts.sheets.digest)
    || snapshots[0].snapshot_id !== `import:${input.manifest.manifestDigest}`
    || snapshots[0].row_count !== String(input.manifest.sourceRecords.length)
    || !equalJson(snapshots[0].redacted_manifest, { bindingKind: 'LEGACY_NORMALIZATION_IMPORT', sourceFingerprint: input.manifest.sourceFingerprint, manifestDigest: input.manifest.manifestDigest })) {
    return [...issues, { category: 'INTEGRITY', code: 'BINDING_MISMATCH' }];
  }
  const artifacts = [
    { kind: 'SHEET' as const, provider: 'GOOGLE_SHEETS', digest: input.manifest.sourceArtifacts.sheets.digest, external: input.manifest.sourceArtifacts.sheets.spreadsheetIdDigest, schemaVersion: input.manifest.metadata.sheetSchemaVersion },
    ...(input.manifest.sourceArtifacts.redis ? [{ kind: 'REDIS' as const, provider: 'LEGACY_REDIS_BRIDGE', digest: input.manifest.sourceArtifacts.redis.digest, external: input.manifest.sourceArtifacts.redis.digest, schemaVersion: null }] : []),
  ];
  const { rows: sources } = await transaction.execute(sql`SELECT * FROM migration_sources WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} LIMIT ${artifacts.length + 1} FOR UPDATE`);
  if (sources.length !== artifacts.length || artifacts.some((artifact) => !sources.some((row) =>
    row.source_id === sourceIdFor(artifact.kind, artifact.digest) && row.provider === artifact.provider
    && row.external_source_id === artifact.external && row.source_fingerprint === artifact.digest
    && Number(row.schema_version ?? 0) === Number(artifact.schemaVersion ?? 0)))) {
    return [...issues, { category: 'SOURCES', code: 'BINDING_MISMATCH' }];
  }
  const checkpoints = projectSourceRecords(input.manifest, input.tenantId, input.migrationJobId);
  const { rows: persisted } = await transaction.execute(sql`SELECT * FROM migration_source_records WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} LIMIT ${checkpoints.length + 1} FOR UPDATE`);
  if (persisted.length !== checkpoints.length) issues.push({ category: 'CHECKPOINTS', code: 'CARDINALITY_MISMATCH' });
  // Cardinality first. A Map alone would hide repeated/missing provenance.
  const byId = new Map(persisted.map((row) => [row.record_id, row]));
  if (byId.size !== persisted.length) issues.push({ category: 'CHECKPOINTS', code: 'CARDINALITY_MISMATCH' });
  for (const record of checkpoints) {
    const row = byId.get(record.recordId);
    const status = record.deferred ? 'STAGED' : record.targetTable ? 'IMPORTED' : 'SKIPPED';
    const expected = {
      source_id: record.sourceId, source_collection: record.sourceCollection,
      source_record_id: record.sourceRecordId, source_row_number: record.sourceRowNumber,
      source_row_hash: record.sourceRowHash, redacted_record: record.redactedRecord,
      canonical_record: record.canonicalRecord, warning_details: record.warningDetails,
      error_details: record.errorDetails, mapping_status: status,
      target_table: record.deferred ? null : record.targetTable,
      target_id: record.deferred ? null : record.targetId,
    };
    if (!row || !Object.entries(expected).every(([key, value]) => equalDatabaseValue(row[key], value))) {
      issues.push({ category: 'CHECKPOINTS', code: 'CHECKPOINT_INCOMPLETE', rowReference: record.recordId });
    }
  }
  const work = projectTargets(input.manifest, input.tenantId);
  for (const table of ['tenant_settings', ...TABLE_ORDER.filter((table) => table !== 'settings' && !DEFERRED_TABLES.has(table))]) {
    const expected = work.filter((record) => record.table === table);
    const descriptor = table === 'tenant_settings' ? { idColumns: ['tenant_id'] } : DESCRIPTORS[table];
    const { rows } = await transaction.execute(sql`SELECT * FROM ${sql.identifier(table)} WHERE tenant_id=${input.tenantId} LIMIT ${expected.length + 1} FOR UPDATE`);
    if (rows.length !== expected.length) issues.push({ category: 'INTEGRITY', code: 'CARDINALITY_MISMATCH', rowReference: table });
    const key = (row: Record<string, unknown>) => canonicalJson(descriptor.idColumns.map((column) => row[column]));
    const actual = new Map(rows.map((row) => [key(row), row]));
    if (actual.size !== rows.length) issues.push({ category: 'INTEGRITY', code: 'CARDINALITY_MISMATCH', rowReference: table });
    for (const record of expected) {
      const row = actual.get(key(record.value));
      if (!row || !Object.entries(record.value).every(([column, value]) => equalDatabaseValue(row[column], value))) {
        issues.push({ category: 'INTEGRITY', code: 'ROW_MISMATCH', rowReference: `${table}\0${record.id}` });
      }
    }
  }
  try { await assertHistoricalOrder(transaction, input.tenantId, work); }
  catch { issues.push({ category: 'RECURRENCE', code: 'HISTORY_ORDER' }); }
  return issues;
}

function assertInput(input: LegacyMigrationImportInput): void {
  assertImportManifestShape(input.manifest);
  const { manifest } = input;
  if (!UUID_PATTERN.test(input.tenantId) || typeof input.migrationJobId !== 'string' || input.migrationJobId.trim() !== input.migrationJobId || !input.migrationJobId) throw new Error('Trusted migration binding is invalid.');
  if (manifest.status !== 'READY_FOR_IMPORT' || manifest.blockingConflicts.length || manifest.quarantines.length) throw new Error('Only an unblocked READY_FOR_IMPORT manifest can be imported.');
  if (manifest.tenantId !== input.tenantId || manifest.migrationJobId !== input.migrationJobId) throw new Error('Manifest does not match the trusted migration binding.');
  if (!DIGEST_PATTERN.test(manifest.sourceFingerprint) || !DIGEST_PATTERN.test(manifest.manifestDigest)) throw new Error('Manifest digest is invalid.');
  const unsigned: Record<string, unknown> = { ...manifest };
  delete unsigned.manifestDigest;
  if (sha256(canonicalJson(unsigned)) !== manifest.manifestDigest) throw new Error('Manifest integrity check failed.');
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) throw new Error(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.`);
  const unknown = Object.keys(manifest.records).filter((table) => table !== 'settings' && !(table in DESCRIPTORS));
  if (unknown.length) throw new Error('Manifest contains an unsupported target table.');
  const knownTarget = (table: string) => table === 'settings' || table in DESCRIPTORS;
  if (manifest.sourceRecords.some((record) => record.targetTable && !knownTarget(record.targetTable))
    || manifest.mappings.some((mapping) => !knownTarget(mapping.targetTable))) {
    throw new Error('Manifest contains an unsupported target table.');
  }
  for (const rows of Object.values(manifest.records)) for (const row of rows) {
    if ('tenantId' in row && row.tenantId !== input.tenantId) throw new Error('Manifest target tenant does not match trusted tenant.');
  }
  assertExplicitOperationBindings(manifest);
  assertOperationalSettings(manifest);
  assertCanonicalSources(manifest);
  assertFinancialHistory(manifest);
  if ((manifest.records.task_completions ?? []).some((row) => row.source === 'BANK')
    || manifest.sourceRecords.some((record) => record.canonicalRecord?.source === 'BANK')) {
    throw new Error('Unsupported legacy BANK authority cannot be imported.');
  }
  if (unsupportedOperationalRecords(
    historicalOrder('task_assignments', manifest.records.task_assignments ?? [], manifest),
    historicalOrder('task_completions', manifest.records.task_completions ?? [], manifest),
  ).size) throw new Error('Unsupported legacy operational history cannot be imported.');
  // Materialize and validate every database projection before the first transaction.
  projectTargets(manifest, input.tenantId);
  if ((manifest.records.task_assignments ?? []).some((row) => row.source === 'ADMIN' || row.source === 'QR')
    || (manifest.records.task_completions ?? []).some((row) => row.source === 'ADMIN' || row.source === 'ADMIN_RESET')
    || manifest.sourceRecords.some((record) => record.canonicalRecord?.source === 'ADMIN'
      || record.canonicalRecord?.source === 'QR' || record.canonicalRecord?.source === 'ADMIN_RESET')) {
    throw new Error('Legacy task administrator provenance is not sufficient for production triggers.');
  }
}

const TARGET_RECORD_SHAPES: Readonly<Record<string, Readonly<{ required: readonly string[]; optional?: readonly string[] }>>> = {
  settings: { required: ['tenantId', 'key', 'value'] },
  students: { required: ['tenantId', 'studentId', 'name', 'status'] },
  accounts: { required: ['tenantId', 'studentId', 'balance'] },
  products: { required: ['tenantId', 'productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'] },
  promotions: { required: ['tenantId', 'promotionId', 'name', 'description', 'type', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'schemaVersion', 'createdAt', 'updatedAt'], optional: ['buyQuantity', 'freeQuantity', 'promotionalUnitPrice', 'percent', 'discountAmount'] },
  promotion_products: { required: ['tenantId', 'promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'] },
  tasks: { required: ['tenantId', 'taskId', 'taskInstanceId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds', 'currentSchedule', 'pendingSchedule', 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'schemaVersion'], optional: ['prerequisiteTaskInstanceId'] },
  task_allowed_students: { required: ['tenantId', 'taskInstanceId', 'studentId'] },
  task_assignments: { required: ['tenantId', 'assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'] },
  transactions: { required: ['tenantId', 'transactionId', 'occurredAt', 'studentId', 'studentNameSnapshot', 'kind', 'legacyTotalAmount', 'balanceDelta', 'balanceBefore', 'balanceAfter', 'operatorSnapshot', 'legacyStatusSnapshot'], optional: ['reversesTransactionId'] },
  transaction_items: { required: ['tenantId', 'itemId', 'transactionId', 'lineNumber', 'productIdSnapshot', 'currentProductId', 'productNameSnapshot', 'quantity', 'unitPriceSnapshot', 'subtotalSnapshot'], optional: ['regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustmentsSnapshot', 'appliedPromotionsSnapshot'] },
  adjustments: { required: ['tenantId', 'adjustmentId', 'transactionId', 'mode', 'requestedAmount', 'operatorSnapshot', 'legacyAdjustmentId'] },
  task_completions: { required: ['tenantId', 'completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion', 'operationId', 'operationPayloadHash'], optional: ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest'] },
  legacy_operation_bindings: { required: ['tenantId', 'operationId', 'tupleDigest', 'ownerDigest', 'payloadHash', 'binding', 'claimField', 'sourceProvenance'] },
  padlet_evidence_claims: { required: ['tenantId', 'provider', 'tupleDigest', 'boardId', 'postId', 'ownerDigest', 'operationId', 'operationPayloadHash', 'taskId', 'studentId', 'cycleStartsAt', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'provenances'] },
  padlet_claim_digest_tombstones: { required: ['tupleDigest', 'kind', 'provenance'], optional: ['ownerDigest'] },
};

function assertImportManifestShape(value: unknown): asserts value is LegacyNormalizationManifest {
  try {
    assertImporterBounds(value);
  } catch (error) {
    if (error instanceof Error && error.message.includes('exceeds')) throw new Error('Legacy migration manifest exceeds importer bounds.');
    throw new Error('Legacy migration manifest is structurally invalid.');
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'manifestVersion', 'status', 'tenantId', 'migrationJobId', 'sourceFingerprint', 'sourceArtifacts',
    'metadata', 'records', 'sourceRecords', 'mappings', 'warnings', 'blockingConflicts', 'quarantines', 'manifestDigest',
  ]) || value.manifestVersion !== 1) throw new Error('Legacy migration manifest version or shape is structurally invalid.');
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > 8_000_000) throw new Error('Legacy migration manifest exceeds importer bounds.');
  if (typeof value.tenantId !== 'string' || typeof value.migrationJobId !== 'string'
    || !isHexDigest(value.sourceFingerprint) || !isHexDigest(value.manifestDigest)) invalidManifest();
  if (!isPlainRecord(value.sourceArtifacts) || !hasExactKeys(value.sourceArtifacts, ['sheets'], ['redis'])) invalidManifest();
  const sheets = value.sourceArtifacts.sheets;
  if (!isPlainRecord(sheets) || !hasExactKeys(sheets, ['digest', 'spreadsheetIdDigest', 'revisionDigest', 'credentialHashes'])
    || !isHexDigest(sheets.digest) || !isHexDigest(sheets.spreadsheetIdDigest) || !isHexDigest(sheets.revisionDigest)
    || !isPlainRecord(sheets.credentialHashes)
    || !hasExactKeys(sheets.credentialHashes, [], ['adminPasswordHash', 'recoveryCodeHash'])
    || Object.values(sheets.credentialHashes).some((digest) => typeof digest !== 'string'
      || (!/^[a-f0-9]{64}$/.test(digest) && !/^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(digest)))) invalidManifest();
  const redis = value.sourceArtifacts.redis;
  if (redis !== undefined && (!isPlainRecord(redis) || !hasExactKeys(redis, ['digest', 'revisionDigest'])
    || !isHexDigest(redis.digest) || !isHexDigest(redis.revisionDigest))) invalidManifest();
  if (!isPlainRecord(value.metadata) || !hasExactKeys(value.metadata, ['sheetSchemaVersion', 'classTimeZone'])
    || ![1, 2, 3].includes(value.metadata.sheetSchemaVersion as number) || typeof value.metadata.classTimeZone !== 'string') invalidManifest();
  if (!isPlainRecord(value.records) || !Array.isArray(value.sourceRecords) || !Array.isArray(value.mappings)
    || !Array.isArray(value.warnings) || !Array.isArray(value.blockingConflicts) || !Array.isArray(value.quarantines)
    || value.sourceRecords.length > 10_000 || value.mappings.length > 100_000) invalidManifest();

  for (const [table, rows] of Object.entries(value.records)) {
    const shape = TARGET_RECORD_SHAPES[table];
    if (!shape || !Array.isArray(rows) || rows.length > 10_000) invalidManifest();
    for (const row of rows) {
      if (!isPlainRecord(row) || !hasExactKeys(row, shape.required, shape.optional ?? [])) invalidManifest();
      assertTargetRecordTypes(table, row);
    }
  }
  for (const diagnostic of [...value.warnings, ...value.blockingConflicts]) assertDiagnostic(diagnostic);
  for (const source of value.sourceRecords) assertSourceRecord(source, sheets.digest, isPlainRecord(redis) ? redis.digest as string : null);
  for (const quarantine of value.quarantines) assertSourceRecord(quarantine, sheets.digest, isPlainRecord(redis) ? redis.digest as string : null);
  for (const mapping of value.mappings) {
    if (!isPlainRecord(mapping) || !hasExactKeys(mapping, ['sourceDigest', 'targetTable', 'targetId', 'status'])
      || !isHexDigest(mapping.sourceDigest) || typeof mapping.targetTable !== 'string'
      || typeof mapping.targetId !== 'string' || !mapping.targetId || mapping.status !== 'STAGED') invalidManifest();
  }
  validateManifestGraph(value as unknown as LegacyNormalizationManifest);
}

function assertImporterBounds(root: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > 300_000 || depth > 64) throw new Error('Legacy migration manifest exceeds importer bounds.');
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalidManifest();
      continue;
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8');
      if (bytes > 8_000_000) throw new Error('Legacy migration manifest exceeds importer bounds.');
      // PostgreSQL text/JSONB cannot represent NUL or unpaired UTF-16 surrogates.
      if (value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) invalidManifest();
      continue;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) invalidManifest();
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidManifest();
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || !Number.isSafeInteger(length.value)
        || length.value < 0 || nodes + length.value > 300_000) throw new Error('Legacy migration manifest exceeds importer bounds.');
      const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (keys.length !== length.value) invalidManifest();
      for (let index = length.value - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidManifest();
        stack.push({ value: descriptor.value, depth: depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(value)) invalidManifest();
    const keys = Reflect.ownKeys(value);
    if (nodes + keys.length > 300_000) throw new Error('Legacy migration manifest exceeds importer bounds.');
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key)) invalidManifest();
      bytes += Buffer.byteLength(key, 'utf8');
      if (bytes > 8_000_000) throw new Error('Legacy migration manifest exceeds importer bounds.');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalidManifest();
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

function assertDiagnostic(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['code', 'path', 'sourceDigest'])
    || typeof value.code !== 'string' || typeof value.path !== 'string' || !isHexDigest(value.sourceDigest)) invalidManifest();
}

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const PG_INTEGER_MIN = -2_147_483_648;
const PG_INTEGER_MAX = 2_147_483_647;
const INTEGER_FIELDS = new Set([
  'balance', 'price', 'stock', 'sortOrder', 'schemaVersion', 'buyQuantity', 'freeQuantity',
  'promotionalUnitPrice', 'discountAmount', 'reward', 'ruleVersion', 'legacyTotalAmount', 'balanceDelta',
  'balanceBefore', 'balanceAfter', 'lineNumber', 'quantity', 'unitPriceSnapshot', 'subtotalSnapshot',
  'regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'requestedAmount',
]);
const BOOLEAN_FIELDS = new Set(['isActive']);
const STRING_FIELDS = new Set([
  'key', 'value', 'name', 'status', 'imageUrl', 'category', 'description', 'type', 'title',
  'timeZone', 'source', 'note', 'studentName', 'studentNameSnapshot', 'kind', 'operatorSnapshot',
  'legacyStatusSnapshot', 'productNameSnapshot', 'mode', 'evidenceProvider', 'evidenceAuthorFullName',
  'provider', 'provenance',
]);
const ARRAY_FIELDS = new Set(['allowedStudentIds', 'adjustmentsSnapshot', 'appliedPromotionsSnapshot', 'provenances']);
const DIGEST_FIELDS = new Set(['tupleDigest', 'ownerDigest']);
const INSTANT_FIELDS = new Set([
  'startsAt', 'endsAt', 'createdAt', 'updatedAt', 'availableFrom', 'dueAt', 'cycleStartsAt',
  'cycleEndsAt', 'occurredAt', 'timestamp', 'evidenceCreatedAt',
]);
const NULLABLE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  products: new Set(['imageUrl', 'category']),
  promotions: new Set(['buyQuantity', 'freeQuantity', 'promotionalUnitPrice', 'percent', 'discountAmount']),
  tasks: new Set(['pendingSchedule', 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'prerequisiteTaskInstanceId']),
  task_assignments: new Set(['cycleEndsAt', 'previousAssignmentId', 'note']),
  transactions: new Set(['legacyStatusSnapshot', 'reversesTransactionId']),
  transaction_items: new Set(['currentProductId', 'regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustmentsSnapshot', 'appliedPromotionsSnapshot']),
  adjustments: new Set(['legacyAdjustmentId']),
  task_completions: new Set(['note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'operationId', 'operationPayloadHash', 'evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest']),
  padlet_claim_digest_tombstones: new Set(['ownerDigest']),
};

function assertTargetRecordTypes(table: string, row: Record<string, unknown>): void {
  const nullable = NULLABLE_FIELDS[table] ?? new Set<string>();
  for (const [key, item] of Object.entries(row)) {
    if (item === null) {
      if (!nullable.has(key)) invalidManifest();
      continue;
    }
    if (INTEGER_FIELDS.has(key) && !Number.isSafeInteger(item)) invalidManifest();
    if (key === 'percent' && (typeof item !== 'number' || !Number.isFinite(item))) invalidManifest();
    if (BOOLEAN_FIELDS.has(key) && typeof item !== 'boolean') invalidManifest();
    if (STRING_FIELDS.has(key) && typeof item !== 'string') invalidManifest();
    if (ARRAY_FIELDS.has(key) && !Array.isArray(item)) invalidManifest();
    if (DIGEST_FIELDS.has(key) && !isHexDigest(item)) invalidManifest();
    if (key === 'operationPayloadHash' || key === 'payloadHash') {
      if (typeof item !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(item)) invalidManifest();
    }
    if (INSTANT_FIELDS.has(key) && !isCanonicalInstant(item)) invalidManifest();
  }
  for (const key of ['sortOrder', 'schemaVersion', 'lineNumber', 'ruleVersion']) {
    if (row[key] !== null && row[key] !== undefined && !safeIntegerIn(row[key], PG_INTEGER_MIN, PG_INTEGER_MAX)) invalidManifest();
  }
  for (const key of Object.keys(row).filter((key) => /Id(?:Snapshot)?$/.test(key))) {
    const item = row[key];
    if (item !== null && (typeof item !== 'string' || !item || item !== item.trim() || item.length > 512)) invalidManifest();
  }
  if (table === 'transaction_items' && (typeof row.itemId !== 'string' || !UUID_PATTERN.test(row.itemId)
    || row.itemId !== row.itemId.toLowerCase())) invalidManifest();
  if ('tenantId' in row && (typeof row.tenantId !== 'string' || !UUID_PATTERN.test(row.tenantId))) invalidManifest();
  if (table === 'settings' && typeof row.value !== 'string') invalidManifest();
  if (table === 'students') {
    if (!nonBlank(row.name) || !['ACTIVE', 'INACTIVE'].includes(String(row.status))) invalidManifest();
  } else if (table === 'accounts') {
    assertSafeInteger(row.balance);
  } else if (table === 'products') {
    if (!nonBlank(row.name) || !safeIntegerIn(row.price, 0, SAFE_INTEGER) || !safeIntegerIn(row.stock, 0, SAFE_INTEGER)) invalidManifest();
  } else if (table === 'promotions') {
    assertPromotion(row);
  } else if (table === 'promotion_products') {
    if (row.schemaVersion !== 3) invalidManifest();
  } else if (table === 'tasks') {
    if (!nonBlank(row.title) || !safeIntegerIn(row.reward, 0, SAFE_INTEGER)
      || !safeIntegerIn(row.schemaVersion, 1, SAFE_INTEGER) || !Array.isArray(row.allowedStudentIds)
      || !row.allowedStudentIds.every(nonBlank) || new Set(row.allowedStudentIds).size !== row.allowedStudentIds.length) invalidManifest();
    assertSchedule(row.currentSchedule);
    if (row.pendingSchedule !== null) assertSchedule(row.pendingSchedule);
    assertChronology(row.createdAt, row.updatedAt);
    if (row.availableFrom !== null) assertOptionalEndAfterStart(row.availableFrom, row.dueAt);
  } else if (table === 'task_assignments') {
    if (!['ASSIGNED', 'UNASSIGNED'].includes(String(row.status))
      || !['ADMIN', 'QR', 'LEGACY_SEED', 'CARRY_FORWARD'].includes(String(row.source))
      || row.timeZone !== 'Asia/Seoul' || !safeIntegerIn(row.ruleVersion, 1, SAFE_INTEGER)
      || row.schemaVersion !== 2) invalidManifest();
    assertOptionalEndAfterStart(row.cycleStartsAt, row.cycleEndsAt);
  } else if (table === 'transactions') {
    if (!['CHECKOUT', 'CANCELLATION', 'ADMIN_ADJUSTMENT', 'TASK_REWARD', 'LEGACY'].includes(String(row.kind))) invalidManifest();
    for (const key of ['legacyTotalAmount', 'balanceDelta', 'balanceBefore', 'balanceAfter']) assertSafeInteger(row[key]);
    if ((row.balanceAfter as number) - (row.balanceBefore as number) !== row.balanceDelta) invalidManifest();
    if ((row.kind === 'CANCELLATION') !== (typeof row.reversesTransactionId === 'string')) invalidManifest();
  } else if (table === 'transaction_items') {
    if (!safeIntegerIn(row.lineNumber, 1, SAFE_INTEGER) || !safeIntegerIn(row.quantity, 1, SAFE_INTEGER)) invalidManifest();
    assertSafeInteger(row.unitPriceSnapshot); assertSafeInteger(row.subtotalSnapshot);
    const extended = ['regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustmentsSnapshot', 'appliedPromotionsSnapshot'];
    const populated = extended.filter((key) => row[key] !== null && row[key] !== undefined).length;
    if (populated !== 0 && populated !== extended.length) invalidManifest();
    if (populated) {
      for (const key of extended.slice(0, 7)) if (!safeIntegerIn(row[key], key === 'totalQuantity' ? 1 : 0, SAFE_INTEGER)) invalidManifest();
      if ((row.paidQuantity as number) + (row.freeQuantity as number) !== row.totalQuantity
        || !exactExtendedSnapshots(row)
        || !parseCheckoutLineSnapshot({
          productId: row.productIdSnapshot, name: row.productNameSnapshot,
          price: row.unitPriceSnapshot, quantity: row.quantity, subtotal: row.subtotalSnapshot,
          regularUnitPrice: row.regularUnitPrice, regularTotal: row.regularTotal,
          totalQuantity: row.totalQuantity, paidQuantity: row.paidQuantity, freeQuantity: row.freeQuantity,
          finalTotal: row.finalTotal, totalDiscount: row.totalDiscount,
          adjustments: row.adjustmentsSnapshot, appliedPromotions: row.appliedPromotionsSnapshot,
        })) invalidManifest();
    }
  } else if (table === 'adjustments') {
    if (!['add', 'subtract', 'set'].includes(String(row.mode))) invalidManifest();
    assertSafeInteger(row.requestedAmount);
  } else if (table === 'task_completions') {
    assertTaskCompletion(row);
  } else if (table === 'legacy_operation_bindings') {
    assertBindingShape(row.binding);
  } else if (table === 'padlet_evidence_claims') {
    if (row.provider !== 'PADLET' || !Array.isArray(row.provenances)
      || !row.provenances.every((pointer) => validSourcePointer(pointer))) invalidManifest();
  } else if (table === 'padlet_claim_digest_tombstones') {
    if (!['V1_GLOBAL', 'ORPHAN_V2'].includes(String(row.kind)) || !nonBlank(row.provenance)) invalidManifest();
    if (row.kind === 'V1_GLOBAL' && (!isHexDigest(row.ownerDigest)
      || row.provenance !== 'upstash:padlet:evidence-claim:v1')) invalidManifest();
    if (row.kind === 'ORPHAN_V2' && (Object.hasOwn(row, 'ownerDigest')
      || row.provenance !== 'upstash:padlet:evidence-bindings:v2')) throw new Error('Redis orphan discriminator is invalid.');
  }
}

function exactExtendedSnapshots(row: Record<string, unknown>): boolean {
  if (!Array.isArray(row.adjustmentsSnapshot) || !Array.isArray(row.appliedPromotionsSnapshot)) return false;
  const adjustmentsExact = row.adjustmentsSnapshot.every((adjustment) => isPlainRecord(adjustment)
    && hasExactKeys(adjustment, adjustment.type === 'N_PLUS_ONE'
      ? ['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount', 'freeQuantity']
      : ['promotionId', 'type', 'beforeAmount', 'afterAmount', 'discountAmount']));
  const promotionsExact = row.appliedPromotionsSnapshot.every((promotion) => {
    if (!isPlainRecord(promotion)) return false;
    const common = ['promotionId', 'name', 'description', 'productIds', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'schemaVersion', 'type'];
    const variant = promotion.type === 'N_PLUS_ONE' ? ['buyQuantity', 'freeQuantity']
      : promotion.type === 'PROMOTIONAL_PRICE' ? ['promotionalUnitPrice']
        : promotion.type === 'PERCENT_DISCOUNT' ? ['percent']
          : promotion.type === 'FIXED_DISCOUNT' ? ['discountAmount'] : [];
    return variant.length > 0 && hasExactKeys(promotion, [...common, ...variant]);
  });
  return adjustmentsExact && promotionsExact;
}

function assertSafeInteger(value: unknown): void {
  if (!safeIntegerIn(value, -SAFE_INTEGER, SAFE_INTEGER)) invalidManifest();
}

function safeIntegerIn(value: unknown, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0;
}

function assertChronology(start: unknown, end: unknown): void {
  if (!isCanonicalInstant(start) || !isCanonicalInstant(end) || Date.parse(end) < Date.parse(start)) invalidManifest();
}

function assertOptionalEndAfterStart(start: unknown, end: unknown): void {
  if (!isCanonicalInstant(start) || (end !== null && (!isCanonicalInstant(end) || Date.parse(end) <= Date.parse(start as string)))) invalidManifest();
}

function assertPromotion(row: Record<string, unknown>): void {
  if (!nonBlank(row.name) || !['N_PLUS_ONE', 'PROMOTIONAL_PRICE', 'PERCENT_DISCOUNT', 'FIXED_DISCOUNT'].includes(String(row.type))
    || row.schemaVersion !== 3 || !isCanonicalInstant(row.startsAt) || !isCanonicalInstant(row.endsAt)
    || Date.parse(row.endsAt) <= Date.parse(row.startsAt)) invalidManifest();
  const absent = (value: unknown) => value === null || value === undefined;
  const variant = row.type === 'N_PLUS_ONE'
    ? safeIntegerIn(row.buyQuantity, 1, SAFE_INTEGER) && safeIntegerIn(row.freeQuantity, 1, SAFE_INTEGER) && absent(row.promotionalUnitPrice) && absent(row.percent) && absent(row.discountAmount)
    : row.type === 'PROMOTIONAL_PRICE'
      ? safeIntegerIn(row.promotionalUnitPrice, 0, SAFE_INTEGER) && absent(row.buyQuantity) && absent(row.freeQuantity) && absent(row.percent) && absent(row.discountAmount)
      : row.type === 'PERCENT_DISCOUNT'
        ? typeof row.percent === 'number' && row.percent > 0 && row.percent <= 100 && absent(row.buyQuantity) && absent(row.freeQuantity) && absent(row.promotionalUnitPrice) && absent(row.discountAmount)
        : safeIntegerIn(row.discountAmount, 1, SAFE_INTEGER) && absent(row.buyQuantity) && absent(row.freeQuantity) && absent(row.promotionalUnitPrice) && absent(row.percent);
  if (!variant) invalidManifest();
}

function assertSchedule(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['ruleVersion', 'effectiveFrom', 'timeZone', 'recurrence', 'resetCompletionOnCycle', 'resetAssignmentOnCycle'])
    || !safeIntegerIn(value.ruleVersion, 1, SAFE_INTEGER) || !isCanonicalInstant(value.effectiveFrom)
    || value.timeZone !== 'Asia/Seoul' || typeof value.resetCompletionOnCycle !== 'boolean'
    || typeof value.resetAssignmentOnCycle !== 'boolean' || !isPlainRecord(value.recurrence)) invalidManifest();
  const recurrence = value.recurrence;
  if (recurrence.type === 'NONE') {
    if (!hasExactKeys(recurrence, ['type'])) invalidManifest();
  } else if (recurrence.type === 'DAILY') {
    if (!hasExactKeys(recurrence, ['type', 'time']) || !validTime(recurrence.time)) invalidManifest();
  } else if (recurrence.type === 'WEEKLY') {
    if (!hasExactKeys(recurrence, ['type', 'time', 'weekdays']) || !validTime(recurrence.time)
      || !Array.isArray(recurrence.weekdays) || recurrence.weekdays.length < 1
      || recurrence.weekdays.some((day) => !safeIntegerIn(day, 1, 7)) || new Set(recurrence.weekdays).size !== recurrence.weekdays.length) invalidManifest();
  } else if (recurrence.type === 'MONTHLY') {
    if (!hasExactKeys(recurrence, ['type', 'time', 'dayOfMonth']) || !validTime(recurrence.time) || !safeIntegerIn(recurrence.dayOfMonth, 1, 31)) invalidManifest();
  } else invalidManifest();
}

function validTime(value: unknown): boolean {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function assertTaskCompletion(row: Record<string, unknown>): void {
  for (const key of ['reward', 'balanceBefore', 'balanceAfter']) {
    if (!safeIntegerIn(row[key], key === 'reward' ? 0 : -SAFE_INTEGER, SAFE_INTEGER)) invalidManifest();
  }
  if (!nonBlank(row.studentName) || !nonBlank(row.status) || !safeIntegerIn(row.schemaVersion, 1, SAFE_INTEGER)) invalidManifest();
  const cycleFields = ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'ruleVersion', 'timeZone', 'source'];
  const cycleCount = cycleFields.filter((key) => row[key] !== null).length;
  if (cycleCount !== 0 && cycleCount !== cycleFields.length) invalidManifest();
  if (cycleCount && (!isCanonicalInstant(row.cycleStartsAt) || !safeIntegerIn(row.ruleVersion, 1, SAFE_INTEGER)
    || row.timeZone !== 'Asia/Seoul' || !['BANK', 'ADMIN', 'CARRY_FORWARD', 'ADMIN_RESET'].includes(String(row.source)))) invalidManifest();
  if (row.cycleEndsAt !== null && (row.cycleStartsAt === null || !isCanonicalInstant(row.cycleEndsAt)
    || Date.parse(row.cycleEndsAt) <= Date.parse(row.cycleStartsAt as string))) invalidManifest();
  if (row.source === 'CARRY_FORWARD' && (row.reward !== 0 || row.balanceBefore !== row.balanceAfter)) invalidManifest();
  if (row.source === 'BANK' && row.operationId && Number(row.balanceAfter) - Number(row.balanceBefore) !== row.reward) invalidManifest();
  if ((row.operationId === null) !== (row.operationPayloadHash === null)) invalidManifest();
  const evidence = ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName'];
  const evidenceCount = evidence.filter((key) => row[key] !== null && row[key] !== undefined).length;
  if (evidenceCount !== 0 && evidenceCount !== evidence.length) invalidManifest();
  if (evidenceCount && (row.evidenceProvider !== 'PADLET' || !nonBlank(row.evidenceBoardId)
    || !nonBlank(row.evidencePostId) || !isCanonicalInstant(row.evidenceCreatedAt) || !nonBlank(row.evidenceAuthorFullName))) invalidManifest();
  if (evidenceCount && (!nonBlank(row.operationId) || !nonBlank(row.operationPayloadHash)
    || row.tupleDigest !== sha256(`${row.evidenceBoardId}\0${row.evidencePostId}`))) invalidManifest();
}

// Same trimmed scalar contract as acquisition/validators.ts; no additional
// external authenticity is inferred from these normalized values.
function boundedText(value: unknown, maximum: number): value is string {
  return nonBlank(value) && value.length <= maximum;
}

function assertBindingShape(value: unknown): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['taskId', 'studentId', 'cycleStartsAt', 'evidence'])
    || !boundedText(value.taskId, 128) || !boundedText(value.studentId, 128) || !isCanonicalInstant(value.cycleStartsAt)
    || !isPlainRecord(value.evidence) || !hasExactKeys(value.evidence, ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName'])
    || value.evidence.evidenceProvider !== 'PADLET' || typeof value.evidence.evidenceBoardId !== 'string'
    || typeof value.evidence.evidencePostId !== 'string' || !isCanonicalInstant(value.evidence.evidenceCreatedAt)
    || !boundedText(value.evidence.evidenceAuthorFullName, 200)) invalidManifest();
}

function validSourcePointer(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  return value.kind === 'SHEET'
    ? hasExactKeys(value, ['kind', 'artifactDigest', 'tab', 'rowNumber', 'rowHash'])
      && isHexDigest(value.artifactDigest) && typeof value.tab === 'string' && Number.isSafeInteger(value.rowNumber) && isHexDigest(value.rowHash)
    : value.kind === 'REDIS' && hasExactKeys(value, ['kind', 'artifactDigest', 'provenance', 'sourceDigest'])
      && isHexDigest(value.artifactDigest) && typeof value.provenance === 'string' && isHexDigest(value.sourceDigest);
}

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertSourceRecord(value: unknown, sheetsDigest: string, redisDigest: string | null): void {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'source', 'redactedSourceRecord', 'canonicalRecord', 'mappingStatus', 'warningCodes', 'errorCodes',
  ], ['targetTable', 'targetId']) || value.mappingStatus !== 'STAGED'
    || !Array.isArray(value.warningCodes) || !value.warningCodes.every((item) => typeof item === 'string')
    || !Array.isArray(value.errorCodes) || !value.errorCodes.every((item) => typeof item === 'string')
    || (value.canonicalRecord !== null && !isPlainRecord(value.canonicalRecord))) invalidManifest();
  if (!isPlainRecord(value.redactedSourceRecord) || !hasExactKeys(value.redactedSourceRecord, ['identityDigest', 'recognizedFieldCount', 'omittedFieldCount'])
    || !isHexDigest(value.redactedSourceRecord.identityDigest)
    || !Number.isSafeInteger(value.redactedSourceRecord.recognizedFieldCount)
    || !Number.isSafeInteger(value.redactedSourceRecord.omittedFieldCount)) invalidManifest();
  if (!isPlainRecord(value.source)) invalidManifest();
  if (value.source.kind === 'SHEET') {
    if (!hasExactKeys(value.source, ['kind', 'artifactDigest', 'tab', 'rowNumber', 'rowHash'])
      || value.source.artifactDigest !== sheetsDigest || typeof value.source.tab !== 'string'
      || value.source.tab.length < 1 || value.source.tab.length > 200
      || !safeIntegerIn(value.source.rowNumber, 1, PG_INTEGER_MAX) || !isHexDigest(value.source.rowHash)) invalidManifest();
  } else if (value.source.kind === 'REDIS') {
    if (!redisDigest || !hasExactKeys(value.source, ['kind', 'artifactDigest', 'provenance', 'sourceDigest'])
      || value.source.artifactDigest !== redisDigest || typeof value.source.provenance !== 'string'
      || !isHexDigest(value.source.sourceDigest)) invalidManifest();
  } else invalidManifest();
  const hasTable = Object.hasOwn(value, 'targetTable');
  const hasId = Object.hasOwn(value, 'targetId');
  if (hasTable !== hasId || (hasTable && (typeof value.targetTable !== 'string' || typeof value.targetId !== 'string'))) invalidManifest();
}

function validateManifestGraph(manifest: LegacyNormalizationManifest): void {
  if (manifest.sourceRecords.some((source) => source.targetTable && !(source.targetTable in TARGET_RECORD_SHAPES))
    || manifest.mappings.some((mapping) => !(mapping.targetTable in TARGET_RECORD_SHAPES))) {
    throw new Error('Manifest contains an unsupported target table.');
  }
  // Reject ordinary contributor multiplicity before digest grouping can erase a
  // Sheet row. Only explicit derived claims may union contributors; their exact
  // origin pointers and cardinality are checked independently below.
  const identities = new Set<string>();
  const primaryTargets = new Set<string>();
  const identityFields: Record<string, string> = {
    Students: 'studentId', Products: 'productId', Transactions: 'transactionId', Adjustments: 'adjustmentId',
    Settings: 'key', Tasks: 'taskId', TaskAssignments: 'assignmentId', TaskCompletions: 'completionId',
    Promotions: 'promotionId', PromotionProducts: 'promotionProductId',
  };
  for (const source of manifest.sourceRecords) {
    if (source.targetTable === 'padlet_evidence_claims' && source.canonicalRecord?.provider === 'PADLET') continue;
    if (source.source.kind === 'SHEET' && source.canonicalRecord) {
      const field = identityFields[source.source.tab];
      if (field) {
        if (source.canonicalRecord[field] === undefined) throw new Error('Canonical source identity is structurally invalid.');
        const identity = canonicalJson([source.source.tab, source.canonicalRecord[field]]);
        if (identities.has(identity)) throw new Error('Duplicate source canonical identity violates unique graph.');
        identities.add(identity);
      }
    }
    if (source.targetTable) {
      const identity = canonicalJson([source.targetTable, source.targetId]);
      if (primaryTargets.has(identity)) throw new Error('Duplicate source primary target identity.');
      primaryTargets.add(identity);
    }
  }
  const sourceDigests = new Set(manifest.sourceRecords.map(sourceDigestOf));
  const mappingKeys = new Set<string>();
  const targetIds = new Map<string, Set<string>>();
  for (const [table, rows] of Object.entries(manifest.records)) {
    const ids = new Set<string>();
    for (const row of rows) {
      const id = expectedManifestTargetId(table, row, manifest);
      if (ids.has(id)) throw new Error('Manifest contains duplicate target IDs.');
      ids.add(id);
    }
    targetIds.set(table, ids);
  }
  for (const mapping of manifest.mappings) {
    if (!sourceDigests.has(mapping.sourceDigest)) throw new Error('Manifest mapping has no source record.');
    const key = `${mapping.sourceDigest}\0${mapping.targetTable}\0${mapping.targetId}`;
    if (mappingKeys.has(key)) throw new Error('Manifest contains a duplicate mapping.');
    mappingKeys.add(key);
    if (!targetIds.get(mapping.targetTable)?.has(mapping.targetId)) throw new Error('Manifest mapping has a dangling target record.');
    const candidates = manifest.sourceRecords.filter((record) => sourceDigestOf(record) === mapping.sourceDigest);
    if (!candidates.some((record) => sourceCanMap(record, mapping.targetTable, mapping.targetId, manifest))) {
      throw new Error('Manifest mapping does not match its source record.');
    }
  }
  for (const [table, ids] of targetIds) for (const id of ids) {
    if (!manifest.mappings.some((mapping) => mapping.targetTable === table && mapping.targetId === id)) {
      throw new Error('Manifest target record is missing a mapping.');
    }
  }
  for (const source of manifest.sourceRecords) {
    const digest = sourceDigestOf(source);
    const mappings = manifest.mappings.filter((mapping) => mapping.sourceDigest === digest);
    if (source.targetTable && !mappings.some((mapping) => mapping.targetTable === source.targetTable && mapping.targetId === source.targetId)) {
      throw new Error('Manifest source record has a dangling mapping projection.');
    }
    if (!source.targetTable && mappings.length) throw new Error('Manifest source record omits an existing mapping.');
  }
}

function expectedManifestTargetId(table: string, row: Readonly<Record<string, unknown>>, manifest: LegacyNormalizationManifest): string {
  const directIds: Record<string, string> = {
    settings: 'key', students: 'studentId', accounts: 'studentId', products: 'productId', promotions: 'promotionId',
    promotion_products: 'promotionProductId', tasks: 'taskInstanceId', task_assignments: 'assignmentId',
    transactions: 'transactionId', transaction_items: 'itemId', adjustments: 'adjustmentId', task_completions: 'completionId',
  };
  if (directIds[table]) return String(row[directIds[table]]);
  if (table === 'task_allowed_students') return deterministicManifestId(manifest.tenantId, 'task_allowed_students', String(row.taskInstanceId), String(row.studentId));
  if (table === 'legacy_operation_bindings') return deterministicManifestId(manifest.tenantId, manifest.migrationJobId, table, String(row.operationId));
  if (table === 'padlet_evidence_claims') return deterministicManifestId(manifest.tenantId, manifest.migrationJobId, table, String(row.tupleDigest));
  if (table === 'padlet_claim_digest_tombstones') return deterministicManifestId('global', table, String(row.tupleDigest));
  invalidManifest();
}

function deterministicManifestId(...parts: readonly string[]): string {
  const encoded = parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
  const hex = sha256(encoded);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function sourceCanMap(source: LegacyNormalizationManifest['sourceRecords'][number], table: string, id: string, manifest: LegacyNormalizationManifest): boolean {
  if (source.targetTable === table && source.targetId === id) return true;
  const canonical = source.canonicalRecord;
  if (!canonical) return false;
  if (table === 'accounts') return source.targetTable === 'students' && canonical.studentId === id;
  if (table === 'transaction_items' && Array.isArray(canonical.items)) return canonical.items.some((item) => isPlainRecord(item) && item.itemId === id);
  if (table === 'task_allowed_students' && Array.isArray(canonical.allowedStudentIds)) {
    return canonical.allowedStudentIds.some((studentId) => deterministicManifestId(manifest.tenantId, 'task_allowed_students', String(canonical.taskInstanceId), String(studentId)) === id);
  }
  return false;
}

function sourceDigestOf(source: LegacyNormalizationManifest['sourceRecords'][number]): string {
  return source.source.kind === 'SHEET' ? source.source.rowHash : source.source.sourceDigest;
}

function assertExplicitOperationBindings(manifest: LegacyNormalizationManifest): void {
  const bindings = new Map<string, Readonly<Record<string, unknown>>>();
  for (const binding of manifest.records.legacy_operation_bindings ?? []) {
    const operationId = String(binding.operationId);
    const targetId = deterministicManifestId(manifest.tenantId, manifest.migrationJobId, 'legacy_operation_bindings', operationId);
    const mappedFromVerifiedRedis = manifest.mappings.some((mapping) => mapping.targetTable === 'legacy_operation_bindings'
      && mapping.targetId === targetId
      && manifest.sourceRecords.some((source) => source.source.kind === 'REDIS'
        && source.source.sourceDigest === mapping.sourceDigest
        && source.targetTable === 'legacy_operation_bindings' && source.targetId === targetId));
    if (!mappedFromVerifiedRedis) throw new Error('Explicit operation binding lacks verified legacy source evidence.');
    assertRedisOperationBinding(binding);
    if (bindings.has(operationId)) throw new Error('Explicit operation binding is duplicated.');
    bindings.set(operationId, binding);
  }
  const requiring = [
    ...(manifest.records.task_completions ?? []),
    ...(manifest.records.padlet_evidence_claims ?? []),
  ];
  for (const row of requiring) {
    if (row.operationId === null || row.operationId === undefined) continue;
    const binding = bindings.get(String(row.operationId));
    const nested = binding?.binding as Record<string, unknown> | undefined;
    const evidence = nested?.evidence as Record<string, unknown> | undefined;
    const correlated = Boolean(binding) && binding?.payloadHash === row.operationPayloadHash
      && nested?.taskId === row.taskId && nested?.studentId === row.studentId
      && nested?.cycleStartsAt === row.cycleStartsAt
      && (row.tupleDigest === undefined || binding?.tupleDigest === row.tupleDigest)
      && (row.boardId === undefined || evidence?.evidenceBoardId === row.boardId)
      && (row.postId === undefined || evidence?.evidencePostId === row.postId)
      && (row.ownerDigest === undefined || (binding?.ownerDigest === row.ownerDigest
        && row.ownerDigest === sha256(String(row.operationId))
        && row.tupleDigest === sha256(`${row.boardId}\0${row.postId}`)))
      && (row.evidenceBoardId === undefined || evidence?.evidenceBoardId === row.evidenceBoardId)
      && (row.evidencePostId === undefined || evidence?.evidencePostId === row.evidencePostId)
      && (row.evidenceCreatedAt === undefined || evidence?.evidenceCreatedAt === row.evidenceCreatedAt)
      && (row.evidenceAuthorFullName === undefined || evidence?.evidenceAuthorFullName === row.evidenceAuthorFullName);
    if (!correlated) throw new Error('Target requires an exact explicit verified operation binding and operation hash.');
  }
}

function rawOperationDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) invalidManifest();
  return value.slice('sha256:'.length);
}

function assertRedisOperationBinding(binding: Readonly<Record<string, unknown>>): void {
  assertBindingShape(binding.binding);
  const nested = binding.binding as Record<string, unknown>;
  const evidence = nested.evidence as Record<string, unknown>;
  if (!boundedText(binding.operationId, 128) || !isHexDigest(binding.tupleDigest) || !isHexDigest(binding.ownerDigest)
    || binding.ownerDigest !== sha256(binding.operationId) || binding.tupleDigest !== sha256(`${evidence.evidenceBoardId}\0${evidence.evidencePostId}`)
    || binding.claimField !== `claim:${binding.tupleDigest}`
    || binding.payloadHash !== `sha256:${sha256(canonicalJson(nested))}`
    || binding.sourceProvenance !== 'upstash:padlet:evidence-bindings:v2'
    || !/^[A-Za-z0-9]{16,22}$/.test(String(evidence.evidenceBoardId))
    || !/^[A-Za-z0-9_-]{3,128}$/.test(String(evidence.evidencePostId))) {
    throw new Error('Redis operation binding provenance is invalid.');
  }
}

function assertOperationalSettings(manifest: LegacyNormalizationManifest): void {
  const settings = manifest.records.settings ?? [];
  if (settings.some((row) => !OPERATIONAL_SETTINGS.has(String(row.key)))) {
    throw new Error('Manifest contains an unsupported operational setting.');
  }
  const exactlyOne = (key: string) => settings.filter((row) => row.key === key);
  const schemaVersions = exactlyOne('schemaVersion');
  const timeZones = exactlyOne('classTimeZone');
  if (schemaVersions.length !== 1 || timeZones.length !== 1
    || schemaVersions[0].value !== String(manifest.metadata.sheetSchemaVersion)
    || timeZones[0].value !== manifest.metadata.classTimeZone
    || !isSupportedTimeZone(manifest.metadata.classTimeZone)) {
    throw new Error('Manifest operational settings do not match manifest metadata.');
  }
}

function isSupportedTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim()
    || (value !== 'UTC' && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))) return false;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

const CANONICAL_SHEET_SHAPES: Readonly<Record<string, Readonly<{ required: readonly string[]; optional?: readonly string[] }>>> = {
  Students: { required: ['studentId', 'name', 'balance', 'status'] },
  Products: { required: ['productId', 'name', 'price', 'stock', 'isActive', 'imageUrl', 'category', 'sortOrder'] },
  Transactions: { required: ['transactionId', 'timestamp', 'studentId', 'studentName', 'items', 'totalAmount', 'balanceBefore', 'balanceAfter', 'status', 'operator'], optional: ['reversesTransactionId'] },
  Adjustments: { required: ['adjustmentId', 'timestamp', 'studentId', 'amount', 'mode', 'operator', 'operatorDigest', 'transactionId'] },
  Settings: { required: ['key'], optional: ['value', 'valueDigest'] },
  Tasks: { required: ['taskId', 'taskInstanceId', 'title', 'description', 'reward', 'isActive', 'sortOrder', 'createdAt', 'updatedAt', 'allowedStudentIds', 'currentSchedule', 'pendingSchedule', 'availableFrom', 'dueAt', 'prerequisiteTaskId', 'schemaVersion'], optional: ['prerequisiteTaskInstanceId'] },
  TaskAssignments: { required: ['assignmentId', 'taskId', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'studentId', 'status', 'source', 'previousAssignmentId', 'createdAt', 'schemaVersion', 'note'] },
  TaskCompletions: { required: ['completionId', 'timestamp', 'taskId', 'studentId', 'studentName', 'reward', 'balanceBefore', 'balanceAfter', 'status', 'note', 'taskInstanceId', 'cycleId', 'cycleStartsAt', 'cycleEndsAt', 'ruleVersion', 'timeZone', 'source', 'assignmentId', 'schemaVersion', 'operationId', 'operationPayloadHash'], optional: ['evidenceProvider', 'evidenceBoardId', 'evidencePostId', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest'] },
  Promotions: { required: ['promotionId', 'name', 'description', 'type', 'startsAt', 'endsAt', 'isActive', 'sortOrder', 'schemaVersion', 'createdAt', 'updatedAt'], optional: ['buyQuantity', 'freeQuantity', 'promotionalUnitPrice', 'percent', 'discountAmount'] },
  PromotionProducts: { required: ['promotionProductId', 'promotionId', 'productId', 'createdAt', 'schemaVersion'] },
};

function assertCanonicalSources(manifest: LegacyNormalizationManifest): void {
  for (const source of manifest.sourceRecords) {
    const canonical = source.canonicalRecord;
    const mappings = manifest.mappings.filter((mapping) => mapping.sourceDigest === sourceDigestOf(source)
      && sourceCanMap(source, mapping.targetTable, mapping.targetId, manifest));
    if (canonical === null) {
      if (source.targetTable || mappings.length) throw new Error('Canonical source is missing for mapped target.');
      continue;
    }
    if (source.source.kind === 'SHEET') {
      const shape = source.targetTable === 'padlet_evidence_claims'
        ? TARGET_RECORD_SHAPES.padlet_evidence_claims
        : CANONICAL_SHEET_SHAPES[source.source.tab];
      if (!shape || !hasExactKeys(canonical, shape.required, shape.optional ?? [])) {
        throw new Error('Canonical source schema is structurally invalid.');
      }
      assertSheetCanonicalTypes(source.source.tab, canonical, manifest.tenantId, source.targetTable);
      if (source.targetTable !== 'padlet_evidence_claims') {
        if (source.source.tab === 'Tasks' && canonical.schemaVersion !== manifest.metadata.sheetSchemaVersion) invalidManifest();
        if (source.source.tab === 'TaskCompletions') {
          const snapshotRequired = manifest.metadata.sheetSchemaVersion >= 2;
          if (canonical.schemaVersion !== (snapshotRequired ? 2 : 1)
            || (snapshotRequired && ['taskInstanceId', 'cycleId', 'cycleStartsAt', 'ruleVersion', 'timeZone', 'source'].some((key) => canonical[key] == null))) invalidManifest();
        }
      }
    } else {
      assertRedisCanonicalSource(source, canonical, manifest);
    }
    for (const mapping of mappings) assertCanonicalTarget(mapping.targetTable, mapping.targetId, canonical, manifest);
  }
  assertCompleteSourceProjection(manifest);
  assertCanonicalDependencies(manifest);
  assertClaimProvenanceUnion(manifest);
  assertRedisClaimGraph(manifest);
}

// Canonical references must survive even when the operations projection discards
// task/student fields. Count Redis contributors, not union targets or Sheets peers.
function assertRedisClaimGraph(manifest: LegacyNormalizationManifest): void {
  const claims = manifest.records.padlet_evidence_claims ?? [];
  const redisClaims = manifest.sourceRecords.filter((source) => source.source.kind === 'REDIS'
    && source.canonicalRecord?.provider === 'PADLET');
  const taskIds = new Set(manifest.sourceRecords.filter((source) => source.source.kind === 'SHEET' && source.source.tab === 'Tasks')
    .map((source) => source.canonicalRecord?.taskId));
  const studentIds = new Set(manifest.sourceRecords.filter((source) => source.source.kind === 'SHEET' && source.source.tab === 'Students')
    .map((source) => source.canonicalRecord?.studentId));
  const assertReferences = (row: Readonly<Record<string, unknown>>) => {
    if (!taskIds.has(row.taskId) || !studentIds.has(row.studentId)) throw new Error('Redis claim graph contains an unresolved canonical reference.');
  };
  for (const binding of manifest.records.legacy_operation_bindings ?? []) {
    if (redisClaims.filter((source) => source.canonicalRecord!.operationId === binding.operationId).length !== 1) {
      throw new Error('Redis binding graph requires exactly one Redis claim contributor.');
    }
    assertReferences(binding.binding as Record<string, unknown>);
  }
  for (const source of redisClaims) assertReferences(source.canonicalRecord!);
  const tuples = new Set(claims.map((claim) => claim.tupleDigest));
  for (const tombstone of manifest.records.padlet_claim_digest_tombstones ?? []) {
    if (tuples.has(tombstone.tupleDigest)) throw new Error('Claim and tombstone tuple sets must be disjoint.');
  }
}

// Local status/relationship gates mirror normalizeTransaction and
// validateTransactionCancellations; item and adjustment semantics use the same
// pure validators as the normalizer (including signed administrator lines).
function assertFinancialHistory(manifest: LegacyNormalizationManifest): void {
  const canonical = (tab: string) => manifest.sourceRecords
    .filter((s) => s.source.kind === 'SHEET' && s.source.tab === tab)
    .map((s) => s.canonicalRecord!).filter(Boolean);
  const transactions = canonical('Transactions');
  const adjustments = canonical('Adjustments');
  const fail = (): never => { throw new Error('Canonical financial history is inconsistent.'); };
  for (const row of transactions) {
    const items = row.items as Record<string, unknown>[];
    const delta = Number(row.balanceAfter) - Number(row.balanceBefore);
    const total = Number(row.totalAmount);
    const purchase = row.status === 'COMPLETED' || row.status === 'CANCELLED';
    const admin = row.status === 'ADMIN_ADJUSTMENT';
    if (!nonBlank(row.studentName) || !nonBlank(row.operator) || !Number.isSafeInteger(delta)) fail();
    if (row.status === 'CANCEL_REVERSAL') {
      const originalId = cancellationOriginalId(String(row.operator));
      if (!originalId || originalId === row.transactionId || originalId !== row.reversesTransactionId
        || items.length !== 0 || total >= 0 || delta <= 0 || total !== -delta) fail();
      const originals = transactions.filter((r) => r.transactionId === originalId);
      const original = originals[0];
      if (originals.length !== 1 || original.status !== 'CANCELLED' || original.studentId !== row.studentId
        || Date.parse(String(row.timestamp)) <= Date.parse(String(original.timestamp))
        || Number(original.totalAmount) !== -total
        || Number(original.balanceAfter) - Number(original.balanceBefore) !== -delta) fail();
    } else if ((purchase && (!items.length || total < 0 || delta !== -total))
      || (admin ? items.length !== 1 : !purchase && items.length !== 0)
      || (row.status === 'TASK_REWARD' && delta !== total) || (admin && delta !== -total)) fail();
    let itemTotal = 0;
    const products = new Set<unknown>();
    for (const item of items) {
      const raw = Object.fromEntries(Object.entries(item).filter(([key]) => !['itemId', 'transactionId', 'lineNumber'].includes(key)));
      if (!canonicalTransactionItem(raw, admin) || products.has(item.productId)) fail();
      products.add(item.productId);
      itemTotal += Number(item.subtotal);
      if (!Number.isSafeInteger(itemTotal)) fail();
    }
    if (purchase && itemTotal !== total) fail();
    if (row.status === 'CANCELLED' && transactions.filter((r) => r.status === 'CANCEL_REVERSAL' && r.reversesTransactionId === row.transactionId).length !== 1) fail();
    if (admin) {
      const key = adjustmentTransactionKey(row);
      const matches = adjustments.filter((a) => adjustmentKey(a) === key);
      if (!key || matches.length !== 1 || matches[0].transactionId !== row.transactionId) fail();
    }
  }
  for (const adjustment of adjustments) {
    const key = adjustmentKey(adjustment);
    const matches = transactions.filter((r) => adjustmentTransactionKey(r) === key);
    if (!key || matches.length !== 1 || matches[0].transactionId !== adjustment.transactionId) fail();
  }
}

function assertCanonicalDependencies(manifest: LegacyNormalizationManifest): void {
  const tasks = manifest.sourceRecords.filter((source) => source.source.kind === 'SHEET' && source.source.tab === 'Tasks')
    .map((source) => source.canonicalRecord).filter((row): row is Record<string, unknown> => row !== null);
  const assignments = manifest.records.task_assignments ?? [];
  const completions = manifest.records.task_completions ?? [];
  for (const event of [...assignments, ...completions]) {
    if (event.taskInstanceId === null) continue;
    const parents = tasks.filter((task) => task.taskInstanceId === event.taskInstanceId);
    if (parents.length !== 1 || parents[0].taskId !== event.taskId) throw new Error('Task event business-instance tuple reference is inconsistent.');
  }
  for (const completion of completions) {
    if (!completion.taskInstanceId || !completion.assignmentId) continue;
    const parents = assignments.filter((assignment) => assignment.assignmentId === completion.assignmentId);
    if (parents.length !== 1 || !sameAssignmentCompletionTuple(parents[0], completion)) throw new Error('Assignment completion tuple reference is inconsistent.');
  }
  const byBusinessId = new Map<unknown, Record<string, unknown>[]>();
  for (const task of tasks) {
    const candidates = byBusinessId.get(task.taskId) ?? [];
    candidates.push(task); byBusinessId.set(task.taskId, candidates);
  }
  for (const task of tasks) {
    const candidates = byBusinessId.get(task.prerequisiteTaskId) ?? [];
    if (task.prerequisiteTaskId === null) {
      if (task.prerequisiteTaskInstanceId != null) throw new Error('Task prerequisite dependency is not requested by its business ID.');
    } else if (candidates.length !== 1 || task.prerequisiteTaskInstanceId !== candidates[0].taskInstanceId) {
      throw new Error('Task prerequisite dependency has an unresolved or inconsistent parent business ID.');
    }
  }
}

function assertClaimProvenanceUnion(manifest: LegacyNormalizationManifest): void {
  for (const claim of manifest.records.padlet_evidence_claims ?? []) {
    // One derived claim source per actual contributor, not the completion and its
    // derived claim twice. Redis operation bindings are not claim contributors.
    const contributors = manifest.sourceRecords.filter((source) => source.canonicalRecord?.provider === 'PADLET'
      && source.canonicalRecord.tupleDigest === claim.tupleDigest);
    const expected = contributors.map((source) => source.source)
      .sort((a, b) => {
        const left = a.kind === 'SHEET' ? a.rowHash : a.sourceDigest;
        const right = b.kind === 'SHEET' ? b.rowHash : b.sourceDigest;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    if (!expected.length || new Set(expected.map((pointer) => canonicalJson(pointer))).size !== expected.length
      || !equalJson(claim.provenances, expected)) throw new Error('Claim provenance union does not equal its full contributing source pointers.');
  }
}

// Derive obligations from canonical source content, never from surviving targets or
// the optional first-target hint. Unsupported tabs and redacted settings are the
// normalizer's only legitimate skipped source contracts in a READY manifest.
function assertCompleteSourceProjection(manifest: LegacyNormalizationManifest): void {
  const expected = new Set<string>();
  const sheetTables: Record<string, string> = {
    Students: 'students', Products: 'products', Transactions: 'transactions', Adjustments: 'adjustments',
    Settings: 'settings', Tasks: 'tasks', TaskAssignments: 'task_assignments', TaskCompletions: 'task_completions',
    Promotions: 'promotions', PromotionProducts: 'promotion_products',
  };
  for (const source of manifest.sourceRecords) {
    const row = source.canonicalRecord;
    const digest = sourceDigestOf(source);
    const add = (table: string, value: Readonly<Record<string, unknown>>) => {
      expected.add(`${digest}\0${table}\0${expectedManifestTargetId(table, value, manifest)}`);
    };
    if (!row) {
      if (source.source.kind === 'REDIS' || sheetTables[source.source.tab]) throw new Error('Canonical source projection is missing.');
      continue;
    }
    if ('provider' in row) {
      add('padlet_evidence_claims', row);
      if (source.source.kind === 'SHEET' && !manifest.sourceRecords.some((candidate) =>
        candidate.source.kind === 'SHEET' && candidate.source.tab === 'TaskCompletions'
        && equalJson(candidate.source, source.source) && candidate.canonicalRecord?.completionId
        && candidate.canonicalRecord.tupleDigest === row.tupleDigest)) {
        throw new Error('Sheet claim provenance does not identify its originating completion.');
      }
      continue;
    }
    if (source.source.kind === 'REDIS') {
      add('binding' in row ? 'legacy_operation_bindings' : 'padlet_claim_digest_tombstones', row);
      continue;
    }
    const table = sheetTables[source.source.tab];
    if (table === 'settings' && !OPERATIONAL_SETTINGS.has(String(row.key))) continue;
    if (!table) throw new Error('Canonical source projection is unsupported.');
    add(table, row);
    if (table === 'students') add('accounts', row);
    if (table === 'transactions') for (const item of row.items as Record<string, unknown>[]) add('transaction_items', item);
    if (table === 'tasks') for (const studentId of row.allowedStudentIds as string[]) add('task_allowed_students', { taskInstanceId: row.taskInstanceId, studentId });
    if (table === 'task_completions' && row.evidenceProvider != null) {
      add('padlet_evidence_claims', row);
      const claims = manifest.sourceRecords.filter((candidate) => sourceDigestOf(candidate) === digest && candidate.canonicalRecord?.provider === 'PADLET');
      if (claims.length !== 1) throw new Error('Sheet completion claim canonical source projection is missing.');
      const claim = claims[0].canonicalRecord!;
      for (const key of ['operationId', 'operationPayloadHash', 'taskId', 'studentId', 'cycleStartsAt', 'evidenceCreatedAt', 'evidenceAuthorFullName', 'tupleDigest']) {
        if (claim[key] !== row[key]) throw new Error('Sheet completion claim binding is inconsistent.');
      }
      if (claim.boardId !== row.evidenceBoardId || claim.postId !== row.evidencePostId
        || claim.ownerDigest !== sha256(String(row.operationId))) throw new Error('Sheet completion claim tuple binding is inconsistent.');
    }
  }
  const actual = new Set(manifest.mappings.map((mapping) => `${mapping.sourceDigest}\0${mapping.targetTable}\0${mapping.targetId}`));
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
    throw new Error('Manifest mappings do not equal the complete canonical source projection.');
  }
}

// These checks establish internal consistency only. Acquisition digests identify the
// authenticated snapshot inputs to normalization; a caller-recomputed manifest digest
// is not authentication of an external Redis deployment or its historical claims.
function assertSheetCanonicalTypes(tab: string, row: Record<string, unknown>, tenantId: string, targetTable?: string): void {
  if (targetTable === 'padlet_evidence_claims') {
    assertTargetRecordTypes(targetTable, row);
    return;
  }
  if (tab === 'Settings') { assertCanonicalSetting(row); return; }
  const direct: Record<string, string> = {
    Students: 'students', Products: 'products', Tasks: 'tasks', TaskAssignments: 'task_assignments',
    TaskCompletions: 'task_completions', Promotions: 'promotions', PromotionProducts: 'promotion_products',
  };
  if (direct[tab]) {
    assertTargetRecordTypes(direct[tab], row);
    if (tab === 'Students') assertSafeInteger(row.balance);
    return;
  }
  if (typeof row.operator !== 'string') invalidManifest();
  if (tab === 'Adjustments') {
    if (!nonBlank(row.operator) || row.operatorDigest !== sha256(row.operator)
      || !safeIntegerIn(row.amount, row.mode === 'set' ? -SAFE_INTEGER : 0, SAFE_INTEGER)) invalidManifest();
    assertTargetRecordTypes('adjustments', { ...row, requestedAmount: row.amount });
    return;
  }
  if (tab !== 'Transactions' || !Array.isArray(row.items)
    || !['COMPLETED', 'CANCELLED', 'TASK_REWARD', 'ADMIN_ADJUSTMENT', 'CANCEL_REVERSAL'].includes(String(row.status))) invalidManifest();
  assertTargetRecordTypes('transactions', canonicalTransactionTarget(row, tenantId));
  const itemIds = new Set<string>();
  const lineNumbers = new Set<unknown>();
  for (const item of row.items) {
    if (!isPlainRecord(item) || !nonBlank(item.productId) || item.productId !== item.productId.trim()
      || item.transactionId !== row.transactionId) invalidManifest();
    const extended = ['regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions'];
    if (extended.some((key) => Object.hasOwn(item, key))
      && !extended.every((key) => Object.hasOwn(item, key) && item[key] !== null)) invalidManifest();
    // Validate this object, not the first sibling sharing its ID. Check cardinality
    // before expected output mappings are reduced to sets.
    const projected = projectCanonicalTransactionItem(row, item, tenantId);
    const id = String(item.itemId).toLowerCase();
    if (itemIds.has(id) || lineNumbers.has(item.lineNumber)) throw new Error('Canonical transaction items violate a unique identity.');
    itemIds.add(id); lineNumbers.add(item.lineNumber);
    if (!projected) invalidManifest();
    assertTargetRecordTypes('transaction_items', projected);
  }
}

function assertCanonicalSetting(canonical: Record<string, unknown>): void {
  if (!nonBlank(canonical.key)) invalidManifest();
  const operational = OPERATIONAL_SETTINGS.has(canonical.key);
  if (operational && typeof canonical.value !== 'string') invalidManifest();
  if (operational ? !hasExactKeys(canonical, ['key', 'value'])
    : !hasExactKeys(canonical, ['key', 'valueDigest']) || !isHexDigest(canonical.valueDigest)) {
    throw new Error('Canonical source setting schema is invalid.');
  }
}

function assertRedisCanonicalSource(
  source: LegacyNormalizationManifest['sourceRecords'][number],
  canonical: Record<string, unknown>,
  manifest: LegacyNormalizationManifest,
): void {
  if (source.source.kind !== 'REDIS') invalidManifest();
  if (source.targetTable === 'legacy_operation_bindings') {
    const shape = TARGET_RECORD_SHAPES.legacy_operation_bindings;
    if (!hasExactKeys(canonical, shape.required) || canonical.sourceProvenance !== source.source.provenance) {
      throw new Error('Redis operation binding canonical source schema is invalid.');
    }
    assertRedisOperationBinding(canonical);
    const raw = Object.fromEntries(Object.entries(canonical).filter(([key]) => key !== 'tenantId'));
    if (sha256(canonicalJson(raw)) !== source.source.sourceDigest) {
      throw new Error('Redis operation binding source provenance digest is invalid.');
    }
  } else if (source.targetTable === 'padlet_evidence_claims') {
    const shape = TARGET_RECORD_SHAPES.padlet_evidence_claims;
    if (!hasExactKeys(canonical, shape.required) || source.source.provenance !== 'upstash:padlet:evidence-bindings:v2') throw new Error('Redis claim canonical source schema is invalid.');
    const raw = {
      tupleDigest: canonical.tupleDigest, boardId: canonical.boardId, postId: canonical.postId,
      ownerDigest: canonical.ownerDigest, operationId: canonical.operationId, sourceProvenance: source.source.provenance,
    };
    if (sha256(canonicalJson(raw)) !== source.source.sourceDigest) throw new Error('Redis claim source provenance digest is invalid.');
  } else if (source.targetTable === 'padlet_claim_digest_tombstones') {
    const shape = TARGET_RECORD_SHAPES.padlet_claim_digest_tombstones;
    if (!hasExactKeys(canonical, shape.required, shape.optional ?? [])) throw new Error('Redis tombstone canonical source schema is invalid.');
    if (canonical.kind === 'ORPHAN_V2') {
      if (source.source.provenance !== 'upstash:padlet:evidence-bindings:v2:orphan'
        || source.source.sourceDigest !== sha256(String(canonical.tupleDigest))) throw new Error('Redis orphan source provenance is invalid.');
    } else {
      const raw = { tupleDigest: canonical.tupleDigest, ownerDigest: canonical.ownerDigest, sourceProvenance: canonical.provenance };
      if (canonical.provenance !== source.source.provenance || sha256(canonicalJson(raw)) !== source.source.sourceDigest) {
        throw new Error('Redis tombstone source provenance digest is invalid.');
      }
    }
  } else throw new Error('Redis canonical source kind is unsupported.');
  assertTargetRecordTypes(source.targetTable!, canonical);
  if (canonical.tenantId !== undefined && canonical.tenantId !== manifest.tenantId) invalidManifest();
}

function assertCanonicalTarget(table: string, id: string, canonical: Record<string, unknown>, manifest: LegacyNormalizationManifest): void {
  const target = (manifest.records[table] ?? []).find((row) => expectedManifestTargetId(table, row, manifest) === id);
  if (!target) throw new Error('Mapping canonical source target is missing.');
  const tenantId = manifest.tenantId;
  let expected: Record<string, unknown> | null = null;
  if (table === 'students') expected = { tenantId, studentId: canonical.studentId, name: canonical.name, status: canonical.status };
  else if (table === 'accounts') expected = { tenantId, studentId: canonical.studentId, balance: canonical.balance };
  else if (['products', 'promotions', 'promotion_products', 'tasks', 'task_assignments', 'task_completions'].includes(table)) expected = { tenantId, ...canonical };
  else if (table === 'settings') expected = { tenantId, key: canonical.key, value: canonical.value };
  else if (table === 'task_allowed_students') expected = { tenantId, taskInstanceId: canonical.taskInstanceId, studentId: target.studentId };
  else if (table === 'transactions') expected = canonicalTransactionTarget(canonical, tenantId);
  else if (table === 'transaction_items') expected = canonicalTransactionItemTarget(canonical, target, tenantId);
  else if (table === 'adjustments') expected = { tenantId, adjustmentId: canonical.adjustmentId, transactionId: canonical.transactionId, mode: canonical.mode, requestedAmount: canonical.amount, operatorSnapshot: canonical.operator, legacyAdjustmentId: canonical.adjustmentId };
  else if (['legacy_operation_bindings', 'padlet_evidence_claims'].includes(table)) expected = { ...canonical };
  else if (table === 'padlet_claim_digest_tombstones') expected = { ...canonical };
  if (!expected || !equalJson(expected, target)) throw new Error(`Mapping canonical source does not match exact target projection for ${table}.`);
  if (table === 'task_allowed_students' && (!Array.isArray(canonical.allowedStudentIds)
    || !canonical.allowedStudentIds.includes(target.studentId))) throw new Error('Mapping canonical source does not match exact target projection.');
}

function canonicalTransactionTarget(canonical: Record<string, unknown>, tenantId: string): Record<string, unknown> {
  const status = String(canonical.status);
  const kind = status === 'COMPLETED' || status === 'CANCELLED' ? 'CHECKOUT'
    : status === 'TASK_REWARD' ? 'TASK_REWARD' : status === 'ADMIN_ADJUSTMENT' ? 'ADMIN_ADJUSTMENT' : 'CANCELLATION';
  return {
    tenantId, transactionId: canonical.transactionId, occurredAt: canonical.timestamp,
    studentId: canonical.studentId, studentNameSnapshot: canonical.studentName, kind,
    legacyTotalAmount: canonical.totalAmount,
    balanceDelta: Number(canonical.balanceAfter) - Number(canonical.balanceBefore),
    balanceBefore: canonical.balanceBefore, balanceAfter: canonical.balanceAfter,
    operatorSnapshot: canonical.operator, legacyStatusSnapshot: canonical.status,
    ...(canonical.reversesTransactionId === undefined ? {} : { reversesTransactionId: canonical.reversesTransactionId }),
  };
}

function canonicalTransactionItemTarget(canonical: Record<string, unknown>, target: Readonly<Record<string, unknown>>, tenantId: string): Record<string, unknown> | null {
  if (!Array.isArray(canonical.items)) return null;
  const item = canonical.items.find((candidate) => isPlainRecord(candidate) && candidate.itemId === target.itemId);
  return item ? projectCanonicalTransactionItem(canonical, item, tenantId) : null;
}

function projectCanonicalTransactionItem(canonical: Record<string, unknown>, item: Record<string, unknown>, tenantId: string): Record<string, unknown> | null {
  if (!hasExactKeys(item, ['productId', 'name', 'price', 'quantity', 'subtotal', 'itemId', 'transactionId', 'lineNumber'], ['regularUnitPrice', 'regularTotal', 'totalQuantity', 'paidQuantity', 'freeQuantity', 'finalTotal', 'totalDiscount', 'adjustments', 'appliedPromotions'])) return null;
  const expected: Record<string, unknown> = {
    tenantId, itemId: item.itemId, transactionId: item.transactionId, lineNumber: item.lineNumber,
    productIdSnapshot: item.productId,
    currentProductId: canonical.status === 'ADMIN_ADJUSTMENT' ? null : item.productId,
    productNameSnapshot: item.name, quantity: item.quantity, unitPriceSnapshot: item.price,
    subtotalSnapshot: item.subtotal,
  };
  if (item.regularUnitPrice !== undefined) Object.assign(expected, {
    regularUnitPrice: item.regularUnitPrice, regularTotal: item.regularTotal,
    totalQuantity: item.totalQuantity, paidQuantity: item.paidQuantity, freeQuantity: item.freeQuantity,
    finalTotal: item.finalTotal, totalDiscount: item.totalDiscount,
    adjustmentsSnapshot: item.adjustments, appliedPromotionsSnapshot: item.appliedPromotions,
  });
  return expected;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function invalidManifest(): never {
  throw new Error('Legacy migration manifest is structurally invalid.');
}

async function bindImport(transaction: TenantTransaction, input: LegacyMigrationImportInput): Promise<void> {
  const { rows: tenantRows } = await transaction.execute(sql`SELECT lifecycle FROM tenants WHERE id=${input.tenantId} FOR UPDATE`);
  const tenant = tenantRows[0] as { lifecycle?: string } | undefined;
  if (!tenant || !['DRAFT', 'IMPORTING'].includes(String(tenant.lifecycle))) throw new Error('Tenant lifecycle does not permit migration import.');
  const { rows: jobRows } = await transaction.execute(sql`SELECT status, state_version, source_fingerprint FROM migration_jobs WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} FOR UPDATE`);
  const job = jobRows[0] as { status?: string; state_version?: bigint; source_fingerprint?: string | null } | undefined;
  if (!job || !['VALIDATED', 'IMPORTING'].includes(String(job.status))) throw new Error('Migration job state does not permit import.');
  await assertSoleImportOwner(transaction, input);
  if (job.source_fingerprint && job.source_fingerprint !== input.manifest.sourceFingerprint) throw new Error('Migration source fingerprint changed.');

  await ensureSources(transaction, input);
  const { rows: snapshots } = await transaction.execute(sql`SELECT artifact_digest FROM migration_snapshots WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId} AND phase='PREFLIGHT' AND redacted_manifest->>'bindingKind'='LEGACY_NORMALIZATION_IMPORT' FOR UPDATE`);
  if (snapshots.some((row) => (row as { artifact_digest?: string }).artifact_digest !== input.manifest.manifestDigest)) throw new Error('Migration manifest digest changed.');
  if (snapshots.length === 0) {
    const sourceId = sourceIdFor('SHEET', input.manifest.sourceArtifacts.sheets.digest);
    await transaction.execute(sql`INSERT INTO migration_snapshots (tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES (${input.tenantId},${input.migrationJobId},${sourceId},${`import:${input.manifest.manifestDigest}`},'PREFLIGHT',${input.manifest.manifestDigest},${JSON.stringify({ bindingKind: 'LEGACY_NORMALIZATION_IMPORT', sourceFingerprint: input.manifest.sourceFingerprint, manifestDigest: input.manifest.manifestDigest })}::jsonb,${input.manifest.sourceRecords.length})`);
  }
  if (!job.source_fingerprint || job.status === 'VALIDATED') {
    await transaction.execute(sql`UPDATE migration_jobs SET source_fingerprint=${input.manifest.sourceFingerprint}, status='IMPORTING', state_version=state_version+1, updated_at=now() WHERE tenant_id=${input.tenantId} AND job_id=${input.migrationJobId}`);
  }
  if (tenant.lifecycle === 'DRAFT') await transaction.execute(sql`UPDATE tenants SET lifecycle='IMPORTING', updated_at=now() WHERE id=${input.tenantId}`);
}

async function ensureSources(transaction: TenantTransaction, input: LegacyMigrationImportInput): Promise<void> {
  const artifacts = [
    { kind: 'SHEET' as const, provider: 'GOOGLE_SHEETS', digest: input.manifest.sourceArtifacts.sheets.digest, external: input.manifest.sourceArtifacts.sheets.spreadsheetIdDigest, schemaVersion: input.manifest.metadata.sheetSchemaVersion },
    ...(input.manifest.sourceArtifacts.redis ? [{ kind: 'REDIS' as const, provider: 'LEGACY_REDIS_BRIDGE', digest: input.manifest.sourceArtifacts.redis.digest, external: input.manifest.sourceArtifacts.redis.digest, schemaVersion: null }] : []),
  ];
  for (const artifact of artifacts) {
    const sourceId = sourceIdFor(artifact.kind, artifact.digest);
    const { rows: existing } = await transaction.execute(sql`SELECT job_id,provider,external_source_id,source_fingerprint,schema_version FROM migration_sources WHERE tenant_id=${input.tenantId} AND source_id=${sourceId} FOR UPDATE`);
    if (existing.length) {
      const row = existing[0] as Record<string, unknown>;
      if (row.job_id !== input.migrationJobId || row.provider !== artifact.provider || row.external_source_id !== artifact.external || row.source_fingerprint !== artifact.digest || Number(row.schema_version ?? 0) !== Number(artifact.schemaVersion ?? 0)) throw new Error('Migration source binding conflicts with persisted source.');
      continue;
    }
    await transaction.execute(sql`INSERT INTO migration_sources (tenant_id,job_id,source_id,provider,external_source_id,schema_version,source_fingerprint) VALUES (${input.tenantId},${input.migrationJobId},${sourceId},${artifact.provider},${artifact.external},${artifact.schemaVersion},${artifact.digest})`);
  }
}

async function assertBoundImport(transaction: TenantTransaction, input: LegacyMigrationImportInput,
  readOnlyReconciliation = false): Promise<void> {
  const { rows } = await transaction.execute(sql`SELECT t.lifecycle,j.status,j.source_fingerprint,(SELECT count(*)::int FROM migration_snapshots s WHERE s.tenant_id=j.tenant_id AND s.job_id=j.job_id AND s.phase='PREFLIGHT' AND s.artifact_digest=${input.manifest.manifestDigest} AND s.redacted_manifest->>'bindingKind'='LEGACY_NORMALIZATION_IMPORT') AS manifest_count FROM tenants t JOIN migration_jobs j ON j.tenant_id=t.id WHERE t.id=${input.tenantId} AND j.job_id=${input.migrationJobId} FOR UPDATE OF t,j`);
  const row = rows[0] as Record<string, unknown> | undefined;
  // Import writes retain the strict IMPORTING-only default. Only the read-only
  // audit can inspect a preparatory state; this flag is not exported to callers.
  const statuses = readOnlyReconciliation ? ['IMPORTING', 'RECONCILING', 'READY'] : ['IMPORTING'];
  if (!row || row.lifecycle !== 'IMPORTING' || !statuses.includes(String(row.status)) || row.source_fingerprint !== input.manifest.sourceFingerprint || Number(row.manifest_count) !== 1) throw new Error('Migration import binding is no longer valid.');
  await assertSoleImportOwner(transaction, input);
}

async function assertSoleImportOwner(transaction: TenantTransaction, input: LegacyMigrationImportInput): Promise<void> {
  const { rows } = await transaction.execute(sql`SELECT job_id,status FROM migration_jobs WHERE tenant_id=${input.tenantId} ORDER BY job_id FOR UPDATE`);
  if (rows.some((candidate) => {
    const row = candidate as { job_id?: unknown; status?: unknown };
    return row.job_id !== input.migrationJobId && !['FAILED', 'ABORTED'].includes(String(row.status));
  })) throw new Error('Another migration job is the nonterminal import owner for this tenant.');
}

function projectTargets(manifest: LegacyNormalizationManifest, tenantId: string): WorkRecord[] {
  const result: WorkRecord[] = [];
  const taskNames = new Map((manifest.records.tasks ?? []).map((task) => [String(task.taskId), String(task.title)]));
  const settings = manifest.records.settings ?? [];
  if (settings.length) {
    const values = Object.fromEntries(settings.map((record) => [String(record.key), record.value]));
    result.push({ table: 'tenant_settings', id: tenantId, value: { tenant_id: tenantId, schema_version: Number(values.schemaVersion), settings: values, version: 1 } });
  }
  for (const table of TABLE_ORDER) {
    if (table === 'settings' || DEFERRED_TABLES.has(table)) continue;
    const descriptor = DESCRIPTORS[table];
    for (const row of dependencyOrder(table, historicalOrder(table, manifest.records[table] ?? [], manifest))) {
      const projectedRow = table === 'task_completions'
        ? { ...row, taskNameSnapshot: taskNames.get(String(row.taskId)) }
        : { ...row };
      if (table === 'task_completions' && !nonBlank(projectedRow.taskNameSnapshot)) invalidManifest();
      const projected = descriptor.project(projectedRow, tenantId);
      // Original schema/status/note/IDs remain unchanged in canonical staging.
      // Workbook schema is source metadata, not the operational schedule codec.
      if (table === 'tasks') Object.assign(projected, { schedule_schema_version: 1 });
      if (table === 'task_assignments') Object.assign(projected, { schema_version: 1, note: null });
      if (table === 'task_completions' && row.source === 'CARRY_FORWARD') {
        Object.assign(projected, { schema_version: 1, status: 'COMPLETED', created_at: row.timestamp,
          note: row.note === '' ? null : row.note });
      }
      const value = completeProjected(table, projected);
      if (Object.values(value).some((item) => item === undefined)) invalidManifest();
      result.push({ table, id: targetId(table, row), value });
    }
  }
  const unique = new Map<string, WorkRecord>();
  for (const record of result) {
    const key = `${record.table}\0${record.id}`;
    const prior = unique.get(key);
    if (prior && !equalJson(prior.value, record.value)) throw new Error('Manifest projects duplicate conflicting targets.');
    unique.set(key, record);
  }
  assertProjectedGraph(result);
  return [...unique.values()];
}

// Inventory: 0001-0012. Tenant/job/source FKs refer to trusted rows locked by
// bindImport; generated sequences cannot collide within this projection. Global
// claim registry inserts are deliberately deferred, never published here.
function assertProjectedGraph(work: readonly WorkRecord[]): void {
  const byTable = new Map<string, Record<string, unknown>[]>();
  for (const record of work) {
    const table = DESCRIPTORS[record.table]?.physicalTable ?? record.table;
    const rows = byTable.get(table) ?? [];
    rows.push(record.value); byTable.set(table, rows);
  }
  const unique = (table: string, columns: string[]) => {
    const keys = new Set<string>();
    for (const row of byTable.get(table) ?? []) {
      if (columns.some((column) => row[column] === null || row[column] === undefined)) continue;
      const key = canonicalJson(columns.map((column) => row[column]));
      if (keys.has(key)) throw new Error(`Projected graph violates ${table} unique constraint.`);
      keys.add(key);
    }
  };
  for (const descriptor of Object.values(DESCRIPTORS)) unique(descriptor.physicalTable, [...descriptor.idColumns]);
  for (const [table, columns] of [
    ['tasks', ['tenant_id', 'task_id']], ['promotion_products', ['tenant_id', 'promotion_id', 'product_id']],
    ['transaction_items', ['tenant_id', 'transaction_id', 'line_number']], ['adjustments', ['tenant_id', 'transaction_id']],
    ['transactions', ['tenant_id', 'operation_id']], ['task_completions', ['tenant_id', 'operation_id']],
  ] as const) unique(table, [...columns]);
  const references: readonly (readonly [string, string, string, string])[] = [
    ['accounts', 'student_id', 'students', 'student_id'],
    ['promotion_products', 'promotion_id', 'promotions', 'promotion_id'], ['promotion_products', 'product_id', 'products', 'product_id'],
    ['tasks', 'prerequisite_task_instance_id', 'tasks', 'task_instance_id'],
    ['task_allowed_students', 'task_instance_id', 'tasks', 'task_instance_id'], ['task_allowed_students', 'student_id', 'students', 'student_id'],
    ['task_assignments', 'task_instance_id', 'tasks', 'task_instance_id'], ['task_assignments', 'student_id', 'students', 'student_id'],
    ['task_assignments', 'previous_assignment_id', 'task_assignments', 'assignment_id'],
    ['task_assignments', 'admin_operation_id', 'operations', 'operation_id'],
    ['transactions', 'student_id', 'students', 'student_id'], ['transactions', 'reverses_transaction_id', 'transactions', 'transaction_id'],
    ['transaction_items', 'transaction_id', 'transactions', 'transaction_id'], ['transaction_items', 'current_product_id', 'products', 'product_id'],
    ['adjustments', 'transaction_id', 'transactions', 'transaction_id'],
    ['task_completions', 'task_instance_id', 'tasks', 'task_instance_id'], ['task_completions', 'student_id', 'students', 'student_id'],
    ['task_completions', 'assignment_id', 'task_assignments', 'assignment_id'], ['task_completions', 'transaction_id', 'transactions', 'transaction_id'],
    ['task_completions', 'admin_operation_id', 'operations', 'operation_id'],
    ['task_completions', 'operation_id', 'operations', 'operation_id'],
  ];
  for (const [table, column, parent, parentColumn] of references) {
    const ids = new Set((byTable.get(parent) ?? []).map((row) => canonicalJson([row.tenant_id, row[parentColumn]])));
    for (const row of byTable.get(table) ?? []) {
      if (row[column] !== null && row[column] !== undefined && !ids.has(canonicalJson([row.tenant_id, row[column]]))) {
        throw new Error(`Projected graph contains an unresolved ${table}.${column} reference.`);
      }
    }
  }
}

// Exact identity sequence values and audit timestamps are generated by PostgreSQL
// and excluded from row equality; semantic relative event order is checked separately.
// Every material version, state, nullable binding, deletion, and availability column is explicit.
function completeProjected(table: string, value: Record<string, unknown>): Record<string, unknown> {
  const defaults: Record<string, Record<string, unknown>> = {
    students: { version: 1, deleted_at: null },
    accounts: { version: 1 },
    products: { version: 1, deleted_at: null },
    promotions: { version: 1, deleted_at: null },
    tasks: { available_until: null, prerequisite_task_instance_id: null, padlet_board_id: null, version: 1, deleted_at: null },
    task_assignments: { admin_operation_id: null, admin_operation_hash: null },
    transactions: { reverses_transaction_id: null, operation_id: null, operation_hash: null, schema_version: 1 },
    transaction_items: {
      regular_unit_price: null, regular_total: null, total_quantity: null, paid_quantity: null,
      free_quantity: null, final_total: null, total_discount: null,
      adjustments_snapshot: null, applied_promotions_snapshot: null,
    },
    task_completions: {
      transaction_id: null, admin_operation_id: null, admin_operation_hash: null,
      evidence_provider: null, evidence_board_id: null, evidence_post_id: null,
      evidence_created_at: null, evidence_author_full_name: null,
    },
    legacy_operation_bindings: {
      status: 'PENDING', result_snapshot: null, failure_code: null, attempt_count: 1,
      started_at: null, finished_at: null,
    },
  };
  return { ...(defaults[table] ?? {}), ...value };
}

// Generated event-order inventory (0002): assignments are physical append order
// (sheetsRows.parseTaskAssignmentRows; database taskCycleQueries provenance).
// Completion/materialization consumers require chronology; presentation ties in
// sheetsRepository and database taskCycleQueries preserve ascending source rows.
// Transactions likewise present timestamp DESC / sequence ASC (transactionQueries).
// inventory_ledger has a sequence but no normalized/imported targets. Other IDs
// and audit sequences have no ordering contract here and remain unchanged.
const HISTORICAL_EVENTS: Readonly<Record<string, { tab: string; time: string | null }>> = {
  task_assignments: { tab: 'TaskAssignments', time: null },
  task_completions: { tab: 'TaskCompletions', time: 'timestamp' },
  transactions: { tab: 'Transactions', time: 'occurredAt' },
};

function historicalOrder(table: string, rows: readonly Readonly<Record<string, unknown>>[], manifest: LegacyNormalizationManifest): readonly Readonly<Record<string, unknown>>[] {
  const event = HISTORICAL_EVENTS[table];
  if (!event) return rows;
  const rowNumbers = new Map<string, number>();
  for (const record of manifest.sourceRecords) {
    if (record.targetTable !== table) continue;
    if (record.source.kind !== 'SHEET' || record.source.tab !== event.tab || typeof record.targetId !== 'string'
      || rowNumbers.has(record.targetId)) throw new Error(`Invalid historical event source provenance for ${table}.`);
    rowNumbers.set(record.targetId, record.source.rowNumber);
  }
  if (rows.some((row) => !rowNumbers.has(targetId(table, row)))) throw new Error(`Missing historical event source provenance for ${table}.`);
  return [...rows].sort((left, right) => (event.time ? Date.parse(String(left[event.time])) - Date.parse(String(right[event.time])) : 0)
    || rowNumbers.get(targetId(table, left))! - rowNumbers.get(targetId(table, right))!);
}

async function assertHistoricalOrder(transaction: TenantTransaction, tenantId: string, work: readonly WorkRecord[]): Promise<void> {
  // Under the tenant/job locks, existing rows must be a prefix of the intended
  // append order. Merely sorting the surviving subset would permit a missing
  // earlier event to be appended after its persisted successor on resume.
  // Exact sequence values/gaps are immaterial; their relative order is not.
  for (const table of Object.keys(HISTORICAL_EVENTS)) {
    const expected = work.filter((record) => record.table === table);
    const idColumn = DESCRIPTORS[table].idColumns[1];
    const { rows } = await transaction.execute(sql`SELECT ${sql.identifier(idColumn)} AS id,event_sequence::text AS sequence FROM ${sql.identifier(table)} WHERE tenant_id=${tenantId} ORDER BY event_sequence FOR UPDATE`);
    let previous = BigInt(0);
    for (const [index, entry] of rows.entries()) {
      const row = entry as { id: unknown; sequence: unknown };
      const sequence = typeof row.sequence === 'string' && /^[0-9]+$/.test(row.sequence) ? BigInt(row.sequence) : BigInt(0);
      if (row.id !== expected[index]?.id || sequence <= previous || sequence > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Target conflict: historical event order for ${table}.`);
      previous = sequence;
    }
  }
}

function dependencyOrder(table: string, rows: readonly Readonly<Record<string, unknown>>[]): readonly Readonly<Record<string, unknown>>[] {
  const shape = table === 'tasks'
    ? { id: 'taskInstanceId', parent: 'prerequisiteTaskInstanceId' }
    : table === 'task_assignments'
      ? { id: 'assignmentId', parent: 'previousAssignmentId' }
      : table === 'transactions'
        ? { id: 'transactionId', parent: 'reversesTransactionId' }
        : null;
  if (!shape) return rows;

  const byId = new Map<string, Readonly<Record<string, unknown>>>();
  const children = new Map<string, string[]>();
  const indegrees = new Map<string, number>();
  for (const row of rows) {
    const id = String(row[shape.id]);
    if (byId.has(id)) throw new Error(`Manifest contains duplicate ${table} IDs.`);
    byId.set(id, row);
    indegrees.set(id, 0);
  }
  for (const row of rows) {
    const id = String(row[shape.id]);
    const parent = row[shape.parent];
    if (parent === null || parent === undefined) continue;
    if (typeof parent !== 'string' || !byId.has(parent)) throw new Error(`Manifest contains an unresolved ${table} parent dependency.`);
    indegrees.set(id, 1);
    const dependents = children.get(parent) ?? [];
    dependents.push(id);
    children.set(parent, dependents);
  }

  const ready: string[] = [];
  for (const row of rows) {
    const id = String(row[shape.id]);
    if (indegrees.get(id) === 0) ready.push(id);
  }
  const ordered: Readonly<Record<string, unknown>>[] = [];
  const historicalRank = HISTORICAL_EVENTS[table] ? new Map(rows.map((row, index) => [String(row[shape.id]), index])) : null;
  for (let cursor = 0; cursor < ready.length; cursor += 1) {
    const id = ready[cursor];
    ordered.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) {
      const next = (indegrees.get(child) ?? 0) - 1;
      indegrees.set(child, next);
      if (next === 0) {
        // A newly ready historical child must compete with all ready events,
        // not be postponed behind newer roots by a FIFO topological traversal.
        let position = ready.length;
        if (historicalRank) {
          let low = cursor + 1; let high = ready.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (historicalRank.get(ready[middle])! < historicalRank.get(child)!) low = middle + 1;
            else high = middle;
          }
          position = low;
        }
        ready.splice(position, 0, child);
      }
    }
  }
  if (ordered.length !== rows.length) throw new Error(`Manifest contains a ${table} dependency cycle.`);
  return ordered;
}

function targetId(table: string, row: Readonly<Record<string, unknown>>): string {
  const keys: Record<string, string> = { students: 'studentId', accounts: 'studentId', products: 'productId', promotions: 'promotionId', promotion_products: 'promotionProductId', tasks: 'taskInstanceId', task_assignments: 'assignmentId', transactions: 'transactionId', transaction_items: 'itemId', adjustments: 'adjustmentId', task_completions: 'completionId', legacy_operation_bindings: 'operationId', padlet_evidence_claims: 'tupleDigest', padlet_claim_digest_tombstones: 'tupleDigest' };
  if (table === 'task_allowed_students') return `${String(row.taskInstanceId)}\0${String(row.studentId)}`;
  return String(row[keys[table]]);
}

function projectSourceRecords(manifest: LegacyNormalizationManifest, tenantId: string, jobId: string): SourceRecord[] {
  const sourcesByDigest = new Map<string, typeof manifest.sourceRecords[number][]>();
  for (const record of manifest.sourceRecords) {
    const digest = record.source.kind === 'SHEET' ? record.source.rowHash : record.source.sourceDigest;
    const group = sourcesByDigest.get(digest) ?? [];
    group.push(record);
    sourcesByDigest.set(digest, group);
  }
  const mappedDigests = new Set<string>();
  const result: SourceRecord[] = [];
  for (const mapping of manifest.mappings) {
    mappedDigests.add(mapping.sourceDigest);
    const candidates = sourcesByDigest.get(mapping.sourceDigest) ?? [];
    const source = candidates.find((record) => record.targetTable === mapping.targetTable && record.targetId === mapping.targetId)
      ?? candidates[0];
    if (!source) throw new Error('Manifest mapping has no source record.');
    result.push(sourceCheckpoint(source, tenantId, jobId, mapping.targetTable, mapping.targetId));
  }
  for (const source of manifest.sourceRecords) {
    const digest = source.source.kind === 'SHEET' ? source.source.rowHash : source.source.sourceDigest;
    if (!mappedDigests.has(digest)) result.push(sourceCheckpoint(source, tenantId, jobId, null, null));
  }
  const recordIds = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const checkpoint of result) {
    const key = canonicalJson([checkpoint.sourceId, checkpoint.sourceCollection, checkpoint.sourceRecordId]);
    if (recordIds.has(checkpoint.recordId) || sourceKeys.has(key)) throw new Error('Projected source checkpoint violates a physical unique constraint.');
    recordIds.add(checkpoint.recordId); sourceKeys.add(key);
  }
  return result;
}

function sourceCheckpoint(
  record: LegacyNormalizationManifest['sourceRecords'][number],
  tenantId: string,
  jobId: string,
  intendedTable: string | null,
  intendedId: string | null,
): SourceRecord {
  const sourceKind = record.source.kind;
  const sourceId = sourceIdFor(sourceKind, record.source.artifactDigest);
  const sourceCollection = sourceKind === 'SHEET' ? record.source.tab : record.source.provenance;
  const sourceRecordId = sourceKind === 'SHEET' ? String(record.source.rowNumber) : record.source.sourceDigest;
  const sourceRowHash = sourceKind === 'SHEET' ? record.source.rowHash : record.source.sourceDigest;
  const checkpoint = intendedTable === null ? null : {
    intendedTargetTable: intendedTable,
    intendedTargetId: intendedId,
    publication: DEFERRED_TABLES.has(intendedTable) ? 'DEFERRED' : 'IMPORTED',
  };
  const identity = `${tenantId}\0${jobId}\0${sourceId}\0${sourceCollection}\0${sourceRecordId}\0${intendedTable ?? 'unmapped'}\0${intendedId ?? ''}`;
  const canonicalRecord = record.canonicalRecord
    ? { ...record.canonicalRecord, ...(checkpoint ? { migrationCheckpoint: checkpoint } : {}) }
    : checkpoint ? { migrationCheckpoint: checkpoint } : null;
  return {
    recordId: `import:${sha256(identity)}`,
    sourceId,
    // Frame the literal collection with a safe prefix and fixed-width suffix:
    // raw tab whitespace/colons stay unambiguous without violating DB btrim IDs.
    // Only a constant-size ASCII prefix is added; provenance and record IDs are unchanged.
    sourceCollection: `source:${sourceCollection}:${sha256(`${intendedTable ?? 'unmapped'}\0${intendedId ?? ''}`).slice(0, 16)}`,
    sourceRecordId,
    sourceRowNumber: sourceKind === 'SHEET' ? record.source.rowNumber : null,
    sourceRowHash,
    redactedRecord: { ...record.redactedSourceRecord },
    canonicalRecord,
    targetTable: intendedTable === 'settings' ? 'tenant_settings' : intendedTable,
    targetId: intendedTable === 'settings' ? tenantId : intendedId,
    warningDetails: [...record.warningCodes],
    errorDetails: [...record.errorCodes],
    deferred: intendedTable !== null && DEFERRED_TABLES.has(intendedTable),
  };
}

async function stageSourceRecord(transaction: TenantTransaction, input: LegacyMigrationImportInput, record: SourceRecord): Promise<void> {
  const { rows } = await transaction.execute(sql`SELECT job_id,source_id,source_collection,source_record_id,source_row_number,source_row_hash,redacted_record,canonical_record,mapping_status,target_table,target_id,warning_details,error_details FROM migration_source_records WHERE tenant_id=${input.tenantId} AND record_id=${record.recordId} FOR UPDATE`);
  if (rows.length) {
    const row = rows[0] as Record<string, unknown>;
    const identical = row.job_id === input.migrationJobId && row.source_id === record.sourceId && row.source_collection === record.sourceCollection && row.source_record_id === record.sourceRecordId && Number(row.source_row_number ?? 0) === Number(record.sourceRowNumber ?? 0) && row.source_row_hash === record.sourceRowHash && equalJson(row.redacted_record, record.redactedRecord) && equalJson(row.canonical_record, record.canonicalRecord) && equalJson(row.warning_details, record.warningDetails) && equalJson(row.error_details, record.errorDetails) && ((row.mapping_status === 'STAGED' && row.target_table === null && row.target_id === null) || (!record.deferred && (record.targetTable ? row.mapping_status === 'IMPORTED' && row.target_table === record.targetTable && row.target_id === record.targetId : row.mapping_status === 'SKIPPED' && row.target_table === null && row.target_id === null)));
    if (!identical) throw new Error('Persisted migration source record conflicts with manifest.');
    return;
  }
  await transaction.execute(sql`INSERT INTO migration_source_records (tenant_id,job_id,source_id,record_id,source_collection,source_record_id,source_row_number,source_row_hash,redacted_record,canonical_record,warning_details,error_details) VALUES (${input.tenantId},${input.migrationJobId},${record.sourceId},${record.recordId},${record.sourceCollection},${record.sourceRecordId},${record.sourceRowNumber},${record.sourceRowHash},${JSON.stringify(record.redactedRecord)}::jsonb,${record.canonicalRecord === null ? null : JSON.stringify(record.canonicalRecord)}::jsonb,${JSON.stringify(record.warningDetails)}::jsonb,${JSON.stringify(record.errorDetails)}::jsonb)`);
}

async function finishSourceRecord(transaction: TenantTransaction, input: LegacyMigrationImportInput, record: SourceRecord): Promise<void> {
  if (record.deferred) return;
  await transaction.execute(record.targetTable
    ? sql`UPDATE migration_source_records SET mapping_status='IMPORTED',target_table=${record.targetTable},target_id=${record.targetId} WHERE tenant_id=${input.tenantId} AND record_id=${record.recordId} AND mapping_status='STAGED'`
    : sql`UPDATE migration_source_records SET mapping_status='SKIPPED' WHERE tenant_id=${input.tenantId} AND record_id=${record.recordId} AND mapping_status='STAGED'`);
}

async function insertIdenticalOrFail(transaction: TenantTransaction, record: WorkRecord): Promise<void> {
  const descriptor = record.table === 'tenant_settings'
    ? { physicalTable: 'tenant_settings', idColumns: ['tenant_id'] as const }
    : DESCRIPTORS[record.table];
  const columns = Object.keys(record.value);
  const idValues = descriptor.idColumns.map((column) => record.value[column]);
  const where = sql.join(descriptor.idColumns.map((column, index) => sql`${sql.identifier(column)}=${idValues[index]}`), sql` AND `);
  const { rows: existing } = await transaction.execute(sql`SELECT ${sql.join(columns.map((column) => sql.identifier(column)), sql`, `)} FROM ${sql.identifier(descriptor.physicalTable)} WHERE ${where} FOR UPDATE`);
  if (existing.length) {
    const actual = existing[0] as Record<string, unknown>;
    if (!columns.every((column) => equalDatabaseValue(actual[column], record.value[column]))) throw new Error(`Target conflict for ${record.table}.`);
    return;
  }
  const values = columns.map((column) => record.value[column]);
  await transaction.execute(sql`INSERT INTO ${sql.identifier(descriptor.physicalTable)} (${sql.join(columns.map((column) => sql.identifier(column)), sql`, `)}) VALUES (${sql.join(values.map(sqlValue), sql`, `)})`);
}

function sqlValue(value: unknown) {
  if (value === null) return sql`NULL`;
  if (Array.isArray(value) || isRecord(value)) return sql`${JSON.stringify(value)}::jsonb`;
  return sql`${value}`;
}

function equalDatabaseValue(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date && typeof expected === 'string') return actual.toISOString() === expected;
  if (typeof actual === 'bigint' && typeof expected === 'number') return actual === BigInt(expected);
  if (typeof actual === 'string' && typeof expected === 'number') return Number(actual) === expected;
  if ((Array.isArray(actual) || isRecord(actual)) && (Array.isArray(expected) || isRecord(expected))) return equalJson(actual, expected);
  return actual === expected;
}

function equalJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function sourceIdFor(kind: 'SHEET' | 'REDIS', digest: string): string {
  return `${kind.toLowerCase()}:${digest}`;
}
function batches<T>(values: readonly T[], size: number): readonly T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}
