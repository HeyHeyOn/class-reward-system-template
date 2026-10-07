import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';
import { reconstructOwnedMixedSourceV2 } from '@/server/db/testing/task19MixedRecoveryV2';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import type { LegacyNormalizationManifest } from '@/server/migration/manifest';
import type { MixedRetentionEvidence } from '@/server/migration/localMixedRetentionV2';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { witness, CATEGORIES, REPORTS, type ColdDatabase } from './task19MixedCold';
import { recoveryDomain } from './task19MixedRecoveryV2Checks';
import { TENANT, OTHER, JOB } from './task19MutableFixture';
import type { PostcommitRequest } from './task19MixedPostcommitV2';

/** Test-only executable composition, with existing runtime gates unchanged. The
 * caller retains a verified exclusive live lease; no serialized request grants it. */
export async function postcommitReplay(q: PostcommitRequest, source: ColdDatabase, destination: ColdDatabase) {
  const reconstructed = await reconstructOwnedMixedSourceV2(q.pin, q.binding, source.lease);
  const materialized = await materializeLocalCandidate(q.binding,
    createOwnedLocalMaterializationRunner(TENANT, JOB, source.lease, destination.lease));
  return { reconstructed, materialized };
}
export const postcommitState = async (source: ColdDatabase, destination: ColdDatabase) =>
  ({ source: await witness(source), destination: await witness(destination) });

/** All real public tables, with a separately enumerated category oracle; compare
 * owner-observed row digests with the immutable materialization readback. */
