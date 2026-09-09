// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('live network forbidden');}));
},60000);
afterEach(async()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();await h?.close();});
function request(token?:string,headers:Record<string,string>={}){return new Request(`${ORIGIN}/internal`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...(token?{'x-csrf-token':token}:{}),...headers}});}
const intent=()=>({migrationJobId:JOB,expectedStateVersion:'1',sourceId:'sheet'});
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
function service(runTransaction=runner(),tenantId=h.tenantOneId){return intake.createFreezingConsentIntake({tenantId,origin:ORIGIN,env,runTransaction,registeredSheets:[{tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1'}],oauth:{createClient:provider}});}
async function begin(){const s=service();const issued=await s.issueChallenge(request(),intent());const url=new URL(await s.begin(request(issued.csrfToken),{challengeId:issued.challengeId}));nonce=url.searchParams.get('nonce')!;return{issued,callback:new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=local-code`,{headers:{cookie}})};}
async function counts(){return Promise.all(tables.map(async t=>(await h.database.query(`SELECT * FROM ${t}`)).rows.length));}


const startRegistration=()=>({tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1',deploymentId:'local-companion',registrationVersion:'1',registrationDigest:digest('registered-local-config')});
function startService(runTransaction=runner()) {return intake.createFreezingConsentIntake({tenantId:h.tenantOneId,origin:ORIGIN,env,runTransaction,registeredSheets:[{tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1'}],oauth:{createClient:provider},startRegistration:startRegistration()});}
async function startBegin(){const s=startService();const issued=await s.issueChallenge(request(),intent());
 const url=new URL(await s.begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:issued.startDisplay}));nonce=url.searchParams.get('nonce')!;
 return{issued,callback:new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=local-code`,{headers:{cookie}})};
}
it('explicit start display and POST are immutable, separately purposed and keep original 300-second issuance',async()=>{
 const s=startService();const issued=await s.issueChallenge(request(),intent());
 expect(issued.startDisplay).toMatchObject({action:'DISABLE_LOCAL_WRITER_AND_START_FREEZING',deploymentId:'local-companion',registrationVersion:'1',registrationDigest:digest('registered-local-config'),automaticEnable:false,spreadsheetId:'sheet-1',tenantId:h.tenantOneId});
 const original=(await h.database.query<{binding:{issuedAt:number;expiresAt:number}}> ('SELECT binding FROM migration_start_intents')).rows[0].binding;
 expect(original.expiresAt-original.issuedAt).toBe(300000);expect(original.expiresAt).toBe(issued.expiresAt);
 await expect(s.begin(request(issued.csrfToken),{challengeId:issued.challengeId})).rejects.toThrow();
 const url=new URL(await s.begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:issued.startDisplay}));
 const row=(await h.database.query<{binding:{purpose:string;stateDigest:string;intentDigest:string}}>('SELECT binding FROM migration_start_confirmations')).rows[0].binding;
 expect(row.purpose).toBe('CLASS_STORE_START_FREEZING_V1');expect(row.stateDigest).toBe(digest(url.searchParams.get('state')!));
 expect((await h.database.query<{binding:unknown}>('SELECT binding FROM migration_start_intents')).rows[0].binding).toEqual(original);
 expect(calls).toEqual([]);
});
it.each(['action','deploymentId','registrationVersion','registrationDigest','automaticEnable','spreadsheetId','tenantId','preflightDigest'])('refuses changed explicit display %s before confirmation',async field=>{
 const s=startService();const issued=await s.issueChallenge(request(),intent());
 await expect(s.begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:{...issued.startDisplay,[field]:'forged'}})).rejects.toThrow();
 expect((await counts()).slice(4)).toEqual([1,0,0]);expect(calls).toEqual([]);
});
it('only fresh start-purpose callback mints live start-bound consent, not consent-only, JSON or archival receipt',async()=>{
 const ordinary=await begin();const handle=await service().complete(ordinary.callback);
 expect(()=>intake.readVerifiedStartFreezingConsent(handle)).toThrow();
 const {issued,callback}=await startBegin();const live=await startService().complete(callback);
 const data=intake.readVerifiedStartFreezingConsent(live);expect(data.intent.display).toEqual(issued.startDisplay);
 expect(data.intent.purpose).toBe('CLASS_STORE_START_FREEZING_V1');expect(data.consent).toEqual(intake.readVerifiedFreezingConsent(live));
 expect(()=>intake.readVerifiedStartFreezingConsent({...live})).toThrow();expect(()=>intake.readVerifiedStartFreezingConsent(JSON.parse(JSON.stringify(data)))).toThrow();
 expect(calls.filter(u=>u.endsWith('/token'))).toHaveLength(2);expect(calls.at(-1)).toContain('/revoke');for(const c of clients)expect(c.credentials).toEqual({});
 await expect(startService().complete(callback)).rejects.toThrow();
 expect((await h.database.query<{status:string}>('SELECT status FROM migration_jobs')).rows[0].status).toBe('READY');
});
it('a consent-only confirmation cannot be promoted by selecting a configured start intake at callback',async()=>{
 const {callback}=await begin();await expect(startService().complete(callback)).rejects.toThrow();expect(calls).toEqual([]);
});


