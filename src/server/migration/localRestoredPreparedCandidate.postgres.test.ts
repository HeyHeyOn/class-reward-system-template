// @vitest-environment node
import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupPreparedDatabase, retainMaterializedBackup } from '@/server/db/testing/materializedRestore';
import { materializeLocalCandidate, prepareLocalCandidateTransition } from './localCandidateMaterialization';
import { canonicalJson, sha256 } from './validators';
import { cleanupDeleteFixture, deleteFixture, deletionEvidence, TENANT } from '../../../test-support/task19DeleteFixture';
import { candidateChild } from '../../../test-support/task19RestoredCandidateChild.test';
vi.mock('server-only', () => ({}));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => { throw new Error('DEFAULT_DATABASE_FORBIDDEN'); } }));
afterEach(cleanupDeleteFixture);
const suite=process.env.RUN_REAL_POSTGRES==='1' ? describe : describe.skip;
async function fixture() {
  const f=await deleteFixture();
  await f.local.owner.query("UPDATE task19_delete_rows SET cells=$1::jsonb WHERE tenant=$2 AND tab='Products' AND cells->>0='P1'",
    [JSON.stringify(['P1','Final modified pencil','27','8','TRUE','','school','1']),TENANT]);
  await f.commitDelete();
  const {binding}=await f.stage(await f.capture());
  await materializeLocalCandidate(binding,f.run());
  const reports=(await f.source.owner.query('SELECT category,expected_count,observed_count,expected_digest,observed_digest,status FROM migration_full_reconciliation ORDER BY category')).rows;
  const materialization=(await f.destination.owner.query('SELECT to_jsonb(t) AS value FROM migration_local_materializations t')).rows[0].value;
  const intent={binding,ownerId:f.ownerId,sourceDatabaseId:f.source.runId,destinationDatabaseId:f.destination.runId,
    expectedDestinationStateVersion:'2',expectedReportDigest:sha256(canonicalJson(reports)),expectedMaterializationDigest:sha256(canonicalJson(materialization))};
  const prepared=await prepareLocalCandidateTransition(intent,f.run());
  const anchor=await retainMaterializedBackup(await backupPreparedDatabase(f.source,f.destination,intent),{retainUntil:Date.now()+60_000,expiresAt:Date.now()+3_600_000});
  mkdirSync('.task19-candidate-results',{recursive:true,mode:0o700});
  return {...f,binding,intent,prepared,anchor};
}
suite('Task19 post-restore candidate reconciliation',() => {
  it('consumes a genuinely prepared cold image in a separate process without acquiring authority',async () => {
    const f=await fixture(), before=await f.state();
    const r=await candidateChild({mode:'restore',anchor:f.anchor,binding:f.binding});
    deletionEvidence('restored-candidate-positive',{intent:f.intent,prepared:f.prepared,anchor:f.anchor,result:r});
    expect(r.legacy).toMatchObject({accepted:false,error:'Local candidate domain materialization refused.'});
    expect(r.consumed.outcome.accepted,r.consumed.outcome.error).toBe(true);
    const c=r.consumed.outcome.value;
    expect(c).toMatchObject({scope:'LOCAL_RESTORED_PREPARED_CANDIDATE',authority:'NONAUTHORITY',activationAllowed:false,
      complete:false,status:'RECONCILING',stateVersion:'3',sourceEvidence:'PINNED_CAPTURED_SOURCE',sourceFreshness:'NOT_PROVEN',continuousWriterFence:'NOT_PROVEN',
      binding:f.binding,stopIntentDigest:sha256(canonicalJson(f.intent)),auditEventId:f.prepared.auditEventId});
    expect(c.job).toEqual(JSON.parse(r.seal.tables.migration_jobs)[0]);
    expect(c.audit).toEqual(JSON.parse(r.seal.tables.audit_events)[0]);
    expect(c.products).toEqual(JSON.parse(r.seal.tables.products));
    expect(c.products).toMatchObject([{product_id:'P1',name:'Final modified pencil',price:27,stock:8}]);
    expect(c.products.some((p:{product_id:string}) => p.product_id==='PX')).toBe(false);
    expect(r.inventory.ownerId).not.toBe(f.ownerId); expect(r.inventory.runId).not.toBe(f.destination.runId);
    expect(r.consumed.pid).not.toBe(r.pid);
    expect(c.observations).toHaveLength(2);
    expect(c.observations[0].backendPid).not.toBe(c.observations[1].backendPid);
    for (const observation of c.observations) {
      expect(observation.readOnly).toBe('on'); expect(observation.backendPid).not.toBe(r.oldBackend);
      expect(observation.systemIdentifier).toBe(r.inventory.systemIdentifier);
    }
    expect(r.consumed.journal.status).toBe('VALIDATED');
    expect(r.consumed.journal.candidateDigest).toBe(sha256(canonicalJson(c)));
    expect(r.replay.outcome.accepted).toBe(false); expect(r.replay.journal).toEqual(r.consumed.journal);
    expect(r.original).toEqual(r.before); expect(r.after).toEqual(r.before);
    expect(r.readback.readOnly).toBe('on'); expect(r.readback.state).toEqual(r.after);
    expect(await f.state()).toEqual(before);
    await expect(materializeLocalCandidate(f.binding,f.run())).rejects.toThrow();
    await expect(prepareLocalCandidateTransition(f.intent,f.run())).rejects.toThrow();
  },300_000);

  it.each(['wrong-generation','wrong-source-version','wrong-source-generation','wrong-intent','wrong-tenant','wrong-job','wrong-owner',
    'wrong-database','wrong-attempt','wrong-system','authority','activation','extra','stale','changed-pin','changed-archive'])('refuses %s before candidate publication',async fault => {
    const f=await fixture(), before=await f.state();
    const r=await candidateChild({mode:'restore',anchor:f.anchor,binding:f.binding,fault});
    expect(r.consumed.outcome.accepted).toBe(false); expect(r.consumed.journal).toBeNull();
    expect(r.consumed.restoreJournal.status).toBe('SUCCEEDED');
    expect(r.before).toEqual(r.after); expect(await f.state()).toEqual(before);
    deletionEvidence('restored-candidate-admission-negative',{fault,anchor:f.anchor,result:r});
  },300_000);

  it.each(['partial-image','changed-product','resurrected-delete','changed-stop','changed-version','changed-lineage','changed-control',
    'privilege-promotion','changed-sequence','post-reopen-change'])('quarantines %s and refuses another cold consumer',async fault => {
    const f=await fixture(), before=await f.state();
    const r=await candidateChild({mode:'restore',anchor:f.anchor,binding:f.binding,fault});
    expect(r.consumed.outcome.accepted).toBe(false);
    expect(r.consumed.journal).toMatchObject({status:'QUARANTINED'});
    expect(r.consumed.journal).not.toHaveProperty('candidateDigest');
    expect(r.consumed.restoreJournal.status).toBe('SUCCEEDED');
    expect(r.replay.outcome.accepted).toBe(false); expect(r.replay.journal).toEqual(r.consumed.journal);
    if (fault!=='post-reopen-change') expect(r.before).toEqual(r.after);
    expect(await f.state()).toEqual(before);
    deletionEvidence('restored-candidate-image-negative',{fault,anchor:f.anchor,result:r});
  },300_000);
});
