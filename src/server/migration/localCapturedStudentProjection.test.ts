// @vitest-environment node
// Pure synthetic captures/readback COPIES. No DB, stage callback or operational source.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { verifyLocalCapturedSourceCoverage, type CapturedSourceCoverageInput } from './localCapturedSourceCoverage';
import { inspectLocalPointerPreparationEnvelopes } from './localPointerCheckedPreparation';
import { inspectLocalFullDeltaPreparationEnvelopes } from './localFullDeltaCheckedPreparation';
import { LocalCapturedStudentProjectionError, verifyLocalCapturedStudentProjection } from './localCapturedStudentProjection';

vi.mock('server-only', () => ({}));
const TENANT = '10000000-0000-4000-8000-000000000019';
const JOB = '20000000-0000-4000-8000-000000000019';
const OTHER = '10000000-0000-4000-8000-000000000020';
const AT = '2026-09-01T00:00:00.000Z';
const HEADERS = ['studentId', 'name', 'balance', 'status'];
const RAW = [['S1', 'Synthetic Alice', '100', 'ACTIVE'], ['S2', 'Synthetic Bob', '-7', 'INACTIVE']];
// Independent, literal oracle. Never obtained from the normalizer's output.
const STUDENTS = [{ tenantId: TENANT, studentId: 'S1', name: 'Synthetic Alice', status: 'ACTIVE' },
  { tenantId: TENANT, studentId: 'S2', name: 'Synthetic Bob', status: 'INACTIVE' }];
const ACCOUNTS = [{ tenantId: TENANT, studentId: 'S1', balance: 100 }, { tenantId: TENANT, studentId: 'S2', balance: -7 }];
type Input = CapturedSourceCoverageInput;
type Draft = { -readonly [K in keyof LegacyNormalizationManifest]: LegacyNormalizationManifest[K] };
type Plan = Parameters<typeof inspectLocalPointerPreparationEnvelopes>[1]['plan'];
type RejectionStage = 'INPUT_BOUNDARY' | 'POINTER_BOUNDARY' | 'STUDENT_PROJECTION';
const flags = { scope: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTING_ONLY', authority: 'NONAUTHORITY',
  complete: false, activationAllowed: false, exclusion: 'NOT_PROVEN', fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', preRedactionInventory: 'NOT_OBSERVED',
  canonicalBusinessValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'STUDENTS_ONLY',
  binding: 'CONTENT_DIGESTS_ONLY', sourceAuthenticity: 'NOT_PROVEN', semanticFingerprintValidation: 'NOT_PERFORMED' };
const evidence: Array<Record<string, unknown>> = [];
const files = ['localCapturedSourceCoverage.ts', 'localPointerCheckedPreparation.ts', 'localFullDeltaCheckedPreparation.ts',
  'localFullCategoryDeltaCoverage.ts', 'normalize.ts', 'importer.ts', 'validators.ts'];
const fileHash = (file: string) => createHash('sha256').update(readFileSync(`src/server/migration/${file}`)).digest('hex');
const beforeHashes = Object.fromEntries(files.map((file) => [file, fileHash(file)]));

afterAll(() => {
  const afterHashes = Object.fromEntries(files.map((file) => [file, fileHash(file)]));
  expect(afterHashes).toEqual(beforeHashes);
  console.log('STUDENT_PROJECTION_EVIDENCE ' + JSON.stringify({ evidence, beforeHashes, afterHashes,
    implementationHash: fileHash('localCapturedStudentProjection.ts'), testHash: fileHash('localCapturedStudentProjection.test.ts'),
    actualDatabaseExecuted: false, wrapperTransactionExecuted: false, liveSourceAccessed: false }));
});

