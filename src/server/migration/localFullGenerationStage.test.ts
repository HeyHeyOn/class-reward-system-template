// @vitest-environment node
// Same application path on in-memory PGlite, or explicitly opted-in disposable PG17.
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createPgliteDatabaseHarness } from '@/server/db/testing/pglite';
import { createDisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { importLegacyNormalizationManifest, type TenantImportTransactionRunner } from './importer';
import { createLegacyNormalizationManifest } from './manifest';
import type { FinalGenerationPreparationInput } from './finalGeneration';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { makeSupportedSheets, makeRedis, finalizeRedisSnapshot, finalizeSheetsSnapshot } from './__fixtures__/normalization';
import { canonicalJson, sha256 } from './validators';
import { LOCAL_DELTA_COVERAGE_CATALOG } from './localFullCategoryDeltaCoverage';
import { stageLocalFullGeneration } from './localFullGenerationStage';

vi.mock('server-only', () => ({}));
const TENANT = '20000000-0000-4000-8000-000000000001';
const OTHER = '20000000-0000-4000-8000-000000000002';
const JOB = '20000000-0000-4000-8000-000000000019';
const TABLES = ['migration_full_generations', 'migration_full_sources', 'migration_full_targets',
  'migration_full_mappings', 'migration_full_contributors', 'migration_full_reconciliation'];
const REFUSAL = 'Local full-generation stage refused.';
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function capture(variant: 'original' | 'added' | 'mutated' | 'removed' | 'mixed' | 'spare'
  | 'ledger-mutated' | 'ledger-removed' | 'claim-recaptured' | 'tombstone-removed' = 'original') {
  const seed = makeSupportedSheets();
  const workbook = Object.fromEntries(Object.entries(seed.tabs).map(([tab, data]) =>
    [tab, [[...data.headers], ...data.rows.map(row => [...row.cells])]]));
  if (variant === 'added' || variant === 'mixed') {
    workbook.Students.push(['S2', 'Bob', '0', 'ACTIVE']);
    workbook.Products.push(['P2', 'Notebook', '15', '3', 'TRUE', '', 'school', '2']);
  }
  if (variant === 'spare') workbook.Products.push(['P2', 'Unreferenced', '1', '0', 'TRUE', '', '', '2']);
  if (variant === 'mutated' || variant === 'mixed') workbook.Products[1][1] = 'Changed pencil';
  if (variant === 'removed' || variant === 'mixed') {
    workbook.Promotions = [workbook.Promotions[0]];
    workbook.PromotionProducts = [workbook.PromotionProducts[0]];
  }
  if (variant === 'ledger-mutated') workbook.Transactions[1][9] = 'other operator';
  if (variant === 'ledger-removed') workbook.Transactions.splice(1, 1);
  const sheets = await captureSheetsSnapshot({ spreadsheetId: seed.spreadsheetId, capturedAt: seed.capturedAt,
    reader: { listSheetNames: async () => Object.keys(workbook), getRows: async name => structuredClone(workbook[name]),
      getRevision: async () => variant } });
  const operation = makeRedis().operationBindings[0];
  const field = operation.claimField;
  const tombstoneKey = `padlet:evidence-claim:v1:${sha256('historical-deleted-post')}`;
  const redis = await captureRedisClaimSnapshot({
    hscan: async () => ({ cursor: '0', entries: [[field, operation.operationId],
      [`op:${sha256(operation.operationId)}`, JSON.stringify({ binding: operation.binding, claimField: field })]] }),
    scan: async () => ({ cursor: '0', keys: variant === 'tombstone-removed' ? [] : [tombstoneKey] }),
    get: async key => { expect(key).toBe(tombstoneKey); return 'old-owner'; },
    getRevision: async () => variant === 'claim-recaptured' ? 'synthetic-redis-2' : 'synthetic-redis-1',
  }, { capturedAt: seed.capturedAt });
  return { sheets, redis };
}

async function fixture(originalVariant: Parameters<typeof capture>[0] = 'original') {
  const pg = process.env.RUN_REAL_POSTGRES === '1' ? await createDisposablePostgres() : null;
  const lite = pg ? null : await createPgliteDatabaseHarness({ migrationSet: 'base' });
  close = async () => { const result = pg ? await pg.close() : await lite!.close(); console.info('FULL_STAGE_CLEANUP', result ?? 'PGlite closed'); };
  if (pg) console.info('FULL_STAGE_PG', JSON.stringify(pg.evidence));
  const query = async (text: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> =>
    pg ? pg.owner.query(text, values) : lite!.database.query(text, values);
  if (lite) for (const file of readdirSync('src/server/db/migrations').filter(f => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) > '0008').sort()) {
    await lite.database.exec(readFileSync(`src/server/db/migrations/${file}`, 'utf8'));
  }
  if (pg) await query(`INSERT INTO tenants(id,slug,display_name) VALUES($1,'full-one','Synthetic one'),($2,'full-two','Synthetic two')`, [TENANT, OTHER]);
  // Disposable fixture grants only; production migration intentionally grants nothing.
  for (const table of [...TABLES, 'migration_full_delta_entries', 'migration_full_claim_recaptures']) await query(`GRANT SELECT,INSERT ON ${table} TO app_runtime`);
  const run = (pg?.runTenantTransaction ?? lite!.runTenantTransaction) as TenantImportTransactionRunner;
  const original = await capture(originalVariant);
  const manifest = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...original });
  expect(manifest.status).toBe('READY_FOR_IMPORT');
  for (const { table } of LOCAL_DELTA_COVERAGE_CATALOG) expect(manifest.records[table]?.length, table).toBeGreaterThan(0);
  await query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')", [TENANT, JOB]);
  await importLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, manifest, runTransaction: run });
  for (const status of ['RECONCILING', 'READY']) await query('UPDATE migration_jobs SET status=$3,state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2', [TENANT, JOB, status]);
  const version = (await query('SELECT state_version::text AS version FROM migration_jobs WHERE tenant_id=$1 AND job_id=$2', [TENANT, JOB])).rows[0].version as string;
  const input: FinalGenerationPreparationInput = { tenantId: TENANT, migrationJobId: JOB, expectedStateVersion: version,
    originalSourceId: `sheet:${original.sheets.digest}`, originalSnapshotId: `import:${manifest.manifestDigest}`,
    exclusionGenerationReference: sha256('UNPROVEN synthetic label'), original, candidate: await capture('added') };
  const state = async (tables = TABLES) => Object.fromEntries(await Promise.all(tables.map(async table =>
    [table, (await query(`SELECT to_jsonb(t) AS row FROM ${table} t`)).rows.map(r => canonicalJson(r.row)).sort()])));
  return { query, run, input, state };
}

