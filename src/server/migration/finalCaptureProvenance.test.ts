// @vitest-environment node
// Synthetic regression for audit C-PROV-01, NOT a migration/activation gate.
// Run only: vitest run src/server/migration/finalCaptureProvenance.test.ts
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { stageLegacyFinalGeneration } from './finalGeneration';
import { createLegacyNormalizationManifest, type LegacyNormalizationManifest } from './manifest';
import { normalizeLegacySnapshots, type SourcePointer } from './normalize';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot, type RedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeSheets, makeRedis } from './__fixtures__/normalization';
import { assertManifestInputShape, assertNormalizationInput, canonicalJson, deterministicId, isPlainRecord, isHexDigest, sha256 } from './validators';

vi.mock('server-only', () => ({}));
// Fail closed if a type-only reference or future pure dependency imports a DB writer.
vi.mock('./finalGeneration', () => { throw new Error('Unexpected final-generation writer import'); });
vi.mock('./importer', () => { throw new Error('Unexpected importer runtime import'); });
vi.mock('@/server/db/transaction', () => { throw new Error('Unexpected DB runtime import'); });

type Manifest = LegacyNormalizationManifest;
type Plan = Awaited<ReturnType<typeof stageLegacyFinalGeneration>>['plan'];
type Acquisition = Readonly<{ sheets: Awaited<ReturnType<typeof captureSheetsSnapshot>>; redis: RedisClaimSnapshot }>;
type Planner = {
  delta: (before: Manifest, after: Manifest) => Plan;
  retainedContributors: (manifest: Manifest, table: string, row: Readonly<Record<string, unknown>>, keys: readonly string[]) => string;
};
const TENANT = '60000000-0000-4000-8000-000000000001';
const JOB = '60000000-0000-4000-8000-000000000019';
const FIRST = '2026-09-02T00:00:00.000Z';
const SECOND = '2026-09-03T00:00:00.000Z';
const CLAIMS = 'padlet_evidence_claims';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const digest = (value: unknown) => hash(canonicalJson(value));
const files = ['finalGeneration.ts', 'normalize.ts', 'manifest.ts', 'validators.ts', 'sheetsSnapshot.ts',
  'redisClaimSnapshot.ts', 'operationalProjection.ts', '__fixtures__/normalization.ts', 'finalCaptureProvenance.test.ts'];
const sourceHashes = () => Object.fromEntries(files.map((file) => [file, hash(readFileSync(`src/server/migration/${file}`, 'utf8'))]));
const beforeHashes = sourceHashes();
const evidencePath = join(tmpdir(), `class-store-final-capture-provenance-${randomUUID()}.json`);
const evidence: Record<string, unknown> = {
  authority: 'NONAUTHORITY', scope: 'PURE_SYNTHETIC_REGRESSION', complete: false,
  activationAllowed: false, sourceReconciliation: 'NOT_PERFORMED', targetReconciliation: 'NOT_PERFORMED',
  plannerSeam: 'Exact current private declarations, type-erased only; no stage/DB/envelope persistence execution',
  sourceHashes: beforeHashes, cases: {}, observations: {},
};

/** Execute the CURRENT private pure implementation, not a copied delta algorithm.
 * AST-selected declaration text is retained verbatim until TypeScript erases types.
 * Deliberately no imports/stage/append/SQL are evaluated and no fake transaction is
 * supplied. Missing declarations/dependencies fail the test, with no fallback.
 * This lexical test seam does NOT exercise the public async staging/storage path. */