async function bridgeAdapter(send:()=>Promise<unknown>=async()=>({outcome:'RECEIVED',manifest:{syntheticTransportResponse:true}})) {
 await h.database.exec('GRANT SELECT,INSERT ON migration_bridge_challenges TO app_runtime');
 const {createFinalBridgeIntake}=await import('./finalBridgeIntake');
 const keys=generateKeyPairSync('ed25519');
 const bridge=createFinalBridgeIntake({tenantId:h.tenantOneId,getAuthenticatedSubject:async()=> 'owner',runTransaction:runner(),registeredDeployments:[{tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1',spreadsheetIdDigest:digest('sheet-1'),deploymentId:'local-companion',keyId:'manifest-key',signingPublicKey:keys.publicKey,encryptionKey:Buffer.alloc(32,1),writerKeyId:'writer-key',writerSigningPublicKey:keys.publicKey}]});
 return {registration:startRegistration(),prepare:async()=>({challenge:await bridge.issueChallenge(intent()),requestDigest:digest('exact-signed-local-request-body'),send})};
}
it('live callback consent ACK precedes real bridge challenge, exact durable dispatch ACK and one external call outside transactions',async()=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {issued,callback}=await startBegin();const live=await startService().complete(callback);let sends=0;
 const adapter=await bridgeAdapter(async()=>{sends++;expect(active).toBe(0);expect(calls.at(-1)).toContain('/revoke');for(const c of clients)expect(c.credentials).toEqual({});
  const rows=(await h.database.query<{binding:{ceremonyId:string;requestDigest:string;registrationDigest:string}}>('SELECT binding FROM migration_start_dispatches')).rows;
  expect(rows).toHaveLength(1);expect(rows[0].binding).toMatchObject({ceremonyId:issued.challengeId,requestDigest:digest('exact-signed-local-request-body'),registrationDigest:startRegistration().registrationDigest});return{outcome:'RECEIVED',manifest:{syntheticTransportResponse:true}};});
 const result=await dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:runner(),adapter});
 expect(result.status).toBe('BRIDGE_RESPONDED');expect(sends).toBe(1);
 await expect(dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:runner(),adapter})).rejects.toThrow();expect(sends).toBe(1);
 expect((await h.database.query<{status:string}>('SELECT status FROM migration_jobs')).rows[0].status).toBe('READY');
});
it.each(['insert','readback','ack','preproducer-membership','preproducer-ttl','registration'])('never sends when dispatch %s is uncertain or no longer authorized',async kind=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {issued,callback}=await startBegin();const live=await startService().complete(callback);let sends=0;let hit=false;
 const adapter=await bridgeAdapter(async()=>{sends++;return{};});
 if(kind==='registration')adapter.registration={...adapter.registration,registrationDigest:digest('changed')};
 let commits=0;const run=runner(text=>{
  if(kind==='insert'&&text.includes('INSERT INTO migration_start_dispatches')){hit=true;return{rows:[]};}
  if(kind==='readback'&&text.includes('SELECT binding FROM migration_start_dispatches')){hit=true;return{rows:[]};}
  if(kind==='preproducer-ttl'&&commits>=2&&text.includes('clock_timestamp')){hit=true;return{rows:[{ms:String(issued.expiresAt)}]};}
 });
 const boundary:TenantImportTransactionRunner=async(t,cb)=>{const value=await run(t,cb);commits++;
  if(commits===2&&kind==='ack'){hit=true;throw Error('COMMIT ACK UNKNOWN');}
  if(commits===2&&kind==='preproducer-membership'){hit=true;await h.database.query('DELETE FROM tenant_memberships');}
  return value;};
 await expect(dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:boundary,adapter})).rejects.toThrow();
 expect(sends).toBe(0);if(kind!=='registration')expect(hit).toBe(true);
 expect((await counts()).slice(4)).toEqual([1,1,['ack','preproducer-membership','preproducer-ttl'].includes(kind)?1:0]);
});
it('transport timeout is terminal UNKNOWN, keeps reservation and never retries or automatically enables',async()=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {callback}=await startBegin();const live=await startService().complete(callback);let sends=0;
 const adapter=await bridgeAdapter(async()=>{sends++;throw Error('timeout containing private remote details');});
 const result=await dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:runner(),adapter});
 expect(result).toEqual({status:'UNKNOWN',externalEffect:'UNKNOWN',automaticRetry:false,automaticEnable:false});expect(sends).toBe(1);
 await expect(dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:runner(),adapter})).rejects.toThrow();expect(sends).toBe(1);
 expect((await counts()).slice(4)).toEqual([1,1,1]);
});
it('dispatch rejects ordinary live consent and forged metadata before preparing any bridge challenge',async()=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {callback}=await begin();const live=await service().complete(callback);let prepared=0;
 const adapter=await bridgeAdapter();const original=adapter.prepare;adapter.prepare=async()=>{prepared++;return original();};
 for(const consent of [live,{} as typeof live])await expect(dispatchStartFreezing({request:callback,consent,intake:startService(),runTransaction:runner(),adapter})).rejects.toThrow();
 expect(prepared).toBe(0);expect((await h.database.query('SELECT * FROM migration_bridge_challenges')).rows).toEqual([]);
});


