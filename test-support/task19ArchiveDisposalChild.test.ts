// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { retainOwnedMutableProvenance, readOwnedMutableRetention, type MutableRetentionPin } from '@/server/db/testing/task19MutableRetention';
import { captureLocalMutableRetention, type MutableRetentionEvidence } from '@/server/migration/localMutableRetention';
import type { FinalGenerationPreparationInput } from '@/server/migration/finalGeneration';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { mutableFixture, cleanupMutableFixture, forbidMutableWrites, TENANT, OTHER, JOB } from './task19MutableFixture';
import { coldConnections, witness, denyWrites, clearWriteGuard, type ColdDatabase } from './task19MixedCold';
import { PRODUCT_REPORTS, type ArchiveDisposalRequest } from './task19ArchiveDisposal';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_SOURCE_FORBIDDEN'); } }));
const path = process.env.TASK19_ARCHIVE_DISPOSAL_REQUEST;
if (path && !/^\.task19-archive-disposal-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid archive disposal request');
type Recovery = Extract<ArchiveDisposalRequest, { pin: MutableRetentionPin }>;
type Generation = {
  acquisition: FinalGenerationPreparationInput['original']; originalSourceId: string;
  originalSnapshotId: string; exclusionGenerationReference: string;
};

async function produce() {
  try {
    const f = await mutableFixture();
    const parent = '.task19-archive-disposal-artifacts';
    mkdirSync(parent,{recursive:true,mode:0o700});
    await forbidMutableWrites(f.source);
    const before = await witness(f.source);
    const pin = await retainOwnedMutableProvenance(f.source,f.ownerId,f.binding,parent);
    expect(await witness(f.source)).toBe(before);
    const originalPins = [f.request.source,f.request.destination];
    const topology = [f.source.evidence,f.destination.evidence];
    const cleanup = [];
    for (const db of [f.source,f.destination]) cleanup.push(await db.close());
    expect(cleanup.every(row => row.containerRemoved && row.scratchRemoved)).toBe(true);
    // No captures or expected data cross the producer process boundary.
    return {pin,binding:f.binding,originalPins,topology,cleanup};
  } finally { await cleanupMutableFixture(); }
}

function sameEvidence(actual: MutableRetentionEvidence, expected: MutableRetentionEvidence) {
  for (const key of ['format','authority','activationAllowed','complete','exclusion','binding','header','coverage'] as const) {
    expect(actual[key],key).toEqual(expected[key]);
  }
  for (const key of ['envelopes','sources','targets','mappings','contributors','deltas','recaptures','reconciliation'] as const) {
    expect(actual[key].map(row => canonicalJson(row)).sort(),key)
      .toEqual(expected[key].map(row => canonicalJson(row)).sort());
  }
}

/** Executable test reconstruction using EXISTING contracts. This is not a new
 * runtime restore API or a transactional backup/recovery acceptance claim.
 * No database write can occur until the complete archive passes validation. */
async function recover(request: Recovery, source: ColdDatabase, destination: ColdDatabase) {
  const evidence = await readOwnedMutableRetention(request.pin,request.binding);
  const {binding} = evidence;
  if (request.phase === 'rebuild') {
    const original = evidence.envelopes.find(row => row.event_id === evidence.header.original_generation_id)!.redacted_details as Generation;
    const candidate = evidence.envelopes.find(row => row.event_id === evidence.header.candidate_generation_id)!.redacted_details as Generation;
    const manifest = createLegacyNormalizationManifest({tenantId:binding.tenantId,migrationJobId:binding.migrationJobId,...original.acquisition});
    await importLegacyNormalizationManifest({tenantId:binding.tenantId,migrationJobId:binding.migrationJobId,
      manifest,runTransaction:source.lease.runTransaction});
    // Synthetic fixture bootstrap only. No ACTIVE/fence/authority transition.
    for (const status of ['RECONCILING','READY']) await source.owner.query(
      'UPDATE migration_jobs SET status=$3,state_version=state_version+1 WHERE tenant_id=$1 AND job_id=$2',[TENANT,JOB,status]);
    expect((await source.owner.query('SELECT state_version::text AS version FROM migration_jobs')).rows)
      .toEqual([{version:binding.expectedStateVersion}]);
    const staged = await stageLocalFullGeneration({tenantId:binding.tenantId,migrationJobId:binding.migrationJobId,
      expectedStateVersion:binding.expectedStateVersion,originalSourceId:original.originalSourceId,originalSnapshotId:original.originalSnapshotId,
      exclusionGenerationReference:candidate.exclusionGenerationReference,original:original.acquisition,candidate:candidate.acquisition},source.lease.runTransaction);
    expect(staged.generationId).toBe(binding.generationId);
  }
  const reconstructed = await source.lease.runTransaction(TENANT,tx => captureLocalMutableRetention(binding,tx));
  sameEvidence(reconstructed,evidence);
  const receipt = await materializeLocalCandidate(binding,createOwnedLocalMaterializationRunner(TENANT,JOB,source.lease,destination.lease));
  return {evidence,receipt};
}

type Mutation = [string, (e: MutableRetentionEvidence) => void];
async function exercise(request: Recovery, source: ColdDatabase, destination: ColdDatabase) {
  const artifact = join(request.pin.directory,'artifact.json'), bytes = readFileSync(artifact,'utf8');
  const observations: Record<string,unknown>[] = [];
  const state = async () => [await witness(source),await witness(destination)];
  const refuse = async (name: string, trial: Recovery) => {
    const before = await state();
    const outcome = await recover(trial,source,destination).then(() => 'ACCEPTED',error => (error as Error).message);
    const after = await state();
    observations.push({name,outcome,before,after});
    expect(outcome,name).toBe('Local mutable retention archive refused.');
    expect(after,name).toEqual(before);
  };
  // Real runtime permissions and SQL guards, no test no-write triggers on these
  // negative intervals. A read-side repair would be visible in row/xmin/ctid.
  for (const [key,value] of Object.entries({tenantId:OTHER,migrationJobId:randomUUID(),generationId:'wrong-generation',
    expectedStateVersion:'99',sourceFingerprint:sha256('wrong-source'),manifestDigest:sha256('wrong-manifest')})) {
    await refuse(`binding:${key}`,{...request,binding:{...request.binding,[key]:value}});
  }
  for (const [key,value] of Object.entries({sourceDatabaseId:request.source.databaseId,sourceOwnerId:request.ownerId,
    ownerId:randomUUID(),sha256:sha256('wrong digest'),directory:join(request.pin.directory,'missing')})) {
    await refuse(`archive-pin:${key}`,{...request,pin:{...request.pin,[key]:value}});
  }
  const mutations: Mutation[] = PRODUCT_REPORTS.flatMap(category => [
    [`missing-report:${category}`,(e: MutableRetentionEvidence) => { Object.assign(e,{reconciliation:e.reconciliation.filter(row => row.category !== category)}); }],
    [`corrupt-report:${category}`,(e: MutableRetentionEvidence) => { Object.assign(e.reconciliation.find(row => row.category === category)!,
      {expected_digest:'0'.repeat(64),observed_digest:'0'.repeat(64)}); }],
  ] as Mutation[]);
  mutations.push(
    ['before-image',e => { const entry = e.deltas.find(row => row.change_kind === 'MUTATED')!.entry_value as {before:{target:{name:string}}}; entry.before.target.name='wrong'; }],
    ['after-image',e => { const entry = e.deltas.find(row => row.change_kind === 'MUTATED')!.entry_value as {after:{target:{price:number}}}; entry.after.target.price=999; }],
    ['removal-tombstone',e => { Object.assign(e,{deltas:e.deltas.filter(row => row.change_kind !== 'REMOVED')}); }],
    ['original-capture',e => { Object.assign(e,{envelopes:e.envelopes.filter(row => row.event_id !== e.header.original_generation_id)}); }],
    ['candidate-capture',e => { Object.assign(e,{envelopes:e.envelopes.filter(row => row.event_id !== e.header.candidate_generation_id)}); }],
    ['source-pointer',e => { (e.envelopes.find(row => row.event_id === e.header.original_generation_id)!.redacted_details as Generation).originalSourceId='sheet:wrong'; }],
    ['sources',e => { e.sources.splice(0,1); }],['targets',e => { e.targets.splice(0,1); }],
    ['mappings',e => { e.mappings.splice(0,1); }],['contributors',e => { e.contributors.splice(0,1); }],
    ['coverage',e => { Object.assign(e.coverage,{coverage:e.coverage.coverage.slice(1)}); }],
    ['recapture-injection',e => { e.recaptures.push({target_table:'padlet_evidence_claims',target_id:'wrong',entry_value:{}}); }],
  );
  for (const [name,mutate] of mutations) {
    const payload = JSON.parse(bytes); mutate(payload.evidence);
    const corrupt = canonicalJson(payload);
    writeFileSync(artifact,corrupt);
    try {
      // Stronger than an external hash mismatch: freshly pinned damaged evidence
      // must still fail semantic verification before any source/destination write.
      await refuse(name,{...request,pin:{...request.pin,sha256:sha256(corrupt)}});
    } finally { writeFileSync(artifact,bytes); }
  }
  expect(readFileSync(artifact,'utf8')).toBe(bytes);
  const before = await state();
  if (request.phase === 'retry') { await denyWrites(source); await denyWrites(destination); }
  const {evidence,receipt} = await recover(request,source,destination);
  const after = await state();
  if (request.phase === 'retry') {
    expect(after).toEqual(before);
    await clearWriteGuard(source); await clearWriteGuard(destination);
  }
  // Rebinding is explicit infrastructure ownership, never replacing the archive
  // origin pin with the new source ID. A stale physical lease must fail closed.
  const rebindingBefore = await state();
  await expect(materializeLocalCandidate(request.binding,createOwnedLocalMaterializationRunner(TENANT,JOB,
    {...source.lease,databaseId:request.pin.sourceDatabaseId},destination.lease)))
    .rejects.toThrow('Local candidate domain materialization refused.');
  expect(await state()).toEqual(rebindingBefore);
  expect(evidence.reconciliation.map(row => row.category).sort()).toEqual([...PRODUCT_REPORTS].sort());
  expect(evidence.recaptures).toEqual([]);
  expect(evidence.reconciliation.find(row => row.category === 'padlet_claim_digest_tombstones'))
    .toMatchObject({expected_count:0,observed_count:0,status:'MATCH'});
  const deltas = (await source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_id')).rows;
  expect(deltas).toEqual([...evidence.deltas].sort((a,b) => String(a.target_id).localeCompare(String(b.target_id))));
  expect(deltas.map(row => [row.target_id,row.change_kind])).toEqual([['P1','MUTATED'],['PNEW','ADDED'],['PX','REMOVED']]);
  for (const table of ['migration_full_delta_entries','migration_full_reconciliation']) {
    await expect(source.owner.query(`UPDATE ${table} SET generation_id=generation_id`)).rejects.toMatchObject({code:'55000'});
  }
  expect((await destination.owner.query('SELECT product_id,name,price::text FROM products ORDER BY product_id')).rows)
    .toEqual([{product_id:'P1',name:'Mutable pencil',price:'27'},{product_id:'PNEW',name:'Added notebook',price:'15'}]);
  expect((await source.owner.query('SELECT product_id,name FROM products ORDER BY product_id')).rows)
    .toEqual([{product_id:'P1',name:'Pencil'},{product_id:'PX',name:'Removed unreferenced'}]);
  expect((await destination.owner.query('SELECT source_database_id,destination_database_id,owner_id FROM migration_local_materializations')).rows)
    .toEqual([{source_database_id:request.source.databaseId,destination_database_id:request.destination.databaseId,owner_id:request.ownerId}]);
  expect((await destination.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
    .toEqual([{status:'IMPORTING',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
  expect(receipt).toMatchObject({binding:request.binding,authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
  expect(readFileSync(artifact,'utf8')).toBe(bytes);
  return {receipt,observations,sourceWitness:await witness(source),destinationWitness:await witness(destination),
    immutableEvidence:evidence,archiveSha256:sha256(bytes),stalePhysicalLeaseRefused:true};
}

it.skipIf(!path)('Task19 archive disposal process phase', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const request = JSON.parse(readFileSync(path!,'utf8')) as ArchiveDisposalRequest;
  const result: Record<string,unknown> = {pid:process.pid,phase:request.phase,success:false};
  try {
    if (request.phase === 'produce') {
      expect(Object.keys(request)).toEqual(['phase']);
      Object.assign(result,await produce());
    } else {
      expect(Object.keys(request).sort()).toEqual(['phase','pin','binding','source','destination','ownerId'].sort());
      expect(request.source.databaseId).not.toBe(request.pin.sourceDatabaseId);
      expect(request.ownerId).not.toBe(request.pin.sourceOwnerId);
      const connections = coldConnections({...request,tombstone:false,phase:request.phase === 'rebuild' ? 'import' : 'retry'});
      try {
        const source = await connections.connect(request.source,'SOURCE'), destination = await connections.connect(request.destination,'DESTINATION');
        Object.assign(result,await exercise(request,source,destination));
      } finally { await connections.close(); result.backends=connections.backends; }
    }
    result.success=true;
  } finally {
    result.poolsClosed=true;
    writeFileSync(path!.replace('-request.json','-result.json'),JSON.stringify(result),{flag:'wx',mode:0o600});
  }
},300_000);