function loadCurrentPurePlanner(): Planner {
  const filename = 'src/server/migration/finalGeneration.ts';
  const text = readFileSync(filename, 'utf8');
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.ES2022, true);
  const names = ['IDENTITIES', 'MUTABLE', 'delta', 'retainedContributors', 'refused'];
  // Include the real new helper when present; pre-fix RED executes the old delta
  // without fabricating this helper or turning module absence into behavioral RED.
  if (source.statements.some((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'claimRecaptureComparison')) {
    names.push('claimRecaptureComparison');
  }
  const pieces = names.map((name) => {
    const matches = source.statements.filter((node) => ts.isFunctionDeclaration(node) ? node.name?.text === name
      : ts.isVariableStatement(node) && node.declarationList.declarations.length === 1
        && ts.isIdentifier(node.declarationList.declarations[0].name) && node.declarationList.declarations[0].name.text === name);
    expect(matches, `Current production declaration ${name}`).toHaveLength(1);
    return { name, text: matches[0].getText(source), line: source.getLineAndCharacterOfPosition(matches[0].getStart(source)).line + 1 };
  });
  const stage = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'stageLegacyFinalGeneration');
  expect(stage?.getText(source)).toContain('return prepareFinalGeneration(raw, options, false)');
  const shared = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'prepareFinalGeneration');
  expect(shared?.getText(source)).toContain('delta(original.manifest, candidate.manifest)');
  const compiled = ts.transpileModule(pieces.map((piece) => piece.text).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, strict: true }, reportDiagnostics: true,
  });
  expect(compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
  evidence.plannerDeclarations = pieces.map(({ name, text: declaration, line }) => ({ name, line, sha256: hash(declaration) }));
  // Trusted local source under explicit read scope, never capture/user-generated code.
  return new Function('canonicalJson', 'sha256', 'deterministicId', 'isPlainRecord', 'isHexDigest',
    `${compiled.outputText}\nreturn { delta, retainedContributors };`)(canonicalJson, sha256, deterministicId, isPlainRecord, isHexDigest) as Planner;
}
const planner = loadCurrentPurePlanner();

type CaptureOptions = Readonly<{
  sheetAt?: string; redisAt?: string; sheetRevision?: string; redisRevision?: string;
  author?: string; claimCount?: 0 | 1 | 2; bankSheet?: boolean; transactionOperator?: string;
}>;
/** Each call independently runs both REAL capture functions over in-memory readers.
 * No shared Redis snapshot, artifact override, stale hash or network adapter. */
