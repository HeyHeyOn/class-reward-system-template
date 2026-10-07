// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { captureSheetsSnapshot, type SheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot, type RedisClaimSnapshot } from './redisClaimSnapshot';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { canonicalJson, sha256 } from './validators';
import { makeRedis, makeSheets, makeSupportedSheets } from './__fixtures__/normalization';
import { verifyLocalCapturedSourceCoverage } from './localCapturedSourceCoverage';

// Environment marker only: capture, validation and normalization are real.
vi.mock('server-only', () => ({}));
const TENANT = '10000000-0000-4000-8000-000000000019';
const JOB = '20000000-0000-4000-8000-000000000019';
const AT = '2026-09-01T00:00:00.000Z';
const V1 = sha256('synthetic-v1-tuple');
const ORPHAN = sha256('synthetic-orphan-tuple');
type Capture = { tenantId: string; migrationJobId: string; sheets: SheetsSnapshot; redis?: RedisClaimSnapshot };
type Input = { capture: Capture; manifest: LegacyNormalizationManifest };
type DraftManifest = { -readonly [K in keyof Omit<LegacyNormalizationManifest, 'manifestDigest'>]: LegacyNormalizationManifest[K] };
type Workbook = Record<string, string[][]>;
// Explicit fixture ledger, NOT calculated from normalization or the checker.
const SHEET_COUNTS = {
  Adjustments: 1, Products: 1, PromotionProducts: 1, Promotions: 1, Settings: 5,
  Students: 1, TaskAssignments: 2, TaskCompletions: 1, Tasks: 1, Transactions: 2,
};
const REDIS_FAMILIES = ['REDIS_V2_CLAIMS', 'REDIS_OPERATION_BINDINGS', 'REDIS_V1_TOMBSTONES', 'REDIS_ORPHANED_CLAIMS'] as const;

