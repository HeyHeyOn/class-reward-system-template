import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantImportTransactionRunner } from './importer';
import { createFreezingApprovalIntake, readVerifiedFreezingApproval } from './freezingApprovalIntake';
vi.mock('server-only', () => ({}));
let h: PgliteDatabaseHarness;
const USER = '20000000-0000-4000-8000-000000000019';
const JOB = '40000000-0000-4000-8000-000000000019';
const HASH = 'a'.repeat(64);
const TOKEN = 'b'.repeat(64);
beforeEach(async () => {
  h = await createPgliteDatabaseHarness();
  const dir = resolve('src/server/db/migrations');
  for (const n of (await readdir(dir)).filter(n => /^\d{4}_.*\.sql$/.test(n) && n.slice(0,4) > '0008').sort()) await h.database.exec(await readFile(resolve(dir,n),'utf8'));
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')",[USER]);
  for (const t of [h.tenantOneId,h.tenantTwoId]) {
    await h.database.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1",[t]);
    await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[t,USER]);
    await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status,source_fingerprint) VALUES($1,$2,'READY',$3)",[t,JOB,HASH]);
    await h.database.query("INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint) VALUES($1,$2,'sheet','GOOGLE_SHEETS',$3,$4)",[t,JOB,`sheet-${t}`,HASH]);
    await h.database.query("INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES($1,$2,'sheet','preflight','PREFLIGHT',$3,'{}',0)",[t,JOB,HASH]);
  }
  await h.database.exec('GRANT SELECT, INSERT ON migration_freezing_challenges, migration_freezing_consumptions, migration_authority_receipts, migration_authority_replays TO app_runtime');
  vi.stubGlobal('fetch',vi.fn(() => { throw Error('network forbidden'); }));
}, 60_000);
afterEach(async () => { vi.unstubAllGlobals(); await h?.close(); });
function service(subject: string | null = 'owner', runTransaction: TenantImportTransactionRunner = h.runTenantTransaction, tenantId = h.tenantOneId) {
  return createFreezingApprovalIntake({ tenantId, origin:'https://store.example', getAuthenticatedSession:async () => subject === null ? null : ({subject,csrfToken:TOKEN}), runTransaction });
}
const intent = () => ({migrationJobId:JOB,expectedStateVersion:'1',sourceId:'sheet'});
function request(display: unknown, extra = {}, headers: Record<string,string> = {}) {
  return new Request('https://store.example/internal',{method:'POST',headers:{origin:'https://store.example','content-type':'application/json','x-csrf-token':TOKEN,...headers},body:JSON.stringify({display,confirmation:'START_FREEZING_APPROVAL',...extra})});
}
async function counts() { return Promise.all(['migration_freezing_consumptions','migration_authority_receipts','migration_authority_replays'].map(async t => (await h.database.query(`SELECT * FROM ${t}`)).rows.length)); }
it('issues immutable exact display and only mints start approval after commit, without operational writes',async () => {
  await h.database.query("INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'unrelated','MIGRATION_IMPORT',$2)",[h.tenantTwoId,HASH]);
  await h.database.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'unrelated-source')",['c'.repeat(64),HASH]);
  const tables=['tenants','migration_jobs','migration_sources','migration_snapshots','operations','transactions','adjustments','padlet_claim_digest_tombstones','padlet_evidence_claims','padlet_claim_digest_registry'];
  const state=() => Promise.all(tables.map(async t => (await h.database.query(`SELECT * FROM ${t}`)).rows));
  const before = await state();
  const b = await service().issueChallenge(intent());
  expect(b).toMatchObject({action:'START_FREEZING_APPROVAL',tenantId:h.tenantOneId,actorUserId:USER,preflightDigest:HASH});
  const c = await service().accept(request(b));
  expect(readVerifiedFreezingApproval(c)).toEqual(b);
  expect(() => readVerifiedFreezingApproval({} as typeof c)).toThrow();
  expect(await counts()).toEqual([1,1,1]);
  expect(await state()).toEqual(before);
  expect(fetch).not.toHaveBeenCalled();
  await expect(service().accept(request(b))).rejects.toThrow();
});
it('rejects unauthenticated, nonmember, cross-tenant and caller authority',async () => {
  const b = await service().issueChallenge(intent());
  for (const subject of [null,'nonmember']) {
    await expect(service(subject).issueChallenge(intent())).rejects.toThrow();
    await expect(service(subject).accept(request(b))).rejects.toThrow();
  }
  await expect(service('owner',h.runTenantTransaction,h.tenantTwoId).accept(request(b))).rejects.toThrow();
  for (const extra of [{actor:'owner'},{issuer:HASH},{replayDigest:HASH},{authorized:true},{receiptId:b.challengeId}]) await expect(service().accept(request(b,extra))).rejects.toThrow();
  expect(await counts()).toEqual([0,0,0]);
});
it('rejects every altered display field, missing confirmation, cross origin and CSRF',async () => {
  const b = await service().issueChallenge(intent());
  for (const key of Object.keys(b)) await expect(service().accept(request({...b,[key]:'forged'}))).rejects.toThrow();
  for (const confirmation of [null,false,true,'ACTIVATE_APPROVAL','']) await expect(service().accept(request(b,{confirmation}))).rejects.toThrow();
  for (const headers of ([{origin:'https://evil.example'},{'x-csrf-token':''},{'sec-fetch-site':'cross-site'}] as Record<string,string>[] )) await expect(service().accept(request(b,{},headers))).rejects.toThrow();
  await expect(service().accept({confirmed:true} as unknown as Request)).rejects.toThrow();
  expect(await counts()).toEqual([0,0,0]);
});
it.each(['membership','status','version','source','preflight'])('rejects current %s drift',async kind => {
  const b = await service().issueChallenge(intent());
  if(kind==='membership') await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[h.tenantOneId]);
  if(kind==='status') await h.database.query("UPDATE migration_jobs SET status='ABORTED',state_version=2,completed_at=now(),updated_at=now() WHERE tenant_id=$1",[h.tenantOneId]);
  if(kind==='version') for(const status of ['FREEZING','FINAL_IMPORT','RECONCILING','READY']) await h.database.query('UPDATE migration_jobs SET status=$1,state_version=state_version+1 WHERE tenant_id=$2',[status,h.tenantOneId]);
  if(kind==='source') await h.database.query("UPDATE migration_sources SET external_source_id='replacement' WHERE tenant_id=$1",[h.tenantOneId]);
  if(kind==='preflight') await h.database.query("INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES($1,$2,'sheet','other','PREFLIGHT',$3,'{}',0)",[h.tenantOneId,JOB,'c'.repeat(64)]);
  await expect(service().accept(request(b))).rejects.toThrow();
  expect(await counts()).toEqual([0,0,0]);
});
function intercept(fn: (sql:string) => unknown): TenantImportTransactionRunner {
  return (tenant,cb) => h.runTenantTransaction(tenant,tx => cb(new Proxy(tx,{get(target,key,receiver) {
    if(key!=='execute') return Reflect.get(target,key,receiver);
    return async (q: Parameters<typeof tx.execute>[0]) => {
      const text = typeof q==='string'? q : new PgDialect().sqlToQuery(q.getSQL()).sql;
      const result = fn(text); return result === undefined ? tx.execute(q) : result;
    };
  }})));
}
it.each(['repeatable read','serializable'])('rejects actual %s isolation on issuance before any binding reads or writes',async isolation => {
  // The supplied runner declares its default READ COMMITTED, but BEGIN inherits
  // this database setting. Inspect the real transaction, not runner metadata.
  await h.database.query("SELECT set_config('default_transaction_isolation',$1,false)",[isolation]);
  const statements: string[] = [];
  await expect(service('owner',intercept(text => { statements.push(text); })).issueChallenge(intent())).rejects.toThrow('Freezing approval intake refused.');
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('transaction_isolation');
  expect((await h.database.query('SELECT * FROM migration_freezing_challenges')).rows).toEqual([]);
  expect(await counts()).toEqual([0,0,0]);
});
it.each(['repeatable read','serializable'])('rejects actual %s isolation on acceptance before loading the binding without consuming approval',async isolation => {
  const b = await service().issueChallenge(intent());
  await h.database.query("SELECT set_config('default_transaction_isolation',$1,false)",[isolation]);
  const statements: string[] = [];
  await expect(service('owner',intercept(text => { statements.push(text); })).accept(request(b))).rejects.toThrow('Freezing approval intake refused.');
  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('transaction_isolation');
  expect((await h.database.query('SELECT binding FROM migration_freezing_challenges')).rows).toEqual([{binding:b}]);
  expect(await counts()).toEqual([0,0,0]);
  await h.database.query("SET default_transaction_isolation = 'read committed'");
  expect(readVerifiedFreezingApproval(await service().accept(request(b)))).toEqual(b);
});
it('checks actual READ COMMITTED isolation first in both transactions',async () => {
  const statements: string[] = [];
  const api = service('owner',intercept(text => { statements.push(text); }));
  const b = await api.issueChallenge(intent());
  expect(statements[0]).toContain('transaction_isolation');
  statements.length=0;
  await api.accept(request(b));
  expect(statements[0]).toContain('transaction_isolation');
});
it('locks the source against snapshot FK inserts before checking PREFLIGHT cardinality on issue and accept',async () => {
  const statements: string[] = [];
  const guarded = service('owner',intercept(text => { statements.push(text); }));
  const b = await guarded.issueChallenge(intent());
  await guarded.accept(request(b));
  const snapshotReads = statements.flatMap((text,index) => text.includes('FROM migration_snapshots') ? [index] : []);
  expect(snapshotReads).toHaveLength(2);
  for (const index of snapshotReads) {
    const sourceLock = statements.slice(0,index).findLast(text => text.includes('FROM migration_sources'));
    expect(sourceLock).toMatch(/FOR UPDATE\s*$/);
  }
});
it.each(['future','expired','postlock','postconsumption','postreceipt'])('refuses %s DB-clock challenge and rolls back',async mode => {
  const b = await service().issueChallenge(intent()); let clocks=0;
  const runner=intercept(s => s.includes('clock_timestamp()') ? {rows:[{ms:String(mode==='future'?b.issuedAt-1: mode==='expired'|| ++clocks>=(({postlock:2,postconsumption:3,postreceipt:4} as Record<string,number>)[mode] ?? 99) ?b.expiresAt:b.issuedAt)}]}:undefined);
  await expect(service('owner',runner).accept(request(b))).rejects.toThrow();
  expect(await counts()).toEqual([0,0,0]);
});
it.each(['consumption','receipt','readback','intermediate'])('rolls back %s failure',async mode => {
  const b = await service().issueChallenge(intent());
  const runner=intercept(s => {
    if(mode==='consumption'&&s.includes('INSERT INTO migration_freezing_consumptions')) return {rows:[]};
    if(mode==='receipt'&&s.includes('INSERT INTO migration_authority_receipts')) return {rows:[]};
    if(mode==='readback'&&s.includes('SELECT r.*, p.replay_digest')) return {rows:[]};
    if(mode==='intermediate'&&s.includes('INSERT INTO migration_authority_replays')) throw Error('injected');
  });
  await expect(service('owner',runner).accept(request(b))).rejects.toThrow();
  expect(await counts()).toEqual([0,0,0]);
});
it('lost commit acknowledgment returns no capability and cannot recover authority',async () => {
  const b = await service().issueChallenge(intent());
  const lost: TenantImportTransactionRunner=async (t,cb) => {await h.runTenantTransaction(t,cb);throw Error('lost commit');};
  await expect(service('owner',lost).accept(request(b))).rejects.toThrow();
  expect(await counts()).toEqual([1,1,1]);
  expect('recover' in service()).toBe(false);
  const {createNonAuthorityReceiptStorage}=await import('./authorityReceiptStorage');
  const {rows}=await h.database.query(`SELECT r.*,p.replay_digest,r.expected_state_version::text AS expected_state_version,
    r.issued_at_ms::text AS issued_at_ms,r.expires_at_ms::text AS expires_at_ms FROM migration_authority_receipts r
    JOIN migration_authority_replays p USING(tenant_id,receipt_id)`);
  const archived=await createNonAuthorityReceiptStorage({tenantId:h.tenantOneId,runTransaction:h.runTenantTransaction}).recover(rows[0] as Record<string,unknown>);
  expect(archived.storage).toBe('NON_AUTHORITY');
  expect(() => readVerifiedFreezingApproval(archived as unknown as Parameters<typeof readVerifiedFreezingApproval>[0])).toThrow();
  await expect(service().accept(request(b))).rejects.toThrow();
});

