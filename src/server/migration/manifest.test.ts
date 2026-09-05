import { describe, expect, it } from 'vitest';
import { createLegacyNormalizationManifest } from './manifest';
import { finalizeRedisSnapshot, makeRedis, makeSheets, payloadHash, sha, tupleDigest } from './__fixtures__/normalization';
import { normalizeLegacySnapshots } from './normalize';
import { canonicalJson } from './validators';

const input = (sheets = makeSheets(), redis = makeRedis()) => ({
  tenantId: '10000000-0000-4000-8000-000000000001', migrationJobId: '20000000-0000-4000-8000-000000000001', sheets, redis,
});

type RedisFixture = ReturnType<typeof makeRedis>;
type MutableSheetsTabs = Parameters<NonNullable<Parameters<typeof makeSheets>[1]>>[0];
type MutableRedisFixture = {
  -readonly [Key in keyof RedisFixture]: Key extends 'v2Claims' | 'operationBindings' | 'v1Tombstones'
    ? Array<RedisFixture[Key][number]>
    : Key extends 'orphanedClaimDigests' ? string[] : RedisFixture[Key];
};
function redisArtifact(mutate: (redis: MutableRedisFixture) => void) {
  const redis = structuredClone(makeRedis()) as unknown as MutableRedisFixture;
  mutate(redis);
  const artifact = Object.fromEntries(
    Object.entries(redis).filter(([key]) => key !== 'digest'),
  ) as unknown as Omit<RedisFixture, 'digest'>;
  return { ...artifact, digest: sha(canonicalJson(artifact)) } as RedisFixture;
}

