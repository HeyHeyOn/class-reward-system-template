import 'server-only';
import { sql } from 'drizzle-orm';
import type { OwnedSyntheticDatabaseLease } from '@/server/migration/localMaterializationRunner';
import type { MixedRetentionBinding, MixedRetentionEvidence } from '@/server/migration/localMixedRetentionV2';
import { captureLocalMixedRetentionV2 } from '@/server/migration/localMixedRetentionV2';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import type { FinalGenerationPreparationInput } from '@/server/migration/finalGeneration';
import { canonicalJson } from '@/server/migration/validators';
import { readOwnedMixedRetentionV2, type MixedRetentionPin } from './task19MixedRetentionV2';

const METADATA = new Set(['tenants', 'migration_jobs', 'migration_local_disposable_database']);
const RECONSTRUCTED = new Set(['tenant_settings', 'students', 'accounts', 'products', 'promotions', 'promotion_products',
  'tasks', 'task_allowed_students', 'task_assignments', 'transactions', 'transaction_items', 'adjustments', 'task_completions',
  'migration_sources', 'migration_source_records', 'migration_snapshots', 'audit_events', 'migration_full_generations',
  'migration_full_sources', 'migration_full_targets', 'migration_full_mappings', 'migration_full_contributors',
  'migration_full_delta_entries', 'migration_full_claim_recaptures', 'migration_full_reconciliation']);
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
const busy = new WeakSet<OwnedSyntheticDatabaseLease>();
function refused(): never { throw new Error('Synthetic mixed V2 source recovery refused.'); }
type Generation = {
  acquisition: FinalGenerationPreparationInput['original']; originalSourceId: string;
  originalSnapshotId: string; exclusionGenerationReference: string;
};
function sameEvidence(actual: MixedRetentionEvidence, expected: MixedRetentionEvidence) {
  for (const key of ['format', 'authority', 'activationAllowed', 'complete', 'exclusion', 'binding', 'header', 'coverage'] as const) {
    if (canonicalJson(actual[key]) !== canonicalJson(expected[key])) refused();
  }
  for (const key of ['envelopes', 'sources', 'targets', 'mappings', 'contributors', 'deltas', 'recaptures', 'reconciliation'] as const) {
    const rows = (value: unknown[]) => canonicalJson(value.map(row => canonicalJson(row)).sort());
    if (rows(actual[key]) !== rows(expected[key])) refused();
  }
}

/** Bounded TEST infrastructure composer; not a route, operational restore or
 * orphan-adoption API. The live allocator retains an exclusive, physically
 * verified disposable source lease across calls/processes. No default pool.
 * A complete V2 admission precedes writes. Import batches + synthetic READY +
 * staging share ONE source transaction. Connection death rolls it back; a lost
 * commit acknowledgement is resolved by exact READY evidence, without writes.
 * Partial legacy IMPORTING/RECONCILING or damaged READY sources are refused.
 * Destination materialization is a SEPARATE existing atomic transaction; this
 * is not distributed atomicity, authority, writer fencing or host-loss recovery. */