it('exports schema and enforces immutable forced RLS with JSON null rejection',async () => {
  const schema = await import('@/server/db/schema');
  expect('migrationFreezingChallenges' in schema).toBe(true);
  expect('migrationFreezingConsumptions' in schema).toBe(true);
  const b = await service().issueChallenge(intent());
  const {sql}=await import('drizzle-orm');
  const {rows:flags}=await h.database.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('migration_freezing_challenges','migration_freezing_consumptions')");
  expect(flags).toEqual([{relrowsecurity:true,relforcerowsecurity:true},{relrowsecurity:true,relforcerowsecurity:true}]);
  await h.runTenantTransaction(h.tenantTwoId,async tx => expect((await tx.execute(sql`SELECT * FROM migration_freezing_challenges`)).rows).toEqual([]));
  for(const statement of ['UPDATE migration_freezing_challenges SET binding=binding','DELETE FROM migration_freezing_challenges','TRUNCATE migration_freezing_challenges']) {
    await expect(h.runTenantTransaction(h.tenantOneId,tx => tx.execute(sql.raw(statement)))).rejects.toThrow();
  }
  for(const binding of [null,{}, {...b,challengeId:'50000000-0000-4000-8000-000000000019',action:null}, {...b,challengeId:'50000000-0000-4000-8000-000000000019',tenantId:null}]) {
    await expect(h.database.query('INSERT INTO migration_freezing_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,binding) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[h.tenantOneId,'50000000-0000-4000-8000-000000000019',JOB,'sheet',USER,JSON.stringify(binding)])).rejects.toThrow();
  }
});
it('rejects suppressed challenge insert, corrupted readback and accessor intent without evaluating it',async () => {
  for(const part of ['INSERT INTO migration_freezing_challenges','SELECT binding FROM migration_freezing_challenges']) {
    const runner=intercept(s => s.includes(part)?{rows:[]}:undefined);
    await expect(service('owner',runner).issueChallenge(intent())).rejects.toThrow();
    expect((await h.database.query('SELECT * FROM migration_freezing_challenges')).rows).toEqual([]);
  }
  const getter=vi.fn(() => JOB); const bad={...intent()};
  Object.defineProperty(bad,'migrationJobId',{get:getter,enumerable:true});
  await expect(service().issueChallenge(bad)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it('accepts current ADMIN but refuses a different otherwise-authorized actor and stale session CSRF',async () => {
  const other='20000000-0000-4000-8000-000000000099';
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'admin','admin@example.invalid')",[other]);
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'ADMIN')",[h.tenantOneId,other]);
  const b=await service().issueChallenge(intent());
  await expect(service('admin').accept(request(b))).rejects.toThrow();
  await expect(service().accept(request(b,{}, {'x-csrf-token':'c'.repeat(64)}))).rejects.toThrow();
  const admin=await service('admin').issueChallenge(intent());
  expect(readVerifiedFreezingApproval(await service('admin').accept(request(admin))).actorUserId).toBe(other);
  expect(await counts()).toEqual([1,1,1]);
});