describe('legacy normalization manifest', () => {
  it('normalizes every generated operational sheet into deterministic target collections', () => {
    const manifest = createLegacyNormalizationManifest(input());
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(Object.keys(manifest.records)).toEqual([
      'accounts', 'adjustments', 'legacy_operation_bindings', 'padlet_evidence_claims', 'products',
      'promotion_products', 'promotions', 'settings', 'students', 'task_allowed_students', 'task_assignments',
      'task_completions', 'tasks', 'transaction_items', 'transactions',
    ]);
    expect(manifest.records.students[0]).toMatchObject({ studentId: 'S1', name: 'Alice', status: 'ACTIVE' });
    expect(manifest.records.accounts[0]).toMatchObject({ studentId: 'S1', balance: 100 });
    expect(manifest.records.transactions[0]).toMatchObject({ transactionId: 'TX1', totalAmount: 20, balanceBefore: 100, balanceAfter: 80, status: 'COMPLETED' });
    expect(manifest.records.transaction_items[0]).toMatchObject({ transactionId: 'TX1', productId: 'P1', quantity: 1, subtotal: 20 });
    expect(manifest.records.tasks[0]).toMatchObject({ taskId: 'T1', taskInstanceId: 'TI1' });
    expect(manifest.records.padlet_evidence_claims[0]).toMatchObject({ tupleDigest, operationId: 'op-1' });
    expect(manifest.records.padlet_evidence_claims[0].provenances).toHaveLength(2);
    expect(manifest.records.settings).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'schemaVersion', value: '3' }),
      expect.objectContaining({ key: 'classTimeZone', value: 'Asia/Seoul' }),
      expect.objectContaining({ key: 'themeColor', value: 'blue' }),
    ]));
    expect(Object.values(manifest.records).flat().some((record) => '__targetId' in record)).toBe(false);
    expect(manifest.records.promotions[0]).toMatchObject({ discountAmount: 5 });
    expect(manifest.blockingConflicts).toEqual([]);
    expect(manifest.quarantines).toEqual([]);
    expect(manifest.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.sourceArtifacts.sheets.credentialHashes).toEqual({ adminPasswordHash: sha('admin'), recoveryCodeHash: sha('recovery') });
    expect(JSON.stringify(manifest)).not.toContain('recoveryCodeHash":"recovery');
  });

  it.each([1, 2, 3] as const)('supports schema snapshot version %s and missing optional tabs', (version) => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(version), undefined));
    expect(manifest.metadata.sheetSchemaVersion).toBe(version);
    expect(manifest.blockingConflicts).toEqual([]);
    expect(manifest.status).toBe('READY_FOR_IMPORT');
  });

  it.each([2, 3] as const)('quarantines blank completion snapshots from sheet schema version %s', (version) => {
    const sheets = makeSheets(version, (tabs) => {
      const completion = tabs.TaskCompletions;
      completion.rows[0].cells = completion.headers.map((header, index) => index < 10 ? completion.rows[0].cells[index] : '');
    });
    const normalized = normalizeLegacySnapshots(input(sheets, undefined));
    const completionSource = normalized.sourceRecords.find((record) => record.source.kind === 'SHEET'
      && record.source.tab === 'TaskCompletions');

    expect(completionSource).toMatchObject({
      mappingStatus: 'QUARANTINED',
      errorCodes: expect.arrayContaining(['MALFORMED_REQUIRED_HISTORY']),
    });
    expect(normalized.blockingConflicts.map((conflict) => conflict.code)).toContain('MALFORMED_REQUIRED_HISTORY');
    expect(normalized.records.task_completions).toEqual([]);
    expect(normalized.mappings.some((mapping) => mapping.targetTable === 'task_completions')).toBe(false);
  });

  it('keeps source fingerprints independent of migration job IDs and sensitive to semantic changes', () => {
    const sheets = makeSheets();
    const left = createLegacyNormalizationManifest({ ...input(sheets), migrationJobId: '20000000-0000-4000-8000-000000000001' });
    const right = createLegacyNormalizationManifest({ ...input(sheets), migrationJobId: '20000000-0000-4000-8000-000000000002' });
    const changed = createLegacyNormalizationManifest({
      ...input(makeSheets(3, (tabs) => { tabs.Students.rows[0].cells[1] = 'Bob'; })),
      migrationJobId: '20000000-0000-4000-8000-000000000002',
    });

    expect(left.sourceFingerprint).toBe(right.sourceFingerprint);
    expect(left.mappings.map(({ targetId }) => targetId)).not.toEqual(right.mappings.map(({ targetId }) => targetId));
    expect(changed.sourceFingerprint).not.toBe(left.sourceFingerprint);
  });

  it('preserves a generated target ID when it is an unrelated semantic setting value', () => {
    const jobA = '20000000-0000-4000-8000-000000000001';
    const jobB = '20000000-0000-4000-8000-000000000002';
    const generatedTargetId = createLegacyNormalizationManifest({ ...input(), migrationJobId: jobA })
      .mappings.find((mapping) => mapping.targetTable === 'transaction_items')!.targetId;
    const sheets = makeSheets(3, (tabs) => {
      tabs.Settings.rows.push({ rowNumber: 0, cells: ['appTitle', generatedTargetId], hash: sha('recomputed-by-helper') });
    });

    const left = createLegacyNormalizationManifest({ ...input(sheets), migrationJobId: jobA });
    const right = createLegacyNormalizationManifest({ ...input(sheets), migrationJobId: jobB });

    expect(left.records.settings).toContainEqual(expect.objectContaining({ key: 'appTitle', value: generatedTargetId }));
    expect(left.sourceFingerprint).toBe(right.sourceFingerprint);
  });

  it('distinguishes generated-ID-looking semantic data from literal placeholder-like data', () => {
    const migrationJobId = '20000000-0000-4000-8000-000000000001';
    const generatedTargetId = createLegacyNormalizationManifest({ ...input(), migrationJobId })
      .mappings.find((mapping) => mapping.targetTable === 'transaction_items')!.targetId;
    const withSetting = (value: string) => makeSheets(3, (tabs) => {
      tabs.Settings.rows.push({ rowNumber: 0, cells: ['appTitle', value], hash: sha('recomputed-by-helper') });
    });

    const generatedLooking = createLegacyNormalizationManifest({
      ...input(withSetting(generatedTargetId)), migrationJobId,
    });
    const literalPlaceholder = createLegacyNormalizationManifest({
      ...input(withSetting('@job-scoped-target:transaction_items')), migrationJobId,
    });

    expect(generatedLooking.sourceFingerprint).not.toBe(literalPlaceholder.sourceFingerprint);
  });

  it('reports duplicate and malformed headers while preserving unknown cells only as redacted provenance', () => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.Students.headers = ['studentId', ' studentId ', 'name', 'balance', 'status', '', 'custom'];
      tabs.Students.rows[0].cells = ['S1', 'shadow', 'Alice', '100', 'ACTIVE', 'hidden', 'custom-value'];
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.blockingConflicts.map((item) => item.code)).toContain('DUPLICATE_HEADER');
    expect(manifest.blockingConflicts.map((item) => item.code)).toContain('MISSING_REQUIRED_COLUMN');
    expect(manifest.warnings.map((item) => item.code)).toEqual(expect.arrayContaining(['BLANK_HEADER', 'UNKNOWN_HEADER']));
    expect(JSON.stringify(manifest)).not.toContain('custom-value');
    expect(JSON.stringify(manifest)).not.toContain('hidden');
  });

  it('audits recognized and omitted columns exactly, including completion evidence headers', () => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      tabs.Students.headers.push('', 'unknownColumn');
      tabs.Students.rows[0].cells.push('blank-secret', 'unknown-secret');
    }), undefined));
    const students = manifest.sourceRecords.find((record) => record.source.kind === 'SHEET' && record.source.tab === 'Students');
    const completion = manifest.sourceRecords.find((record) => record.source.kind === 'SHEET' && record.source.tab === 'TaskCompletions');

    expect(students?.redactedSourceRecord).toMatchObject({ recognizedFieldCount: 4, omittedFieldCount: 2 });
    expect(completion?.redactedSourceRecord).toMatchObject({ recognizedFieldCount: 26, omittedFieldCount: 0 });
    expect(students!.redactedSourceRecord.recognizedFieldCount + students!.redactedSourceRecord.omittedFieldCount)
      .toBe(6);
    expect(completion!.redactedSourceRecord.recognizedFieldCount + completion!.redactedSourceRecord.omittedFieldCount)
      .toBe(26);
    expect(JSON.stringify(manifest)).not.toMatch(/blank-secret|unknown-secret/);
  });

  it('quarantines malformed required history and duplicate financial identifiers without silently merging', () => {
    const sheets = makeSheets(3, (tabs) => {
      const first = tabs.Transactions.rows[0];
      tabs.Transactions.rows.push({ rowNumber: 3, cells: [...first.cells], hash: first.hash });
      tabs.Adjustments.rows[0].cells[3] = '1.5';
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.blockingConflicts.map((item) => item.code)).toEqual(expect.arrayContaining(['DUPLICATE_LEDGER_ID', 'MALFORMED_REQUIRED_HISTORY']));
    expect(manifest.quarantines
      .flatMap((item) => item.source.kind === 'SHEET' ? [item.source.tab] : []))
      .toEqual(expect.arrayContaining(['Transactions', 'Adjustments']));
    expect(manifest.records.transactions).toEqual([]);
    expect(manifest.records.adjustments).toEqual([]);
  });

  it('reports broken references with stable codes and quarantines referencing rows', () => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.Transactions.rows[0].cells[2] = 'MISSING';
      tabs.TaskAssignments.rows[0].cells[8] = 'MISSING';
      tabs.PromotionProducts.rows[0].cells[2] = 'MISSING';
      tabs.Tasks.rows[0].cells[8] = 'S1,MISSING';
      tabs.Tasks.rows[0].cells[30] = 'MISSING-TASK';
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.blockingConflicts.map((item) => item.code)).toEqual(expect.arrayContaining([
      'BROKEN_STUDENT_REFERENCE', 'BROKEN_PRODUCT_REFERENCE', 'BROKEN_ALLOWED_STUDENT_REFERENCE', 'BROKEN_TASK_REFERENCE',
    ]));
    expect(manifest.quarantines.length).toBeGreaterThanOrEqual(4);
  });

  it('unions Redis-only bindings, orphan claims, and v1 tombstones without loss', () => {
    const orphan = 'b'.repeat(64);
    const tombstone = 'c'.repeat(64);
    const redis = makeRedis({ orphanedClaimDigests: [orphan], v1Tombstones: [{ tupleDigest: tombstone, ownerDigest: sha('old-owner'), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }] });
    const sheets = makeSheets(3, (tabs) => { tabs.TaskCompletions.rows = []; });
    const manifest = createLegacyNormalizationManifest(input(sheets, redis));
    expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
    expect(manifest.records.padlet_claim_digest_tombstones).toEqual(expect.arrayContaining([
      expect.objectContaining({ tupleDigest: orphan, kind: 'ORPHAN_V2' }),
      expect.objectContaining({ tupleDigest: tombstone, kind: 'V1_GLOBAL' }),
    ]));
    expect(manifest.records.legacy_operation_bindings).toHaveLength(1);
  });

  it.each([
    ['taskId', 'MISSING-TASK', 'BROKEN_TASK_REFERENCE'],
    ['studentId', 'MISSING-STUDENT', 'BROKEN_STUDENT_REFERENCE'],
  ] as const)('atomically quarantines a valid Redis-only claim whose %s is missing', (field, missingId, errorCode) => {
    const base = makeRedis();
    const redis = finalizeRedisSnapshot({
      ...base,
      operationBindings: base.operationBindings.map((operation) => ({
        ...operation,
        binding: { ...operation.binding, [field]: missingId },
      })),
    });
    const sheets = makeSheets(3, (tabs) => { tabs.TaskCompletions.rows = []; });
    const manifest = createLegacyNormalizationManifest(input(sheets, redis));
    const redisSourceDigests = new Set([
      sha(canonicalJson(redis.v2Claims[0])),
      sha(canonicalJson(redis.operationBindings[0])),
    ]);
    const pairedSources = manifest.sourceRecords.filter((record) => record.source.kind === 'REDIS'
      && redisSourceDigests.has(record.source.sourceDigest));

    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.records.padlet_evidence_claims).toEqual([]);
    expect(manifest.records.legacy_operation_bindings).toEqual([]);
    expect(pairedSources).toHaveLength(2);
    expect(pairedSources.every((record) => record.mappingStatus === 'QUARANTINED'
      && record.errorCodes.includes(errorCode))).toBe(true);
    expect(manifest.blockingConflicts.filter((conflict) => conflict.code === errorCode)).toHaveLength(2);
    expect(manifest.mappings.some((mapping) => mapping.targetTable === 'padlet_evidence_claims'
      || mapping.targetTable === 'legacy_operation_bindings')).toBe(false);
  });

  it('symmetrically quarantines a Redis orphan digest colliding with a Sheet claim', () => {
    const redis = makeRedis({ operationBindings: [], v2Claims: [], orphanedClaimDigests: [tupleDigest] });
    const manifest = createLegacyNormalizationManifest(input(makeSheets(), redis));

    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.records.padlet_evidence_claims).toEqual([]);
    expect(manifest.records.padlet_claim_digest_tombstones).toEqual([]);
    expect(manifest.records.task_completions).toEqual([]);
    expect(manifest.mappings.some((mapping) => ['padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'task_completions']
      .includes(mapping.targetTable))).toBe(false);
    expect(manifest.blockingConflicts.map(({ code }) => code)).toContain('ORPHAN_CLAIM_COLLISION');
  });

  it('blocks conflicting Sheet/Redis claim ownership and v1 collisions instead of choosing a source', () => {
    const conflicting = redisArtifact((redis) => {
      const binding = redis.operationBindings[0];
      redis.operationBindings = [{ ...binding, binding: { ...binding.binding, studentId: 'S2' } }];
      redis.v1Tombstones = [{ tupleDigest, ownerDigest: sha('legacy'), sourceProvenance: 'upstash:padlet:evidence-claim:v1' }];
    });
    const normalized = normalizeLegacySnapshots(input(makeSheets(), conflicting));
    expect(normalized.blockingConflicts.map((item) => item.code)).toEqual(expect.arrayContaining(['CLAIM_BINDING_CONFLICT', 'V1_TOMBSTONE_COLLISION']));
    expect(normalized.records.padlet_evidence_claims).toEqual([]);
    expect(normalized.records.legacy_operation_bindings).toEqual([]);
    expect(normalized.sourceRecords.some((item) => item.mappingStatus === 'QUARANTINED' && item.source.kind === 'SHEET' && item.source.tab === 'TaskCompletions')).toBe(true);
  });

  it('emits a source record and mapping for both sources that exactly agree on one claim', () => {
    const manifest = createLegacyNormalizationManifest(input());
    const targetId = manifest.mappings.find((mapping) => mapping.targetTable === 'padlet_evidence_claims')?.targetId;
    expect(targetId).toBeTruthy();
    expect(manifest.mappings.filter((mapping) => mapping.targetTable === 'padlet_evidence_claims' && mapping.targetId === targetId)).toHaveLength(2);
    expect(manifest.sourceRecords.filter((record) => record.targetTable === 'padlet_evidence_claims' && record.targetId === targetId)).toHaveLength(2);
    expect(manifest.records.padlet_evidence_claims).toHaveLength(1);
  });

  it.each([
    (redis: MutableRedisFixture) => { redis.v2Claims = [{ ...redis.v2Claims[0], ownerDigest: sha('wrong') }]; },
    (redis: MutableRedisFixture) => { redis.operationBindings = [{ ...redis.operationBindings[0], payloadHash: `sha256:${sha('wrong')}` }]; },
  ])('atomically quarantines inconsistent Redis claims, bindings, and matching Sheet claims', (breakRedis) => {
    const normalized = normalizeLegacySnapshots(input(makeSheets(), redisArtifact(breakRedis)));
    expect(normalized.records.padlet_evidence_claims).toEqual([]);
    expect(normalized.records.legacy_operation_bindings).toEqual([]);
    expect(normalized.sourceRecords.some((item) => item.mappingStatus === 'QUARANTINED' && item.source.kind === 'SHEET' && item.source.tab === 'TaskCompletions')).toBe(true);
  });

  it('derives metadata from the exact validated UTC setting', () => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      const timezone = tabs.Settings.rows.find((row) => row.cells[0] === 'classTimeZone')!;
      timezone.cells[1] = 'UTC';
    }), undefined));

    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(manifest.metadata.classTimeZone).toBe('UTC');
    expect(manifest.records.settings).toContainEqual(expect.objectContaining({ key: 'classTimeZone', value: 'UTC' }));
  });

  it.each([
    ['missing schema setting', 'Asia/Seoul', (rows: string[][]) => rows.filter((row) => row[0] !== 'schemaVersion')],
    ['mismatched schema setting', 'Asia/Seoul', (rows: string[][]) => rows.map((row) => row[0] === 'schemaVersion' ? ['schemaVersion', '2'] : row)],
    ['malformed timezone setting', '', (rows: string[][]) => rows.map((row) => row[0] === 'classTimeZone' ? ['classTimeZone', '+09:00'] : row)],
  ])('blocks inconsistent Settings for %s', (_label, expectedTimeZone, mutate) => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      const settings = tabs.Settings;
      settings.rows = mutate(settings.rows.map((row) => [...row.cells])).map((cells, index) => ({
        rowNumber: index + 2, cells, hash: sha('recomputed-by-helper'),
      }));
    }), undefined));

    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.blockingConflicts.map(({ code }) => code)).toEqual(expect.arrayContaining([
      expect.stringMatching(/SCHEMA_VERSION_SETTING|CLASS_TIME_ZONE_SETTING/),
    ]));
    expect(manifest.metadata.classTimeZone).toBe(expectedTimeZone);
  });

  it('blocks duplicate settings keys, task business IDs, and task instance IDs without first-wins output', () => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.Settings.rows.push({ ...tabs.Settings.rows[2], cells: [...tabs.Settings.rows[2].cells] });
      const task = tabs.Tasks.rows[0];
      const sameBusiness = [...task.cells]; sameBusiness[9] = 'TI2';
      const sameInstance = [...task.cells]; sameInstance[0] = 'T2';
      tabs.Tasks.rows.push({ ...task, cells: sameBusiness }, { ...task, cells: sameInstance });
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.blockingConflicts.map((item) => item.code)).toEqual(expect.arrayContaining([
      'DUPLICATE_SETTING_KEY', 'DUPLICATE_BUSINESS_ID', 'DUPLICATE_PRIMARY_ID',
    ]));
    expect(manifest.records.settings.some((record) => record.key === 'themeColor')).toBe(false);
    expect(manifest.records.tasks).toEqual([]);
  });

  it('canonicalizes valid optional task instants and preserves empty values as null', () => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      tabs.Tasks.rows[0].cells[28] = '2026-08-31T01:00:00.000Z';
      tabs.Tasks.rows[0].cells[29] = '2026-09-01T01:00:00.000Z';
    }), undefined));
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(manifest.records.tasks[0]).toMatchObject({
      createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
      availableFrom: '2026-08-31T01:00:00.000Z', dueAt: '2026-09-01T01:00:00.000Z',
    });
  });

  it.each([
    ['malformed availableFrom', 28, '2026-08-31T01:00:00Z'],
    ['malformed dueAt', 29, 'not-an-instant'],
    ['updated before created', 7, '2026-08-30T23:59:59.999Z'],
    ['non-increasing availability', 29, '2026-08-31T01:00:00.000Z'],
  ])('blocks task timestamp integrity for %s', (_label, index, value) => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      if (index === 29) tabs.Tasks.rows[0].cells[28] = '2026-08-31T01:00:00.000Z';
      tabs.Tasks.rows[0].cells[index] = value;
    }), undefined));
    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.records.tasks).toEqual([]);
    expect(manifest.blockingConflicts.map(({ code }) => code)).toContain('MALFORMED_REQUIRED_RECORD');
  });

  it.each([
    ['task prerequisite', 'SELF_TASK_REFERENCE', (tabs: MutableSheetsTabs) => { tabs.Tasks.rows[0].cells[30] = 'T1'; }],
    ['assignment predecessor', 'SELF_ASSIGNMENT_REFERENCE', (tabs: MutableSheetsTabs) => { tabs.TaskAssignments.rows[0].cells[11] = 'AS1'; }],
  ])('blocks a direct self reference in %s before reference resolution', (_label, code, mutate) => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, mutate), undefined));
    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.blockingConflicts.map((item) => item.code)).toContain(code);
  });

  it('marks every task prerequisite cycle member and propagates quarantine to dependent ledgers', () => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      const first = tabs.Tasks.rows[0];
      first.cells[30] = 'T2';
      const second = [...first.cells];
      second[0] = 'T2'; second[9] = 'TI2'; second[30] = 'T1';
      tabs.Tasks.rows.push({ rowNumber: 3, cells: second, hash: sha('recomputed-by-helper') });
    }), undefined));
    const taskSources = manifest.sourceRecords.filter((record) => record.source.kind === 'SHEET' && record.source.tab === 'Tasks');
    const assignment = manifest.sourceRecords.find((record) => record.source.kind === 'SHEET' && record.source.tab === 'TaskAssignments');
    const completion = manifest.sourceRecords.find((record) => record.source.kind === 'SHEET' && record.source.tab === 'TaskCompletions');

    expect(taskSources).toHaveLength(2);
    expect(taskSources.every((record) => record.errorCodes.includes('CYCLIC_TASK_PREREQUISITE'))).toBe(true);
    expect(assignment?.errorCodes).toContain('BROKEN_TASK_REFERENCE');
    expect(completion?.errorCodes).toEqual(expect.arrayContaining(['BROKEN_TASK_REFERENCE', 'BROKEN_ASSIGNMENT_REFERENCE']));
    expect(manifest.records.tasks).toEqual([]);
    expect(manifest.records.task_assignments).toEqual([]);
    expect(manifest.records.task_completions).toEqual([]);
  });

  it('marks every member of a longer assignment predecessor cycle without flagging its dependent as cyclic', () => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      const first = tabs.TaskAssignments.rows[0];
      first.cells[11] = 'AS2';
      const assignment = (id: string, previous: string) => {
        const cells = [...first.cells]; cells[0] = id; cells[11] = previous;
        return { rowNumber: 0, cells, hash: sha('recomputed-by-helper') };
      };
      tabs.TaskAssignments.rows.push(assignment('AS2', 'AS3'), assignment('AS3', 'AS1'), assignment('AS4', 'AS1'));
    }), undefined));
    const assignments = manifest.sourceRecords.filter((record) => record.source.kind === 'SHEET' && record.source.tab === 'TaskAssignments');

    expect(assignments.slice(0, 3).every((record) => record.errorCodes.includes('CYCLIC_ASSIGNMENT_PREDECESSOR'))).toBe(true);
    expect(assignments[3].errorCodes).toContain('BROKEN_ASSIGNMENT_REFERENCE');
    expect(assignments[3].errorCodes).not.toContain('CYCLIC_ASSIGNMENT_PREDECESSOR');
    expect(manifest.records.task_assignments).toEqual([]);
    expect(manifest.records.task_completions).toEqual([]);
  });

  it('does not flag acyclic prerequisite and predecessor chains', () => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      const firstTask = tabs.Tasks.rows[0];
      const secondTask = [...firstTask.cells];
      secondTask[0] = 'T2'; secondTask[9] = 'TI2'; secondTask[30] = 'T1';
      tabs.Tasks.rows.push({ rowNumber: 3, cells: secondTask, hash: sha('recomputed-by-helper') });

      const firstAssignment = tabs.TaskAssignments.rows[0];
      const secondAssignment = [...firstAssignment.cells];
      secondAssignment[0] = 'AS2'; secondAssignment[11] = 'AS1';
      tabs.TaskAssignments.rows.push({ rowNumber: 3, cells: secondAssignment, hash: sha('recomputed-by-helper') });
    }), undefined));

    expect(manifest.sourceRecords.flatMap((record) => record.errorCodes)).not.toEqual(expect.arrayContaining([
      'CYCLIC_TASK_PREREQUISITE', 'CYCLIC_ASSIGNMENT_PREDECESSOR',
    ]));
    expect(manifest.records.tasks).toHaveLength(2);
    expect(manifest.records.task_assignments).toHaveLength(2);
  });

  it('blocks full tuple mismatches between tasks, assignments, and completions', () => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.TaskAssignments.rows[0].cells[1] = 'OTHER-TASK';
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.blockingConflicts.map((item) => item.code)).toEqual(expect.arrayContaining([
      'TASK_INSTANCE_TUPLE_CONFLICT', 'ASSIGNMENT_TUPLE_CONFLICT',
    ]));
    expect(manifest.records.task_assignments).toEqual([]);
    expect(manifest.records.task_completions).toEqual([]);
  });

  it('validates exact Padlet fields and operation payload hashes while preserving signed snapshots', () => {
    const valid = makeSheets(3, (tabs) => {
      const row = tabs.TaskCompletions.rows[0].cells;
      row[6] = '-10'; row[7] = '0'; row[20] = payloadHash;
    });
    expect(createLegacyNormalizationManifest(input(valid, makeRedis())).records.task_completions[0]).toMatchObject({ balanceBefore: -10, balanceAfter: 0 });

    const invalid = makeSheets(3, (tabs) => { tabs.TaskCompletions.rows[0].cells[22] = 'BOARD-1'; });
    const manifest = createLegacyNormalizationManifest(input(invalid, undefined));
    expect(manifest.records.task_completions).toEqual([]);
    expect(manifest.blockingConflicts.map((item) => item.code)).toContain('MALFORMED_REQUIRED_HISTORY');
  });

  it('uses stable ordering and target IDs when semantically identified rows are permuted', () => {
    const second = makeSheets(3, (tabs) => {
      const first = tabs.Students.rows[0];
      const cells = ['S2', 'Bob', '0', 'INACTIVE'];
      tabs.Students.rows = [{ rowNumber: 3, cells, hash: sha(JSON.stringify(cells)) }, first];
    });
    const reversed = makeSheets(3, (tabs) => {
      const first = tabs.Students.rows[0];
      const cells = ['S2', 'Bob', '0', 'INACTIVE'];
      tabs.Students.rows = [first, { rowNumber: 3, cells, hash: sha(JSON.stringify(cells)) }];
    });
    const a = createLegacyNormalizationManifest(input(second, undefined));
    const b = createLegacyNormalizationManifest(input(reversed, undefined));
    expect(a.records.students).toEqual(b.records.students);
    expect(a.mappings.map(({ targetTable, targetId }) => [targetTable, targetId])).toEqual(b.mappings.map(({ targetTable, targetId }) => [targetTable, targetId]));
  });

  it('rejects duplicate allowed-student tokens before the shared task parser can deduplicate them', () => {
    const sheets = makeSheets(3, (tabs) => { tabs.Tasks.rows[0].cells[8] = 'S1, S1 '; });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.blockingConflicts.map((item) => item.code)).toContain('DUPLICATE_ALLOWED_STUDENT_ID');
    expect(manifest.records.tasks).toEqual([]);
    expect(manifest.records.task_allowed_students).toEqual([]);
  });

  it('stages the exact sorted canonical allowed-student token sequence when it is unique', () => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.Students.rows.push({ rowNumber: 3, cells: ['S2', 'Bob', '0', 'ACTIVE'], hash: sha('recomputed-by-helper') });
      tabs.Tasks.rows[0].cells[8] = ' S2 ; S1 ';
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(manifest.records.tasks[0].allowedStudentIds).toEqual(['S1', 'S2']);
    expect(manifest.records.task_allowed_students.map((row) => row.studentId).sort()).toEqual(['S1', 'S2']);
  });

  it('preserves signed and rewarding ADMIN history instead of applying carry-forward invariants', () => {
    const sheets = makeSheets(3, (tabs) => {
      const completion = tabs.TaskCompletions.rows[0].cells;
      completion[5] = '-10'; completion[6] = '90'; completion[7] = '80';
      completion[16] = 'ADMIN'; completion[19] = ''; completion[20] = '';
      completion.splice(21, 5, '', '', '', '', '');
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(manifest.records.task_completions[0]).toMatchObject({ source: 'ADMIN', reward: -10, balanceBefore: 90, balanceAfter: 80 });
  });

  it('accepts exact administrator and transaction-cancellation reset history while rejecting carry mutations', () => {
    const cancellation = makeSheets(3, (tabs) => {
      const completion = tabs.TaskCompletions.rows[0].cells;
      completion[5] = '10'; completion[6] = '90'; completion[7] = '80'; completion[8] = 'RESET';
      completion[16] = 'ADMIN_RESET';
      completion.splice(21, 5, '', '', '', '', '');
    });
    expect(createLegacyNormalizationManifest(input(cancellation, undefined)).records.task_completions[0])
      .toMatchObject({ source: 'ADMIN_RESET', status: 'RESET', reward: 10, balanceBefore: 90, balanceAfter: 80 });

    const carry = makeSheets(3, (tabs) => {
      const completion = tabs.TaskCompletions.rows[0].cells;
      completion[5] = '1'; completion[6] = '80'; completion[7] = '81'; completion[16] = 'CARRY_FORWARD';
      completion[19] = ''; completion[20] = ''; completion.splice(21, 5, '', '', '', '', '');
    });
    const blocked = createLegacyNormalizationManifest(input(carry, undefined));
    expect(blocked.records.task_completions).toEqual([]);
    expect(blocked.blockingConflicts.map((item) => item.code)).toContain('MALFORMED_REQUIRED_HISTORY');
  });

  it.each([
    ['cycleId', 11, 'OTHER-CYCLE'],
    ['cycleStartsAt', 12, '2026-08-31T01:00:00.000Z'],
    ['cycleEndsAt', 13, '2026-09-02T00:00:00.000Z'],
    ['ruleVersion', 14, '2'],
  ])('atomically quarantines assignment and completion on %s tuple mismatch', (_field, index, value) => {
    const sheets = makeSheets(3, (tabs) => {
      const completion = tabs.TaskCompletions.rows[0].cells;
      completion[index] = value; completion[19] = ''; completion[20] = '';
      completion.splice(21, 5, '', '', '', '', '');
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.blockingConflicts.map((item) => item.code)).toContain('ASSIGNMENT_TUPLE_CONFLICT');
    expect(manifest.records.task_assignments).toEqual([]);
    expect(manifest.records.task_completions).toEqual([]);
  });

  it('propagates broken references to a fixed point through tasks and dependent ledgers', () => {
    const sheets = makeSheets(3, (tabs) => {
      const prerequisite = tabs.Tasks.rows[0];
      prerequisite.cells[8] = 'MISSING-STUDENT';
      const dependent = [...prerequisite.cells];
      dependent[0] = 'T2'; dependent[9] = 'TI2'; dependent[30] = 'T1'; dependent[8] = '';
      tabs.Tasks.rows.push({ rowNumber: 3, cells: dependent, hash: sha('recomputed-by-helper') });
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));
    expect(manifest.records.tasks).toEqual([]);
    expect(manifest.records.task_assignments).toEqual([]);
    expect(manifest.records.task_completions).toEqual([]);
    expect(manifest.blockingConflicts.map((item) => item.code)).toEqual(expect.arrayContaining([
      'BROKEN_ALLOWED_STUDENT_REFERENCE', 'BROKEN_TASK_REFERENCE',
    ]));
  });

  it('quarantines identical same-source Redis claim and binding duplicates instead of folding them', () => {
    const redis = redisArtifact((artifact) => {
      artifact.v2Claims = [structuredClone(artifact.v2Claims[0]), structuredClone(artifact.v2Claims[0])];
      artifact.operationBindings = [structuredClone(artifact.operationBindings[0]), structuredClone(artifact.operationBindings[0])];
    });
    const normalized = normalizeLegacySnapshots(input(makeSheets(), redis));
    expect(normalized.records.padlet_evidence_claims).toEqual([]);
    expect(normalized.records.legacy_operation_bindings).toEqual([]);
    expect(normalized.sourceRecords.filter((row) => row.source.kind === 'REDIS' && row.mappingStatus === 'QUARANTINED')).toHaveLength(4);
  });

  it.each([
    ['binding without claim', (redis: MutableRedisFixture) => { redis.v2Claims = []; }],
    ['claim without binding', (redis: MutableRedisFixture) => { redis.operationBindings = []; }],
  ])('quarantines an unmatched Redis %s', (_label, mutate) => {
    const normalized = normalizeLegacySnapshots(input(makeSheets(3, (tabs) => { tabs.TaskCompletions.rows = []; }), redisArtifact(mutate)));
    expect(normalized.records.padlet_evidence_claims).toEqual([]);
    expect(normalized.records.legacy_operation_bindings ?? []).toEqual([]);
  });

  it('stages an authentic zero-item cancellation reversal linked to its cancelled original', () => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.Transactions.rows[0].cells[8] = 'CANCELLED';
      tabs.Transactions.rows.push({
        rowNumber: 3,
        cells: ['CANCEL-TX1', '2026-09-01T00:00:00.000Z', 'S1', 'Alice', '[]', '-20', '80', '100', 'CANCEL_REVERSAL', 'cancel:TX1'],
        hash: sha('recomputed-by-helper'),
      });
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));

    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(manifest.records.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ transactionId: 'TX1', status: 'CANCELLED' }),
      expect.objectContaining({
        transactionId: 'CANCEL-TX1', kind: 'CANCELLATION', totalAmount: -20,
        balanceDelta: 20, reversesTransactionId: 'TX1', status: 'CANCEL_REVERSAL',
      }),
    ]));
    expect(manifest.records.transaction_items).toHaveLength(1);
  });

  it.each([
    ['missing original', (cells: string[]) => { cells[9] = 'cancel:MISSING'; }],
    ['self reversal', (cells: string[]) => { cells[9] = 'cancel:CANCEL-TX1'; }],
    ['bad sign', (cells: string[]) => { cells[5] = '20'; }],
    ['bad arithmetic', (cells: string[]) => { cells[7] = '99'; }],
  ])('atomically blocks malformed cancellation history for %s', (_label, corrupt) => {
    const sheets = makeSheets(3, (tabs) => {
      tabs.Transactions.rows[0].cells[8] = 'CANCELLED';
      const cells = ['CANCEL-TX1', '2026-09-01T00:00:00.000Z', 'S1', 'Alice', '[]', '-20', '80', '100', 'CANCEL_REVERSAL', 'cancel:TX1'];
      corrupt(cells);
      tabs.Transactions.rows.push({ rowNumber: 3, cells, hash: sha('recomputed-by-helper') });
    });
    const manifest = createLegacyNormalizationManifest(input(sheets, undefined));

    expect(manifest.status).toBe('BLOCKED');
    expect(manifest.records.transactions).toEqual([]);
    expect(manifest.mappings.some((mapping) => mapping.targetTable === 'transactions'
      || mapping.targetTable === 'transaction_items')).toBe(false);
    expect(manifest.blockingConflicts.map(({ code }) => code)).toContain('MALFORMED_CANCELLATION_HISTORY');
  });

  it('accepts only exact legacy and exact extended transaction item snapshots', () => {
    const extended = {
      productId: 'P1', name: 'Pencil', price: 20, quantity: 1, subtotal: 20,
      regularUnitPrice: 20, regularTotal: 20, totalQuantity: 1, paidQuantity: 1,
      freeQuantity: 0, finalTotal: 20, totalDiscount: 0, adjustments: [], appliedPromotions: [],
    };
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      tabs.Transactions.rows[0].cells[4] = JSON.stringify([extended]);
    }), undefined));
    expect(manifest.status).toBe('READY_FOR_IMPORT');
    expect(manifest.records.transaction_items[0]).toMatchObject(extended);
    expect(Object.keys(manifest.records.transaction_items[0]).sort()).toEqual([
      'adjustments', 'appliedPromotions', 'finalTotal', 'freeQuantity', 'itemId', 'lineNumber', 'name',
      'paidQuantity', 'price', 'productId', 'quantity', 'regularTotal', 'regularUnitPrice', 'subtotal',
      'tenantId', 'totalDiscount', 'totalQuantity', 'transactionId',
    ].sort());
  });

  it.each([
    ['bad arithmetic', { productId: 'P1', name: 'Pencil', price: 20, quantity: 2, subtotal: 20 }],
    ['partial snapshot', { productId: 'P1', name: 'Pencil', price: 20, quantity: 1, subtotal: 20, regularUnitPrice: 20 }],
    ['unknown secret field', { productId: 'P1', name: 'Pencil', price: 20, quantity: 1, subtotal: 20, secretToken: 'do-not-copy' }],
  ])('atomically quarantines a transaction and malformed item for %s', (_label, item) => {
    const manifest = createLegacyNormalizationManifest(input(makeSheets(3, (tabs) => {
      tabs.Transactions.rows[0].cells[4] = JSON.stringify([item]);
    }), undefined));
    expect(manifest.records.transactions).toEqual([]);
    expect(manifest.records.transaction_items).toEqual([]);
    expect(manifest.blockingConflicts.map((entry) => entry.code)).toContain('MALFORMED_REQUIRED_HISTORY');
    expect(JSON.stringify(manifest)).not.toContain('do-not-copy');
  });

  it('detaches and deeply freezes output without mutating either snapshot', () => {
    const sheets = makeSheets();
    const before = JSON.stringify(sheets);
    const manifest = createLegacyNormalizationManifest(input(sheets));
    expect(JSON.stringify(sheets)).toBe(before);
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.records)).toBe(true);
    expect(Object.isFrozen(manifest.records.students[0])).toBe(true);
    expect(() => (manifest.records.students as unknown[]).push({})).toThrow();
  });

  it('throws generic errors for structural corruption, prototype pollution, and output bounds', () => {
    const polluted = JSON.parse('{"snapshotVersion":1,"__proto__":{"polluted":true}}');
    expect(() => createLegacyNormalizationManifest({ ...input(), sheets: polluted as never })).toThrow('Legacy migration input is structurally invalid.');
    const huge = makeSheets(3, (tabs) => {
      tabs.Students.rows = Array.from({ length: 10_001 }, (_, i) => ({ rowNumber: i + 2, cells: [`S${i}`, 'A', '0', 'ACTIVE'], hash: sha(String(i)) }));
    });
    expect(() => createLegacyNormalizationManifest(input(huge, undefined))).toThrow('Legacy migration input exceeds normalization bounds.');
  });
});