async function fixture(options: {
  bank?: boolean; redis?: 'all' | 'empty' | 'unobserved'; version?: 1 | 2 | 3;
  mutate?: (workbook: Workbook) => void;
} = {}): Promise<Input> {
  const seed = options.bank ? makeSheets(options.version) : makeSupportedSheets(options.version);
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([name, tab]) =>
    [name, [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  options.mutate?.(workbook);
  let sheetRevisions = 0;
  const sheets = await captureSheetsSnapshot({ spreadsheetId: 'synthetic-source-pointer-workbook', capturedAt: AT,
    reader: { listSheetNames: async () => Object.keys(workbook),
      getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => { sheetRevisions++; return 'synthetic-sheet-revision'; } } });
  expect(sheetRevisions).toBe(2);
  const capture: Capture = { tenantId: TENANT, migrationJobId: JOB, sheets };
  if (options.redis !== 'unobserved') {
    const operation = makeRedis().operationBindings[0];
    const entries: Array<readonly [string, string]> = options.redis === 'empty' ? [] : [
      [operation.claimField, operation.operationId],
      [`op:${sha256(operation.operationId)}`, JSON.stringify({ binding: operation.binding, claimField: operation.claimField })],
      [`claim:${ORPHAN}`, 'synthetic-orphan-owner'],
    ];
    let hscans = 0, scans = 0, gets = 0, revisions = 0;
    capture.redis = await captureRedisClaimSnapshot({
      hscan: async (key, cursor) => {
        expect([key, cursor]).toEqual(['padlet:evidence-bindings:v2', '0']); hscans++;
        return { cursor: '0', entries: structuredClone(entries) };
      },
      scan: async (cursor, match) => {
        expect([cursor, match]).toEqual(['0', 'padlet:evidence-claim:v1:*']); scans++;
        return { cursor: '0', keys: options.redis === 'empty' ? [] : [`padlet:evidence-claim:v1:${V1}`] };
      },
      get: async (key) => { expect(key).toBe(`padlet:evidence-claim:v1:${V1}`); gets++; return 'synthetic-v1-owner'; },
      getRevision: async () => { revisions++; return 'synthetic-redis-revision'; },
    }, { capturedAt: AT });
    expect([hscans, scans, gets, revisions]).toEqual([1, 1, options.redis === 'empty' ? 0 : 1, 2]);
  }
  const manifest = createLegacyNormalizationManifest(capture);
  // BLOCKED BANK history is deliberately retained; never rewrite it into READY.
  if (!options.bank && !options.mutate) expect(manifest.status).toBe('READY_FOR_IMPORT');
  return { capture, manifest };
}
function rewrite(input: Input, change: (draft: DraftManifest) => void): Input {
  const draft: DraftManifest = structuredClone(input.manifest);
  Reflect.deleteProperty(draft, 'manifestDigest');
  change(draft);
  return { capture: input.capture, manifest: { ...draft, manifestDigest: sha256(canonicalJson(draft)) } };
}
function sealed<T extends { digest: string }>(value: T): T {
  const body = { ...value }; Reflect.deleteProperty(body, 'digest');
  return { ...body, digest: sha256(canonicalJson(body)) };
}
function redisPointer(input: Input, family: typeof REDIS_FAMILIES[number]) {
  const redis = input.capture.redis!;
  const value = family === 'REDIS_V2_CLAIMS' ? redis.v2Claims[0]
    : family === 'REDIS_OPERATION_BINDINGS' ? redis.operationBindings[0]
      : family === 'REDIS_V1_TOMBSTONES' ? redis.v1Tombstones[0] : redis.orphanedClaimDigests[0];
  return { kind: 'REDIS' as const, artifactDigest: redis.digest,
    provenance: typeof value === 'string' ? 'upstash:padlet:evidence-bindings:v2:orphan' : value.sourceProvenance,
    sourceDigest: sha256(typeof value === 'string' ? value : canonicalJson(value)) };
}
function family(result: ReturnType<typeof verifyLocalCapturedSourceCoverage>, name: string) {
  const row = result.families.find((row) => row.family === name);
  expect(row).toBeDefined(); return row!;
}
const flags = {
  scope: 'CAPTURED_SOURCE_POINTER_ACCOUNTING_ONLY', authority: 'NONAUTHORITY', complete: false,
  activationAllowed: false, exclusion: 'NOT_PROVEN', fullSourceReconciliation: 'NOT_PERFORMED',
  fullTargetReconciliation: 'NOT_PERFORMED', preRedactionInventory: 'NOT_OBSERVED',
  canonicalBusinessValidation: 'NOT_PERFORMED', contributorMultiplicityValidation: 'NOT_PERFORMED',
  binding: 'CONTENT_DIGESTS_ONLY',
};

describe('CAPTURED_SOURCE_POINTER_ACCOUNTING_ONLY (synthetic, not source completeness)', () => {
  it('accounts for each independently listed Sheet/Redis family without granting authority', async () => {
    const input = await fixture();
    const result = verifyLocalCapturedSourceCoverage(input);
    expect(result).toMatchObject({ ...flags, status: 'CAPTURE_POINTERS_ACCOUNTED', pointerAccounting: 'ACCOUNTED',
      normalizationStatus: 'READY_FOR_IMPORT', diagnostics: [], omittedDiagnostics: 0 });
    expect(Object.fromEntries(result.families.filter((r) => r.kind === 'SHEET').map((r) => [r.family, r.expectedSourceUnits])))
      .toEqual(Object.fromEntries(Object.entries(SHEET_COUNTS).map(([name, count]) => [`SHEET:${name}`, count])));
    for (const name of REDIS_FAMILIES) {
      expect(family(result, name)).toMatchObject({ presence: 'PRESENT_NONEMPTY', expectedSourceUnits: 1,
        referencedSourceUnits: 1, sourceRecordReferences: 1 });
      const pointerDigest = sha256(canonicalJson(redisPointer(input, name)));
      expect(result.units.find((u) => u.pointerDigest === pointerDigest)).toMatchObject({ family: name, sourceRecordReferences: 1 });
    }
    expect(result.units.every((u) => u.sourceRecordReferences > 0)).toBe(true);
  });

  it.each(Object.keys(SHEET_COUNTS))('detects omission of all %s normalized sources despite removal of related outputs', async (tab) => {
    const input = await fixture();
    const changed = rewrite(input, (m) => {
      const removed = m.sourceRecords.filter((r) => r.source.kind === 'SHEET' && r.source.tab === tab);
      const digests = new Set(removed.map((r) => r.source.kind === 'SHEET' ? r.source.rowHash : ''));
      m.sourceRecords = m.sourceRecords.filter((r) => !(r.source.kind === 'SHEET' && r.source.tab === tab));
      m.mappings = m.mappings.filter((r) => !digests.has(r.sourceDigest));
      m.records = {}; // Neither output records nor their absent counterparts may define the denominator.
    });
    expect(changed.capture).toBe(input.capture);
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, status: 'BLOCKED', pointerAccounting: 'MISMATCH' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_CAPTURE_SOURCE' }));
    expect(family(result, `SHEET:${tab}`)).toMatchObject({
      expectedSourceUnits: SHEET_COUNTS[tab as keyof typeof SHEET_COUNTS], referencedSourceUnits: 0,
    });
  });

  it.each(REDIS_FAMILIES)('detects independently inventoried %s omission', async (name) => {
    const input = await fixture();
    const pointer = redisPointer(input, name);
    const changed = rewrite(input, (m) => {
      m.sourceRecords = m.sourceRecords.filter((r) => canonicalJson(r.source) !== canonicalJson(pointer));
      m.records = {}; m.mappings = [];
    });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result.status).toBe('BLOCKED');
    expect(result.diagnostics).toContainEqual({ code: 'MISSING_CAPTURE_SOURCE', referenceDigest: sha256(canonicalJson(pointer)) });
    expect(family(result, name)).toMatchObject({ expectedSourceUnits: 1, referencedSourceUnits: 0 });
  });

  it('refuses same-count binding-to-claim pointer substitution, not merely aggregate counts', async () => {
    const input = await fixture();
    const from = redisPointer(input, 'REDIS_OPERATION_BINDINGS'), to = redisPointer(input, 'REDIS_V2_CLAIMS');
    const changed = rewrite(input, (m) => {
      m.sourceRecords = m.sourceRecords.map((r) => canonicalJson(r.source) === canonicalJson(from) ? { ...r, source: to } : r);
    });
    expect(changed.manifest.sourceRecords).toHaveLength(input.manifest.sourceRecords.length);
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result.status).toBe('BLOCKED');
    expect(family(result, 'REDIS_OPERATION_BINDINGS').referencedSourceUnits).toBe(0);
    expect(family(result, 'REDIS_V2_CLAIMS').sourceRecordReferences).toBe(2);
  });

  it('preserves literal tab and row-position identity despite identical row hashes', async () => {
    const input = await fixture({ mutate: (w) => {
      w.Notes = [['unknown'], ['same'], ['same']]; w[' Notes'] = [['unknown'], ['same']]; w['Notes '] = [['unknown'], ['same']];
    } });
    const result = verifyLocalCapturedSourceCoverage(input);
    const unknown = result.families.filter((r) => r.review === 'UNREVIEWED_FAMILY');
    expect(unknown).toHaveLength(3);
    expect(unknown.map((r) => r.familyDigest).sort()).toEqual(['Notes', ' Notes', 'Notes '].map((name) => sha256(name)).sort());
    expect(unknown.map((r) => r.expectedSourceUnits).sort()).toEqual([1, 1, 2]);
    const notes = input.capture.sheets.tabs.Notes;
    expect(notes.rows[0].hash).toBe(notes.rows[1].hash);
    const changed = rewrite(input, (m) => {
      m.sourceRecords = m.sourceRecords.map((r) => r.source.kind === 'SHEET' && r.source.tab === 'Notes' && r.source.rowNumber === 3
        ? { ...r, source: { ...r.source, rowNumber: 2 } } : r);
    });
    const missing = verifyLocalCapturedSourceCoverage(changed);
    expect(missing.status).toBe('BLOCKED');
    expect(missing.diagnostics.filter((d) => d.code === 'MISSING_CAPTURE_SOURCE')).toHaveLength(1);
  });

  it('distinguishes absent optional, empty known, empty unknown, and unobserved Redis', async () => {
    const input = await fixture({ redis: 'unobserved', mutate: (w) => {
      delete w.Promotions; w.PromotionProducts = [w.PromotionProducts[0]]; w.Notes = [['unknown']];
    } });
    const result = verifyLocalCapturedSourceCoverage(input);
    expect(result).toMatchObject({ ...flags, status: 'BLOCKED', pointerAccounting: 'INCOMPLETE' });
    expect(family(result, 'SHEET:Promotions')).toMatchObject({ presence: 'ABSENT_IN_CAPTURE', expectedSourceUnits: null });
    expect(family(result, 'SHEET:PromotionProducts')).toMatchObject({ presence: 'PRESENT_EMPTY', expectedSourceUnits: 0 });
    expect(family(result, 'SHEET:UNREVIEWED')).toMatchObject({ presence: 'PRESENT_EMPTY', review: 'UNREVIEWED_FAMILY' });
    for (const name of REDIS_FAMILIES) expect(family(result, name)).toMatchObject({ presence: 'NOT_OBSERVED', expectedSourceUnits: null });
    expect(result.diagnostics).toContainEqual({ code: 'REDIS_NOT_OBSERVED' });
  });

  it.each(['Notes', ' Notes', 'Notes '])('detects the wholly omitted unreviewed literal tab "%s"', async (tab) => {
    const input = await fixture({ mutate: (w) => { w[tab] = [['future'], ['private-unreviewed-value']]; } });
    const changed = rewrite(input, (m) => {
      m.sourceRecords = m.sourceRecords.filter((r) => r.source.kind !== 'SHEET' || r.source.tab !== tab);
      m.records = {}; m.mappings = [];
    });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, status: 'BLOCKED', missingSourceUnits: 1 });
    expect(family(result, 'SHEET:UNREVIEWED')).toMatchObject({ familyDigest: sha256(tab),
      review: 'UNREVIEWED_FAMILY', expectedSourceUnits: 1, referencedSourceUnits: 0 });
    expect(JSON.stringify(result)).not.toContain('private-unreviewed-value');
  });

  it('caps diagnostics without hiding their exact omitted count or changing failure status', async () => {
    const rows = 140;
    const input = await fixture({ mutate: (w) => { w.Notes = [['future'], ...Array.from({ length: rows }, () => ['same'])]; } });
    const changed = rewrite(input, (m) => {
      m.sourceRecords = m.sourceRecords.filter((r) => r.source.kind !== 'SHEET' || r.source.tab !== 'Notes');
    });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, status: 'BLOCKED', missingSourceUnits: rows });
    expect(result.diagnostics).toHaveLength(128);
    expect(result.omittedDiagnostics).toBe(rows - result.diagnostics.length);
  });

  it('does not treat a validated empty Redis capture as unobserved', async () => {
    const result = verifyLocalCapturedSourceCoverage(await fixture({ redis: 'empty' }));
    expect(result.status).toBe('CAPTURE_POINTERS_ACCOUNTED');
    for (const name of REDIS_FAMILIES) expect(family(result, name)).toMatchObject({ presence: 'PRESENT_EMPTY', expectedSourceUnits: 0 });
  });

  it.each([1, 2] as const)('retains schema-v%s optional absence rather than inventing empty source families', async (version) => {
    const result = verifyLocalCapturedSourceCoverage(await fixture({ version }));
    expect(family(result, 'SHEET:Promotions').presence).toBe('ABSENT_IN_CAPTURE');
    expect(family(result, 'SHEET:PromotionProducts').presence).toBe('ABSENT_IN_CAPTURE');
  });

  it('retains true BANK quarantine and observes Sheet base/claim fan-out without claiming multiplicity validity', async () => {
    const input = await fixture({ bank: true });
    expect(input.manifest.status).toBe('BLOCKED');
    expect(input.manifest.quarantines.some((r) => r.errorCodes.includes('UNSUPPORTED_LEGACY_BANK_AUTHORITY'))).toBe(true);
    const result = verifyLocalCapturedSourceCoverage(input);
    expect(result).toMatchObject({ ...flags, status: 'BLOCKED', pointerAccounting: 'ACCOUNTED', normalizationStatus: 'BLOCKED' });
    expect(family(result, 'SHEET:TaskCompletions')).toMatchObject({ expectedSourceUnits: 1, sourceRecordReferences: 2, quarantinedReferences: 2 });
  });

  it('keeps omitted Settings and unknown columns visibly unresolved, not source-free', async () => {
    const input = await fixture({ mutate: (w) => {
      w.Settings.push(['customSetting', 'private-looking-customer-value']);
      w.Products[0].push('futureColumn'); w.Products[1].push('future-value');
    } });
    const result = verifyLocalCapturedSourceCoverage(input);
    expect(family(result, 'SHEET:Settings')).toMatchObject({ expectedSourceUnits: 6 });
    expect(family(result, 'SHEET:Settings').warningReferences).toBeGreaterThan(0);
    expect(family(result, 'SHEET:Products').warningReferences).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('private-looking-customer-value');
    expect(JSON.stringify(result)).not.toContain('future-value');
  });

  it('reports foreign or nonexistent exact pointers without echoing source contents', async () => {
    const input = await fixture();
    const changed = rewrite(input, (m) => {
      m.sourceRecords = m.sourceRecords.map((r, index) => index ? r : { ...r, source: {
        kind: 'SHEET', artifactDigest: input.capture.sheets.digest, tab: 'do-not-echo-this-tab', rowNumber: 999, rowHash: sha256('unknown'),
      } });
    });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result.status).toBe('BLOCKED');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNEXPECTED_SOURCE_POINTER' }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_CAPTURE_SOURCE' }));
    expect(JSON.stringify(result)).not.toContain('do-not-echo-this-tab');
  });

  it.each(['tenant', 'job', 'sheetArtifact', 'redisArtifact', 'revision', 'credential', 'manifestDigest'] as const)('fails closed on %s binding mismatch', async (which) => {
    const input = await fixture();
    const changed = rewrite(input, (m) => {
      if (which === 'tenant') m.tenantId = '10000000-0000-4000-8000-000000000020';
      if (which === 'job') m.migrationJobId = '20000000-0000-4000-8000-000000000020';
      if (which === 'sheetArtifact') m.sourceArtifacts = { ...m.sourceArtifacts, sheets: { ...m.sourceArtifacts.sheets, digest: 'a'.repeat(64) } };
      if (which === 'redisArtifact') m.sourceArtifacts = { ...m.sourceArtifacts, redis: { ...m.sourceArtifacts.redis!, digest: 'b'.repeat(64) } };
      if (which === 'revision') m.sourceArtifacts = { ...m.sourceArtifacts, sheets: { ...m.sourceArtifacts.sheets, revisionDigest: 'c'.repeat(64) } };
      if (which === 'credential') m.sourceArtifacts = { ...m.sourceArtifacts, sheets: { ...m.sourceArtifacts.sheets, credentialHashes: {} } };
    });
    if (which === 'manifestDigest') changed.manifest = { ...changed.manifest, manifestDigest: 'd'.repeat(64) };
    expect(() => verifyLocalCapturedSourceCoverage(changed)).toThrow(/binding/i);
  });

  it.each(['sheet', 'redis', 'row', 'requiredTab', 'optionalDeclaration'] as const)('rejects invalid %s capture before pointer accounting', async (which) => {
    const input = await fixture();
    const changed: Input = structuredClone(input);
    if (which === 'sheet') changed.capture.sheets = { ...changed.capture.sheets, digest: 'a'.repeat(64) };
    if (which === 'redis') changed.capture.redis = { ...changed.capture.redis!, digest: 'b'.repeat(64) };
    if (which === 'row') {
      const tabs = { ...changed.capture.sheets.tabs, Products: { ...changed.capture.sheets.tabs.Products,
        rows: changed.capture.sheets.tabs.Products.rows.map((r) => ({ ...r, hash: 'c'.repeat(64) })) } };
      changed.capture.sheets = sealed({ ...changed.capture.sheets, tabs });
    }
    if (which === 'requiredTab') {
      const tabs = { ...changed.capture.sheets.tabs }; delete tabs.Students;
      changed.capture.sheets = sealed({ ...changed.capture.sheets, tabs });
    }
    if (which === 'optionalDeclaration') changed.capture.sheets = sealed({ ...changed.capture.sheets, missingOptionalTabs: ['Promotions'] });
    expect(() => verifyLocalCapturedSourceCoverage(changed)).toThrow(/input/i);
  });

  it('rejects Redis omission when the supplied manifest still binds a Redis acquisition', async () => {
    const input = await fixture();
    const { redis, ...capture } = input.capture; expect(redis).toBeDefined();
    expect(() => verifyLocalCapturedSourceCoverage({ capture, manifest: input.manifest })).toThrow(/binding/i);
  });

  it.each(['sheetArtifact', 'rowHash', 'redisArtifact', 'redisProvenance', 'redisDigest'] as const)('detects %s pointer corruption even with an exact manifest/acquisition binding', async (which) => {
    const input = await fixture();
    const changed = rewrite(input, (m) => {
      let modified = false;
      m.sourceRecords = m.sourceRecords.map((r) => {
        if (modified) return r;
        if ((which === 'sheetArtifact' || which === 'rowHash') && r.source.kind === 'SHEET') {
          modified = true;
          return { ...r, source: { ...r.source, [which === 'rowHash' ? 'rowHash' : 'artifactDigest']: 'a'.repeat(64) } };
        }
        if (which.startsWith('redis') && r.source.kind === 'REDIS') {
          modified = true;
          return { ...r, source: { ...r.source, [which === 'redisDigest' ? 'sourceDigest'
            : which === 'redisArtifact' ? 'artifactDigest' : 'provenance']: which === 'redisProvenance' ? 'other:namespace' : 'b'.repeat(64) } };
        }
        return r;
      });
      expect(modified).toBe(true);
    });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, status: 'BLOCKED', missingSourceUnits: 1, unexpectedSourceReferences: 1 });
  });

  it('does not confuse recapture semantic equality with exact artifact binding', async () => {
    const input = await fixture();
    const capture = { ...input.capture, sheets: sealed({ ...input.capture.sheets, sourceRevision: 'new-revision' }),
      redis: sealed({ ...input.capture.redis!, sourceRevision: 'new-revision' }) };
    expect(() => verifyLocalCapturedSourceCoverage({ capture, manifest: input.manifest })).toThrow(/binding/i);
    const manifest = createLegacyNormalizationManifest(capture);
    expect(manifest.sourceFingerprint).toBe(input.manifest.sourceFingerprint);
    expect(verifyLocalCapturedSourceCoverage({ capture, manifest }).status).toBe('CAPTURE_POINTERS_ACCOUNTED');
  });

  it('documents the intentional nested-target limitation instead of certifying canonical business data', async () => {
    const input = await fixture();
    const changed = rewrite(input, (m) => { m.records = { ...m.records, transaction_items: [], task_allowed_students: [] }; });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, status: 'CAPTURE_POINTERS_ACCOUNTED' });
  });

  it('explicitly does NOT certify reference multiplicity when a known pointer is duplicated', async () => {
    const input = await fixture();
    const changed = rewrite(input, (m) => { m.sourceRecords = [...m.sourceRecords, m.sourceRecords[0]]; });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, status: 'CAPTURE_POINTERS_ACCOUNTED',
      sourceRecordReferences: input.manifest.sourceRecords.length + 1 });
  });

  it('explicitly cannot prove derived-claim fan-out when its base Sheet pointer still exists', async () => {
    const input = await fixture({ bank: true });
    const changed = rewrite(input, (m) => {
      let seen = false;
      m.sourceRecords = m.sourceRecords.filter((r) => {
        if (r.source.kind !== 'SHEET' || r.source.tab !== 'TaskCompletions') return true;
        if (seen) return false;
        seen = true; return true;
      });
      m.quarantines = m.sourceRecords.filter((r) => r.mappingStatus === 'QUARANTINED');
    });
    const result = verifyLocalCapturedSourceCoverage(changed);
    expect(result).toMatchObject({ ...flags, pointerAccounting: 'ACCOUNTED', status: 'BLOCKED', normalizationStatus: 'BLOCKED' });
    expect(family(result, 'SHEET:TaskCompletions').sourceRecordReferences).toBe(1);
  });

  it('is independent of source-record traversal order, while retaining the exact changed manifest digest', async () => {
    const input = await fixture();
    const changed = rewrite(input, (m) => { m.sourceRecords = [...m.sourceRecords].reverse(); });
    const original = verifyLocalCapturedSourceCoverage(input), reordered = verifyLocalCapturedSourceCoverage(changed);
    expect(reordered.manifestDigest).not.toBe(original.manifestDigest);
    expect(reordered.units).toEqual(original.units); expect(reordered.families).toEqual(original.families);
    expect(reordered.diagnostics).toEqual(original.diagnostics);
  });

  it('cannot recover an optional family removed before capture; does not report it as empty or complete', async () => {
    const input = await fixture({ mutate: (w) => { delete w.Promotions; delete w.PromotionProducts; } });
    const result = verifyLocalCapturedSourceCoverage(input);
    expect(result).toMatchObject(flags);
    expect(family(result, 'SHEET:Promotions')).toMatchObject({ presence: 'ABSENT_IN_CAPTURE', expectedSourceUnits: null });
  });

  it('does not mutate/freeze inputs and returns detached deeply frozen redacted output', async () => {
    const input = structuredClone(await fixture());
    const before = canonicalJson(input);
    const result = verifyLocalCapturedSourceCoverage(input);
    expect(canonicalJson(input)).toBe(before); expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.families)).toBe(true);
    expect(result.units.every(Object.isFrozen)).toBe(true);
    const encoded = JSON.stringify(result);
    for (const secret of ['Alice', 'Pencil', 'original assignment note', 'synthetic-source-pointer-workbook', input.capture.sheets.credentialHashes.adminPasswordHash!]) {
      expect(encoded).not.toContain(secret);
    }
  });

  it.each(['accessor', 'proxy', 'symbol', 'sparse', 'cycle', 'prototype', 'nonfinite'] as const)('rejects unsafe %s graphs without reading attacker getters/traps', async (kind) => {
    const input: Record<string, unknown> = structuredClone(await fixture()); let reads = 0;
    if (kind === 'accessor') Object.defineProperty(input, 'capture', { enumerable: true, get: () => { reads++; throw Error('getter leaked'); } });
    if (kind === 'proxy') input.capture = new Proxy({}, { ownKeys: () => { reads++; throw Error('trap leaked'); } });
    if (kind === 'symbol') input[Symbol('hidden') as unknown as string] = 'hidden';
    if (kind === 'sparse') input.capture = new Array(2);
    if (kind === 'cycle') input.extra = input;
    if (kind === 'prototype') input.capture = new Date();
    if (kind === 'nonfinite') input.extra = Infinity;
    expect(() => verifyLocalCapturedSourceCoverage(input)).toThrow(/input/i);
    expect(reads).toBe(0);
  });

  it.each(['string', 'text', 'array', 'keys', 'depth', 'nodes'] as const)('enforces local %s admission bounds before binding work', async (kind) => {
    const input: Record<string, unknown> = structuredClone(await fixture());
    if (kind === 'string') input.extra = 'x'.repeat(8_193);
    if (kind === 'text') input.extra = Array.from({ length: 129 }, () => 'x'.repeat(8_192));
    if (kind === 'array') input.extra = new Array(4_097);
    if (kind === 'keys') input.extra = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, null]));
    if (kind === 'depth') { let v: unknown = null; for (let i = 0; i < 26; i++) v = [v]; input.extra = v; }
    if (kind === 'nodes') input.extra = Array.from({ length: 512 }, () => Array.from({ length: 256 }, () => null));
    expect(() => verifyLocalCapturedSourceCoverage(input)).toThrow(/limit/i);
  });
});