async function fixture(rows = RAW, options: { version?: 1 | 2 | 3; headers?: string[]; revision?: string } = {}): Promise<Input> {
  const version = options.version ?? 3;
  // Reuse unrelated canonical headers ONLY. All source values come from this test.
  const workbook = Object.fromEntries(Object.entries(makeSupportedSheets(version).tabs)
    .map(([name, tab]) => [name, [[...tab.headers]]]));
  workbook.Students = [[...(options.headers ?? HEADERS)], ...structuredClone(rows)];
  workbook.Settings = [['key', 'value'], ['schemaVersion', String(version)], ['classTimeZone', 'Asia/Seoul']];
  // A stable reader token must describe one raw workbook. Different synthetic
  // contents need different tokens; explicit overrides exercise contradictions.
  const revision = options.revision ?? `synthetic-students-${createHash('sha256').update(canonicalJson(workbook)).digest('hex')}`;
  let revisions = 0;
  const sheets = await captureSheetsSnapshot({ spreadsheetId: 'synthetic-student-projection', capturedAt: AT,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => { revisions++; return revision; } } });
  expect(revisions).toBe(2);
  const redis = await captureRedisClaimSnapshot({ hscan: async () => ({ cursor: '0', entries: [] }),
    scan: async () => ({ cursor: '0', keys: [] }), get: async () => { throw new Error('unused synthetic reader'); },
    getRevision: async () => 'synthetic-redis' }, { capturedAt: AT });
  const capture = { tenantId: TENANT, migrationJobId: JOB, sheets, redis };
  return { capture, manifest: createLegacyNormalizationManifest(capture) };
}

// Test-only resealing for this restricted students/accounts/settings fixture.
// Mirrors the documented semantic envelope format, not the student value oracle.
// It cannot be used for job-scoped/claim/transaction fixtures.
function reseal(draft: Draft): LegacyNormalizationManifest {
  expect(Object.entries(draft.records).every(([table, rows]) => rows.length === 0 || ['students', 'accounts', 'settings'].includes(table))).toBe(true);
  const sorted = <T,>(items: readonly T[]) => [...items].sort((a, b) => {
    const x = canonicalJson(a), y = canonicalJson(b); return x < y ? -1 : x > y ? 1 : 0;
  });
  draft.sourceFingerprint = sha256(canonicalJson({
    records: Object.fromEntries(Object.entries(draft.records).map(([table, rows]) => [table, sorted(rows)])),
    sourceRecords: sorted(draft.sourceRecords.map((record) => ({
      source: record.source.kind === 'SHEET' ? { kind: 'SHEET', tab: record.source.tab }
        : { kind: 'REDIS', provenance: record.source.provenance },
      redactedSourceRecord: record.redactedSourceRecord, canonicalRecord: record.canonicalRecord,
      mappingStatus: record.mappingStatus, targetTable: record.targetTable ?? null, targetId: record.targetId ?? null,
      warningCodes: record.warningCodes, errorCodes: record.errorCodes,
    }))),
    mappings: sorted(draft.mappings.map(({ targetTable, targetId, status }) => ({ targetTable, targetId, status }))),
    warnings: sorted(draft.warnings.map(({ code, path }) => ({ code, path: path.replace(/\[[0-9]+\]/g, '[]') }))),
    blockingConflicts: sorted(draft.blockingConflicts.map(({ code, path }) => ({ code, path: path.replace(/\[[0-9]+\]/g, '[]') }))),
  }));
  const body = { ...draft }; Reflect.deleteProperty(body, 'manifestDigest');
  return { ...draft, manifestDigest: sha256(canonicalJson(body)) };
}
function rewrite(input: Input, mutate: (draft: Draft) => void): Input {
  const draft: Draft = structuredClone(input.manifest); mutate(draft);
  return { capture: input.capture, manifest: reseal(draft) };
}
function isStudent(source: Input['manifest']['sourceRecords'][number]) {
  return source.source.kind === 'SHEET' && source.source.tab === 'Students';
}

