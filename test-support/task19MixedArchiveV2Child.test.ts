// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { retainOwnedMixedProvenanceV2, readOwnedMixedRetentionV2, type MixedRetentionPin } from '@/server/db/testing/task19MixedRetentionV2';
import { captureLocalMixedRetentionV2, type MixedRetentionEvidence } from '@/server/migration/localMixedRetentionV2';
import type { FinalGenerationPreparationInput } from '@/server/migration/finalGeneration';
import { importLegacyNormalizationManifest } from '@/server/migration/importer';
import { createLegacyNormalizationManifest } from '@/server/migration/manifest';
import { stageLocalFullGeneration } from '@/server/migration/localFullGenerationStage';
import { materializeLocalCandidate } from '@/server/migration/localCandidateMaterialization';
import { createOwnedLocalMaterializationRunner } from '@/server/migration/localMaterializationRunner';
import { canonicalJson, sha256 } from '@/server/migration/validators';
import { TENANT, OTHER, JOB } from './task19MutableFixture';
import { coldConnections, witness, denyWrites, clearWriteGuard, type ColdDatabase } from './task19MixedCold';
import { allocateMixed, produceMixed, type MixedArchiveRequest } from './task19MixedArchiveV2';
import { REPORTS } from './task19MixedCold';
import type { DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { readOwnedMutableRetention, retainOwnedMutableProvenance } from '@/server/db/testing/task19MutableRetention';
import { verifyLocalMutableRetention } from '@/server/migration/localMutableRetention';
import type { LegacyNormalizationManifest } from '@/server/migration/manifest';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_SOURCE_FORBIDDEN'); } }));
const path = process.env.TASK19_MIXED_V2_REQUEST;
if (path && !/^\.task19-mixed-v2-results\/[0-9a-f-]{36}-request\.json$/.test(path)) throw new Error('Invalid archive disposal request');
type Recovery = Extract<MixedArchiveRequest, { pin: MixedRetentionPin }>;
type Generation = {
  manifest: LegacyNormalizationManifest;
  acquisition: FinalGenerationPreparationInput['original']; originalSourceId: string;
  originalSnapshotId: string; exclusionGenerationReference: string;
};

async function produce(tombstone:boolean) {
  const databases: DisposablePostgres[] = [];
  try {
    const ownerId=randomUUID(), source=await allocateMixed(databases,ownerId,'SOURCE'), destination=await allocateMixed(databases,ownerId,'DESTINATION');
    const {binding}=await produceMixed(source.cold,tombstone);
    const parent='.task19-mixed-v2-artifacts';
    mkdirSync(parent,{recursive:true,mode:0o700});
    const state=async () => [await witness(source.db),await witness(destination.db)];
    const before=await state(), files=readdirSync(parent);
    await expect(retainOwnedMutableProvenance(source.db,ownerId,binding,parent)).rejects.toThrow('Local mutable retention archive refused.');
    await expect(retainOwnedMixedProvenanceV2(source.db,randomUUID(),binding,parent)).rejects.toThrow('Local mixed V2 retention archive refused.');
    expect(readdirSync(parent)).toEqual(files); expect(await state()).toEqual(before);
    const pin=await retainOwnedMixedProvenanceV2(source.db,ownerId,binding,parent);
    expect(await state()).toEqual(before);
    await expect(readOwnedMutableRetention(pin,binding)).rejects.toThrow('Local mutable retention archive refused.');
    const bytes=readFileSync(join(pin.directory,'artifact.json'),'utf8');
    expect(() => verifyLocalMutableRetention(canonicalJson(JSON.parse(bytes).evidence),binding)).toThrow('Local mutable retention evidence refused.');
    const cleanup=[];
    for (const db of databases) cleanup.push(await db.close());
    expect(cleanup.every(row => row.containerRemoved && row.scratchRemoved)).toBe(true);
    // Only trusted pins/binding, disposal and topology receipts leave this process.
    return {pin,binding,originalPins:[source.pin,destination.pin],topology:[source.db.evidence,destination.db.evidence],cleanup};
  } finally {
    const results=await Promise.allSettled(databases.map(db => db.close()));
    const failures=results.filter(row => row.status==='rejected');
    if (failures.length) throw new AggregateError(failures,'Mixed producer cleanup failed');
  }
}

function sameEvidence(actual: MixedRetentionEvidence, expected: MixedRetentionEvidence) {
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
  const evidence = await readOwnedMixedRetentionV2(request.pin,request.binding);
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
  const reconstructed = await source.lease.runTransaction(TENANT,tx => captureLocalMixedRetentionV2(binding,tx));
  sameEvidence(reconstructed,evidence);
  const receipt = await materializeLocalCandidate(binding,createOwnedLocalMaterializationRunner(TENANT,JOB,source.lease,destination.lease));
  return {evidence,receipt};
}

type Mutation = [string, (e: MixedRetentionEvidence) => void];
async function exercise(request: Recovery, source: ColdDatabase, destination: ColdDatabase) {
  const artifact = join(request.pin.directory,'artifact.json'), bytes = readFileSync(artifact,'utf8');
  const observations: Record<string,unknown>[] = [];
  const state = async () => [await witness(source),await witness(destination)];
  const refuse = async (name: string, trial: Recovery) => {
    const before = await state();
    const outcome = await recover(trial,source,destination).then(() => 'ACCEPTED',error => (error as Error).message);
    const after = await state();
    observations.push({name,outcome,before,after});
    expect(outcome,name).toBe('Local mixed V2 retention archive refused.');
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
  const mutations: Mutation[] = REPORTS.flatMap(category => [
    [`missing-report:${category}`,(e: MixedRetentionEvidence) => { Object.assign(e,{reconciliation:e.reconciliation.filter(row => row.category !== category)}); }],
    [`corrupt-report:${category}`,(e: MixedRetentionEvidence) => { Object.assign(e.reconciliation.find(row => row.category === category)!,
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
    ['coverage',e => { Object.assign(e.coverage,{categories:e.coverage.categories.slice(1)}); }],
    ['recapture-injection',e => { e.recaptures.push({target_table:'padlet_evidence_claims',target_id:'wrong',entry_value:{}}); }],
    ['missing-recapture',e => {e.recaptures.splice(0,1);}],
    ['recapture-before',e => {Object.assign(e.recaptures[0].entry_value as object,{beforeDigest:'0'.repeat(64)});}],
    ['recapture-after',e => {Object.assign(e.recaptures[0].entry_value as object,{afterDigest:'0'.repeat(64)});}],
    ['settings-before',e => {const entry=e.deltas.find(row => row.target_table==='settings')!.entry_value as {before:{target:{value:string}}}; entry.before.target.value='wrong';}],
    ['settings-after',e => {const entry=e.deltas.find(row => row.target_table==='settings')!.entry_value as {after:{target:{value:string}}}; entry.after.target.value='wrong';}],
    ['removed-before',e => {const entry=e.deltas.find(row => row.change_kind==='REMOVED')!.entry_value as {before:{target:{name:string}}}; entry.before.target.name='wrong';}],
    ['removed-after',e => {Object.assign(e.deltas.find(row => row.change_kind==='REMOVED')!.entry_value as object,{after:{},afterDigest:'0'.repeat(64)});}],
    ['v1-payload',e => {Object.assign(e,{format:'TASK19_MUTABLE_RETENTION_V1'});}],
    ['v1-generation',e => {Object.assign(e.binding,{generationId:e.binding.generationId.replace('full-recapture-stage','full-mutable-stage')});}],
  );
  for (const key of ['header','envelopes','sources','targets','mappings','contributors','deltas','recaptures','reconciliation','coverage']) {
    mutations.push([`mandatory-field:${key}`,e => {delete (e as unknown as Record<string,unknown>)[key];}]);
  }
  if (request.tombstone) mutations.push(
    ['missing-tombstone',e => {Object.assign(e,{targets:e.targets.filter(row => row.target_table!=='padlet_claim_digest_tombstones')});}],
    ['corrupt-tombstone',e => {Object.assign(e.targets.find(row => row.target_table==='padlet_claim_digest_tombstones')!.canonical_value as object,{ownerDigest:'0'.repeat(64)});}],
  );
  renameSync(artifact,`${artifact}.saved`);
  try {await refuse('missing-artifact',request);} finally {renameSync(`${artifact}.saved`,artifact);}
  for (const [name,mutate] of [
    ['v1-wrapper',(payload:Record<string,unknown>) => {payload.format='TASK19_OWNED_MUTABLE_ARCHIVE_V1';}],
    ['wrong-origin',(payload:Record<string,unknown>) => {payload.sourceDatabaseId=request.source.databaseId;}],
  ] as const) {
    const payload=JSON.parse(bytes); mutate(payload); const changed=canonicalJson(payload);
    writeFileSync(artifact,changed);
    try {await refuse(name,{...request,pin:{...request.pin,sha256:sha256(changed)}});} finally {writeFileSync(artifact,bytes);}
  }
  for (const [name,mutate] of mutations) {
    const payload = JSON.parse(bytes); mutate(payload.evidence);
    const corrupt = canonicalJson(payload);
    expect(corrupt,name).not.toBe(bytes);
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
  expect(evidence.reconciliation.map(row => row.category).sort()).toEqual([...REPORTS].sort());
  expect(evidence.recaptures).toHaveLength(1);
  expect(evidence.reconciliation.find(row => row.category === 'padlet_claim_digest_tombstones'))
    .toMatchObject({expected_count:request.tombstone ? 1 : 0,observed_count:request.tombstone ? 1 : 0,status:'MATCH'});
  const deltas=(await source.owner.query('SELECT target_table,target_id,change_kind,entry_value FROM migration_full_delta_entries ORDER BY target_table,target_id')).rows;
  expect(deltas.map(row => canonicalJson(row)).sort()).toEqual(evidence.deltas.map(row => canonicalJson(row)).sort());
  expect(deltas.map(row => [row.target_table,row.change_kind])).toEqual([['products','MUTATED'],['products','REMOVED'],['settings','MUTATED']]);
  expect((await source.owner.query('SELECT target_table,target_id,entry_value FROM migration_full_claim_recaptures')).rows).toEqual(evidence.recaptures);
  for (const table of ['migration_full_delta_entries','migration_full_reconciliation','migration_full_claim_recaptures']) {
    await expect(source.owner.query(`UPDATE ${table} SET generation_id=generation_id`)).rejects.toMatchObject({code:'55000'});
  }
  const manifest=(evidence.envelopes.find(row => row.event_id===evidence.header.candidate_generation_id)!.redacted_details as Generation).manifest;
  expect((await destination.owner.query('SELECT settings FROM tenant_settings')).rows)
    .toEqual([{settings:Object.fromEntries(manifest.records.settings.map(row => [row.key,row.value]))}]);
  expect((await destination.owner.query('SELECT tenant_id,product_id,name,price,stock,is_active,image_url,category,sort_order FROM products ORDER BY product_id')).rows)
    .toEqual(manifest.records.products.map(row => ({tenant_id:row.tenantId,product_id:row.productId,name:row.name,price:String(row.price),
      stock:String(row.stock),is_active:row.isActive,image_url:row.imageUrl,category:row.category,sort_order:row.sortOrder})));
  expect((await source.owner.query('SELECT product_id,name FROM products ORDER BY product_id')).rows)
    .toEqual([{product_id:'P1',name:'Pencil'},{product_id:'PX',name:'Removed cold product'}]);
  const claims=(await destination.owner.query(`SELECT provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,
    to_char(evidence_created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS evidence_created_at,evidence_author_full_name FROM padlet_evidence_claims ORDER BY tuple_digest`)).rows;
  expect(claims).toEqual(manifest.records.padlet_evidence_claims.map(row => ({provider:'PADLET',board_id:row.boardId,post_id:row.postId,
    tuple_digest:row.tupleDigest,claimed_by_tenant_id:TENANT,claimed_by_operation_id:row.operationId,
    evidence_created_at:row.evidenceCreatedAt,evidence_author_full_name:row.evidenceAuthorFullName})));
  expect((await destination.owner.query('SELECT tuple_digest,owner_digest,source_provenance FROM padlet_claim_digest_tombstones ORDER BY tuple_digest')).rows)
    .toEqual((manifest.records.padlet_claim_digest_tombstones ?? []).map(row => ({tuple_digest:row.tupleDigest,owner_digest:row.ownerDigest ?? null,source_provenance:row.provenance})));
  expect((await destination.owner.query('SELECT source_database_id,destination_database_id,owner_id FROM migration_local_materializations')).rows)
    .toEqual([{source_database_id:request.source.databaseId,destination_database_id:request.destination.databaseId,owner_id:request.ownerId}]);
  expect((await destination.owner.query('SELECT status,final_fingerprint,freeze_started_at,freeze_verified_at,completed_at FROM migration_jobs')).rows)
    .toEqual([{status:'IMPORTING',final_fingerprint:null,freeze_started_at:null,freeze_verified_at:null,completed_at:null}]);
  expect(receipt).toMatchObject({binding:request.binding,authority:'NONAUTHORITY',activationAllowed:false,complete:false,exclusion:'NOT_PROVEN'});
  expect(readFileSync(artifact,'utf8')).toBe(bytes);
  return {receipt,observations,sourceWitness:await witness(source),destinationWitness:await witness(destination),
    immutableEvidence:evidence,archiveSha256:sha256(bytes),stalePhysicalLeaseRefused:true};
}

it.skipIf(!path)('Task19 mixed V2 archive process phase', async () => {
  if (process.env.RUN_REAL_POSTGRES !== '1') throw new Error('Owned PG required');
  const request = JSON.parse(readFileSync(path!,'utf8')) as MixedArchiveRequest;
  const result: Record<string,unknown> = {pid:process.pid,phase:request.phase,success:false};
  try {
    if (request.phase === 'produce') {
      expect(Object.keys(request).sort()).toEqual(['phase','tombstone']);
      Object.assign(result,await produce(request.tombstone));
    } else {
      expect(Object.keys(request).sort()).toEqual(['phase','pin','binding','source','destination','ownerId','tombstone'].sort());
      expect(request.source.databaseId).not.toBe(request.pin.sourceDatabaseId);
      expect(request.ownerId).not.toBe(request.pin.sourceOwnerId);
      const connections = coldConnections({...request,phase:request.phase === 'rebuild' ? 'import' : 'retry'});
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
