// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { QueryResult, QueryResultRow } from 'pg';
import type { TenantTransaction } from '@/server/db/transaction';
import type { StartFreezingIntent } from './startFreezingCeremony';
import https from 'node:https';
import { canonicalJson } from './validators';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantImportTransactionRunner } from './importer';
import * as intake from './freezingConsentIntake';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { makeSheets, makeSupportedSheets } from './__fixtures__/normalization';
vi.mock('server-only', () => ({}));
const ORIGIN='https://store.example';
const env={AUTH_SECRET:'synthetic-auth-secret-with-at-least-32-characters',MIGRATION_GOOGLE_CLIENT_ID:'migration.apps.googleusercontent.com',MIGRATION_GOOGLE_CLIENT_SECRET:'local-client-secret',MIGRATION_GOOGLE_OAUTH_ORIGIN:ORIGIN};
const USER='20000000-0000-4000-8000-000000000019';
const JOB='40000000-0000-4000-8000-000000000019';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const tables=['migration_consent_challenges','migration_consent_confirmations','migration_consent_attempts','migration_consent_captures','migration_start_intents','migration_start_confirmations','migration_start_dispatches'];
let h:PgliteDatabaseHarness;let cookie:string;let calls:string[];let active=0;let nonce='';let cleanupFail=false;let providerHook:()=>Promise<void>;let extraTab='';let blockedCapture=false;let clients:InstanceType<typeof google.auth.OAuth2>[]=[];
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
beforeEach(async()=>{
  h=await createPgliteDatabaseHarness();
  const dir=resolve('src/server/db/migrations');
  for(const n of (await readdir(dir)).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)>'0008').sort())await h.database.exec(await readFile(resolve(dir,n),'utf8'));
  await h.database.query("INSERT INTO users(id,google_subject,canonical_email) VALUES($1,'owner','owner@example.invalid')",[USER]);
  await h.database.query("UPDATE tenants SET lifecycle='IMPORTING' WHERE id=$1",[h.tenantOneId]);
  await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[h.tenantOneId,USER]);
  await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status,source_fingerprint) VALUES($1,$2,'READY',$3)",[h.tenantOneId,JOB,digest('semantic')]);
  await h.database.query("INSERT INTO migration_sources(tenant_id,job_id,source_id,provider,external_source_id,source_fingerprint) VALUES($1,$2,'sheet','GOOGLE_SHEETS',$3,$4)",[h.tenantOneId,JOB,digest('sheet-1'),digest('acquisition')]);
  await h.database.query("INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES($1,$2,'sheet','preflight','PREFLIGHT',$3,'{}',0)",[h.tenantOneId,JOB,digest('preflight')]);
  // Provision only if present, so the first RED asserts missing production relations.
  for(const t of tables)if((await h.database.query<{name:string|null}>('SELECT to_regclass($1) AS name',[t])).rows[0]?.name)await h.database.exec(`GRANT SELECT,INSERT ON ${t} TO app_runtime`);
  vi.stubEnv('AUTH_SECRET',env.AUTH_SECRET);
  const r=NextResponse.json({});setGoogleSessionCookie(r,{subject:'owner',email:'Owner@Example.invalid',issuedAt:Date.now()-1000});
  cookie=`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
  calls=[];active=0;nonce='';cleanupFail=false;extraTab='';blockedCapture=false;clients=[];providerHook=async()=>{};
  vi.spyOn(https,'request').mockImplementation(()=>{throw Error('Nonlocal HTTPS forbidden');});
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('live network forbidden');}));
},60000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();await h?.close();});
function request(token?:string,headers:Record<string,string>={}){return new Request(`${ORIGIN}/internal`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...(token?{'x-csrf-token':token}:{}),...headers}});}
function provider(){
 const client=new google.auth.OAuth2(env.MIGRATION_GOOGLE_CLIENT_ID,env.MIGRATION_GOOGLE_CLIENT_SECRET,`${ORIGIN}/api/migrations/google-sheets/callback`);
 const source=JSON.parse(JSON.stringify(blockedCapture?makeSheets(3):makeSupportedSheets(3))) as ReturnType<typeof makeSupportedSheets>;const access='local-access-token';
 if(extraTab)(source.tabs as Record<string,unknown>)[extraTab]={headers:['key','value'],rows:[{cells:['adminPasswordHash','d'.repeat(64)]}]};
 client.transporter.request=(async(options:{url:string|URL;headers?:Headers})=>{
  expect(active).toBe(0);const url=String(options.url);calls.push(url);let data:unknown;
  if(url.endsWith('/token')){
   await providerHook();const now=Math.floor(Date.now()/1000);
   const claims={iss:'https://accounts.google.com',aud:env.MIGRATION_GOOGLE_CLIENT_ID,azp:env.MIGRATION_GOOGLE_CLIENT_ID,sub:'owner',email:'owner@example.invalid',email_verified:true,iat:now,exp:now+300,nonce,at_hash:createHash('sha256').update(access).digest().subarray(0,16).toString('base64url')};
   const unsigned=[Buffer.from(JSON.stringify({alg:'RS256',kid:'local-key'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
   data={access_token:access,id_token:`${unsigned}.${sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')}`,expires_in:300,token_type:'Bearer'};
  }else if(url.includes('/tokeninfo'))data={aud:env.MIGRATION_GOOGLE_CLIENT_ID,sub:'owner',email:'owner@example.invalid',email_verified:'true',expires_in:300,scope:'openid email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.file'};
  else if(url.includes('/certs'))data={'local-key':publicKey.export({type:'spki',format:'pem'})};
  else if(url.includes('/revoke')){if(cleanupFail)throw Error('secret cleanup error');data={};}
  else if(url.includes('/drive/v3/files/'))data={id:'sheet-1',mimeType:'application/vnd.google-apps.spreadsheet',trashed:false,version:'42'};
  else if(url.includes('/values/')){const name=decodeURIComponent(new URL(url).pathname.split('/values/')[1]).slice(1,-1).replace(/''/g,"'");const tab=source.tabs[name];data={values:[tab.headers,...tab.rows.map(r=>r.cells)]};}
  else if(url.includes('/v4/spreadsheets/sheet-1'))data={spreadsheetId:'sheet-1',sheets:Object.keys(source.tabs).map((title,sheetId)=>({properties:{title,sheetId,sheetType:'GRID',gridProperties:{rowCount:100,columnCount:100}}}))};
  else throw Error('unexpected local provider URL');
  return {data:Readable.from([JSON.stringify(data)]),headers:new Headers({'cache-control':'max-age=300'}),status:200,statusText:'OK',config:options};
 }) as typeof client.transporter.request;
 clients.push(client);return client;
}
function runner(intercept?:(text:string)=>unknown):TenantImportTransactionRunner{return(t,cb)=>h.runTenantTransaction(t,async tx=>{
 active++;try{return await cb(new Proxy(tx,{get(target,key,receiver){if(key!=='execute')return Reflect.get(target,key,receiver);return async(q:Parameters<typeof tx.execute>[0])=>{const text=typeof q==='string'?q:new PgDialect().sqlToQuery(q.getSQL()).sql;if(text.includes('INSERT INTO migration_consent_captures'))for(const client of clients)expect(client.credentials).toEqual({});const result=intercept?.(text);return result===undefined?tx.execute(q):result;};}}));}finally{active--;}
});}
const startRegistration=()=>({tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1',deploymentId:'local-companion',registrationVersion:'1',registrationDigest:digest('registered-local-config')});
async function preparedFlow(options: { oauthBlocked?: boolean; bridgeBlocked?: boolean; startingVersion?: string; expiringSession?: boolean } = {}) {
 const {createLegacyNormalizationManifest}=await import('./manifest');const {importLegacyNormalizationManifest}=await import('./importer');const {prepareLegacyImportReady}=await import('./reconcile');
 const tenantId=h.tenantTwoId;const jobId='40000000-0000-4000-8000-000000000029';
 await h.database.query('UPDATE migration_sources SET external_source_id=$1 WHERE tenant_id=$2',[digest('unrelated-fixture'),h.tenantOneId]);
 await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenantId,USER]);
 await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status,state_version) VALUES($1,$2,'VALIDATED',$3)",[tenantId,jobId,options.startingVersion??'1']);
 const manifest=createLegacyNormalizationManifest({tenantId,migrationJobId:jobId,sheets:makeSupportedSheets(3)});
 await importLegacyNormalizationManifest({tenantId,migrationJobId:jobId,manifest,runTransaction:h.runTenantTransaction});
 expect((await prepareLegacyImportReady({tenantId,migrationJobId:jobId,manifest,currentManifest:manifest,comparisonInstant:'2026-08-31T03:00:00.000Z',runTransaction:h.runTenantTransaction})).readiness).toBe('READY');
 const row=(await h.database.query<{source_id:string;version:string}>('SELECT s.source_id,j.state_version::text AS version FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1',[jobId])).rows[0];
 const registration={...startRegistration(),tenantId,sourceId:row.source_id};
 if(options.expiringSession){const response=NextResponse.json({});setGoogleSessionCookie(response,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()-30*24*60*60*1000+30000});cookie=`${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;}
 const service=intake.createFreezingConsentIntake({tenantId,origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[registration],startRegistration:registration,oauth:{createClient:provider}});
 const issued=await service.issueChallenge(request(),{migrationJobId:jobId,sourceId:row.source_id,expectedStateVersion:row.version});
 const url=new URL(await service.begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:issued.startDisplay}));nonce=url.searchParams.get('nonce')!;
 const callback=new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie}});
 blockedCapture=options.oauthBlocked??false;
 const consent=await service.complete(callback);blockedCapture=false;
 expect(manifest.sourceFingerprint).not.toBe(manifest.sourceArtifacts.sheets.digest);
 const requestKeys=generateKeyPairSync('ed25519'),manifestKeys=generateKeyPairSync('ed25519'),writerKeys=generateKeyPairSync('ed25519');const encryptionKey=Buffer.alloc(32,4);
 const pem=(key:typeof writerKeys.publicKey)=>String(key.export({type:key.type==='private'?'pkcs8':'spki',format:'pem'}));
 await h.database.exec('GRANT SELECT,INSERT ON migration_bridge_challenges,migration_bridge_consumptions TO app_runtime');
 if((await h.database.query<{name:string|null}>("SELECT to_regclass('migration_start_executions') AS name")).rows[0].name) await h.database.exec('GRANT SELECT,INSERT ON migration_start_executions TO app_runtime');
 const {createFinalBridgeIntake}=await import('./finalBridgeIntake');
 const bridgeIntake=createFinalBridgeIntake({tenantId,getAuthenticatedSubject:async()=> 'owner',runTransaction:runner(),registeredDeployments:[{...registration,spreadsheetIdDigest:digest('sheet-1'),keyId:'manifest-1',signingPublicKey:manifestKeys.publicKey,encryptionKey,writerKeyId:'writer-1',writerSigningPublicKey:writerKeys.publicKey}]});
 const {createRegisteredBridgeClient}=await import('./registeredBridgeClient');
 const {createRegisteredBridgeProducer}=await import('./registeredBridgeProducer');
 const {createBridgeProducerReservations}=await import('./bridgeProducerReservations');
 const r={...registration,endpoint:'https://local.example/api/internal/migrations/final-bridge',approvedScope:'DISABLE_LOCAL_WRITER_AND_START_FREEZING' as const,requestKeyId:'request-1',requestPublicKey:requestKeys.publicKey,manifestPublicKey:manifestKeys.publicKey,writerPublicKey:writerKeys.publicKey};
 await h.database.exec('CREATE ROLE "local-companion" NOSUPERUSER NOBYPASSRLS; GRANT SELECT,INSERT ON migration_bridge_producer_reservations TO "local-companion"');
 const reservations=createBridgeProducerReservations({connect:async()=>({query:async<T extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<T>>=>{
  const result=await h.database.query(text,values?[...values]:undefined);if(text.startsWith('BEGIN'))await h.database.exec('SET LOCAL ROLE "local-companion"');return {rows:result.rows as T[],rowCount:result.affectedRows??null,command:'',oid:0,fields:[]};
 },release:()=>{}})},'local-companion');
 const sheets=options.bridgeBlocked?makeSheets(3):makeSupportedSheets(3);const events:string[]=[];let disabledAt=0;
 const producer=createRegisteredBridgeProducer({registration:r,reservations,sheets:{listSheetNames:async()=>{events.push('sheets');return Object.keys(sheets.tabs);},getRevision:async()=> 'bridge-fresh-revision',getRows:async(name:string)=>[sheets.tabs[name].headers,...sheets.tabs[name].rows.map(r=>r.cells)]},manifest:{keyId:'manifest-1',signingPrivateKey:manifestKeys.privateKey,encryptionKey}});
 vi.stubEnv('UPSTASH_REDIS_REST_URL','https://redis.example');vi.stubEnv('UPSTASH_REDIS_REST_TOKEN','synthetic');vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_URL','http://127.0.0.1:8787/control');vi.stubEnv('LEGACY_REDIS_WRITER_CONTROL_TOKEN','synthetic-control');vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_KEY_ID','writer-1');vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PUBLIC_KEY',pem(writerKeys.publicKey));vi.stubEnv('CLASS_STORE_REDIS_WRITER_DISABLE_PRIVATE_KEY',pem(writerKeys.privateKey));
 vi.stubGlobal('fetch',async(url:string|URL,init:RequestInit)=>{
  if(String(url)===r.endpoint){expect(active).toBe(0);return producer(new Request(url,init));}
  if(String(url)==='http://127.0.0.1:8787/control') {events.push(init.method==='POST'?'disable':'readback');if(init.method==='POST')disabledAt=Date.now();return Response.json({version:1,deploymentId:r.deploymentId,source:'UPSTASH_REDIS_REST',status:'DISABLED',disabled:true,generation:1,evidence:`sha256:${'a'.repeat(64)}`,disabledAt:new Date(disabledAt).toISOString()});}
  if(String(url).startsWith('https://redis.example')){events.push('redis');return Response.json({result:['0',[]]});}
  throw Error('Nonlocal HTTP forbidden');
 });
 const client=createRegisteredBridgeClient({registration:r,requestPrivateKey:requestKeys.privateKey});
 const adapter={registration,prepare:async(intent:StartFreezingIntent=intake.readVerifiedStartFreezingConsent(consent).intent)=>{const challenge=await bridgeIntake.issueChallenge({migrationJobId:jobId,sourceId:row.source_id,expectedStateVersion:row.version});return{challenge,...client.prepare({ceremonyId:intent.ceremonyId,challenge})};}};
 return {tenantId,jobId,manifest,row,registration,request:callback,consent,intake:service,runTransaction:runner(),adapter,bridgeIntake,events,issued};
}
it('actual READY producer and signed consent plus durable registered bridge commit atomic FREEZING only',async()=>{
 const f=await preparedFlow();
 const {continueStartFreezing}=await import('./startFreezing');
 expect(typeof continueStartFreezing).toBe('function');
 await h.database.exec("UPDATE migration_sources SET grant_expires_at=now()+interval '1 hour'");
 await h.database.query("INSERT INTO operations(tenant_id,operation_id,operation_kind,payload_hash) VALUES($1,'unrelated-claim','MIGRATION_IMPORT',$2)",[h.tenantOneId,digest('unrelated')]);
 await h.database.query(`INSERT INTO padlet_evidence_claims(provider,board_id,post_id,tuple_digest,claimed_by_tenant_id,claimed_by_operation_id,evidence_created_at,evidence_author_full_name)
  VALUES('PADLET','other-board','other-post',encode(digest(convert_to('other-board','UTF8')||decode('00','hex')||convert_to('other-post','UTF8'),'sha256'),'hex'),$1,'unrelated-claim',now(),'Other Student')`,[h.tenantOneId]);
 await h.database.query("INSERT INTO padlet_claim_digest_tombstones(tuple_digest,owner_digest,source_provenance) VALUES($1,$2,'unrelated-source')",[digest('unrelated-tuple'),digest('unrelated-owner')]);
 const changedTables=['migration_jobs','migration_bridge_challenges','migration_bridge_consumptions','migration_start_dispatches','migration_start_executions','migration_bridge_producer_reservations','audit_events'];
 const preserved=(await h.database.query<{tablename:string}>("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename).filter(t=>!changedTables.includes(t));
 const before=await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)));
 const result=await continueStartFreezing(f);
 expect(result).toMatchObject({status:'STARTED',exclusion:'NOT_PROVEN',automaticRetry:false,automaticEnable:false});
 const job=(await h.database.query<Record<string,unknown>>('SELECT status,state_version::text AS version,freeze_started_at,freeze_verified_at,final_fingerprint FROM migration_jobs WHERE job_id=$1',[f.jobId])).rows[0];
 expect(job).toMatchObject({status:'FREEZING',version:String(BigInt(f.row.version)+BigInt(1)),freeze_verified_at:null,final_fingerprint:null});expect(job.freeze_started_at).not.toBeNull();
 expect(await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)))).toEqual(before);
 const rows=(await h.database.query<{binding:Record<string,unknown>}>('SELECT binding FROM migration_start_executions')).rows;expect(rows).toHaveLength(1);
 expect(rows[0].binding).toMatchObject({ceremonyId:f.issued.challengeId,consentAcquisitionDigest:intake.readVerifiedFreezingConsent(f.consent).acquisitionDigest,sourceAcquisitionDigest:f.manifest.sourceArtifacts.sheets.digest,jobSemanticFingerprint:f.manifest.sourceFingerprint,exclusion:'NOT_PROVEN'});
 expect(rows[0].binding.bridgeSheetsDigest).not.toBe(rows[0].binding.consentAcquisitionDigest);
 const producer=(await h.database.query<{request_digest:string;registration_digest:string;ceremony_id:string;challenge_id:string}>('SELECT * FROM migration_bridge_producer_reservations')).rows[0];
 expect(rows[0].binding).toMatchObject({requestDigest:producer.request_digest,registrationDigest:producer.registration_digest,ceremonyId:producer.ceremony_id,bridgeChallengeId:producer.challenge_id});
 expect(f.events[0]).toBe('disable');expect(f.events.at(-1)).toBe('readback');expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
 await expect(continueStartFreezing(f)).rejects.toThrow();expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);

async function acquiredFlow(options:Parameters<typeof preparedFlow>[0]={}) {
 const f=await preparedFlow(options);const {dispatchStartFreezing}=await import('./startFreezingCeremony');
 const dispatch=await dispatchStartFreezing(f);expect(dispatch.status).toBe('BRIDGE_RESPONDED');if(dispatch.status!=='BRIDGE_RESPONDED')throw Error('Missing real bridge response');
 const bridge=await f.bridgeIntake.accept({challengeId:dispatch.bridgeChallenge.challengeId,manifest:dispatch.response});
 return {...f,dispatch,bridge};
}
it('archival status survives lost start ACK without remint, retry or external enable',async()=>{
 const f=await acquiredFlow();const api=await import('./startFreezing');let commits=0;
 const runTransaction:TenantImportTransactionRunner=async(t,cb)=>{const result=await runner()(t,cb);commits++;throw Error('COMMIT ACK UNKNOWN');return result;};
 await expect(api.startFreezing({...f,runTransaction})).rejects.toThrow();expect(commits).toBe(1);
 expect(typeof api.readStartFreezingStatus).toBe('function');
 const status=await api.readStartFreezingStatus({tenantId:f.tenantId,migrationJobId:f.jobId,ceremonyId:f.issued.challengeId,intentDigest:digest(canonicalJson(intake.readVerifiedStartFreezingConsent(f.consent).intent)),request:f.request,origin:ORIGIN,env,runTransaction:runner()});
 expect(status).toMatchObject({scope:'ARCHIVAL_ONLY',status:'STARTED',jobStatus:'FREEZING',exclusion:'NOT_PROVEN'});
 expect(()=>intake.readVerifiedStartFreezingConsent(status as never)).toThrow();
 await expect(api.startFreezing(f)).rejects.toThrow();expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);
it('execution SQL and ORM expose the same immutable tenant-bound relation',async()=>{
 const schema=await import('@/server/db/schema');expect(schema).toHaveProperty('migrationStartExecutions');
 const table='migration_start_executions';expect((await h.database.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1',[table])).rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
});
it.each(['audit-insert','audit-readback','execution-insert','execution-readback','cas','job-readback','post-insert-expiry','post-cas-expiry'])('start %s rolls back only local execution and CAS, retaining genuine prior intake and disabled writer',async failure=>{
 const f=await acquiredFlow();const {startFreezing}=await import('./startFreezing');let reached=false;let wrote=false;let cas=false;
 const before=(await h.database.query('SELECT * FROM migration_jobs WHERE job_id=$1',[f.jobId])).rows;
 const auditsBefore=(await h.database.query('SELECT * FROM audit_events')).rows;
 const runTransaction=runner(text=>{
  if(text.startsWith('INSERT INTO migration_start_executions'))wrote=true;
  if(text.startsWith('UPDATE migration_jobs SET'))cas=true;
  const targets:Record<string,string>={'audit-insert':'INSERT INTO audit_events','audit-readback':'SELECT job_id,actor_user_id','execution-insert':'INSERT INTO migration_start_executions','execution-readback':'SELECT binding FROM migration_start_executions','cas':'UPDATE migration_jobs SET','job-readback':'SELECT status,state_version::text AS version,source_fingerprint,freeze_started_at'};
  if(targets[failure]&&text.startsWith(targets[failure])){reached=true;return{rows:[]};}
  if(text.includes('clock_timestamp')&&!text.startsWith('UPDATE')&&((failure==='post-insert-expiry'&&wrote)||(failure==='post-cas-expiry'&&cas))){reached=true;return{rows:[{ms:String(f.issued.expiresAt)}]};}
 });
 await expect(startFreezing({...f,runTransaction})).rejects.toThrow();expect(reached).toBe(true);
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);
 expect((await h.database.query('SELECT * FROM migration_jobs WHERE job_id=$1',[f.jobId])).rows).toEqual(before);
 expect((await h.database.query('SELECT * FROM audit_events')).rows).toEqual(auditsBefore);
 for(const table of ['migration_consent_captures','migration_start_dispatches','migration_bridge_consumptions','migration_bridge_producer_reservations'])expect((await h.database.query(`SELECT * FROM ${table}`)).rows).toHaveLength(1);
 expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);
it.each(['consent','bridge','dispatch'])('refuses JSON %s before SQL rather than rebuilding authority from valid archival rows',async kind=>{
 const f=await acquiredFlow();const {startFreezing}=await import('./startFreezing');let sqlCalls=0;
 const forged={...f,[kind]:JSON.parse(JSON.stringify(f[kind as 'consent'|'bridge'|'dispatch'])),runTransaction:runner(()=>{sqlCalls++;})};
 await expect(startFreezing(forged)).rejects.toThrow();expect(sqlCalls).toBe(0);
},60000);
it.each(['session','membership','job-fingerprint','source-fingerprint','preflight-many','isolation'])('rejects fresh start %s drift without local writes',async drift=>{
 const f=await acquiredFlow();const {startFreezing}=await import('./startFreezing');let hit=false;
 if(drift==='membership')await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[f.tenantId]);
 if(drift==='job-fingerprint')await h.database.query("UPDATE migration_jobs SET source_fingerprint=$1 WHERE job_id=$2",[digest('drift'),f.jobId]);
 if(drift==='source-fingerprint')await h.database.query('UPDATE migration_sources SET source_fingerprint=$1 WHERE tenant_id=$2',[digest('drift'),f.tenantId]);
 if(drift==='preflight-many')await h.database.query("INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES($1,$2,$3,'extra','PREFLIGHT',$4,'{}',0)",[f.tenantId,f.jobId,f.row.source_id,digest('extra')]);
 const input={...f,request:drift==='session'?new Request(f.request.url):f.request,runTransaction:runner(text=>{if(drift==='isolation'&&text.includes('transaction_isolation')){hit=true;return{rows:[{isolation:'repeatable read'}]};}})};
 await expect(startFreezing(input)).rejects.toThrow();if(drift==='isolation')expect(hit).toBe(true);
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);

it.each([false,true])('actual callback reports committed STARTED or terminal UNKNOWN after local CAS suppression=%s',async suppress=>{
 const f=await preparedFlow();const {createFreezingConsentHandlers}=await import('./freezingConsentHandlers');const {continueStartFreezing}=await import('./startFreezing');
 const slug='transaction-tenant-two';
 const directory={findBySlug:async()=>({id:f.tenantId,slug,displayName:'local',lifecycle:'IMPORTING' as const,timezone:'Asia/Seoul' as const})};
 const api=createFreezingConsentHandlers({origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[f.registration],startRegistration:f.registration,oauth:{createClient:provider},directory,
  continueStart:(request,consent,intake)=>continueStartFreezing({...f,request,consent,intake,runTransaction:suppress?runner(text=>text.startsWith('UPDATE migration_jobs SET')?{rows:[]}:undefined):runner()})});
 const {createTenantApiDispatcher}=await import('@/server/tenantApiDispatcher');
 const dispatch=createTenantApiDispatcher({...directory,getSession:()=>null,findByTenantAndSubject:async()=>null},[
  {method:'POST',pattern:'migrations/[jobId]/freezing/start/challenge',access:'public',handler:api.challenge},
  {method:'POST',pattern:'migrations/[jobId]/freezing/start',access:'public',handler:api.begin}]);
 const post=(body:unknown,challenge:boolean,headers:Record<string,string>={})=>{const path=['migrations',f.jobId,'freezing','start',...(challenge?['challenge']:[])];return dispatch(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)}),{slug,path});};
 const issuance=await post({expectedStateVersion:f.row.version,sourceId:f.row.source_id},true);expect(issuance.status).toBe(200);const issued=await issuance.json();
 const confirmed=await post({challengeId:issued.challengeId,display:issued.startDisplay},false,{cookie:`${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':issued.csrfToken});expect(confirmed.status).toBe(200);
 const url=new URL((await confirmed.json()).authorizationUrl);nonce=url.searchParams.get('nonce')!;
 const callback=new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie:`${cookie}; ${confirmed.headers.get('set-cookie')!.split(';')[0]}`}});
 const response=await api.callback(callback);
 expect((await h.database.query<{status:string}>('SELECT status FROM migration_jobs WHERE job_id=$1',[f.jobId])).rows[0].status).toBe(suppress?'READY':'FREEZING');
 expect(response.status).toBe(suppress?202:200);expect(await response.json()).toEqual(suppress?{ceremonyId:issued.challengeId,status:'UNKNOWN',externalEffect:'UNKNOWN',automaticRetry:false,automaticEnable:false}:{ceremonyId:issued.challengeId,status:'STARTED',exclusion:'NOT_PROVEN',automaticRetry:false,automaticEnable:false});
 expect(response.headers.get('cache-control')).toBe('no-store');expect((await api.callback(callback)).status).toBe(403);expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);