async function capture(options: CaptureOptions = {}): Promise<Acquisition> {
  const sheet = options.bankSheet ? makeSheets() : makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(sheet.tabs).map(([name, tab]) => [name,
    [[...tab.headers], ...tab.rows.map((row) => [...row.cells])]]));
  if (options.transactionOperator !== undefined) {
    const column = workbook.Transactions[0].indexOf('operator');
    expect(column).toBeGreaterThanOrEqual(0);
    workbook.Transactions[1][column] = options.transactionOperator;
  }
  const base = makeRedis().operationBindings[0];
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < (options.claimCount ?? 1); index++) {
    const operationId = `op-${index + 1}`;
    const binding = structuredClone(base.binding);
    const postId = `POST-${index + 1}`;
    const changed = { ...binding, evidence: { ...binding.evidence,
      evidencePostId: postId, evidenceAuthorFullName: options.author ?? binding.evidence.evidenceAuthorFullName } };
    const tuple = hash(`${changed.evidence.evidenceBoardId}\0${postId}`);
    const claimField = `claim:${tuple}`;
    entries.push([claimField, operationId], [`op:${hash(operationId)}`, JSON.stringify({ binding: changed, claimField })]);
  }
  let sheetRevisions = 0, redisRevisions = 0, scans = 0;
  const sheets = await captureSheetsSnapshot({ spreadsheetId: sheet.spreadsheetId,
    capturedAt: options.sheetAt ?? FIRST,
    reader: {
      listSheetNames: async () => Object.keys(workbook),
      getRows: async (name) => structuredClone(workbook[name]),
      getRevision: async () => { sheetRevisions++; return options.sheetRevision ?? 'sheet-revision-1'; },
    } });
  const redis = await captureRedisClaimSnapshot({
    hscan: async (key, cursor) => {
      expect(key).toBe('padlet:evidence-bindings:v2'); expect(cursor).toBe('0'); scans++;
      return { cursor: '0', entries: structuredClone(entries) };
    },
    scan: async (cursor, pattern) => {
      expect(cursor).toBe('0'); expect(pattern).toBe('padlet:evidence-claim:v1:*');
      return { cursor: '0', keys: [] };
    },
    get: async () => { throw new Error('Unexpected v1 fixture read'); },
    getRevision: async () => { redisRevisions++; return options.redisRevision ?? 'redis-revision-1'; },
  }, { capturedAt: options.redisAt ?? FIRST });
  expect(sheetRevisions).toBe(2); expect(redisRevisions).toBe(2); expect(scans).toBe(1);
  return { sheets, redis };
}
function artifactBody<T extends { digest: string }>(value: T): Omit<T, 'digest'> {
  const { digest: sealedDigest, ...body } = value;
  expect(sealedDigest).toBe(digest(body));
  return body;
}
function validate(acquisition: Acquisition, ready = true): Manifest {
  const input = { tenantId: TENANT, migrationJobId: JOB, ...acquisition };
  assertNormalizationInput(input); assertManifestInputShape(input);
  artifactBody(acquisition.sheets); artifactBody(acquisition.redis);
  const normalized = normalizeLegacySnapshots(input);
  const manifest = createLegacyNormalizationManifest(input);
  expect(manifest.records).toEqual(normalized.records);
  expect(manifest.mappings).toEqual(normalized.mappings);
  expect(manifest.sourceRecords).toEqual(normalized.sourceRecords);
  expect(manifest.sourceArtifacts.sheets.digest).toBe(acquisition.sheets.digest);
  expect(manifest.sourceArtifacts.redis?.digest).toBe(acquisition.redis.digest);
  for (const row of manifest.sourceRecords) {
    expect(row.source.artifactDigest).toBe(row.source.kind === 'SHEET' ? acquisition.sheets.digest : acquisition.redis.digest);
  }
  if (ready) {
    expect(manifest.status, canonicalJson(manifest.blockingConflicts)).toBe('READY_FOR_IMPORT');
    expect(manifest.blockingConflicts).toEqual([]); expect(manifest.quarantines).toEqual([]);
    expect(manifest.sourceRecords.every((record) => record.mappingStatus === 'STAGED' && !record.errorCodes.length)).toBe(true);
  }
  return manifest;
}
function claim(manifest: Manifest, index = 0) {
  const rows = manifest.records[CLAIMS];
  expect(rows?.length).toBeGreaterThan(index);
  return rows[index];
}
// Equality diagnostics only: NEVER pass either projection back into normalization,
// the real planner, captures or persisted evidence. Whole records remain untouched.
function businessClaim(row: Readonly<Record<string, unknown>>) {
  const { provenances, ...business } = row;
  expect(Array.isArray(provenances)).toBe(true);
  return business;
}
function claimSources(manifest: Manifest) {
  return manifest.sourceRecords.filter((row) => row.targetTable === CLAIMS).map((row) => row.source);
}
function stablePointers(sources: readonly SourcePointer[]) {
  return sources.map((source) => source.kind === 'SHEET'
    ? canonicalJson({ kind: source.kind, tab: source.tab, rowNumber: source.rowNumber, rowHash: source.rowHash })
    : canonicalJson({ kind: source.kind, provenance: source.provenance, sourceDigest: source.sourceDigest })).sort();
}
function plan(before: Manifest, after: Manifest): Plan {
  const prior = canonicalJson([before, after]);
  const result = planner.delta(before, after);
  expect(canonicalJson([before, after])).toBe(prior);
  return result;
}
function expectedMutation(before: Manifest, after: Manifest, table = CLAIMS) {
  const previous = before.records[table][0], next = after.records[table][0];
  return { table, identity: canonicalJson([table === CLAIMS ? previous.tupleDigest : previous.operationId]),
    kind: 'MUTATED', beforeDigest: digest(previous), afterDigest: digest(next) };
}
function observe(name: string, value: unknown) { (evidence.observations as Record<string, unknown>)[name] = value; }
function checked(name: string, run: () => Promise<void>) {
  it(name, async () => {
    try { await run(); (evidence.cases as Record<string, string>)[name] = 'passed'; }
    catch (error) { (evidence.cases as Record<string, string>)[name] = 'failed'; throw error; }
  });
}
afterAll(() => {
  evidence.sourceFilesUnchanged = canonicalJson(sourceHashes()) === canonicalJson(beforeHashes);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`Synthetic C-PROV-01 evidence: ${evidencePath}`);
  expect(evidence.sourceFilesUnchanged).toBe(true);
});