export async function reconstructOwnedMixedSourceV2(pin: MixedRetentionPin, expected: MixedRetentionBinding,
  source: OwnedSyntheticDatabaseLease) {
  if (busy.has(source)) refused();
  busy.add(source);
  try {
    if (process.env.RUN_REAL_POSTGRES !== '1' || source.kind !== 'SYNTHETIC_DISPOSABLE'
      || source.databaseId === pin.sourceDatabaseId || source.ownerId === pin.sourceOwnerId) refused();
    const evidence = await readOwnedMixedRetentionV2(pin, expected);
    const { binding } = evidence;
    const marker = { database_id: source.databaseId, owner_id: source.ownerId, role: 'SOURCE',
      tenant_id: binding.tenantId, job_id: binding.migrationJobId };
    const markers = await source.queryOwner('SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database');
    if (canonicalJson(markers.rows) !== canonicalJson([marker])) refused();
    const jobs = await source.queryOwner('SELECT tenant_id,job_id FROM migration_jobs');
    if (canonicalJson(jobs.rows) !== canonicalJson([{ tenant_id: binding.tenantId, job_id: binding.migrationJobId }])) refused();
    return await source.runTransaction(binding.tenantId, async tx => {
      const markerRows = (await tx.execute(sql`SELECT database_id,owner_id,role,tenant_id,job_id FROM migration_local_disposable_database`)).rows;
      if (canonicalJson(markerRows) !== canonicalJson([marker])) refused();
      const tenants = (await tx.execute(sql`SELECT lifecycle FROM tenants WHERE id=${binding.tenantId} FOR UPDATE`)).rows;
      const jobs = (await tx.execute(sql`SELECT status,state_version::text AS version,source_fingerprint,
        final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs
        WHERE tenant_id=${binding.tenantId} AND job_id=${binding.migrationJobId} FOR UPDATE`)).rows;
      if (tenants.length !== 1 || jobs.length !== 1) refused();
      const job = jobs[0], retry = job.status === 'READY';
      if (job.status !== (retry ? 'READY' : 'VALIDATED') || job.version !== (retry ? binding.expectedStateVersion : '1')
        || tenants[0].lifecycle !== (retry ? 'IMPORTING' : 'DRAFT')
        || (!retry && job.source_fingerprint !== null) || job.final_fingerprint !== null
        || job.freeze_started_at !== null || job.freeze_verified_at !== null || job.completed_at !== null) refused();
      // Global counts bypass RLS ONLY via allocator's owner readback. The source
      // lease is exclusive; do not infer exclusivity from this in-process lock.
      const tables = await source.queryOwner("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' ORDER BY tablename");
      const columns = await source.queryOwner("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('tenant_id','claimed_by_tenant_id')");
      for (const row of tables.rows) {
        if (typeof row.tablename !== 'string') refused();
        const table = row.tablename;
        const counts = await source.queryOwner(`SELECT count(*)::text AS count FROM ${identifier(table)}`);
        if (!METADATA.has(table) && (!retry || !RECONSTRUCTED.has(table)) && counts.rows[0].count !== '0') refused();
        const column = columns.rows.find(value => value.table_name === table)?.column_name;
        if (typeof column === 'string') {
          const foreign = await source.queryOwner(`SELECT count(*)::text AS count FROM ${identifier(table)} WHERE ${identifier(column)} <> $1`, [binding.tenantId]);
          if (foreign.rows[0].count !== '0') refused();
        }
      }
      if (!retry) {
        const original = evidence.envelopes.find(row => row.event_id === evidence.header.original_generation_id)!.redacted_details as Generation;
        const candidate = evidence.envelopes.find(row => row.event_id === evidence.header.candidate_generation_id)!.redacted_details as Generation;
        const run: OwnedSyntheticDatabaseLease['runTransaction'] = async (tenant, callback) => {
          if (tenant !== binding.tenantId) refused();
          return callback(tx);
        };
        const manifest = createLegacyNormalizationManifest({ tenantId: binding.tenantId, migrationJobId: binding.migrationJobId, ...original.acquisition });
        await importLegacyNormalizationManifest({ tenantId: binding.tenantId, migrationJobId: binding.migrationJobId, manifest, runTransaction: run });
        for (const status of ['RECONCILING', 'READY']) await tx.execute(sql`UPDATE migration_jobs SET status=${status},state_version=state_version+1
          WHERE tenant_id=${binding.tenantId} AND job_id=${binding.migrationJobId}`);
        const staged = await stageLocalFullGeneration({ tenantId: binding.tenantId, migrationJobId: binding.migrationJobId,
          expectedStateVersion: binding.expectedStateVersion, originalSourceId: original.originalSourceId, originalSnapshotId: original.originalSnapshotId,
          exclusionGenerationReference: candidate.exclusionGenerationReference, original: original.acquisition, candidate: candidate.acquisition }, run);
        if (staged.generationId !== binding.generationId) refused();
      }
      sameEvidence(await captureLocalMixedRetentionV2(binding, tx), evidence);
      return Object.freeze({ disposition: retry ? 'VERIFIED_EXISTING' as const : 'RECONSTRUCTED' as const,
        scope: 'SYNTHETIC_RECONSTRUCTED_SOURCE_V2' as const, authority: 'NONAUTHORITY' as const,
        activationAllowed: false as const, complete: false as const, exclusion: 'NOT_PROVEN' as const, binding });
    });
  } catch { refused(); }
  finally { busy.delete(source); }
}