export async function postcommitDomain(q: PostcommitRequest, source: ColdDatabase, destination: ColdDatabase,
  materialized: Awaited<ReturnType<typeof materializeLocalCandidate>>) {
  const evidence = await recoveryDomain({ ...q, phase: 'retry', boundary: 'source-records' }, source, destination);
  const manifest = (evidence.envelopes.find(row => row.event_id === evidence.header.candidate_generation_id)!
    .redacted_details as { manifest: LegacyNormalizationManifest }).manifest;
  const mapping: Record<string, string> = { settings: 'tenant_settings', legacy_operation_bindings: 'operations' };
  const tables: { name: string; rows: { row: Record<string, unknown>; xmin: string; ctid: string }[] }[] = JSON.parse(await witness(destination));
  const categories = CATEGORIES.map(category => {
    const rows = tables.find(row => row.name === (mapping[category] ?? category))!.rows;
    const expected = manifest.records[category as keyof typeof manifest.records] ?? [];
    expect(rows.length, category).toBe(category === 'settings' ? 1 : expected.length);
    return { category, table: mapping[category] ?? category, count: rows.length };
  });
  const selectable = (await destination.owner.query("SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND has_table_privilege('app_runtime',quote_ident(schemaname)||'.'||quote_ident(tablename),'SELECT') ORDER BY tablename")).rows
    .map(row => row.tablename as string).filter(name => !['migration_local_disposable_database', 'migration_local_materializations'].includes(name));
  const observed = Object.fromEntries(selectable.map(name => {
    const rows = tables.find(row => row.name === name)!.rows.map(row => row.row)
      .filter(row => name !== 'tenants' || row.id === TENANT);
    return [name, { count: rows.length, digest: sha256(canonicalJson(rows.map(row => canonicalJson(row)).sort())) }];
  }));
  expect(materialized.readback).toEqual(observed);
  const receipt = (await destination.owner.query('SELECT * FROM migration_local_materializations')).rows;
  expect(receipt).toHaveLength(1); expect(receipt[0].domain_readback).toEqual(observed);
  expect(materialized).toMatchObject({ binding: q.binding, authority: 'NONAUTHORITY', activationAllowed: false, complete: false, exclusion: 'NOT_PROVEN' });
  expect((await source.owner.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows)
    .toEqual([{ status: 'READY', version: q.binding.expectedStateVersion }]);
  expect((await destination.owner.query('SELECT status,state_version::text AS version FROM migration_jobs')).rows)
    .toEqual([{ status: 'IMPORTING', version: '2' }]);
  for (const db of [source, destination]) {
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1', [TENANT])).rows).toEqual([{ lifecycle: 'IMPORTING' }]);
    expect((await db.owner.query('SELECT count(*)::integer AS n FROM migration_authority_receipts')).rows).toEqual([{ n: 0 }]);
  }
  expect(evidence.deltas.map(row => [row.target_table, row.change_kind]).sort())
    .toEqual([['products', 'MUTATED'], ['products', 'REMOVED'], ['settings', 'MUTATED']]);
  return { evidence, categories, observed, receipt, publicTableCount: tables.length };
}

export async function postcommitRefusals(q: PostcommitRequest, source: ColdDatabase, destination: ColdDatabase) {
  const observations: Record<string, unknown>[] = [];
  const refuse = async (name: string, call: () => Promise<unknown>, expected: string) => {
    const before = await postcommitState(source, destination);
    const outcome = await call().then(value => ({ accepted: true, value }), error => ({ accepted: false, error: (error as Error).message }));
    const after = await postcommitState(source, destination);
    observations.push({ name, before, after, outcome });
    expect(outcome, name).toEqual({ accepted: false, error: expected }); expect(after, name).toEqual(before);
  };
  const sourceError = 'Synthetic mixed V2 source recovery refused.', destinationError = 'Local candidate domain materialization refused.';
  for (const [key, value] of Object.entries({ tenantId: OTHER, migrationJobId: randomUUID(), generationId: 'wrong-generation',
    expectedStateVersion: '99', sourceFingerprint: sha256('wrong-source'), manifestDigest: sha256('wrong-manifest') })) {
    await refuse(`binding:${key}`, () => postcommitReplay({ ...q, binding: { ...q.binding, [key]: value } }, source, destination), sourceError);
  }
  for (const [key, value] of Object.entries({ sourceDatabaseId: q.source.databaseId, sourceOwnerId: q.ownerId, ownerId: randomUUID(),
    sha256: sha256('wrong-pin'), inode: 0, device: -1, directory: q.pin.directory + '/missing' })) {
    await refuse(`pin:${key}`, () => postcommitReplay({ ...q, pin: { ...q.pin, [key]: value } }, source, destination), sourceError);
  }
  const artifact = `${q.pin.directory}/artifact.json`, bytes = readFileSync(artifact, 'utf8');
  const changes: [string, (e: MixedRetentionEvidence) => void][] = REPORTS.flatMap(category => [
    [`missing-report:${category}`, (e: MixedRetentionEvidence) => { Object.assign(e, { reconciliation: e.reconciliation.filter(row => row.category !== category) }); }],
    [`corrupt-report:${category}`, (e: MixedRetentionEvidence) => { Object.assign(e.reconciliation.find(row => row.category === category)!, { expected_digest: '0'.repeat(64), observed_digest: '0'.repeat(64) }); }],
  ] as [string, (e: MixedRetentionEvidence) => void][]);
  changes.push(['claim-recapture', e => { e.recaptures.splice(0, 1); }],
    ['removal', e => { Object.assign(e, { deltas: e.deltas.filter(row => row.change_kind !== 'REMOVED') }); }],
    ['settings', e => { Object.assign(e.deltas.find(row => row.target_table === 'settings')!.entry_value as object, { afterDigest: '0'.repeat(64) }); }],
    ['products', e => { Object.assign(e.deltas.find(row => row.target_table === 'products')!.entry_value as object, { beforeDigest: '0'.repeat(64) }); }]);
  for (const [name, change] of changes) {
    const payload = JSON.parse(bytes); change(payload.evidence); const changed = canonicalJson(payload);
    expect(changed, name).not.toBe(bytes); writeFileSync(artifact, changed);
    try { await refuse(name, () => postcommitReplay({ ...q, pin: { ...q.pin, sha256: sha256(changed) } }, source, destination), sourceError); }
    finally { writeFileSync(artifact, bytes); }
  }
  expect(readFileSync(artifact, 'utf8')).toBe(bytes);
  // These are actual admitted SQL divergences, not mocked return values. Damage
  // and restoration commits are OUTSIDE each exact measured refusal interval.
  for (const [label, db, error] of [['source', source, sourceError], ['destination', destination, destinationError]] as const) {
    const old = (await db.owner.query("SELECT name FROM products WHERE product_id='P1'")).rows[0].name;
    await db.owner.query("UPDATE products SET name='Postcommit mismatch' WHERE product_id='P1'");
    try { await refuse(`${label}:product-mismatch`, () => postcommitReplay(q, source, destination), error); }
    finally { await db.owner.query("UPDATE products SET name=$1 WHERE product_id='P1'", [old]); }
  }
  const settings = (await destination.owner.query('SELECT settings FROM tenant_settings')).rows[0].settings;
  await destination.owner.query("UPDATE tenant_settings SET settings=settings || '{\"postcommit-mismatch\":true}'::jsonb");
  try { await refuse('destination:settings-mismatch', () => postcommitReplay(q, source, destination), destinationError); }
  finally { await destination.owner.query('UPDATE tenant_settings SET settings=$1', [JSON.stringify(settings)]); }
  for (const [name, s, d] of [
    ['stale-source-physical', { ...source.lease, databaseId: q.pin.sourceDatabaseId }, destination.lease],
    ['wrong-destination', source.lease, { ...destination.lease, databaseId: randomUUID() }],
    ['wrong-owner', source.lease, { ...destination.lease, ownerId: randomUUID() }],
    ['same-database', source.lease, source.lease],
  ] as const) await refuse(name, () => materializeLocalCandidate(q.binding, createOwnedLocalMaterializationRunner(TENANT, JOB, s, d)), destinationError);
  const before = await postcommitState(source, destination);
  for (const table of ['migration_local_materializations', 'migration_local_disposable_database']) {
    await expect(destination.owner.query(`UPDATE ${table} SET owner_id=owner_id`)).rejects.toMatchObject({ code: '55000' });
  }
  const after = await postcommitState(source, destination); expect(after).toEqual(before);
  observations.push({ name: 'intrinsic-receipt-marker-immutability', before, after, outcome: { accepted: false, code: '55000' } });
  return observations;
}