describe('C-PROV-01 real capture/normalization and conservative pure delta regression', () => {
  checked('independently captured identical acquisitions validate and produce an empty accepted LOCAL diff', async () => {
    const original = await capture(), candidate = await capture();
    expect(original).toEqual(candidate); expect(original.redis).not.toBe(candidate.redis);
    expect(original.redis.operationBindings[0]).not.toBe(candidate.redis.operationBindings[0]);
    expect(original.sheets).not.toBe(candidate.sheets);
    const before = validate(original), after = validate(candidate);
    expect(before.records[CLAIMS]).toHaveLength(1);
    expect(before.records.legacy_operation_bindings).toHaveLength(1);
    expect(claimSources(before)).toHaveLength(1);
    expect(before.mappings.filter((row) => row.targetTable === CLAIMS)).toHaveLength(1);
    expect(plan(before, after)).toEqual({ status: 'DIFF_VALIDATED', changes: [], blockers: [] });
    observe('identical', { claim: claim(before), plan: plan(before, after) });
  });

  for (const [name, options] of [
    ['Redis timestamp only', { redisAt: SECOND }],
    ['Redis revision only', { redisRevision: 'redis-revision-2' }],
    ['both captures timestamp/revision', { sheetAt: SECOND, sheetRevision: 'sheet-revision-2', redisAt: SECOND, redisRevision: 'redis-revision-2' }],
  ] as const) checked(`C-PROV-01: ${name} preserves both captures but is not a business claim mutation`, async () => {
    const original = await capture(), candidate = await capture(options);
    const before = validate(original), after = validate(candidate);
    const untouched = canonicalJson([original, candidate]);
    expect(original.redis.digest).not.toBe(candidate.redis.digest);
    expect(original.redis.v2Claims).toEqual(candidate.redis.v2Claims);
    expect(original.redis.operationBindings).toEqual(candidate.redis.operationBindings);
    expect(original.sheets.tabs).toEqual(candidate.sheets.tabs);
    const oldClaim = claim(before), newClaim = claim(after);
    expect(businessClaim(oldClaim)).toEqual(businessClaim(newClaim));
    expect(claimSources(before)).toHaveLength(1); expect(claimSources(after)).toHaveLength(1);
    expect(oldClaim.provenances).toEqual(claimSources(before)); expect(newClaim.provenances).toEqual(claimSources(after));
    expect(stablePointers(claimSources(before))).toEqual(stablePointers(claimSources(after)));
    expect(stablePointers(claimSources(before))).toEqual([canonicalJson({ kind: 'REDIS',
      provenance: 'upstash:padlet:evidence-bindings:v2', sourceDigest: digest(original.redis.v2Claims[0]) })]);
    expect(planner.retainedContributors(before, CLAIMS, oldClaim, ['tupleDigest']))
      .toBe(canonicalJson(stablePointers(claimSources(before))));
    expect(planner.retainedContributors(after, CLAIMS, newClaim, ['tupleDigest']))
      .toBe(planner.retainedContributors(before, CLAIMS, oldClaim, ['tupleDigest']));
    expect(before.mappings).toEqual(after.mappings);
    expect(before.sourceFingerprint).toBe(after.sourceFingerprint);
    expect(before.manifestDigest).not.toBe(after.manifestDigest);
    expect(digest(oldClaim)).not.toBe(digest(newClaim));
    for (const table of Object.keys(before.records).filter((name) => name !== CLAIMS)) expect(before.records[table]).toEqual(after.records[table]);
    const result = plan(before, after);
    expect(result).toEqual({ status: 'DIFF_VALIDATED', blockers: [], changes: [] });
    expect(canonicalJson([original, candidate])).toBe(untouched);
    observe(name, { originalCapture: { sheets: original.sheets.digest, redis: original.redis.digest },
      candidateCapture: { sheets: candidate.sheets.digest, redis: candidate.redis.digest },
      beforeClaim: oldClaim, afterClaim: newClaim, sourceFingerprint: before.sourceFingerprint,
      beforeManifestDigest: before.manifestDigest, afterManifestDigest: after.manifestDigest,
      retainedContributors: planner.retainedContributors(before, CLAIMS, oldClaim, ['tupleDigest']), plan: result });
  });

  checked('Sheets-only recapture is NOT a reproduction when the sole accepted claim contributor is Redis', async () => {
    const original = await capture(), candidate = await capture({ sheetAt: SECOND, sheetRevision: 'sheet-revision-2' });
    const before = validate(original), after = validate(candidate);
    expect(original.sheets.digest).not.toBe(candidate.sheets.digest);
    expect(original.redis.digest).toBe(candidate.redis.digest);
    expect(before.manifestDigest).not.toBe(after.manifestDigest);
    expect(claim(before)).toEqual(claim(after));
    expect(plan(before, after)).toEqual({ status: 'DIFF_VALIDATED', changes: [], blockers: [] });
  });

  checked('a real binding payload change with stable tuple/owner changes the fingerprint and adds retained-provenance blocker', async () => {
    const original = await capture(), candidate = await capture({ author: 'Alice-Updated' });
    const before = validate(original), after = validate(candidate);
    expect(original.redis.capturedAt).toBe(candidate.redis.capturedAt);
    expect(original.redis.sourceRevision).toBe(candidate.redis.sourceRevision);
    expect(original.redis.v2Claims).toEqual(candidate.redis.v2Claims);
    expect(original.redis.operationBindings[0].payloadHash).not.toBe(candidate.redis.operationBindings[0].payloadHash);
    expect(businessClaim(claim(before))).not.toEqual(businessClaim(claim(after)));
    expect(before.sourceFingerprint).not.toBe(after.sourceFingerprint);
    expect(claimSources(before)).toHaveLength(1); expect(claimSources(after)).toHaveLength(1);
    const result = plan(before, after);
    expect(result).toEqual({ status: 'BLOCKED', blockers: ['APPEND_ONLY_HISTORY_CHANGED', 'APPEND_ONLY_HISTORY_PROVENANCE_CHANGED'],
      changes: [expectedMutation(before, after, 'legacy_operation_bindings'), expectedMutation(before, after)] });
    observe('business-payload-control', { beforeClaim: claim(before), afterClaim: claim(after), plan: result });
  });

  checked('valid removal changes accepted claim contributor multiplicity from one to zero and is REMOVED, not recapture-only MUTATED', async () => {
    const before = validate(await capture()), after = validate(await capture({ claimCount: 0 }));
    expect(claimSources(before)).toHaveLength(1); expect(claimSources(after)).toHaveLength(0);
    expect(after.records[CLAIMS]).toEqual([]);
    const result = plan(before, after);
    expect(result.status).toBe('BLOCKED'); expect(result.blockers).toEqual(['APPEND_ONLY_HISTORY_CHANGED']);
    expect(result.changes).toEqual(['legacy_operation_bindings', CLAIMS].map((table) => ({ table,
      identity: canonicalJson([table === CLAIMS ? before.records[table][0].tupleDigest : before.records[table][0].operationId]),
      kind: 'REMOVED', beforeDigest: digest(before.records[table][0]), afterDigest: null })));
    observe('multiplicity-removal-control', { beforeContributors: 1, afterContributors: 0, plan: result });
  });

  checked('valid independent tuple addition changes total contributors one to two without inventing a duplicate retained-identity contributor', async () => {
    const before = validate(await capture()), after = validate(await capture({ claimCount: 2 }));
    expect(claimSources(before)).toHaveLength(1); expect(claimSources(after)).toHaveLength(2);
    expect(after.records[CLAIMS]).toHaveLength(2);
    const retained = after.records[CLAIMS].find((row) => row.tupleDigest === claim(before).tupleDigest)!;
    expect(businessClaim(retained)).toEqual(businessClaim(claim(before)));
    for (const row of after.records[CLAIMS]) expect(row.provenances).toHaveLength(1);
    const result = plan(before, after);
    expect(result.status).toBe('DIFF_VALIDATED'); expect(result.blockers).toEqual([]);
    expect(result.changes).toHaveLength(2);
    expect(result.changes.filter((change) => change.kind === 'ADDED').map((change) => change.table).sort()).toEqual(['legacy_operation_bindings', CLAIMS]);
    expect(result.changes.filter((change) => change.kind === 'MUTATED')).toEqual([]);
    for (const change of result.changes) {
      const key = change.table === CLAIMS ? 'tupleDigest' : 'operationId';
      const added = after.records[change.table].find((row) => canonicalJson([row[key]]) === change.identity)!;
      expect(change.beforeDigest).toBeNull(); expect(change.afterDigest).toBe(digest(added));
    }
    observe('multiplicity-addition-control', { beforeContributors: 1, afterContributors: 2,
      retainedIdentityContributorCount: 1, plan: result });
  });

  checked('same-tuple Sheet plus Redis contributors remain unsupported BANK evidence, not an admissible READY multiplicity reproduction', async () => {
    const original = await capture(), candidate = await capture({ bankSheet: true });
    const before = validate(original), after = validate(candidate, false);
    expect(after.status).toBe('BLOCKED');
    expect(after.quarantines.some((row) => row.errorCodes.includes('UNSUPPORTED_LEGACY_BANK_AUTHORITY'))).toBe(true);
    const contributors = after.quarantines.filter((row) => row.canonicalRecord?.provider === 'PADLET');
    expect(contributors).toHaveLength(2);
    for (const contributor of contributors) {
      expect(contributor.canonicalRecord?.provenances).toHaveLength(2);
      expect(businessClaim(contributor.canonicalRecord!)).toEqual(businessClaim(claim(before)));
    }
    expect(after.records[CLAIMS]).toEqual([]);
    const result = plan(before, after);
    expect(result.status).toBe('BLOCKED'); expect(result.blockers).toContain('NORMALIZATION_BLOCKED');
    observe('same-tuple-multiplicity-domain-limit', { acceptedBefore: 1, quarantinedCandidateContributors: 2,
      errors: [...new Set(after.quarantines.flatMap((row) => row.errorCodes))].sort(), plan: result,
      admissibleRetainedMultiplicityProof: false });
  });

  for (const side of ['sheets', 'redis'] as const) checked(`invalid ${side} metadata with an unrecomputed digest is refused before normalization/plan`, async () => {
    const original = await capture(); validate(original);
    const invalid = { ...original, [side]: { ...original[side], capturedAt: SECOND } };
    const input = { tenantId: TENANT, migrationJobId: JOB, ...invalid };
    expect(() => assertManifestInputShape(input)).toThrow('Legacy migration input is structurally invalid.');
    expect(() => createLegacyNormalizationManifest(input)).toThrow('Legacy migration input is structurally invalid.');
  });

  checked('a correctly rehashed duplicate Redis contributor is STILL structurally invalid, never a product provenance regression', async () => {
    const original = await capture(); validate(original);
    const body = artifactBody(original.redis);
    const duplicated = { ...body, v2Claims: [structuredClone(body.v2Claims[0]), structuredClone(body.v2Claims[0])] };
    const redis = { ...duplicated, digest: digest(duplicated) };
    expect(redis.digest).toBe(digest(artifactBody(redis)));
    const input = { tenantId: TENANT, migrationJobId: JOB, sheets: original.sheets, redis };
    assertNormalizationInput(input);
    expect(() => assertManifestInputShape(input)).toThrow('Legacy migration input is structurally invalid.');
    expect(() => createLegacyNormalizationManifest(input)).toThrow('Legacy migration input is structurally invalid.');
  });

  checked('fresh metadata cannot mask an actual binding mutation and full row digests remain in the blocked change', async () => {
    const before = validate(await capture());
    const after = validate(await capture({ author: 'Alice-Updated', redisAt: SECOND, redisRevision: 'redis-revision-2' }));
    expect(plan(before, after)).toEqual({ status: 'BLOCKED',
      blockers: ['APPEND_ONLY_HISTORY_CHANGED', 'APPEND_ONLY_HISTORY_PROVENANCE_CHANGED'],
      changes: [expectedMutation(before, after, 'legacy_operation_bindings'), expectedMutation(before, after)] });
  });

  checked('same fingerprint and equal canonical rows do not mask changed retained Sheet source bytes', async () => {
    const before = validate(await capture()), after = validate(await capture({ transactionOperator: ' kiosk ', redisAt: SECOND }));
    expect(before.records.transactions).toEqual(after.records.transactions);
    expect(before.sourceFingerprint).toBe(after.sourceFingerprint);
    expect(plan(before, after)).toEqual({ status: 'BLOCKED', changes: [], blockers: ['APPEND_ONLY_HISTORY_PROVENANCE_CHANGED'] });
  });

  checked('real non-claim append-only mutation is still blocked alongside a recaptured unchanged claim', async () => {
    const before = validate(await capture()), after = validate(await capture({ transactionOperator: 'different-operator', redisAt: SECOND }));
    const result = plan(before, after);
    expect(result.status).toBe('BLOCKED');
    expect(result.blockers).toEqual(['APPEND_ONLY_HISTORY_CHANGED', 'APPEND_ONLY_HISTORY_PROVENANCE_CHANGED']);
    expect(result.changes).toHaveLength(1); expect(result.changes[0]).toMatchObject({ table: 'transactions', kind: 'MUTATED' });
    const row = after.records.transactions.find((row) => canonicalJson([row.transactionId]) === result.changes[0].identity)!;
    expect(result.changes[0].afterDigest).toBe(digest(row));
  });

  // These are deliberately forged *derived manifests*, not valid acquisitions.
  // Public staging constructs manifests itself. They test the new private seam's
  // consistency guards without falsely claiming READY same-tuple multiplicity is
  // currently reachable through the BANK-quarantining normalizer.
  for (const attack of ['duplicate mapping', 'duplicate source', 'missing source', 'missing provenance',
    'stale pointer artifact', 'unknown pointer member', 'source canonical disagreement'] as const) {
    checked(`adversarial internal ${attack} cannot obtain the recapture exemption`, async () => {
      const before = validate(await capture()), candidate = validate(await capture({ redisAt: SECOND }));
      const row = claim(candidate), record = candidate.sourceRecords.find((item) => item.targetTable === CLAIMS)!;
      const provenance = structuredClone((row.provenances as readonly SourcePointer[])[0]);
      const altered = { ...row, provenances: attack === 'missing provenance' ? [] : [attack === 'stale pointer artifact'
        ? { ...provenance, artifactDigest: 'a'.repeat(64) } : attack === 'unknown pointer member'
          ? { ...provenance, unexpected: 'must-not-be-ignored' } : provenance] };
      const sourceRecords = candidate.sourceRecords.filter((item) => attack !== 'missing source' || item.targetTable !== CLAIMS)
        .map((item) => item.targetTable !== CLAIMS ? item : { ...item,
          canonicalRecord: attack === 'source canonical disagreement' ? { ...altered, evidenceAuthorFullName: 'conflicting' } : altered,
          source: attack === 'stale pointer artifact' ? { ...item.source, artifactDigest: 'a'.repeat(64) } : item.source });
      if (attack === 'duplicate source') sourceRecords.push(structuredClone(record));
      const mappings = [...candidate.mappings];
      if (attack === 'duplicate mapping') mappings.push(structuredClone(mappings.find((item) => item.targetTable === CLAIMS)!));
      const forged = { ...candidate, records: { ...candidate.records, [CLAIMS]: [altered] }, sourceRecords, mappings };
      expect(() => plan(before, forged)).toThrow('Final generation preparation refused.');
    });
  }

  checked('internal exact duplicate contributor multiplicity is blocked even when its complete claim business and fingerprint agree', async () => {
    const before = validate(await capture()), candidate = validate(await capture({ redisAt: SECOND }));
    const row = claim(candidate), record = candidate.sourceRecords.find((item) => item.targetTable === CLAIMS)!;
    const pointers = row.provenances as readonly SourcePointer[];
    const doubled = { ...row, provenances: [...pointers, structuredClone(pointers[0])] };
    const sourceRecords = candidate.sourceRecords.map((item) => item.targetTable !== CLAIMS ? item : { ...item, canonicalRecord: doubled });
    sourceRecords.push({ ...structuredClone(record), canonicalRecord: doubled });
    const forged = { ...candidate, records: { ...candidate.records, [CLAIMS]: [doubled] }, sourceRecords };
    expect(businessClaim(claim(before))).toEqual(businessClaim(doubled));
    expect(forged.sourceFingerprint).toBe(before.sourceFingerprint);
    expect(JSON.parse(planner.retainedContributors(before, CLAIMS, claim(before), ['tupleDigest']))).toHaveLength(1);
    expect(JSON.parse(planner.retainedContributors(forged, CLAIMS, doubled, ['tupleDigest']))).toHaveLength(2);
    expect(plan(before, forged)).toEqual({ status: 'BLOCKED',
      blockers: ['APPEND_ONLY_HISTORY_CHANGED', 'APPEND_ONLY_HISTORY_PROVENANCE_CHANGED'], changes: [expectedMutation(before, forged)] });
  });

  checked('a full business field unknown to the identity recipe is not lost in comparison', async () => {
    const before = validate(await capture()), candidate = validate(await capture({ redisAt: SECOND }));
    const changed = { ...claim(candidate), futureBusinessField: { proof: 'must-remain-significant' } };
    const forged = { ...candidate, records: { ...candidate.records, [CLAIMS]: [changed] },
      sourceRecords: candidate.sourceRecords.map((item) => item.targetTable === CLAIMS ? { ...item, canonicalRecord: changed } : item) };
    expect(plan(before, forged)).toEqual({ status: 'BLOCKED', blockers: ['APPEND_ONLY_HISTORY_CHANGED'], changes: [expectedMutation(before, forged)] });
  });
});