async function httpApi(start:boolean, send:()=>Promise<unknown>=async()=>({outcome:'RECEIVED',manifest:{syntheticTransportResponse:true}})) {
 const {createFreezingConsentHandlers}=await import('./freezingConsentHandlers');
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const adapter=await bridgeAdapter(send);
 return createFreezingConsentHandlers({origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[{tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1'}],oauth:{createClient:provider},
  ...(start?{startRegistration:startRegistration(),continueStart:(request:Request,consent: intake.VerifiedFreezingConsent,service:ReturnType<typeof startService>)=>dispatchStartFreezing({request,consent,intake:service,runTransaction:runner(),adapter})}:{}),
  directory:{findBySlug:async(slug:string)=>({id:h.tenantOneId,slug,displayName:'local',lifecycle:'IMPORTING',timezone:'Asia/Seoul'})}});
}
async function httpPost(api:Awaited<ReturnType<typeof httpApi>>,body:unknown,challenge:boolean,headers:Record<string,string>={}) {
 const {createTenantApiDispatcher}=await import('@/server/tenantApiDispatcher');const slug='transaction-tenant-one';
 const path=['migrations',JOB,'freezing','start',...(challenge?['challenge']:[])];
 return createTenantApiDispatcher({findBySlug:async()=>({id:h.tenantOneId,slug,displayName:'local',lifecycle:'IMPORTING',timezone:'Asia/Seoul'}),getSession:()=>null,findByTenantAndSubject:async()=>null},[
 {method:'POST',pattern:'migrations/[jobId]/freezing/start/challenge',access:'public',handler:api.challenge},
 {method:'POST',pattern:'migrations/[jobId]/freezing/start',access:'public',handler:api.begin},
 ])(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)}),{slug,path});
}
async function httpBegin(api:Awaited<ReturnType<typeof httpApi>>,start=true){
 const issuance=await httpPost(api,{expectedStateVersion:'1',sourceId:'sheet'},true);expect(issuance.status).toBe(200);const issued=await issuance.json();
 const confirmed=await httpPost(api,{challengeId:issued.challengeId,...(start?{display:issued.startDisplay}:{})},false,{cookie:`${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':issued.csrfToken});
 expect(confirmed.status).toBe(200);const url=new URL((await confirmed.json()).authorizationUrl);nonce=url.searchParams.get('nonce')!;
 return{issued,issuance,confirmed,callback:new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie:`${cookie}; ${confirmed.headers.get('set-cookie')!.split(';')[0]}`}})};
}
it('authenticated new-purpose routing cookie and state continue fresh consent to durable dispatch inside the same awaited callback',async()=>{
 let sends=0;let entered!:()=>void;let release!:()=>void;const atSend=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
 const api=await httpApi(true,async()=>{sends++;entered();await gate;return{outcome:'RECEIVED',manifest:{syntheticTransportResponse:true}};});const {issued,callback}=await httpBegin(api);
 let responded=false;const completion=api.callback(callback).then(r=>{responded=true;return r;});await atSend;expect(responded).toBe(false);release();
 const response=await completion;expect(response.status).toBe(202);expect(await response.json()).toEqual({ceremonyId:issued.challengeId,status:'BRIDGE_RESPONDED_START_NOT_COMMITTED',externalEffect:'UNVERIFIED',automaticRetry:false,automaticEnable:false});
 expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect(sends).toBe(1);
 expect((await api.callback(callback)).status).toBe(403);expect(sends).toBe(1);
});
it('ordinary consent cookie and archival CAPTURED cannot be routed into start purpose even with a forged pending row',async()=>{
 const ordinary=await httpApi(false);const {issued,callback}=await httpBegin(ordinary,false);
 const b=(await h.database.query<{binding:intake.FreezingConsentBinding}>('SELECT binding FROM migration_consent_challenges')).rows[0].binding;
 const {makeStartFreezingIntent}=await import('./startFreezingCeremony');const pending=makeStartFreezingIntent(b,startRegistration());
 await h.database.query('INSERT INTO migration_start_intents(tenant_id,ceremony_id,binding) VALUES($1,$2,$3::jsonb)',[h.tenantOneId,issued.challengeId,JSON.stringify(pending)]);
 let sends=0;const start=await httpApi(true,async()=>{sends++;return{};});
 expect((await start.callback(callback)).status).toBe(403);expect(calls).toEqual([]);
 const result=await ordinary.callback(callback);expect(result.status).toBe(200);expect((await result.json()).status).toBe('CAPTURED');
 expect((await start.callback(callback)).status).toBe(403);expect(sends).toBe(0);expect((await counts()).slice(5)).toEqual([0,0]);
});
it.each(['missing-cookie','state','new-login','missing-explicit-post','wrong-purpose'])('start callback %s cannot mint or dispatch',async kind=>{
 const api=await httpApi(true);const {callback,issuance}=await httpBegin(api);const url=new URL(callback.url);const headers=new Headers(callback.headers);
 if(kind==='missing-cookie')headers.set('cookie',cookie);
 if(kind==='state')url.searchParams.set('state',url.searchParams.get('state')!.slice(0,37)+'a'.repeat(64));
 if(kind==='new-login'){const r=NextResponse.json({});setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()-1000});headers.set('cookie',headers.get('cookie')!.replace(cookie,`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`));}
 if(kind==='missing-explicit-post')headers.set('cookie',`${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`);
 const target=kind==='wrong-purpose'?await httpApi(false):api;
 expect((await target.callback(new Request(url,{headers}))).status).toBe(403);expect(calls).toEqual([]);expect((await counts()).slice(2,4)).toEqual([0,0]);expect((await counts()).at(-1)).toBe(0);
});


it('actual client UNKNOWN result is not misreported as a bridge response',async()=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {callback}=await startBegin();const live=await startService().complete(callback);
 const adapter=await bridgeAdapter(async()=>({outcome:'UNKNOWN'}));
 expect(await dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:runner(),adapter})).toEqual({status:'UNKNOWN',externalEffect:'UNKNOWN',automaticRetry:false,automaticEnable:false});
});
it('a genuine bridge challenge issued before live consent ACK cannot be substituted',async()=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {callback}=await startBegin();let sends=0;
 const adapter=await bridgeAdapter(async()=>{sends++;return{outcome:'RECEIVED',manifest:{}};});const prior=await adapter.prepare();
 const live=await startService().complete(callback);adapter.prepare=async()=>prior;
 await expect(dispatchStartFreezing({request:callback,consent:live,intake:startService(),runTransaction:runner(),adapter})).rejects.toThrow();
 expect(sends).toBe(0);expect((await counts()).at(-1)).toBe(0);
});


it('new start metadata uses actual normalization/import/READY output and fresh signed OAuth, never equalized source fingerprints',async()=>{
 const {createLegacyNormalizationManifest}=await import('./manifest');const {importLegacyNormalizationManifest}=await import('./importer');const {prepareLegacyImportReady}=await import('./reconcile');
 const tenantId=h.tenantTwoId;const jobId='40000000-0000-4000-8000-000000000029';
 await h.database.query('UPDATE migration_sources SET external_source_id=$1 WHERE tenant_id=$2',[digest('unrelated-fixture'),h.tenantOneId]);
 await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenantId,USER]);
 await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[tenantId,jobId]);
 const manifest=createLegacyNormalizationManifest({tenantId,migrationJobId:jobId,sheets:makeSupportedSheets(3)});
 await importLegacyNormalizationManifest({tenantId,migrationJobId:jobId,manifest,runTransaction:h.runTenantTransaction});
 const ready=await prepareLegacyImportReady({tenantId,migrationJobId:jobId,manifest,currentManifest:manifest,comparisonInstant:'2026-08-31T03:00:00.000Z',runTransaction:h.runTenantTransaction});expect(ready.readiness).toBe('READY');
 const row=(await h.database.query<{source_id:string;version:string}>('SELECT s.source_id,j.state_version::text AS version FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1',[jobId])).rows[0];
 const registration={...startRegistration(),tenantId,sourceId:row.source_id};
 const s=intake.createFreezingConsentIntake({tenantId,origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[registration],startRegistration:registration,oauth:{createClient:provider}});
 const issued=await s.issueChallenge(request(),{migrationJobId:jobId,sourceId:row.source_id,expectedStateVersion:row.version});
 expect(issued.startDisplay?.jobSemanticFingerprint).toBe(manifest.sourceFingerprint);expect(issued.startDisplay?.sourceAcquisitionDigest).toBe(manifest.sourceArtifacts.sheets.digest);expect(manifest.sourceFingerprint).not.toBe(manifest.sourceArtifacts.sheets.digest);
 const url=new URL(await s.begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:issued.startDisplay}));nonce=url.searchParams.get('nonce')!;
 const preserved=['migration_jobs','migration_sources','migration_snapshots','operations','padlet_claim_digest_registry','padlet_claim_digest_tombstones'];const before=await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)));
 const handle=await s.complete(new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie}}));
 const live=intake.readVerifiedStartFreezingConsent(handle);expect(live.intent.display).toEqual(issued.startDisplay);expect(live.consent.acquisitionDigest).not.toBe(manifest.sourceArtifacts.sheets.digest);
 expect(await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)))).toEqual(before);
},60000);
it('start relations retain forced RLS, exact durable linkage, immutable update/delete/truncate and cross-tenant invisibility',async()=>{
 const {dispatchStartFreezing}=await import('./startFreezingCeremony');const {callback}=await startBegin();const handle=await startService().complete(callback);
 await dispatchStartFreezing({request:callback,consent:handle,intake:startService(),runTransaction:runner(),adapter:await bridgeAdapter()});
 for(const t of tables.slice(4)){
  expect((await h.database.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1',[t])).rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
  await h.runTenantTransaction(h.tenantTwoId,async tx=>expect((await tx.execute(sql.raw(`SELECT * FROM ${t}`))).rows).toEqual([]));
  for(const statement of [`UPDATE ${t} SET binding=binding`,`DELETE FROM ${t}`,`TRUNCATE ${t}`])await expect(h.database.exec(statement)).rejects.toThrow();
 }
});
it.each(['confirmation-insert','confirmation-readback','confirmation-ack','capture-ack','intent-expiry','registration-drift'])('start %s cannot mint fresh start authority',async kind=>{
 const s=startService();const issued=await s.issueChallenge(request(),intent());let reached=false;let captured=false;
 const run=runner(text=>{
  if(kind==='confirmation-insert'&&text.includes('INSERT INTO migration_start_confirmations')){reached=true;return{rows:[]};}
  if(kind==='confirmation-readback'&&text.includes('SELECT binding FROM migration_start_confirmations')){reached=true;return{rows:[]};}
  if(text.includes('INSERT INTO migration_consent_captures'))captured=true;
  if(kind==='intent-expiry'&&text.includes('clock_timestamp')){reached=true;return{rows:[{ms:String(issued.expiresAt)}]};}
 });
 const uncertain:TenantImportTransactionRunner=async(t,cb)=>{const value=await run(t,cb);if(kind==='confirmation-ack'||(kind==='capture-ack'&&captured)){reached=true;throw Error('COMMIT ACK UNKNOWN');}return value;};
 if(kind.startsWith('confirmation')||kind==='intent-expiry'){
  await expect(startService(uncertain).begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:issued.startDisplay})).rejects.toThrow();expect(reached).toBe(true);expect(calls).toEqual([]);
 }else{
  const url=new URL(await s.begin(request(issued.csrfToken),{challengeId:issued.challengeId,display:issued.startDisplay}));nonce=url.searchParams.get('nonce')!;
  const callback=new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie}});
  const target=kind==='registration-drift'?intake.createFreezingConsentIntake({tenantId:h.tenantOneId,origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[startRegistration()],startRegistration:{...startRegistration(),registrationDigest:digest('replacement')},oauth:{createClient:provider}}):startService(uncertain);
  await expect(target.complete(callback)).rejects.toThrow();if(kind==='capture-ack'){expect(reached).toBe(true);expect((await counts())[3]).toBe(1);}else expect(calls).toEqual([]);
 }
 expect((await counts()).at(-1)).toBe(0);
});

it('SQL and Drizzle agree on column domains, named constraints, checks and foreign-key targets/actions',async()=>{
 const schema=await import('@/server/db/schema/startFreezing');const {getTableConfig}=await import('drizzle-orm/pg-core');
 for(const table of Object.values(schema)){
  const config=getTableConfig(table);
  const columns=(await h.database.query<{column_name:string;udt_name:string;is_nullable:string}>("SELECT column_name,udt_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",[config.name])).rows;
  expect(columns.map(c=>[c.column_name,c.udt_name,c.is_nullable]).sort()).toEqual(config.columns.map(c=>[c.name,c.getSQLType(),c.notNull?'NO':'YES']).sort());
  const constraints=(await h.database.query<{conname:string;contype:string;definition:string;confdeltype:string;confupdtype:string}>("SELECT conname,contype,pg_get_constraintdef(oid) AS definition,confdeltype,confupdtype FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u','f','c')",[config.name])).rows;
  expect(constraints.map(c=>c.conname).sort()).toEqual([...config.primaryKeys.map(c=>c.getName()),...config.uniqueConstraints.map(c=>c.getName()),...config.foreignKeys.map(c=>c.getName()),...config.checks.map(c=>c.name)].sort());
  for(const check of config.checks){
   const expression=new PgDialect().sqlToQuery(check.value).sql.replaceAll(`"${config.name}".`, '');
   await h.database.exec(`ALTER TABLE ${config.name} ADD CONSTRAINT shadow_check CHECK (${expression})`);
   const shadow=(await h.database.query<{definition:string}>("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND conname='shadow_check'",[config.name])).rows[0];
   expect(shadow.definition).toBe(constraints.find(c=>c.conname===check.name)!.definition);
   await h.database.exec(`ALTER TABLE ${config.name} DROP CONSTRAINT shadow_check`);
  }
  for(const fk of config.foreignKeys){const row=constraints.find(c=>c.conname===fk.getName())!;const ref=fk.reference();
   expect(row.confdeltype).toBe('a');expect(row.confupdtype).toBe('a');
   expect(row.definition).toBe(`FOREIGN KEY (${ref.columns.map(c=>c.name).join(', ')}) REFERENCES ${getTableConfig(ref.foreignTable).name}(${ref.foreignColumns.map(c=>c.name).join(', ')})`);
  }
 }
});


it('adds immutable tenant-bound start intent, explicit confirmation and one-dispatch production relations',async()=>{
 for(const t of tables.slice(4))expect((await h.database.query<{name:string|null}>('SELECT to_regclass($1) AS name',[t])).rows[0]?.name).toBe(t);
 const schema=await import('@/server/db/schema');for(const key of ['migrationStartIntents','migrationStartConfirmations','migrationStartDispatches'])expect(key in schema).toBe(true);
});