// Resigned in-memory envelopes with the real stage's shape. No fake DB/runner,
// no assertion that these bytes were archived or can reach the actual stage.
function copies(original: Input, candidate: Input) {
  const context = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: '1',
    originalSnapshotId: `import:${original.manifest.manifestDigest}`, originalSourceId: `sheet:${original.capture.sheets.digest}`,
    exclusionGenerationReference: 'a'.repeat(64) };
  const binding = { tenantId: TENANT, migrationJobId: JOB, expectedStatus: 'READY', expectedStateVersion: '1',
    originalSnapshotId: context.originalSnapshotId, originalSourceId: context.originalSourceId,
    originalManifestDigest: original.manifest.manifestDigest, originalSourceFingerprint: original.manifest.sourceFingerprint };
  const acquisition = (input: Input) => ({ sheets: input.capture.sheets, redis: input.capture.redis });
  const originalDetails = { storage: 'UNTRUSTED_PREPARATION', phase: 'ORIGINAL_PREFLIGHT', tenantId: TENANT, migrationJobId: JOB,
    originalSnapshotId: context.originalSnapshotId, originalSourceId: context.originalSourceId,
    acquisition: acquisition(original), manifest: original.manifest };
  const originalGenerationId = `preparation:original:${sha256(canonicalJson(originalDetails))}`;
  const candidateDetails = { storage: 'UNTRUSTED_PREPARATION', phase: 'FINAL_CANDIDATE', binding, originalGenerationId,
    exclusionGenerationReference: context.exclusionGenerationReference, acquisition: acquisition(candidate), manifest: candidate.manifest };
  const candidateGenerationId = `preparation:candidate:${sha256(canonicalJson(candidateDetails))}`;
  // Original has zero Students. This intentionally lets correlated normalized
  // omissions produce a self-consistent smaller ADDED plan.
  const changes: Plan['changes'] = ['students', 'accounts'].flatMap((table) => (candidate.manifest.records[table] ?? [])
    .map((row) => ({ table, identity: canonicalJson([row.studentId]), kind: 'ADDED' as const,
      beforeDigest: null, afterDigest: sha256(canonicalJson(row)) })));
  const plan: Plan = { status: 'DIFF_VALIDATED', changes, blockers: [] };
  const planDetails = { storage: 'UNTRUSTED_PREPARATION', phase: 'DELTA_PLAN', binding, originalGenerationId,
    candidateGenerationId, exclusionGenerationReference: context.exclusionGenerationReference,
    originalManifestDigest: original.manifest.manifestDigest, candidateManifestDigest: candidate.manifest.manifestDigest, ...plan };
  const planId = `preparation:plan:${sha256(canonicalJson(planDetails))}`;
  const row = (kind: string, id: string, details: object) => ({ tenant_id: TENANT, event_id: id, job_id: JOB,
    event_type: `MIGRATION_PREPARATION_${kind}`, operation_id: null, actor_user_id: null, entity_type: null, entity_id: null,
    redacted_details: details });
  return { context, prepared: { storage: 'UNTRUSTED_PREPARATION' as const, originalGenerationId, candidateGenerationId, planId, plan },
    rows: [row('ORIGINAL', originalGenerationId, originalDetails), row('CANDIDATE', candidateGenerationId, candidateDetails), row('PLAN', planId, planDetails)] };
}
function rejected(input: unknown, stage: RejectionStage) {
  let error: unknown;
  try { verifyLocalCapturedStudentProjection(input); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(LocalCapturedStudentProjectionError);
  expect(error).toMatchObject({ stage, message: `Captured student projection ${stage} refused.` });
  // Diagnostics consist ONLY of a fixed stage/name/message, never raw cells.
  expect(Object.keys(error as object).sort()).toEqual(['name', 'stage']);
}
function admitted(input: Input) {
  const report = verifyLocalCapturedSourceCoverage(input);
  expect(report).toMatchObject({ status: 'CAPTURE_POINTERS_ACCOUNTED', pointerAccounting: 'ACCOUNTED', normalizationStatus: 'READY_FOR_IMPORT' });
}
function fullBoundary(original: Input, candidate: Input, passes: boolean) {
  const data = copies(original, candidate);
  expect(() => inspectLocalPointerPreparationEnvelopes(data.context, data.prepared, data.rows)).not.toThrow();
  if (passes) expect(() => inspectLocalFullDeltaPreparationEnvelopes(data.context, data.prepared, data.rows)).not.toThrow();
  else expect(() => inspectLocalFullDeltaPreparationEnvelopes(data.context, data.prepared, data.rows)).toThrow('Local full-delta-checked preparation refused.');
}

// Change only captured raw data; retain plausible good normalized values and
// repair every artifact/pointer/mapping hash in the COPY. Not a real normalizer output.
function rebind(good: Input, changed: Input): Input {
  const digestChanges = new Map<string, string>();
  const draft: Draft = structuredClone(good.manifest);
  draft.sourceArtifacts = changed.manifest.sourceArtifacts;
  draft.sourceRecords = draft.sourceRecords.map((record) => {
    if (record.source.kind !== 'SHEET') return record;
    const row = changed.capture.sheets.tabs[record.source.tab].rows[record.source.rowNumber - 2];
    digestChanges.set(record.source.rowHash, row.hash);
    return { ...record, source: { ...record.source, artifactDigest: changed.capture.sheets.digest, rowHash: row.hash } };
  });
  draft.mappings = draft.mappings.map((mapping) => ({ ...mapping, sourceDigest: digestChanges.get(mapping.sourceDigest) ?? mapping.sourceDigest }));
  return { capture: changed.capture, manifest: reseal(draft) };
}

describe('captured sanitized Students projection only', () => {
  it('uses distinct synthetic revision tokens for distinct raw workbooks before exercising the full-copy gate', async () => {
    const original = await fixture([]), candidate = await fixture();
    expect(original.capture.sheets.sourceRevision).not.toBe(candidate.capture.sheets.sourceRevision);
    fullBoundary(original, candidate, true);
    expect(verifyLocalCapturedStudentProjection(candidate)).toMatchObject({ expectedSourceUnits: 2 });
  });
  it('keeps contradictory same-revision raw captures refused even when each projection is individually valid', async () => {
    const original = await fixture([], { revision: 'synthetic-equal-revision' });
    const candidate = await fixture(RAW, { revision: 'synthetic-equal-revision' });
    for (const input of [original, candidate]) {
      admitted(input);
      expect(verifyLocalCapturedStudentProjection(input).status).toBe('CAPTURED_STUDENT_PROJECTION_ACCOUNTED');
    }
    const data = copies(original, candidate);
    expect(() => inspectLocalPointerPreparationEnvelopes(data.context, data.prepared, data.rows))
      .toThrow('Local pointer-checked preparation refused.');
    expect(() => inspectLocalFullDeltaPreparationEnvelopes(data.context, data.prepared, data.rows))
      .toThrow('Local full-delta-checked preparation refused.');
  });
  it('allows identical raw workbooks with the same revision, including an observed-empty Students tab', async () => {
    const original = await fixture([], { revision: 'synthetic-equal-revision' });
    const candidate = await fixture([], { revision: 'synthetic-equal-revision' });
    fullBoundary(original, candidate, true);
    expect(verifyLocalCapturedStudentProjection(candidate)).toMatchObject({ presence: 'PRESENT_EMPTY' });
  });
  it.each([1, 2, 3] as const)('has an independent raw denominator and literal positive oracle in schema %s', async (version) => {
    const input = await fixture(RAW, { version }); admitted(input);
    expect(input.manifest.records.students).toEqual(STUDENTS); expect(input.manifest.records.accounts).toEqual(ACCOUNTS);
    expect(reseal(structuredClone(input.manifest))).toEqual(input.manifest);
    const before = canonicalJson(input); const result = verifyLocalCapturedStudentProjection(input);
    expect(result).toEqual({ ...flags, status: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTED', presence: 'PRESENT_NONEMPTY',
      expectedSourceUnits: 2, sourceRecordReferences: 2, studentRows: 2, accountRows: 2, mappingReferences: 4,
      diagnostics: [], omittedDiagnostics: 0 });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.diagnostics)).toBe(true);
    expect(canonicalJson(input)).toBe(before);
  });
  it('distinguishes observed empty Students from an omitted required tab', async () => {
    const input = await fixture([]); admitted(input);
    expect(verifyLocalCapturedStudentProjection(input)).toEqual({ ...flags, status: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTED',
      presence: 'PRESENT_EMPTY', expectedSourceUnits: 0, sourceRecordReferences: 0, studentRows: 0, accountRows: 0,
      mappingReferences: 0, diagnostics: [], omittedDiagnostics: 0 });
    const copy = structuredClone(input); Reflect.deleteProperty(copy.capture.sheets.tabs, 'Students');
    expect(() => verifyLocalCapturedSourceCoverage(copy)).toThrow(); rejected(copy, 'INPUT_BOUNDARY');
  });
  it('accepts reordered padded headers/cells only according to the current scalar contract', async () => {
    const input = await fixture([[' ACTIVE ', ' -7 ', ' S1 ', ' 2026-09-01T00:00:00Z ']],
      { headers: [' status ', ' balance ', ' studentId ', ' name '] }); admitted(input);
    expect(input.manifest.records.students).toEqual([{ tenantId: TENANT, studentId: 'S1', name: '2026-09-01T00:00:00Z', status: 'ACTIVE' }]);
    expect(input.manifest.records.accounts).toEqual([{ tenantId: TENANT, studentId: 'S1', balance: -7 }]);
    expect(verifyLocalCapturedStudentProjection(input)).toMatchObject({ ...flags, expectedSourceUnits: 1 });
  });
  it.each(['0', '-0', '9007199254740991', '-9007199254740991'])('accepts the exact safe-integer scalar %s', async (balance) => {
    const input = await fixture([['S1', 'Literal', balance, 'ACTIVE']]); admitted(input);
    expect(verifyLocalCapturedStudentProjection(input)).toMatchObject({ ...flags, expectedSourceUnits: 1 });
  });
  it('ignores array order but never multiplicity; leaves mutable inputs mutable and unchanged', async () => {
    const original = await fixture(); const input = rewrite(original, (m) => {
      m.records = { ...m.records, students: [...m.records.students].reverse(), accounts: [...m.records.accounts].reverse() };
      m.sourceRecords = [...m.sourceRecords].reverse(); m.mappings = [...m.mappings].reverse();
    }); admitted(input); const before = canonicalJson(input);
    expect(verifyLocalCapturedStudentProjection(input)).toMatchObject({ status: 'CAPTURED_STUDENT_PROJECTION_ACCOUNTED' });
    expect(canonicalJson(input)).toBe(before); expect(Object.isFrozen(input.manifest)).toBe(false);
  });

  const attacks: Array<[string, (m: Draft) => void, boolean]> = [
    ['account target only missing', (m) => { m.records = { ...m.records, accounts: m.records.accounts.slice(1) }; }, true],
    ['account target and mapping missing', (m) => {
      m.records = { ...m.records, accounts: m.records.accounts.slice(1) };
      m.mappings = m.mappings.filter((x) => !(x.targetTable === 'accounts' && x.targetId === 'S1'));
    }, true],
    ['canonical and account balance mutated together', (m) => {
      m.records = { ...m.records, accounts: m.records.accounts.map((r) => r.studentId === 'S1' ? { ...r, balance: 101 } : r) };
      m.sourceRecords = m.sourceRecords.map((r) => isStudent(r) && r.targetId === 'S1' ? { ...r, canonicalRecord: { ...r.canonicalRecord, balance: 101 } } : r);
    }, true],
    ['same-count account identity swap', (m) => { m.records = { ...m.records, accounts: m.records.accounts.map((r, i) => i ? r : { ...r, studentId: 'foreign' }) }; }, true],
    ['same-count account tenant swap', (m) => { m.records = { ...m.records, accounts: m.records.accounts.map((r, i) => i ? r : { ...r, tenantId: OTHER }) }; }, true],
    ['duplicate mapping separate object', (m) => { m.mappings = [...m.mappings, structuredClone(m.mappings.find((r) => r.targetTable === 'accounts')!)]; }, true],
    ['duplicate source contributor separate object', (m) => { m.sourceRecords = [...m.sourceRecords, structuredClone(m.sourceRecords.find(isStudent)!)]; }, true],
    ['extra account', (m) => { m.records = { ...m.records, accounts: [...m.records.accounts, { tenantId: TENANT, studentId: 'extra', balance: 0 }] }; }, true],
    ['extra mapping', (m) => { m.mappings = [...m.mappings, { sourceDigest: 'f'.repeat(64), targetTable: 'accounts', targetId: 'extra', status: 'STAGED' }]; }, true],
    ['mapping digest substitution', (m) => { m.mappings = m.mappings.map((r) => r.targetTable === 'accounts' ? { ...r, sourceDigest: 'f'.repeat(64) } : r); }, true],
    ['mapping redirected outside Students', (m) => { m.mappings = m.mappings.map((r) => r.targetTable === 'accounts' ? { ...r, targetTable: 'products' } : r); }, true],
    ['non-Students contributor targets Students', (m) => { m.sourceRecords = m.sourceRecords.map((r) => !isStudent(r) ? { ...r, targetTable: 'students', targetId: 'S1' } : r); }, true],
    ['wrong redacted identity', (m) => { m.sourceRecords = m.sourceRecords.map((r) => isStudent(r) ? { ...r, redactedSourceRecord: { ...r.redactedSourceRecord, identityDigest: 'f'.repeat(64) } } : r); }, true],
    ['wrong recognized multiplicity', (m) => { m.sourceRecords = m.sourceRecords.map((r) => isStudent(r) ? { ...r, redactedSourceRecord: { ...r.redactedSourceRecord, recognizedFieldCount: 3 } } : r); }, true],
    ['source target identity substitution', (m) => { m.sourceRecords = m.sourceRecords.map((r) => isStudent(r) ? { ...r, targetId: 'foreign' } : r); }, true],
    ['duplicate account normalized identity', (m) => { m.records = { ...m.records, accounts: [...m.records.accounts, structuredClone(m.records.accounts[0])] }; }, false],
    ['duplicate student normalized identity', (m) => { m.records = { ...m.records, students: [...m.records.students, structuredClone(m.records.students[0])] }; }, false],
    ['student target missing', (m) => { m.records = { ...m.records, students: [] }; }, true],
    ['student and canonical name mutation', (m) => {
      m.records = { ...m.records, students: m.records.students.map((r) => ({ ...r, name: 'replacement' })) };
      m.sourceRecords = m.sourceRecords.map((r) => isStudent(r) ? { ...r, canonicalRecord: { ...r.canonicalRecord, name: 'replacement' } } : r);
    }, true],
    ['target extra property', (m) => { m.records = { ...m.records, accounts: m.records.accounts.map((r) => ({ ...r, extra: 'unexpected' })) }; }, true],
  ];
  it.each(attacks)('%s: classifies actual pointer/full-copy gates before own projection', async (name, mutate, fullPasses) => {
    const good = await fixture(); const input = rewrite(good, mutate); const original = await fixture([]);
    admitted(input); fullBoundary(original, input, fullPasses);
    const before = canonicalJson(input); rejected(input, 'STUDENT_PROJECTION'); expect(canonicalJson(input)).toBe(before);
    evidence.push({ name, pointer: 'PASSED', fullReadbackCopy: fullPasses ? 'PASSED' : 'REJECTED',
      standaloneProjection: 'REJECTED', ownRejectionAfterFullPass: fullPasses, realWrapperBypassClaimed: false });
  });
  it('omitting a new account AND its change leaves the normalized plan self-consistent, not the raw projection', async () => {
    const good = await fixture(); const original = await fixture([]);
    const input = rewrite(good, (m) => {
      m.records = { ...m.records, accounts: m.records.accounts.filter((r) => r.studentId !== 'S2') };
      m.mappings = m.mappings.filter((r) => !(r.targetTable === 'accounts' && r.targetId === 'S2'));
    });
    const data = copies(original, input);
    expect(data.prepared.plan.changes).toHaveLength(3);
    expect(data.prepared.plan.changes.some((r) => r.table === 'accounts' && r.identity === '["S2"]')).toBe(false);
    fullBoundary(original, input, true); rejected(input, 'STUDENT_PROJECTION');
    evidence.push({ name: 'correlated new account/plan omission', fullReadbackCopy: 'PASSED', standaloneProjection: 'REJECTED', rawStudents: 2, planChanges: 3 });
  });
  it('does not turn date-looking names into same-instant equivalence', async () => {
    const good = await fixture([['S1', '2026-09-01T00:00:00Z', '0', 'ACTIVE']]);
    const input = rewrite(good, (m) => {
      m.records = { ...m.records, students: m.records.students.map((r) => ({ ...r, name: '2026-09-01T00:00:00.000Z' })) };
      m.sourceRecords = m.sourceRecords.map((r) => isStudent(r) ? { ...r, canonicalRecord: { ...r.canonicalRecord, name: '2026-09-01T00:00:00.000Z' } } : r);
    }); admitted(input); fullBoundary(await fixture([]), input, true); rejected(input, 'STUDENT_PROJECTION');
  });
  it.each(['rowHash', 'rowNumber', 'artifactDigest', 'tab', 'omit source'] as const)('classifies source %s corruption as existing pointer rejection', async (kind) => {
    const input = rewrite(await fixture(), (m) => {
      if (kind === 'omit source') { m.sourceRecords = m.sourceRecords.filter((r) => !isStudent(r)); return; }
      m.sourceRecords = m.sourceRecords.map((r) => !isStudent(r) || r.source.kind !== 'SHEET' ? r : { ...r, source: { ...r.source,
        ...(kind === 'rowHash' ? { rowHash: 'f'.repeat(64) } : kind === 'rowNumber' ? { rowNumber: 999 }
          : kind === 'artifactDigest' ? { artifactDigest: 'f'.repeat(64) } : { tab: 'Products' }) } });
    });
    expect(verifyLocalCapturedSourceCoverage(input).status).toBe('BLOCKED');
    const data = copies(await fixture([]), input);
    expect(() => inspectLocalFullDeltaPreparationEnvelopes(data.context, data.prepared, data.rows)).toThrow();
    rejected(input, 'POINTER_BOUNDARY'); evidence.push({ name: kind, fullReadbackCopy: 'REJECTED_AT_POINTER', ownProjectionReached: false });
  });

  const invalidRows = [
    ['missing id', ['', 'Literal', '0', 'ACTIVE']], ['long id', ['s'.repeat(513), 'Literal', '0', 'ACTIVE']],
    ['empty name', ['S1', ' ', '0', 'ACTIVE']], ['invalid status', ['S1', 'Literal', '0', 'active']],
    ['decimal', ['S1', 'Literal', '1.5', 'ACTIVE']], ['leading zero', ['S1', 'Literal', '01', 'ACTIVE']],
    ['exponent', ['S1', 'Literal', '1e2', 'ACTIVE']], ['unsafe integer', ['S1', 'Literal', '9007199254740992', 'ACTIVE']],
    ['blank balance', ['S1', 'Literal', '', 'ACTIVE']],
  ] as const;
  it.each(invalidRows)('%s from real normalizer is upstream BLOCKED, not own projection evidence', async (name, row) => {
    const input = await fixture([[...row]]);
    expect(input.manifest.status).toBe('BLOCKED'); expect(verifyLocalCapturedSourceCoverage(input).status).toBe('BLOCKED');
    rejected(input, 'POINTER_BOUNDARY'); evidence.push({ name: `natural ${name}`, pointer: 'BLOCKED', ownProjectionReached: false });
  });
  it.each(invalidRows)('resealed raw %s with plausible READY canonical values is independently refused', async (name, row) => {
    const good = await fixture([['S1', 'Literal', '0', 'ACTIVE']]); const changed = await fixture([[...row]]);
    const input = rebind(good, changed); admitted(input); fullBoundary(await fixture([]), input, true);
    rejected(input, 'STUDENT_PROJECTION'); evidence.push({ name: `forged READY ${name}`, fullReadbackCopy: 'PASSED', standaloneProjection: 'REJECTED' });
  });
  it('refuses duplicate raw identity even with two distinct canonical student identities and valid pointers', async () => {
    const good = await fixture(); const changed = await fixture([RAW[0], ['S1', 'Different', '-7', 'INACTIVE']]);
    expect(changed.manifest.status).toBe('BLOCKED'); rejected(changed, 'POINTER_BOUNDARY');
    const forged = rebind(good, changed); admitted(forged); fullBoundary(await fixture([]), forged, true); rejected(forged, 'STUDENT_PROJECTION');
  });
  it.each([['studentId', 'name', 'balance', 'name'], ['studentId', 'name', 'balance', 'unknown']])('refuses forged READY with malformed header %j', async (...headers) => {
    const good = await fixture(); const changed = await fixture(RAW, { headers });
    expect(changed.manifest.status).toBe('BLOCKED'); rejected(changed, 'POINTER_BOUNDARY');
    const forged = rebind(good, changed); admitted(forged); fullBoundary(await fixture([]), forged, true); rejected(forged, 'STUDENT_PROJECTION');
  });
  it('conservatively refuses unreviewed extra Students columns even when normalizer READY', async () => {
    const input = await fixture([['S1', 'Literal', '0', 'ACTIVE', 'unreviewed']], { headers: [...HEADERS, 'extra'] });
    admitted(input); fullBoundary(await fixture([]), input, true); rejected(input, 'STUDENT_PROJECTION');
  });
  it('requires observed Redis as the inherited pointer prerequisite, without claiming Redis projection', async () => {
    const input = await fixture(); const { redis: omitted, ...capture } = input.capture; expect(omitted).toBeDefined();
    const missing = { capture, manifest: createLegacyNormalizationManifest(capture) };
    expect(verifyLocalCapturedSourceCoverage(missing).pointerAccounting).toBe('INCOMPLETE'); rejected(missing, 'POINTER_BOUNDARY');
  });
  it.each(['tenant', 'job', 'schema', 'manifest digest', 'sheet digest'] as const)('uses existing binding refusal for %s', async (kind) => {
    const input = await fixture(); const copy = structuredClone(input);
    if (kind === 'sheet digest') Object.assign(copy.capture.sheets, { digest: 'f'.repeat(64) });
    else Object.assign(copy.manifest, kind === 'tenant' ? { tenantId: OTHER } : kind === 'job' ? { migrationJobId: OTHER }
      : kind === 'schema' ? { metadata: { ...copy.manifest.metadata, sheetSchemaVersion: 1 } } : { manifestDigest: 'f'.repeat(64) });
    expect(() => verifyLocalCapturedSourceCoverage(copy)).toThrow(); rejected(copy, 'INPUT_BOUNDARY');
  });

  it('refuses accessors, proxies and toJSON without executing user code or exposing its message', async () => {
    const input = await fixture(); let calls = 0;
    const getter = structuredClone(input);
    Object.defineProperty(getter.capture.sheets.tabs.Students.rows[0], 'cells', { enumerable: true,
      get() { calls++; throw new Error('private source cells'); } });
    const proxy = new Proxy(input, { get() { calls++; throw new Error('private proxy'); },
      ownKeys() { calls++; throw new Error('private keys'); }, getPrototypeOf() { calls++; throw new Error('private proto'); } });
    const revocable = Proxy.revocable(input, {}); revocable.revoke();
    const json = structuredClone(input); Object.assign(json.manifest, { toJSON() { calls++; throw new Error('private serialization'); } });
    for (const value of [getter, proxy, revocable.proxy, json]) rejected(value, 'INPUT_BOUNDARY');
    expect(calls).toBe(0);
  });
  it.each(['cycle', 'sparse', 'symbol', 'prototype', 'infinite', 'long string', 'array cap', 'depth cap', 'key cap', 'aggregate text'] as const)('bounded descriptor admission rejects %s', async (kind) => {
    const input = await fixture(); const copy = structuredClone(input);
    if (kind === 'cycle') Object.assign(copy.manifest, { cycle: copy });
    if (kind === 'sparse') Reflect.deleteProperty(copy.capture.sheets.tabs.Students.rows[0].cells, '0');
    if (kind === 'symbol') Object.assign(copy.manifest, { [Symbol('private')]: 1 });
    if (kind === 'prototype') Object.setPrototypeOf(copy.manifest, { unexpected: true });
    if (kind === 'infinite') Object.assign(copy.manifest, { bad: Infinity });
    if (kind === 'long string') Object.assign(copy.manifest, { bad: 'x'.repeat(8193) });
    if (kind === 'array cap') Object.assign(copy.manifest, { bad: Array(4097).fill(null) });
    if (kind === 'depth cap') { let nested: object = {}; for (let i = 0; i < 25; i++) nested = { nested }; Object.assign(copy.manifest, { bad: nested }); }
    if (kind === 'key cap') Object.assign(copy.manifest, { bad: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, null])) });
    if (kind === 'aggregate text') Object.assign(copy.manifest, { bad: Array(130).fill('x'.repeat(8192)) });
    expect(() => verifyLocalCapturedSourceCoverage(copy)).toThrow(); rejected(copy, 'INPUT_BOUNDARY');
  });
});
