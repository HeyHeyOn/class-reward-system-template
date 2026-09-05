import type { SheetsSnapshot } from './sheetsSnapshot';
import type { RedisClaimSnapshot } from './redisClaimSnapshot';
import { deepFreeze } from './sensitiveRedaction';
import { normalizeLegacySnapshots, type Diagnostic, type NormalizedSourceRecord, type SourceMapping } from './normalize';
import {
  assertManifestInputShape, assertNormalizationInput, canonicalJson, clonePlainData, compareCodeUnits, sha256,
} from './validators';

export type LegacyNormalizationManifest = Readonly<{
  manifestVersion: 1;
  status: 'READY_FOR_IMPORT' | 'BLOCKED';
  tenantId: string;
  migrationJobId: string;
  sourceFingerprint: string;
  sourceArtifacts: Readonly<{
    sheets: Readonly<{ digest: string; spreadsheetIdDigest: string; revisionDigest: string; credentialHashes: Readonly<Record<string, string>> }>;
    redis?: Readonly<{ digest: string; revisionDigest: string }>;
  }>;
  metadata: Readonly<{ sheetSchemaVersion: 1 | 2 | 3; classTimeZone: string }>;
  records: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
  sourceRecords: readonly NormalizedSourceRecord[];
  mappings: readonly SourceMapping[];
  warnings: readonly Diagnostic[];
  blockingConflicts: readonly Diagnostic[];
  quarantines: readonly NormalizedSourceRecord[];
  manifestDigest: string;
}>;

export function createLegacyNormalizationManifest(input: Readonly<{
  tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot;
}>): LegacyNormalizationManifest {
  try {
    assertNormalizationInput(input);
    assertManifestInputShape(input);
  } catch (error) {
    if (error instanceof Error && [
      'Legacy migration input is structurally invalid.',
      'Legacy migration input exceeds normalization bounds.',
    ].includes(error.message)) throw error;
    throw new Error('Legacy migration input is structurally invalid.');
  }
  const normalized = normalizeLegacySnapshots(input);
  const classTimeZoneRecord = normalized.records.settings?.find((record) => record.key === 'classTimeZone');
  const classTimeZone = typeof classTimeZoneRecord?.value === 'string' ? classTimeZoneRecord.value : '';
  const sourceFingerprint = semanticFingerprint(normalized);
  const artifact = {
    manifestVersion: 1 as const,
    status: (normalized.blockingConflicts.length || normalized.sourceRecords.some((record) => record.mappingStatus === 'QUARANTINED') ? 'BLOCKED' : 'READY_FOR_IMPORT') as 'BLOCKED' | 'READY_FOR_IMPORT',
    tenantId: input.tenantId,
    migrationJobId: input.migrationJobId,
    sourceFingerprint,
    sourceArtifacts: {
      sheets: { digest: input.sheets.digest, spreadsheetIdDigest: sha256(input.sheets.spreadsheetId), revisionDigest: sha256(input.sheets.sourceRevision), credentialHashes: { ...input.sheets.credentialHashes } },
      ...(input.redis ? { redis: { digest: input.redis.digest, revisionDigest: sha256(input.redis.sourceRevision) } } : {}),
    },
    metadata: { sheetSchemaVersion: input.sheets.schemaVersion, classTimeZone },
    records: normalized.records,
    sourceRecords: normalized.sourceRecords,
    mappings: normalized.mappings,
    warnings: normalized.warnings,
    blockingConflicts: normalized.blockingConflicts,
    quarantines: normalized.sourceRecords.filter((record) => record.mappingStatus === 'QUARANTINED'),
  };
  const encoded = canonicalJson(artifact);
  if (Buffer.byteLength(encoded, 'utf8') > 8_000_000) throw new Error('Legacy migration output exceeds normalization bounds.');
  return deepFreeze(clonePlainData({ ...artifact, manifestDigest: sha256(encoded) }));
}

type JobScopedTargetTable = 'legacy_operation_bindings' | 'padlet_evidence_claims' | 'transaction_items';
type JobScopedTargetIdProjection = Readonly<{
  projection: 'JOB_SCOPED_TARGET_ID';
  targetTable: JobScopedTargetTable;
}>;

const JOB_SCOPED_TARGET_TABLES = new Set<JobScopedTargetTable>([
  'legacy_operation_bindings', 'padlet_evidence_claims', 'transaction_items',
]);

function semanticFingerprint(normalized: ReturnType<typeof normalizeLegacySnapshots>): string {
  const records = Object.fromEntries(Object.entries(normalized.records).map(([table, rows]) => [
    table,
    rows.map((row) => semanticTargetRecord(table, row))
      .sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right))),
  ]));
  const sourceRecords = normalized.sourceRecords.map((record) => ({
    source: record.source.kind === 'SHEET'
      ? { kind: record.source.kind, tab: record.source.tab }
      : { kind: record.source.kind, provenance: record.source.provenance },
    redactedSourceRecord: record.redactedSourceRecord,
    canonicalRecord: semanticSourceCanonicalRecord(record),
    mappingStatus: record.mappingStatus,
    targetTable: record.targetTable ?? null,
    targetId: record.targetTable && isJobScopedTargetTable(record.targetTable)
      ? jobScopedTargetId(record.targetTable)
      : record.targetId ?? null,
    warningCodes: record.warningCodes,
    errorCodes: record.errorCodes,
  })).sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));
  const mappings = normalized.mappings
    .map(({ targetTable, targetId, status }) => ({
      targetTable,
      targetId: isJobScopedTargetTable(targetTable) ? jobScopedTargetId(targetTable) : targetId,
      status,
    }))
    .sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));
  const diagnostics = (items: readonly Diagnostic[]) => items
    .map(({ code, path }) => ({ code, path: path.replace(/\[[0-9]+\]/g, '[]') }))
    .sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));
  return sha256(canonicalJson({
    records,
    sourceRecords,
    mappings,
    warnings: diagnostics(normalized.warnings),
    blockingConflicts: diagnostics(normalized.blockingConflicts),
  }));
}

function semanticTargetRecord(table: string, record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (table === 'transaction_items') {
    return { ...record, itemId: jobScopedTargetId('transaction_items') };
  }
  if (table === 'padlet_evidence_claims') return withoutClaimProvenances(record);
  return record;
}

function semanticSourceCanonicalRecord(record: NormalizedSourceRecord): Readonly<Record<string, unknown>> | null {
  const canonicalRecord = record.canonicalRecord;
  if (!canonicalRecord) return null;
  if (record.source.kind === 'SHEET' && record.source.tab === 'Transactions'
    && Array.isArray(canonicalRecord.items)) {
    return {
      ...canonicalRecord,
      items: canonicalRecord.items.map((item) => item !== null && typeof item === 'object' && !Array.isArray(item)
        ? { ...(item as Record<string, unknown>), itemId: jobScopedTargetId('transaction_items') }
        : item),
    };
  }
  if (record.targetTable === 'padlet_evidence_claims') return withoutClaimProvenances(canonicalRecord);
  return canonicalRecord;
}

function withoutClaimProvenances(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const semanticRecord = { ...record };
  delete semanticRecord.provenances;
  return semanticRecord;
}

function isJobScopedTargetTable(table: string): table is JobScopedTargetTable {
  return JOB_SCOPED_TARGET_TABLES.has(table as JobScopedTargetTable);
}

function jobScopedTargetId(targetTable: JobScopedTargetTable): JobScopedTargetIdProjection {
  return { projection: 'JOB_SCOPED_TARGET_ID', targetTable };
}