import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { expect } from 'vitest';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { readOwnedMixedRetentionV2 } from '@/server/db/testing/task19MixedRetentionV2';
import type { MixedRetentionEvidence } from '@/server/migration/localMixedRetentionV2';
import type { LegacyNormalizationManifest } from '@/server/migration/manifest';
import { witness, REPORTS, type ColdDatabase } from './task19MixedCold';
import { TENANT, OTHER } from './task19MutableFixture';
import type { RecoveryRequest } from './task19MixedRecoveryV2';
export async function recoveryRefusals(q: RecoveryRequest, source: ColdDatabase, destination: ColdDatabase) {
  const observations: Record<string, unknown>[] = [];
  const state = async () => ({ source: await witness(source), destination: await witness(destination) });
  const refuse = async (name: string, trial: RecoveryRequest, lease = source.lease) => {
    const before = await state();
    const outcome = await reconstructOwnedMixedSourceV2(trial.pin, trial.binding, lease)
      .then(() => 'ACCEPTED', error => (error as Error).message);
    const after = await state(); observations.push({ name, before, after, outcome });
    expect(outcome, name).toBe('Synthetic mixed V2 source recovery refused.');
    expect(after, name).toEqual(before);
  };
  for (const [key, value] of Object.entries({ tenantId: OTHER, migrationJobId: randomUUID(), generationId: 'wrong',
    expectedStateVersion: '99', sourceFingerprint: sha256('wrong'), manifestDigest: sha256('wrong-manifest') })) {
    await refuse(`binding:${key}`, { ...q, binding: { ...q.binding, [key]: value } });
  }
  for (const [key, value] of Object.entries({ sourceDatabaseId: q.source.databaseId, sourceOwnerId: q.ownerId,
    ownerId: randomUUID(), sha256: sha256('wrong-pin'), inode: 0, device: -1, directory: q.pin.directory + '/missing' })) {
    await refuse(`pin:${key}`, { ...q, pin: { ...q.pin, [key]: value } });
  }
  await refuse('lease:stale-original-source', q, { ...source.lease, databaseId: q.pin.sourceDatabaseId });
  await refuse('lease:wrong-owner', q, { ...source.lease, ownerId: randomUUID() });
  const artifact = `${q.pin.directory}/artifact.json`, bytes = readFileSync(artifact, 'utf8');
  renameSync(artifact, `${artifact}.saved`);
  try { await refuse('missing-artifact', q); } finally { renameSync(`${artifact}.saved`, artifact); }
  const changes: [string, (e: MixedRetentionEvidence) => void][] = REPORTS.map(category => [
    `missing-report:${category}`, e => { Object.assign(e, { reconciliation: e.reconciliation.filter(row => row.category !== category) }); },
  ]);
  for (const key of ['header', 'envelopes', 'sources', 'targets', 'mappings', 'contributors', 'deltas', 'recaptures', 'coverage']) {
    changes.push([`missing-field:${key}`, e => { delete (e as unknown as Record<string, unknown>)[key]; }]);
  }
  changes.push(['v1-payload', e => { Object.assign(e, { format: 'TASK19_MUTABLE_RETENTION_V1' }); }],
    ['missing-claim-recapture', e => { e.recaptures.splice(0, 1); }],
    ['claim-after', e => { Object.assign(e.recaptures[0].entry_value as object, { afterDigest: '0'.repeat(64) }); }],
    ['missing-removal', e => { Object.assign(e, { deltas: e.deltas.filter(row => row.change_kind !== 'REMOVED') }); }],
    ['settings-before', e => { Object.assign(e.deltas.find(row => row.target_table === 'settings')!.entry_value as object, { beforeDigest: '0'.repeat(64) }); }]);
  for (const [name, change] of changes) {
    const payload = JSON.parse(bytes); change(payload.evidence); const changed = canonicalJson(payload);
    expect(changed, name).not.toBe(bytes); writeFileSync(artifact, changed);
    try { await refuse(name, { ...q, pin: { ...q.pin, sha256: sha256(changed) } }); }
    finally { writeFileSync(artifact, bytes); }
  }
  const wrapper = JSON.parse(bytes); wrapper.format = 'TASK19_OWNED_MUTABLE_ARCHIVE_V1'; const changed = canonicalJson(wrapper);
  writeFileSync(artifact, changed);
  try { await refuse('v1-wrapper', { ...q, pin: { ...q.pin, sha256: sha256(changed) } }); }
  finally { writeFileSync(artifact, bytes); }
  expect(readFileSync(artifact, 'utf8')).toBe(bytes);
  // Damage a committed source's mutable domain outside the measured interval.
  // Runtime permissions and intrinsic SQL guards stay unchanged during refusal.
  if (q.phase === 'retry') {
    const old = (await source.owner.query("SELECT name FROM products WHERE product_id='P1'")).rows[0].name;
    await source.owner.query("UPDATE products SET name='Damaged reconstruction' WHERE product_id='P1'");
    try { await refuse('damaged-ready-source', q); }
    finally { await source.owner.query("UPDATE products SET name=$1 WHERE product_id='P1'", [old]); }
  }
  return observations;
}
export async function recoveryDomain(q: RecoveryRequest, source: ColdDatabase, destination: ColdDatabase) {
  const evidence = await readOwnedMixedRetentionV2(q.pin, q.binding);
  expect(evidence.reconciliation.map(row => row.category).sort()).toEqual([...REPORTS].sort());
  expect(evidence.recaptures).toHaveLength(1);
  expect(evidence.reconciliation.find(row => row.category === 'padlet_claim_digest_tombstones'))
    .toMatchObject({ status: 'MATCH', expected_count: q.tombstone ? 1 : 0, observed_count: q.tombstone ? 1 : 0 });
  const manifest = (evidence.envelopes.find(row => row.event_id === evidence.header.candidate_generation_id)!.redacted_details as { manifest: LegacyNormalizationManifest }).manifest;
  expect((await source.owner.query('SELECT product_id,name FROM products ORDER BY product_id')).rows)
    .toEqual([{ product_id: 'P1', name: 'Pencil' }, { product_id: 'PX', name: 'Removed cold product' }]);
  expect((await destination.owner.query('SELECT tenant_id,product_id,name,price,stock,is_active,image_url,category,sort_order FROM products ORDER BY product_id')).rows)
    .toEqual(manifest.records.products.map(row => ({ tenant_id: row.tenantId, product_id: row.productId, name: row.name, price: String(row.price),
      stock: String(row.stock), is_active: row.isActive, image_url: row.imageUrl, category: row.category, sort_order: row.sortOrder })));
  expect((await destination.owner.query('SELECT settings FROM tenant_settings')).rows)
    .toEqual([{ settings: Object.fromEntries(manifest.records.settings.map(row => [row.key, row.value])) }]);
  expect((await destination.owner.query(`SELECT provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,
    to_char(evidence_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS evidence_created_at,evidence_author_full_name FROM padlet_evidence_claims ORDER BY tuple_digest`)).rows)
    .toEqual(manifest.records.padlet_evidence_claims.map(row => ({ provider: 'PADLET', board_id: row.boardId, post_id: row.postId,
      tuple_digest: row.tupleDigest, claimed_by_tenant_id: TENANT, claimed_by_operation_id: row.operationId,
      evidence_created_at: row.evidenceCreatedAt, evidence_author_full_name: row.evidenceAuthorFullName })));
  expect((await destination.owner.query('SELECT tuple_digest,owner_digest,source_provenance FROM padlet_claim_digest_tombstones ORDER BY tuple_digest')).rows)
    .toEqual((manifest.records.padlet_claim_digest_tombstones ?? []).map(row => ({ tuple_digest: row.tupleDigest, owner_digest: row.ownerDigest ?? null, source_provenance: row.provenance })));
  expect((await destination.owner.query('SELECT source_database_id,destination_database_id,owner_id FROM migration_local_materializations')).rows)
    .toEqual([{ source_database_id: q.source.databaseId, destination_database_id: q.destination.databaseId, owner_id: q.ownerId }]);
  for (const db of [source, destination]) expect((await db.owner.query('SELECT final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
    .toEqual([{ final_fingerprint: null, freeze_started_at: null, freeze_verified_at: null, completed_at: null }]);
  return evidence;
}