it('an injected retrying runner cannot repeat the local start attempt after rollback',async()=>{
 const f=await acquiredFlow();const {startFreezing}=await import('./startFreezing');let inserts=0;let retry=false;
 const first=runner(text=>{if(text.startsWith('INSERT INTO migration_start_executions')){inserts++;throw Error('retryable rollback');}});
 const second=runner(text=>{if(text.startsWith('INSERT INTO migration_start_executions'))inserts++;});
 const runTransaction:TenantImportTransactionRunner=async(t,cb)=>{try{return await first(t,cb);}catch{retry=true;return second(t,cb);}};
 await expect(startFreezing({...f,runTransaction})).rejects.toThrow();expect(retry).toBe(true);expect(inserts).toBe(1);
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);
},60000);
it('OAuth Sheet-only BLOCKED diagnostics cannot replace complete healthy bridge pair eligibility',async()=>{
 const f=await preparedFlow({oauthBlocked:true});expect(intake.readVerifiedFreezingConsent(f.consent).status).toBe('BLOCKED');
 const {continueStartFreezing}=await import('./startFreezing');expect(await continueStartFreezing(f)).toMatchObject({status:'STARTED',exclusion:'NOT_PROVEN'});
},60000);
it('an authentic BANK/quarantined complete bridge pair is retained only by intake and cannot start',async()=>{
 const f=await preparedFlow({bridgeBlocked:true});const {continueStartFreezing}=await import('./startFreezing');
 await expect(continueStartFreezing(f)).rejects.toThrow();expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);
 expect((await h.database.query('SELECT * FROM migration_bridge_consumptions')).rows).toHaveLength(1);expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);