describe('local full-generation persisted snapshot; no operational publication', () => {
  it('stores every normalized category, fan-out, Redis claims/tombstones and exact source/mapping bytes; retries without child writes', async () => {
    const f = await fixture();
    const operational = ['students', 'accounts', 'products', 'transactions', 'task_assignments', 'task_completions',
      'padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'operations', 'migration_jobs', 'migration_sources'];
    const before = await f.state(operational);
    const result = await stageLocalFullGeneration(f.input, f.run);
    expect(result).toMatchObject({ authority: 'NONAUTHORITY', phase: 'LOCAL_CANDIDATE', exclusion: 'NOT_PROVEN',
      activationAllowed: false, complete: false, scope: 'LOCAL_FULL_ADDED_SNAPSHOT', persistedReadback: 'MATCH' });
    const candidate = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...f.input.candidate });
    const sources = (await f.query('SELECT source_value FROM migration_full_sources ORDER BY source_ordinal')).rows;
    expect(sources.map(r => r.source_value)).toEqual(candidate.sourceRecords);
    expect(sources.some(r => (r.source_value as { source: { kind: string } }).source.kind === 'REDIS')).toBe(true);
    const mappings = (await f.query('SELECT mapping_value FROM migration_full_mappings ORDER BY mapping_ordinal')).rows;
    expect(mappings.map(r => r.mapping_value)).toEqual(candidate.mappings);
    const targets = (await f.query('SELECT target_table,canonical_value FROM migration_full_targets')).rows;
    for (const { table } of LOCAL_DELTA_COVERAGE_CATALOG) {
      expect(targets.filter(r => r.target_table === table).map(r => canonicalJson(r.canonical_value)).sort())
        .toEqual(candidate.records[table].map(row => canonicalJson(row)).sort());
    }
    expect((await f.query('SELECT * FROM migration_full_reconciliation')).rows).toHaveLength(19);
    expect((await f.query('SELECT source_ordinal FROM migration_full_contributors GROUP BY source_ordinal HAVING count(*)>1')).rows.length).toBeGreaterThan(0);
    const persisted = await f.state();
    // Suppressed re-inserts would fail too; exact retry must not attempt child writes.
    await f.query(`CREATE FUNCTION full_no_repeat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'repeat child write'; END $$`);
    for (const table of TABLES) await f.query(`CREATE TRIGGER full_no_repeat BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION full_no_repeat()`);
    expect(await stageLocalFullGeneration(f.input, f.run)).toEqual(result);
    expect(await f.state()).toEqual(persisted);
    expect(await f.state(operational)).toEqual(before);
  }, 120_000);

  it.each(['mutated', 'removed'] as const)('stages %s with immutable before/after provenance, removal tombstones and exact retry', async variant => {
    const f = await fixture();
    const operational = ['students','accounts','products','promotions','promotion_products','transactions',
      'transaction_items','adjustments','task_assignments','task_completions','padlet_evidence_claims',
      'padlet_claim_digest_tombstones','padlet_claim_digest_registry','migration_jobs','migration_sources','migration_snapshots'];
    const before = await f.state(operational);
    const input = { ...f.input, candidate: await capture(variant) };
    const result = await stageLocalFullGeneration(input, f.run);
    expect(result).toMatchObject({ scope: 'LOCAL_FULL_MUTABLE_SNAPSHOT', authority: 'NONAUTHORITY',
      activationAllowed: false, complete: false, phase: 'LOCAL_CANDIDATE', persistedReadback: 'MATCH' });
    const delta = (await f.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries')).rows;
    expect(delta).toHaveLength(variant === 'mutated' ? 1 : 2);
    for (const entry of delta) {
      const value = entry.entry_value as { before: { target: { name?: string }; sources: unknown[]; mappings: unknown[]; contributors: unknown[] }; after: { target: { name?: string } } | null };
      expect(value.before.sources.length).toBeGreaterThan(0);
      expect(value.before.mappings.length).toBeGreaterThan(0);
      expect(value.before.contributors.length).toBeGreaterThan(0);
      expect(entry.change_kind).toBe(variant === 'mutated' ? 'MUTATED' : 'REMOVED');
      if (variant === 'mutated') {
        expect(value.before.target.name).toBe('Pencil');
        expect(value.after!.target.name).toBe('Changed pencil');
      } else {
        expect(value.after).toBeNull();
        expect((await f.query('SELECT * FROM migration_full_targets WHERE target_table=$1 AND target_id=$2',
          [entry.target_table, entry.target_id])).rows).toEqual([]);
      }
    }
    const original = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...input.original });
    for (const table of ['transactions','transaction_items','adjustments','task_assignments','task_completions',
      'padlet_evidence_claims','padlet_claim_digest_tombstones','legacy_operation_bindings']) {
      expect((await f.query('SELECT canonical_value FROM migration_full_targets WHERE target_table=$1', [table])).rows
        .map(row => canonicalJson(row.canonical_value)).sort()).toEqual(original.records[table].map(row => canonicalJson(row)).sort());
    }
    const staged = await f.state([...TABLES, 'migration_full_delta_entries']);
    await f.query(`CREATE FUNCTION delta_no_repeat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'repeat delta write'; END $$`);
    await f.query('CREATE TRIGGER delta_no_repeat BEFORE INSERT ON migration_full_delta_entries FOR EACH ROW EXECUTE FUNCTION delta_no_repeat()');
    expect(await stageLocalFullGeneration(input, f.run)).toEqual(result);
    expect(await f.state([...TABLES, 'migration_full_delta_entries'])).toEqual(staged);
    expect(await f.state(operational)).toEqual(before);
  }, 120_000);

  it('handles mixed additions, edits and deletions in one generation and preserves earlier generations', async () => {
    const f = await fixture();
    const first = await stageLocalFullGeneration(f.input, f.run);
    const firstRows = (await f.query('SELECT canonical_value FROM migration_full_targets WHERE generation_id=$1', [first.generationId])).rows;
    const result = await stageLocalFullGeneration({ ...f.input, candidate: await capture('mixed') }, f.run);
    expect(result.scope).toBe('LOCAL_FULL_MUTABLE_SNAPSHOT');
    expect(result.generationId).not.toBe(first.generationId);
    expect((await f.query('SELECT change_kind,count(*)::int AS count FROM migration_full_delta_entries GROUP BY change_kind ORDER BY change_kind')).rows)
      .toEqual([{ change_kind: 'ADDED', count: 3 }, { change_kind: 'MUTATED', count: 1 }, { change_kind: 'REMOVED', count: 2 }]);
    expect((await f.query('SELECT canonical_value FROM migration_full_targets WHERE generation_id=$1', [first.generationId])).rows).toEqual(firstRows);
  }, 120_000);

  it('retains an explicit before-image tombstone when an unreferenced product disappears', async () => {
    const f = await fixture('spare');
    const result = await stageLocalFullGeneration({ ...f.input, candidate: await capture() }, f.run);
    expect((await f.query("SELECT change_kind,entry_value->'before'->'target'->>'name' AS name, entry_value->'after' AS after FROM migration_full_delta_entries WHERE generation_id=$1 AND target_table='products' AND target_id='P2'", [result.generationId])).rows)
      .toEqual([{ change_kind: 'REMOVED', name: 'Unreferenced', after: null }]);
    expect((await f.query("SELECT * FROM products WHERE product_id='P2'")).rows).toHaveLength(1);
  }, 120_000);

  it('stages capture-only claim recapture with exact acquisitions and candidate provenance', async () => {
    const f = await fixture();
    const operational = ['students', 'accounts', 'products', 'transactions', 'transaction_items', 'adjustments',
      'task_assignments', 'task_completions', 'padlet_evidence_claims', 'padlet_claim_digest_tombstones',
      'operations', 'migration_jobs', 'migration_sources'];
    const untouched = await f.state(operational);
    const input = { ...f.input, candidate: await capture('claim-recaptured') };
    const original = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...input.original });
    const candidate = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...input.candidate });
    expect(candidate.sourceFingerprint).toBe(original.sourceFingerprint);
    expect(candidate.records.padlet_evidence_claims).not.toEqual(original.records.padlet_evidence_claims);
    expect(input.candidate.redis.digest).not.toBe(input.original.redis.digest);
    const bytes = canonicalJson(input);
    const result = await stageLocalFullGeneration(input, f.run);
    expect(result).toMatchObject({ scope: 'LOCAL_FULL_RECAPTURE_SNAPSHOT', phase: 'LOCAL_CANDIDATE',
      authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN', persistedReadback: 'MATCH' });
    const rows = (await f.query("SELECT canonical_value FROM migration_full_targets WHERE target_table='padlet_evidence_claims'")).rows;
    expect(rows.map(row => row.canonical_value)).toEqual(candidate.records.padlet_evidence_claims);
    const envelopes = (await f.query("SELECT event_type,redacted_details FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows;
    for (const [kind, acquisition, manifest] of [['ORIGINAL', input.original, original], ['CANDIDATE', input.candidate, candidate]] as const) {
      const stored = envelopes.find(row => row.event_type === `MIGRATION_PREPARATION_${kind}`)!.redacted_details as Record<string, unknown>;
      expect(canonicalJson(stored.acquisition)).toBe(canonicalJson(acquisition));
      expect(canonicalJson(stored.manifest)).toBe(canonicalJson(manifest));
    }
    const recaptures = (await f.query('SELECT target_id,entry_value FROM migration_full_claim_recaptures')).rows;
    expect(recaptures).toHaveLength(1);
    const entry = recaptures[0].entry_value as { kind: string; beforeDigest: string; afterDigest: string;
      before: { target: unknown; sources: unknown[]; mappings: unknown[]; contributors: unknown[] };
      after: { target: unknown; sources: unknown[]; mappings: unknown[]; contributors: unknown[] } };
    expect(entry.kind).toBe('RECAPTURED');
    for (const [side, manifest] of [['before', original], ['after', candidate]] as const) {
      expect(entry[side].target).toEqual(manifest.records.padlet_evidence_claims[0]);
      expect(entry[`${side}Digest`]).toBe(sha256(canonicalJson(entry[side].target)));
      const mappings = manifest.mappings.flatMap((value, ordinal) => value.targetTable === 'padlet_evidence_claims'
        ? [{ mappingOrdinal: ordinal, mappingValue: value }] : []);
      const sources = manifest.sourceRecords.flatMap((value, ordinal) => value.targetTable === 'padlet_evidence_claims'
        ? [{ sourceOrdinal: ordinal, sourceValue: value }] : []);
      expect(entry[side].mappings).toEqual(mappings);
      expect(entry[side].sources).toEqual(sources);
      expect(entry[side].contributors).toEqual([{ mappingOrdinal: mappings[0].mappingOrdinal, sourceOrdinal: sources[0].sourceOrdinal }]);
    }
    const all = [...TABLES, 'migration_full_claim_recaptures', 'migration_full_delta_entries'];
    const once = await f.state(all);
    expect(await stageLocalFullGeneration(input, f.run)).toEqual(result);
    expect(await f.state(all)).toEqual(once);
    expect(await f.state(operational)).toEqual(untouched);
    expect(canonicalJson(input)).toBe(bytes);
  }, 120_000);

  it('composes recapture with ADDED/MUTATED/REMOVED deltas and preserves the earlier generation', async () => {
    const f = await fixture();
    const earlier = await stageLocalFullGeneration(f.input, f.run);
    const oldRows = await f.state();
    const candidate = { ...await capture('mixed'), redis: (await capture('claim-recaptured')).redis };
    const input = { ...f.input, candidate };
    const result = await stageLocalFullGeneration(input, f.run);
    expect(result.scope).toBe('LOCAL_FULL_RECAPTURE_SNAPSHOT');
    expect(result.generationId).not.toBe(earlier.generationId);
    const entries = (await f.query('SELECT change_kind FROM migration_full_delta_entries WHERE generation_id=$1', [result.generationId])).rows;
    expect(new Set(entries.map(row => row.change_kind))).toEqual(new Set(['ADDED', 'MUTATED', 'REMOVED']));
    const now = await f.state();
    for (const table of TABLES) expect(now[table].filter((row: string) => JSON.parse(row).generation_id === earlier.generationId)).toEqual(oldRows[table]);
    expect(await stageLocalFullGeneration(input, f.run)).toEqual(result);
    expect(await f.state()).toEqual(now);
  }, 120_000);

  it('stages an ADDED claim beside a retained recapture without publishing either', async () => {
    const f = await fixture();
    const acquisition = await capture('claim-recaptured');
    const op = acquisition.redis.operationBindings[0];
    const extra = { ...op, operationId: 'new-operation', binding: { ...op.binding,
      evidence: { ...op.binding.evidence, evidencePostId: 'new-post' } } };
    const candidate = { ...acquisition, redis: finalizeRedisSnapshot({ ...acquisition.redis, operationBindings: [op, extra] }) };
    const operational = await f.state(['padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'operations']);
    const input = { ...f.input, candidate };
    const result = await stageLocalFullGeneration(input, f.run);
    expect(result).toMatchObject({ scope: 'LOCAL_FULL_RECAPTURE_SNAPSHOT', targetCounts: { padlet_evidence_claims: 2 } });
    const entries = (await f.query('SELECT target_table,change_kind FROM migration_full_delta_entries')).rows;
    expect(entries).toHaveLength(2);
    expect(entries.every(row => row.change_kind === 'ADDED')).toBe(true);
    expect(new Set(entries.map(row => row.target_table))).toEqual(new Set(['padlet_evidence_claims', 'legacy_operation_bindings']));
    expect((await f.query('SELECT * FROM migration_full_claim_recaptures')).rows).toHaveLength(1);
    expect(await f.state(['padlet_evidence_claims', 'padlet_claim_digest_tombstones', 'operations'])).toEqual(operational);
    expect(await stageLocalFullGeneration(input, f.run)).toEqual(result);
  }, 120_000);

  it('refuses ledger contributor relocation even when business rows remain identical during recapture', async () => {
    const f = await fixture();
    const acquisition = await capture('claim-recaptured');
    const sheets = structuredClone(acquisition.sheets);
    (sheets.tabs.Transactions.rows as unknown[]).reverse();
    const candidate = { ...acquisition, sheets: finalizeSheetsSnapshot(sheets) };
    const old = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...f.input.original });
    const next = createLegacyNormalizationManifest({ tenantId: TENANT, migrationJobId: JOB, ...candidate });
    expect(old.records.transactions.map(row => canonicalJson(row)).sort()).toEqual(next.records.transactions.map(row => canonicalJson(row)).sort());
    const tables = [...TABLES, 'migration_full_claim_recaptures', 'audit_events'];
    const before = await f.state(tables);
    await expect(stageLocalFullGeneration({ ...f.input, candidate }, f.run)).rejects.toThrow(REFUSAL);
    expect(await f.state(tables)).toEqual(before);
  }, 120_000);

  it.each(['owner-operation', 'post-identity', 'evidence-author', 'claim-removed', 'tombstone-mutated'] as const)(
    'refuses captured %s changes on the recapture path without any writes', async change => {
      const f = await fixture();
      const acquisition = await capture('claim-recaptured');
      const op = acquisition.redis.operationBindings[0];
      const operationBindings = change === 'claim-removed' ? [] : [{ ...op,
        operationId: change === 'owner-operation' ? 'changed-operation' : op.operationId,
        binding: { ...op.binding, evidence: { ...op.binding.evidence,
          evidencePostId: change === 'post-identity' ? 'changed-post' : op.binding.evidence.evidencePostId,
          evidenceAuthorFullName: change === 'evidence-author' ? 'Different author' : op.binding.evidence.evidenceAuthorFullName } } }];
      const redis = finalizeRedisSnapshot({ ...acquisition.redis, operationBindings,
        v1Tombstones: change === 'tombstone-mutated' ? acquisition.redis.v1Tombstones.map(row => ({ ...row, ownerDigest: sha256('different-owner') })) : acquisition.redis.v1Tombstones });
      const before = await f.state([...TABLES, 'migration_full_claim_recaptures', 'audit_events']);
      await expect(stageLocalFullGeneration({ ...f.input, candidate: { ...acquisition, redis } }, f.run)).rejects.toThrow(REFUSAL);
      expect(await f.state([...TABLES, 'migration_full_claim_recaptures', 'audit_events'])).toEqual(before);
    }, 120_000);

  it.each(['suppressed', 'interrupted'] as const)('rolls back %s recapture inserts and all preparation evidence', async kind => {
    const f = await fixture();
    const input = { ...f.input, candidate: await capture('claim-recaptured') };
    await f.query(`CREATE FUNCTION recapture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${kind === 'suppressed'
      ? 'RETURN NULL;' : "RAISE EXCEPTION 'synthetic recapture interruption';"} END $$`);
    await f.query('CREATE TRIGGER recapture_fail BEFORE INSERT ON migration_full_claim_recaptures FOR EACH ROW EXECUTE FUNCTION recapture_fail()');
    const tables = [...TABLES, 'migration_full_claim_recaptures', 'migration_full_delta_entries', 'audit_events'];
    const before = await f.state(tables);
    await expect(stageLocalFullGeneration(input, f.run)).rejects.toThrow(REFUSAL);
    expect(await f.state(tables)).toEqual(before);
    await f.query('DROP TRIGGER recapture_fail ON migration_full_claim_recaptures');
    await expect(stageLocalFullGeneration(input, f.run)).resolves.toMatchObject({ scope: 'LOCAL_FULL_RECAPTURE_SNAPSHOT' });
  }, 120_000);

  it.each(['missing', 'substituted', 'report', 'source', 'mapping', 'contributor'] as const)(
    'refuses %s recapture retry evidence without silent repairs', async kind => {
      const f = await fixture();
      const input = { ...f.input, candidate: await capture('claim-recaptured') };
      await stageLocalFullGeneration(input, f.run);
      const table = kind === 'report' ? 'migration_full_reconciliation'
        : kind === 'source' ? 'migration_full_sources' : kind === 'mapping' ? 'migration_full_mappings'
          : kind === 'contributor' ? 'migration_full_contributors' : 'migration_full_claim_recaptures';
      await f.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
      if (kind === 'substituted') await f.query(`UPDATE ${table} SET entry_value=jsonb_set(entry_value,'{before,sources,0,sourceValue,source,artifactDigest}',to_jsonb($1::text))`, [sha256('substitute')]);
      else if (kind === 'source') await f.query(`UPDATE ${table} SET source_value=jsonb_set(source_value,'{redactedSourceRecord,identityDigest}',to_jsonb($1::text)) WHERE source_value->>'targetTable'='padlet_evidence_claims'`, [sha256('substitute')]);
      else if (kind === 'mapping') await f.query(`UPDATE ${table} SET mapping_value=jsonb_set(mapping_value,'{sourceDigest}',to_jsonb($1::text)) WHERE target_table='padlet_evidence_claims'`, [sha256('substitute')]);
      else if (kind === 'report') await f.query(`DELETE FROM ${table} WHERE category='CLAIM_RECAPTURES'`);
      else await f.query(`DELETE FROM ${table}`);
      await f.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      const tables = [...TABLES, 'migration_full_claim_recaptures', 'migration_full_delta_entries', 'audit_events'];
      const before = await f.state(tables);
      await expect(stageLocalFullGeneration(input, f.run)).rejects.toThrow(REFUSAL);
      expect(await f.state(tables)).toEqual(before);
    }, 120_000);

  it('enforces recapture tenant/job/version binding and additive SQL protection', async () => {
    const f = await fixture();
    const input = { ...f.input, candidate: await capture('claim-recaptured') };
    for (const changed of [{ tenantId: OTHER }, { migrationJobId: 'wrong-job' }, { expectedStateVersion: '999' },
      { originalSourceId: `sheet:${sha256('wrong')}` }, { originalSnapshotId: `import:${sha256('wrong')}` }]) {
      await expect(stageLocalFullGeneration({ ...input, ...changed }, f.run)).rejects.toThrow(REFUSAL);
    }
    const result = await stageLocalFullGeneration(input, f.run);
    expect((await f.run(OTHER, tx => tx.execute(sql`SELECT * FROM migration_full_claim_recaptures`))).rows).toEqual([]);
    const row = (await f.query('SELECT target_id,entry_value FROM migration_full_claim_recaptures')).rows[0];
    await expect(f.run(OTHER, tx => tx.execute(sql`INSERT INTO migration_full_claim_recaptures
      VALUES (${TENANT},${JOB},${result.generationId},'padlet_evidence_claims',${row.target_id},${JSON.stringify(row.entry_value)}::jsonb)`))).rejects.toMatchObject({ cause: { code: '42501' } });
    for (const [job, generation, target] of [['wrong-job', result.generationId, row.target_id], [JOB, 'wrong-generation', row.target_id], [JOB, result.generationId, 'wrong-target']]) {
      await expect(f.query('INSERT INTO migration_full_claim_recaptures VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [TENANT, job, generation, 'padlet_evidence_claims', target, JSON.stringify(row.entry_value)])).rejects.toMatchObject({ code: '23503' });
    }
    for (const command of ['UPDATE migration_full_claim_recaptures SET target_id=target_id', 'DELETE FROM migration_full_claim_recaptures', 'TRUNCATE migration_full_claim_recaptures']) {
      await expect(f.query(command)).rejects.toMatchObject({ code: '55000' });
    }
    await expect(f.query(`INSERT INTO migration_full_delta_entries SELECT tenant_id,migration_job_id,generation_id,target_table,target_id,
      'MUTATED',jsonb_set(entry_value,'{kind}','"MUTATED"'::jsonb) FROM migration_full_claim_recaptures`)).rejects.toMatchObject({ code: '23514' });
    const flags = (await f.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname='migration_full_claim_recaptures'")).rows;
    expect(flags).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  }, 120_000);

  it.each(['ledger-mutated', 'ledger-removed', 'tombstone-removed'] as const)(
    'refuses %s without rewriting retained history/provenance or appending a partial graph', async variant => {
      const f = await fixture();
      await expect(stageLocalFullGeneration({ ...f.input, candidate: await capture(variant) }, f.run)).rejects.toThrow(REFUSAL);
      for (const rows of Object.values(await f.state())) expect(rows).toEqual([]);
      expect((await f.query("SELECT * FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows).toEqual([]);
    }, 120_000);

  it('rolls back suppressed delta inserts including envelopes; an identical retry succeeds', async () => {
    const f = await fixture();
    const input = { ...f.input, candidate: await capture('removed') };
    await f.query(`CREATE FUNCTION delta_drop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await f.query('CREATE TRIGGER delta_drop BEFORE INSERT ON migration_full_delta_entries FOR EACH ROW EXECUTE FUNCTION delta_drop()');
    await expect(stageLocalFullGeneration(input, f.run)).rejects.toThrow(REFUSAL);
    for (const rows of Object.values(await f.state([...TABLES, 'migration_full_delta_entries']))) expect(rows).toEqual([]);
    expect((await f.query("SELECT * FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows).toEqual([]);
    await f.query('DROP TRIGGER delta_drop ON migration_full_delta_entries');
    await expect(stageLocalFullGeneration(input, f.run)).resolves.toMatchObject({ persistedReadback: 'MATCH' });
  }, 120_000);

  it.each(['missing', 'substituted'] as const)('does not silently repair %s removal evidence on retry', async kind => {
    const f = await fixture();
    const input = { ...f.input, candidate: await capture('removed') };
    await stageLocalFullGeneration(input, f.run);
    await f.query('ALTER TABLE migration_full_delta_entries DISABLE TRIGGER USER');
    if (kind === 'missing') await f.query("DELETE FROM migration_full_delta_entries WHERE target_table='promotions'");
    else await f.query("UPDATE migration_full_delta_entries SET entry_value=jsonb_set(entry_value,'{before,target,name}','\"substituted\"'::jsonb) WHERE target_table='promotions'");
    await f.query('ALTER TABLE migration_full_delta_entries ENABLE TRIGGER USER');
    const before = await f.state([...TABLES, 'migration_full_delta_entries']);
    await expect(stageLocalFullGeneration(input, f.run)).rejects.toThrow(REFUSAL);
    expect(await f.state([...TABLES, 'migration_full_delta_entries'])).toEqual(before);
  }, 120_000);

  it('scopes and protects staged removal evidence with tenant/job FKs and immutable SQL', async () => {
    const f = await fixture();
    await stageLocalFullGeneration({ ...f.input, candidate: await capture('removed') }, f.run);
    expect((await f.run(OTHER, tx => tx.execute(sql`SELECT * FROM migration_full_delta_entries`))).rows).toEqual([]);
    await expect(f.query('UPDATE migration_full_delta_entries SET target_id=target_id')).rejects.toMatchObject({ code: '55000' });
    await expect(f.query('DELETE FROM migration_full_delta_entries')).rejects.toMatchObject({ code: '55000' });
    await expect(f.query('TRUNCATE migration_full_delta_entries')).rejects.toMatchObject({ code: '55000' });
    await expect(f.query("INSERT INTO migration_full_delta_entries SELECT tenant_id,'other-job',generation_id,target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries LIMIT 1"))
      .rejects.toMatchObject({ code: '23503' });
    await expect(f.query("INSERT INTO migration_full_delta_entries SELECT tenant_id,migration_job_id,generation_id,'transactions',target_id,change_kind,entry_value FROM migration_full_delta_entries LIMIT 1"))
      .rejects.toMatchObject({ code: '23514' });
  }, 120_000);

  it('rolls back a mid-target failure including envelopes; an identical retry succeeds', async () => {
    const f = await fixture();
    await f.query(`CREATE FUNCTION full_fail_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_table='products' THEN RAISE EXCEPTION 'synthetic interruption'; END IF; RETURN NEW; END $$`);
    await f.query('CREATE TRIGGER full_fail BEFORE INSERT ON migration_full_targets FOR EACH ROW EXECUTE FUNCTION full_fail_target()');
    await expect(stageLocalFullGeneration(f.input, f.run)).rejects.toThrow(REFUSAL);
    for (const rows of Object.values(await f.state())) expect(rows).toEqual([]);
    expect((await f.query("SELECT * FROM audit_events WHERE event_type LIKE 'MIGRATION_PREPARATION_%'")).rows).toEqual([]);
    await f.query('DROP TRIGGER full_fail ON migration_full_targets');
    await expect(stageLocalFullGeneration(f.input, f.run)).resolves.toMatchObject({ persistedReadback: 'MATCH' });
  }, 120_000);

  it.each(['missing', 'substituted'] as const)('refuses %s persisted evidence on retry without repairing rows', async kind => {
    const f = await fixture();
    await stageLocalFullGeneration(f.input, f.run);
    // Owner-only corruption in a disposable database, re-enable before runtime resumes.
    if (kind === 'missing') {
      await f.query('ALTER TABLE migration_full_reconciliation DISABLE TRIGGER USER');
      await f.query("DELETE FROM migration_full_reconciliation WHERE category='products'");
      await f.query('ALTER TABLE migration_full_reconciliation ENABLE TRIGGER USER');
    } else {
      await f.query('ALTER TABLE migration_full_targets DISABLE TRIGGER USER');
      await f.query("UPDATE migration_full_targets SET canonical_value=canonical_value || '{\"name\":\"substituted\"}'::jsonb WHERE target_id='P2'");
      await f.query('ALTER TABLE migration_full_targets ENABLE TRIGGER USER');
    }
    const before = await f.state();
    await expect(stageLocalFullGeneration(f.input, f.run)).rejects.toThrow(REFUSAL);
    expect(await f.state()).toEqual(before);
  }, 120_000);

  it('refuses a stale READY version, cross-tenant binding, and missing runner', async () => {
    const f = await fixture();
    await expect(stageLocalFullGeneration({ ...f.input, expectedStateVersion: '999' }, f.run)).rejects.toThrow(REFUSAL);
    await expect(stageLocalFullGeneration({ ...f.input, tenantId: OTHER }, f.run)).rejects.toThrow(REFUSAL);
    await expect(stageLocalFullGeneration(f.input, undefined as unknown as TenantImportTransactionRunner)).rejects.toThrow(REFUSAL);
    for (const rows of Object.values(await f.state())) expect(rows).toEqual([]);
  }, 120_000);

  it('rejects changed capture bytes, orphan Redis claims and skipped callbacks without persisting evidence', async () => {
    const f = await fixture();
    const damaged = structuredClone(f.input);
    const changed = damaged.candidate.sheets.tabs.Products.rows[0].cells as unknown as string[];
    changed[1] = 'changed after capture without updating digest';
    await expect(stageLocalFullGeneration(damaged, f.run)).rejects.toThrow(REFUSAL);
    const orphan = await captureRedisClaimSnapshot({
      hscan: async () => ({ cursor: '0', entries: [[makeRedis().operationBindings[0].claimField, 'missing-operation']] }),
      scan: async () => ({ cursor: '0', keys: [] }), get: async () => null, getRevision: async () => 'synthetic-orphan',
    }, { capturedAt: makeSupportedSheets().capturedAt });
    await expect(stageLocalFullGeneration({ ...f.input, candidate: { ...f.input.candidate, redis: orphan } }, f.run)).rejects.toThrow(REFUSAL);
    const skipped = (async () => ({})) as unknown as TenantImportTransactionRunner;
    await expect(stageLocalFullGeneration(f.input, skipped)).rejects.toThrow(REFUSAL);
    for (const rows of Object.values(await f.state())) expect(rows).toEqual([]);
  }, 120_000);

  it('rejects suppressed target inserts and rolls back the entire graph', async () => {
    const f = await fixture();
    await f.query(`CREATE FUNCTION full_drop_target() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`);
    await f.query('CREATE TRIGGER full_drop BEFORE INSERT ON migration_full_targets FOR EACH ROW EXECUTE FUNCTION full_drop_target()');
    await expect(stageLocalFullGeneration(f.input, f.run)).rejects.toThrow(REFUSAL);
    for (const rows of Object.values(await f.state())) expect(rows).toEqual([]);
  }, 120_000);

  it('enforces scoped FKs, FORCE RLS, immutability and non-authoritative phase in disposable SQL', async () => {
    const f = await fixture();
    await stageLocalFullGeneration(f.input, f.run);
    expect((await f.run(OTHER, tx => tx.execute(sql`SELECT * FROM migration_full_targets`))).rows).toEqual([]);
    const header = (await f.query('SELECT generation_id FROM migration_full_generations')).rows[0];
    await expect(f.run(OTHER, tx => tx.execute(sql`INSERT INTO migration_full_targets
      VALUES (${TENANT},${JOB},${header.generation_id},'products','foreign-insert','{}'::jsonb)`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(f.query(`INSERT INTO migration_full_contributors SELECT tenant_id,migration_job_id,generation_id,mapping_ordinal,999999 FROM migration_full_contributors LIMIT 1`))
      .rejects.toMatchObject({ code: '23503' });
    await expect(f.run(OTHER, tx => tx.execute(sql`INSERT INTO migration_full_generations SELECT * FROM migration_full_generations WHERE tenant_id=${TENANT}`)))
      .resolves.toMatchObject({ rows: [] }); // RLS hides foreign rows; not a write capability.
    await expect(f.query(`INSERT INTO migration_full_targets SELECT tenant_id,'wrong-job',generation_id,target_table,target_id,canonical_value FROM migration_full_targets LIMIT 1`)).rejects.toMatchObject({ code: '23503' });
    await expect(f.query(`INSERT INTO migration_full_generations SELECT tenant_id,migration_job_id,'different',candidate_generation_id,original_generation_id,plan_id,expected_state_version,source_fingerprint,manifest_digest,'ACTIVE',writer_exclusion_status FROM migration_full_generations`)).rejects.toMatchObject({ code: '23514' });
    await expect(f.query('UPDATE migration_full_targets SET target_id=target_id')).rejects.toMatchObject({ code: '55000' });
    await expect(f.query('TRUNCATE migration_full_reconciliation')).rejects.toMatchObject({ code: '55000' });
    const flags = (await f.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=ANY($1)", [TABLES])).rows;
    expect(flags).toHaveLength(TABLES.length);
    expect(flags.every(r => r.relrowsecurity && r.relforcerowsecurity)).toBe(true);
  }, 120_000);
});
