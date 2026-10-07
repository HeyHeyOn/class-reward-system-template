// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDisposablePostgres, type DisposablePostgres } from '@/server/db/testing/disposablePostgres';
import { createDatabasePadletClaimRepository } from '@/server/repositories/database/padletClaims';
import { captureRedisClaimSnapshot } from './redisClaimSnapshot';
import { createLegacyRedisSnapshotStager, publishLegacyClaimsInternal } from './legacyClaimPublication';
import { sha256 } from './validators';
vi.mock('server-only',()=>({}));
const suite=process.env.RUN_REAL_POSTGRES==='1'?describe:describe.skip;
let db:DisposablePostgres;
const evidence=(post:string)=>({evidenceProvider:'PADLET' as const,evidenceBoardId:'BOARD000000000001',evidencePostId:post,
  evidenceCreatedAt:'2026-09-01T00:00:00.000Z',evidenceAuthorFullName:'Test student'});
async function seed(orphan=false){
  const tenantId=randomUUID(),migrationJobId=randomUUID(),sourceId=randomUUID(),operationId=randomUUID();
  const e=evidence(randomUUID()),tuple=sha256(`${e.evidenceBoardId}\0${e.evidencePostId}`),v1=sha256(randomUUID());
  const binding={taskId:'T1',studentId:'S1',cycleStartsAt:'2026-09-01T00:00:00.000Z',evidence:e};
  const entries:Array<readonly[string,string]>=[[`claim:${tuple}`,operationId],[`op:${sha256(operationId)}`,JSON.stringify({binding,claimField:`claim:${tuple}`})]];
  if(orphan)entries.push([`claim:${sha256(randomUUID())}`,'unresolved-owner']);
  const snapshot=await captureRedisClaimSnapshot({getRevision:async()=> 'frozen-fixture-1',
    hscan:async()=>({cursor:'0',entries}),scan:async()=>({cursor:'0',keys:[`padlet:evidence-claim:v1:${v1}`]}),get:async()=> 'historical-owner'},
    {capturedAt:new Date().toISOString()});
  await db.owner.query("INSERT INTO tenants(id,slug,display_name,lifecycle) VALUES($1,$2,'Isolated claims','IMPORTING')",[tenantId,'claims-'+tenantId]);
  await db.owner.query(`INSERT INTO migration_jobs(tenant_id,job_id,status,freeze_started_at,freeze_verified_at)
    VALUES($1,$2,'FINAL_IMPORT',now(),now())`,[tenantId,migrationJobId]);
  await db.owner.query(`INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint)
    VALUES($1,$2,$3,'LEGACY_REDIS_BRIDGE',$4,$5)`,[tenantId,migrationJobId,sourceId,sha256(tenantId),snapshot.digest]);
  return{tenantId,migrationJobId,sourceId,snapshot,expectedStateVersion:'1',expectedSourceDigest:snapshot.digest,evidence:e,tuple,v1};
}
const stage=(input:Awaited<ReturnType<typeof seed>>)=>createLegacyRedisSnapshotStager(db.runTenantTransaction)(input);
const publish=(input:Awaited<ReturnType<typeof seed>>)=>db.runTenantTransaction(input.tenantId,tx=>publishLegacyClaimsInternal(tx,input));
suite('historical Redis archive and same-transaction claim publication',()=>{
  beforeAll(async()=>{expect(process.env.DATABASE_URL).toBeUndefined();db=await createDisposablePostgres();await db.owner.query('GRANT SELECT,INSERT ON legacy_redis_snapshot_archives,legacy_claim_publications TO app_runtime');},60_000);
  afterAll(async()=>{if(db)expect(await db.close()).toMatchObject({containerRemoved:true,scratchRemoved:true});},60_000);
  it('stages v1/v2 provenance without publishing, then retains global one-use claims without modern operation receipts',async()=>{
    const input=await seed();expect(await stage(input)).toMatchObject({v2Claims:1,v1Tombstones:1,claimsPublished:false});
    expect((await db.owner.query('SELECT count(*)::int n FROM padlet_claim_digest_registry WHERE tuple_digest=ANY($1)',[[input.tuple,input.v1]])).rows[0].n).toBe(0);
    const first=await publish(input);expect(first).toMatchObject({tombstones:2,modernOperationsCreated:0});expect(await publish(input)).toEqual(first);
    expect((await db.owner.query('SELECT count(*)::int n FROM operations WHERE tenant_id=$1',[input.tenantId])).rows[0].n).toBe(0);
    expect((await db.owner.query('SELECT snapshot FROM legacy_redis_snapshot_archives WHERE tenant_id=$1',[input.tenantId])).rows[0].snapshot).toEqual(input.snapshot);
  });
  it('blocks a modern claim in another tenant for a historically used Padlet post',async()=>{
    const source=await seed();await stage(source);await publish(source);const other=await seed(),operationId=randomUUID();
    expect(await db.runTenantTransaction(other.tenantId,tx=>createDatabasePadletClaimRepository().findClaimedPostIds(tx,
      source.evidence.evidenceBoardId,[source.evidence.evidencePostId,'unused-post']))).toEqual([source.evidence.evidencePostId]);
    const result=await db.runTenantTransaction(other.tenantId,async tx=>{
      await tx.execute(sql`INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash,status)
        VALUES (${other.tenantId},${operationId},'TASK_REWARD',${'a'.repeat(64)},'PENDING')`);
      return createDatabasePadletClaimRepository().claim(tx,{tenantId:other.tenantId,operationId,evidence:source.evidence,claimedAt:new Date()});
    });
    expect(result).toBe('CONFLICT');
    expect((await db.owner.query('SELECT count(*)::int n FROM padlet_evidence_claims WHERE tuple_digest=$1',[source.tuple])).rows[0].n).toBe(0);
  });
  it('rolls global claim publication and the tenant activation back together on a later error',async()=>{
    const input=await seed();await stage(input);
    await expect(db.runTenantTransaction(input.tenantId,async tx=>{
      await publishLegacyClaimsInternal(tx,input);await tx.execute(sql`UPDATE tenants SET lifecycle='ACTIVE' WHERE id=${input.tenantId}`);
      throw new Error('simulated final activation failure');
    })).rejects.toThrow('simulated final activation failure');
    expect((await db.owner.query('SELECT count(*)::int n FROM padlet_claim_digest_registry WHERE tuple_digest=ANY($1)',[[input.tuple,input.v1]])).rows[0].n).toBe(0);
    expect((await db.owner.query('SELECT count(*)::int n FROM legacy_claim_publications WHERE tenant_id=$1',[input.tenantId])).rows[0].n).toBe(0);
    expect((await db.owner.query('SELECT lifecycle FROM tenants WHERE id=$1',[input.tenantId])).rows[0].lifecycle).toBe('IMPORTING');
  });
  it('refuses orphaned claims, stale versions and source drift without publishing',async()=>{
    const orphan=await seed(true);await stage(orphan);await expect(publish(orphan)).rejects.toThrow(/Orphaned/);
    const stale=await seed();await stage(stale);await expect(publish({...stale,expectedStateVersion:'2'})).rejects.toThrow(/version/);
    await db.owner.query('UPDATE migration_sources SET source_fingerprint=$1 WHERE tenant_id=$2',[sha256('changed'),stale.tenantId]);
    await expect(publish(stale)).rejects.toThrow(/missing/);
    expect((await db.owner.query('SELECT count(*)::int n FROM padlet_claim_digest_registry WHERE tuple_digest=ANY($1)',[[orphan.tuple,orphan.v1,stale.tuple,stale.v1]])).rows[0].n).toBe(0);
  });
});