it('a genuine but unrelated registered bridge challenge cannot replace the same-dispatch handle',async()=>{
 const f=await acquiredFlow();const {startFreezing}=await import('./startFreezing');
 const other=await f.adapter.prepare();const response=await other.send();expect(response.outcome).toBe('RECEIVED');if(response.outcome!=='RECEIVED')throw Error('Missing actual bridge response');
 const bridge=await f.bridgeIntake.accept({challengeId:other.challenge.challengeId,manifest:response.manifest});let calls=0;
 await expect(startFreezing({...f,bridge,runTransaction:runner(()=>{calls++;})})).rejects.toThrow();expect(calls).toBe(0);
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);
},60000);

it('production single-attempt transaction runner discards a real committed local SQL connection on lost start ACK',async()=>{
 const f=await acquiredFlow();const {startFreezing,readStartFreezingStatus}=await import('./startFreezing');
 const {createTenantTransactionRunner}=await import('@/server/db/transaction');let discarded=false;let commits=0;let released=0;
 const runTransaction=createTenantTransactionRunner({pool:{connect:async()=>({
  query:async<T extends QueryResultRow>(text:string,values?:unknown[]):Promise<QueryResult<T>>=>{
   const result=await h.database.query(text,values);if(text.startsWith('BEGIN'))await h.database.exec('SET LOCAL ROLE app_runtime');
   if(text==='COMMIT'){commits++;throw Error('Synthetic transport ACK loss after actual COMMIT');}
   return{rows:result.rows as T[],rowCount:result.affectedRows??null,command:'',oid:0,fields:[]};
  },release:(discard?:Error|boolean)=>{released++;discarded=discard===true;},
 })},createDatabase:()=>({execute:async(query:Parameters<TenantTransaction['execute']>[0])=>{const q=typeof query==='string'?{sql:query,params:[]}:new PgDialect().sqlToQuery(query.getSQL());return h.database.query(q.sql,q.params);}} as TenantTransaction)}, {maxAttempts:1,isolationLevel:'READ COMMITTED'});
 await expect(startFreezing({...f,runTransaction})).rejects.toThrow();expect(commits).toBe(1);expect(released).toBe(1);expect(discarded).toBe(true);
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toHaveLength(1);
 expect(await readStartFreezingStatus({tenantId:f.tenantId,migrationJobId:f.jobId,ceremonyId:f.issued.challengeId,intentDigest:digest(canonicalJson(intake.readVerifiedStartFreezingConsent(f.consent).intent)),request:f.request,origin:ORIGIN,env,runTransaction:runner()})).toMatchObject({scope:'ARCHIVAL_ONLY',status:'STARTED'});
 expect(f.events.filter(e=>e==='disable')).toHaveLength(1);
},60000);
it('execution rows enforce forced RLS, global one-use, parent linkage and immutable retention on populated facts',async()=>{
 const f=await acquiredFlow();const {startFreezing}=await import('./startFreezing');await startFreezing(f);
 await h.runTenantTransaction(h.tenantOneId,async tx=>expect((await tx.execute(sql`SELECT * FROM migration_start_executions`)).rows).toEqual([]));
 for(const statement of ['UPDATE migration_start_executions SET binding=binding','DELETE FROM migration_start_executions','TRUNCATE migration_start_executions','TRUNCATE audit_events CASCADE',"INSERT INTO migration_start_executions SELECT * FROM migration_start_executions"])
  await expect(h.database.exec(statement)).rejects.toThrow();
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toHaveLength(1);
},60000);

it.each([false,true])('enforces JavaScript safe-integer next-version boundary, overflow=%s',async overflow=>{
 const f=await preparedFlow({startingVersion:String(BigInt(Number.MAX_SAFE_INTEGER)-BigInt(overflow?3:4))});
 expect(f.row.version).toBe(String(BigInt(Number.MAX_SAFE_INTEGER)-BigInt(overflow?0:1)));
 const {continueStartFreezing}=await import('./startFreezing');
 if(overflow){await expect(continueStartFreezing(f)).rejects.toThrow();expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);}
 else expect(await continueStartFreezing(f)).toMatchObject({status:'STARTED',stateVersion:String(Number.MAX_SAFE_INTEGER)});
},60000);
it.each(['post-source-lock','bridge-expiry','envelope-expiry','session-expiry'])('checks %s against DB clock after the relevant wait rather than original issuance clock',async boundary=>{
 const f=await acquiredFlow({expiringSession:boundary==='session-expiry'});const {startFreezing}=await import('./startFreezing');const {readVerifiedFinalBridgeAcquisition}=await import('./finalBridgeIntake');
 const metadata=readVerifiedFinalBridgeAcquisition(f.bridge);let waited=false;let hit=false;
 const {readFreezingConsentSession}=await import('./freezingConsentSession');const sessionExpires=readFreezingConsentSession(f.request,ORIGIN,env).issuedAt+30*24*60*60*1000;
 if(boundary==='session-expiry'){expect(sessionExpires).toBeLessThan(metadata.challenge.expiresAt);expect(sessionExpires).toBeLessThan(f.issued.expiresAt);}
 const runTransaction=runner(text=>{
  if(text.includes('FROM migration_sources')&&text.includes('FOR UPDATE'))waited=true;
  if(text.includes('clock_timestamp')&&(boundary!=='post-source-lock'||waited)){hit=true;return{rows:[{ms:String(boundary==='bridge-expiry'?metadata.challenge.expiresAt:boundary==='envelope-expiry'?metadata.envelopeExpiresAt:boundary==='session-expiry'?sessionExpires:f.issued.expiresAt)}]};}
 });
 await expect(startFreezing({...f,runTransaction})).rejects.toThrow();expect(hit).toBe(true);
 expect((await h.database.query('SELECT * FROM migration_start_executions')).rows).toEqual([]);
},60000);
it.each(['session','member','tenant','job','intent'])('archival read rejects wrong %s without issuing action authority',async field=>{
 const f=await acquiredFlow();const {startFreezing,readStartFreezingStatus}=await import('./startFreezing');await startFreezing(f);
 const input={tenantId:f.tenantId,migrationJobId:f.jobId,ceremonyId:f.issued.challengeId,intentDigest:digest(canonicalJson(intake.readVerifiedStartFreezingConsent(f.consent).intent)),request:f.request,origin:ORIGIN,env,runTransaction:runner()};
 if(field==='session')input.request=new Request(f.request.url);
 if(field==='member')await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[f.tenantId]);
 if(field==='tenant')input.tenantId=h.tenantOneId;
 if(field==='job')input.migrationJobId=JOB;
 if(field==='intent')input.intentDigest=digest('wrong');
 if(field==='tenant'||field==='job')expect(await readStartFreezingStatus(input)).toEqual({scope:'ARCHIVAL_ONLY',status:'ABSENT'});
 else await expect(readStartFreezingStatus(input)).rejects.toThrow();
},60000);
