// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import { createPgliteDatabaseHarness, type PgliteDatabaseHarness } from '@/server/db/testing/pglite';
import type { TenantImportTransactionRunner } from './importer';
import * as handlers from './freezingConsentHandlers';
import { createTenantApiDispatcher } from '@/server/tenantApiDispatcher';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import { google } from 'googleapis';
import { makeSheets, makeSupportedSheets } from './__fixtures__/normalization';
vi.mock('server-only', () => ({}));
vi.mock('./freezingConsentProduction', async importOriginal => {const actual=await importOriginal<typeof import('./freezingConsentProduction')>();return {...actual,getProductionFreezingConsentHandlers:()=>useProductionFactory?actual.getProductionFreezingConsentHandlers():api()};});
vi.mock('@/server/db/client',()=>({getDatabaseClient:()=>({pool:{connect:()=>h.runtimePool.connect(),query:async(text:string,values:unknown[])=>{const c=await h.runtimePool.connect();await c.query('BEGIN');try{const r=await c.query(text,values);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}}})}));
const OriginalOAuth2 = google.auth.OAuth2;
let useProductionFactory=false;
const ORIGIN='https://store.example';
const env={AUTH_SECRET:'synthetic-auth-secret-with-at-least-32-characters',MIGRATION_GOOGLE_CLIENT_ID:'migration.apps.googleusercontent.com',MIGRATION_GOOGLE_CLIENT_SECRET:'local-client-secret',MIGRATION_GOOGLE_OAUTH_ORIGIN:ORIGIN};
const USER='20000000-0000-4000-8000-000000000019';
const JOB='40000000-0000-4000-8000-000000000019';
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
const tables=['migration_consent_challenges','migration_consent_confirmations','migration_consent_attempts','migration_consent_captures'];
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
  useProductionFactory=false;
  await h.database.exec('GRANT EXECUTE ON FUNCTION public.platform_find_tenant_by_slug(text) TO app_runtime');
  calls=[];active=0;nonce='';cleanupFail=false;extraTab='';blockedCapture=false;clients=[];providerHook=async()=>{};
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('live network forbidden');}));
},60000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();await h?.close();});
function request(token?:string,headers:Record<string,string>={}){return new Request(`${ORIGIN}/internal`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...(token?{'x-csrf-token':token}:{}),...headers}});}
function provider(){
 const client=new OriginalOAuth2(env.MIGRATION_GOOGLE_CLIENT_ID,env.MIGRATION_GOOGLE_CLIENT_SECRET,`${ORIGIN}/api/migrations/google-sheets/callback`);
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

function api(){return handlers.createFreezingConsentHandlers({origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[{tenantId:h.tenantOneId,sourceId:'sheet',spreadsheetId:'sheet-1'}],oauth:{createClient:provider},directory:{findBySlug:async(slug:string)=>{const rows=(await h.database.query<{id:string;slug:string;display_name:string;lifecycle:'IMPORTING'}>('SELECT * FROM tenants WHERE slug=$1',[slug])).rows;return rows[0]?{id:rows[0].id,slug:rows[0].slug,displayName:rows[0].display_name,lifecycle:rows[0].lifecycle,timezone:'Asia/Seoul' as const}:null;}}});}
async function dispatch(req:Request,job=JOB){
 const a=api();const tenant=(await h.database.query<{slug:string}>('SELECT slug FROM tenants WHERE id=$1',[h.tenantOneId])).rows[0];
 return createTenantApiDispatcher({findBySlug:async()=>({id:h.tenantOneId,slug:tenant.slug,displayName:'local',lifecycle:'IMPORTING',timezone:'Asia/Seoul'}),getSession:()=>null,findByTenantAndSubject:async()=>null},[
 {method:'POST',pattern:'migrations/[jobId]/freezing/consent/challenge',access:'public',handler:a.challenge},
 {method:'POST',pattern:'migrations/[jobId]/freezing/consent',access:'public',handler:a.begin},
 ])(req,{slug:tenant.slug,path:['migrations',job,'freezing','consent',...(new URL(req.url).pathname.endsWith('/challenge')?['challenge']:[])]});
}
async function post(body:unknown,suffix='/challenge',headers:Record<string,string>={},job=JOB){const slug=(await h.database.query<{slug:string}>('SELECT slug FROM tenants WHERE id=$1',[h.tenantOneId])).rows[0].slug;return dispatch(new Request(`${ORIGIN}/api/c/${slug}/migrations/${job}/freezing/consent${suffix}`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)}),job);}
async function ceremony(){const issuedResponse=await post({expectedStateVersion:'1',sourceId:'sheet'});expect(issuedResponse.status).toBe(200);const issued=await issuedResponse.json();const routing=issuedResponse.headers.get('set-cookie')!.split(';')[0];const response=await post({challengeId:issued.challengeId},'',{cookie:`${cookie}; ${routing}`,'x-csrf-token':issued.csrfToken});expect(response.status).toBe(200);const body=await response.json();const url=new URL(body.authorizationUrl);nonce=url.searchParams.get('nonce')!;return{issued,response,callback:new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie:`${cookie}; ${response.headers.get('set-cookie')!.split(';')[0]}`}})};}
it('canonical dispatcher delivers session CSRF no-store and composes actual signed OAuth/workbook/SQL without HTTP capability',async()=>{
 const before=(await h.database.query('SELECT * FROM migration_jobs')).rows;const {issued,callback}=await ceremony();
 const response=await api().callback(callback);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');const body=await response.json();expect(body).toEqual({challengeId:issued.challengeId,status:'CAPTURED',scope:'CONSENT_AND_SHEET_CAPTURE_ONLY'});
 const rows=(await h.database.query<{binding:{challengeId:string};capture:unknown}>('SELECT * FROM migration_consent_captures')).rows;expect(rows).toHaveLength(1);expect(rows[0].binding.challengeId).toBe(issued.challengeId);expect(rows[0].capture).toBeTruthy();expect((await h.database.query('SELECT * FROM migration_jobs')).rows).toEqual(before);expect(calls.at(-1)).toContain('/revoke');for(const client of clients)expect(client.credentials).toEqual({});expect((await api().callback(callback)).status).toBe(403);
});
it.each(['unscoped','origin','fetch-site','query','compat','nonmember','extra-body'])('challenge rejects %s with no-store before issuance',async mode=>{
 let response:Response;
 if(mode==='unscoped')response=await api().challenge(request(),{params:Promise.resolve({jobId:JOB})});
 else{if(mode==='nonmember')await h.database.query('DELETE FROM tenant_memberships');response=await post({expectedStateVersion:'1',sourceId:'sheet',...(mode==='extra-body'?{tenantId:h.tenantOneId}:{})},mode==='query'?'/challenge?tenantId=bad':'/challenge',mode==='origin'?{origin:'https://evil.invalid'}:mode==='fetch-site'?{'sec-fetch-site':'cross-site'}:mode==='compat'?{cookie:'class_store_tenant_admin=synthetic'}:{});}
 expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toBe('no-store');expect((await h.database.query('SELECT * FROM migration_consent_challenges')).rows).toHaveLength(0);expect(calls).toEqual([]);
});
it('CSRF delivery is noncacheable and routing cookie is confidential, API-path scoped, HttpOnly Secure SameSite=Lax',async()=>{const r=await post({expectedStateVersion:'1',sourceId:'sheet'});expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');expect(r.headers.get('referrer-policy')).toBe('no-referrer');const c=r.headers.get('set-cookie')!;expect(c).toContain('HttpOnly');expect(c).toContain('Secure');expect(c).toContain('SameSite=Lax');expect(c).toContain('Path=/api/');expect(c).not.toContain(h.tenantOneId);expect(c).not.toContain('sheet-1');});
it.each(['absent','forged','tenant-query','duplicate-scope','wrong-login','expired-session','membership','wrong-path','error'])('callback rejects %s without provider exchange or secrets',async mode=>{const {callback}=await ceremony();const u=new URL(callback.url);const headers=new Headers(callback.headers);
 if(mode==='absent')headers.set('cookie',cookie);if(mode==='forged')headers.set('cookie',`${cookie}; ${handlers.FREEZING_ROUTING_COOKIE}=forged`);
 if(mode==='tenant-query')u.searchParams.set('tenantId',h.tenantOneId);if(mode==='duplicate-scope'){u.searchParams.append('scope','email');u.searchParams.append('scope','openid');}
 if(mode==='wrong-login'||mode==='expired-session'){const r=NextResponse.json({});setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()-(mode==='expired-session'?31*86400000:5000)});headers.set('cookie',headers.get('cookie')!.replace(cookie,`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`));}
 if(mode==='membership')await h.database.query('DELETE FROM tenant_memberships');if(mode==='wrong-path')u.pathname='/api/other';if(mode==='error'){u.searchParams.delete('code');u.searchParams.set('error','access_denied');u.searchParams.set('error_description','local-code local-access-token');}
 const r=await api().callback(new Request(u,{headers}));expect(r.status).toBe(403);expect(r.headers.get('cache-control')).toBe('no-store');expect(await r.text()).toBe(JSON.stringify({error:'Freezing consent refused.'}));expect(calls).toEqual([]);
});
it('singleton Google scope/authuser/prompt callback extras are ignored only after exact allowlist validation',async()=>{const {callback}=await ceremony();const u=new URL(callback.url);u.searchParams.set('scope','openid email');u.searchParams.set('authuser','0');u.searchParams.set('prompt','consent');expect((await api().callback(new Request(u,{headers:callback.headers}))).status).toBe(200);});
it('begin rejects cross-job challenge even with real session CSRF and authentic routing cookie',async()=>{const issuedResponse=await post({expectedStateVersion:'1',sourceId:'sheet'});const issued=await issuedResponse.json();const response=await post({challengeId:issued.challengeId},'',{cookie:`${cookie}; ${issuedResponse.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':issued.csrfToken},'another-job');expect(response.status).toBe(403);expect((await h.database.query('SELECT * FROM migration_consent_confirmations')).rows).toHaveLength(0);});

it('actual canonical route exports and fixed callback run the real handler service chain',async()=>{
 const scoped=await import('@/app/api/c/[slug]/[...path]/route');
 const fixed=await import('@/app/api/migrations/google-sheets/callback/route');
 const unscoped=await import('@/app/api/migrations/[jobId]/freezing/consent/route');
 const slug=(await h.database.query<{slug:string}>('SELECT slug FROM tenants WHERE id=$1',[h.tenantOneId])).rows[0].slug;
 async function call(suffix:string,body:unknown,headers:Record<string,string>={}){const path=['migrations',JOB,'freezing','consent',...(suffix?['challenge']:[])];return scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)}),{params:Promise.resolve({slug,path})});}
 const issuance=await call('challenge',{expectedStateVersion:'1',sourceId:'sheet'});expect(issuance.status).toBe(200);const issued=await issuance.json();
 const started=await call('',{challengeId:issued.challengeId},{cookie:`${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':issued.csrfToken});expect(started.status).toBe(200);const url=new URL((await started.json()).authorizationUrl);nonce=url.searchParams.get('nonce')!;
 const response=await fixed.GET(new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code`,{headers:{cookie:`${cookie}; ${started.headers.get('set-cookie')!.split(';')[0]}`}}));expect(response.status).toBe(200);expect((await h.database.query('SELECT * FROM migration_consent_captures')).rows).toHaveLength(1);
 expect((await unscoped.POST(request(),{params:Promise.resolve({jobId:JOB})})).status).toBe(403);
});
it('provider denial consumes the bound attempt without exchange so a later success callback cannot revive it',async()=>{const {callback}=await ceremony();const u=new URL(callback.url);u.searchParams.delete('code');u.searchParams.set('error','access_denied');expect((await api().callback(new Request(u,{headers:callback.headers}))).status).toBe(403);expect((await h.database.query('SELECT * FROM migration_consent_attempts')).rows).toHaveLength(1);expect((await api().callback(callback)).status).toBe(403);expect(calls).toEqual([]);});

it('production factory plus actual routes consumes real normalization/import/READY via restricted SQL and signed provider transport',async()=>{
 const {createLegacyNormalizationManifest}=await import('./manifest');const {importLegacyNormalizationManifest}=await import('./importer');const {prepareLegacyImportReady}=await import('./reconcile');
 const tenantId=h.tenantTwoId;const jobId='40000000-0000-4000-8000-000000000029';
 await h.database.query('UPDATE migration_sources SET external_source_id=$1 WHERE tenant_id=$2',[digest('unrelated-synthetic-sheet'),h.tenantOneId]);
 await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenantId,USER]);await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[tenantId,jobId]);
 const manifest=createLegacyNormalizationManifest({tenantId,migrationJobId:jobId,sheets:makeSupportedSheets(3)});await importLegacyNormalizationManifest({tenantId,migrationJobId:jobId,manifest,runTransaction:h.runTenantTransaction});
 const ready=await prepareLegacyImportReady({tenantId,migrationJobId:jobId,manifest,currentManifest:manifest,comparisonInstant:'2026-08-31T03:00:00.000Z',runTransaction:h.runTenantTransaction});expect(ready.readiness).toBe('READY');
 const rows=(await h.database.query<{source_id:string;version:string;slug:string}>(`SELECT s.source_id,j.state_version::text AS version,t.slug FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) JOIN tenants t ON t.id=j.tenant_id WHERE j.job_id=$1 AND s.provider='GOOGLE_SHEETS'`,[jobId])).rows;expect(rows).toHaveLength(1);
 for(const [k,v] of Object.entries(env))vi.stubEnv(k,v);vi.stubEnv('CLASS_STORE_STORAGE','postgresql');vi.stubEnv('MIGRATION_GOOGLE_SHEET_REGISTRATIONS',JSON.stringify([{tenantId,sourceId:rows[0].source_id,spreadsheetId:'sheet-1'}]));
 // Only installed SDK construction to attach the local provider transport; all
 // signature/tokeninfo/workbook/capture/normalizer and factory/SQL code is real.
 vi.spyOn(google.auth,'OAuth2').mockImplementation(function(){return provider();} as never);useProductionFactory=true;
 const scoped=await import('@/app/api/c/[slug]/[...path]/route');const fixed=await import('@/app/api/migrations/google-sheets/callback/route');const slug=rows[0].slug;
 async function call(challenge:boolean,body:unknown,headers:Record<string,string>={}){const path=['migrations',jobId,'freezing','consent',...(challenge?['challenge']:[])];return scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...headers},body:JSON.stringify(body)}),{params:Promise.resolve({slug,path})});}
 const issuance=await call(true,{expectedStateVersion:rows[0].version,sourceId:rows[0].source_id});expect(issuance.status).toBe(200);const issued=await issuance.json();expect(issued.jobSemanticFingerprint).toBe(manifest.sourceFingerprint);expect(issued.sourceAcquisitionDigest).toBe(manifest.sourceArtifacts.sheets.digest);expect(issued.jobSemanticFingerprint).not.toBe(issued.sourceAcquisitionDigest);
 const started=await call(false,{challengeId:issued.challengeId},{cookie:`${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`,'x-csrf-token':issued.csrfToken});expect(started.status).toBe(200);const url=new URL((await started.json()).authorizationUrl);nonce=url.searchParams.get('nonce')!;
 const preserved=['tenants','migration_jobs','migration_sources','migration_snapshots','operations','transactions','padlet_claim_digest_registry','padlet_claim_digest_tombstones'];const before=await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)));
 const response=await fixed.GET(new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${url.searchParams.get('state')}&code=local-code&scope=openid%20email&authuser=0&prompt=consent`,{headers:{cookie:`${cookie}; ${started.headers.get('set-cookie')!.split(';')[0]}`}}));expect(response.status).toBe(200);expect(await response.json()).toEqual({challengeId:issued.challengeId,status:'CAPTURED',scope:'CONSENT_AND_SHEET_CAPTURE_ONLY'});
 const stored=(await h.database.query<{binding:{acquisitionDigest:string;normalizationDigest:string};capture:{sheets:{digest:string};normalization:{manifestDigest:string}}}>('SELECT binding,capture FROM migration_consent_captures WHERE tenant_id=$1',[tenantId])).rows;expect(stored).toHaveLength(1);expect(stored[0].binding.acquisitionDigest).toBe(stored[0].capture.sheets.digest);expect(stored[0].binding.normalizationDigest).toBe(stored[0].capture.normalization.manifestDigest);expect(stored[0].binding.acquisitionDigest).not.toBe(issued.sourceAcquisitionDigest);expect(await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)))).toEqual(before);expect(calls.at(-1)).toContain('/revoke');for(const c of clients)expect(c.credentials).toEqual({});
},60000);

function ingressStream(chunks: Uint8Array[]) {
  const stats = { pulls: 0, bytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[stats.pulls++];
      if (!chunk) { controller.close(); return; }
      stats.bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() { stats.cancelled = true; },
  }, { highWaterMark: 0 });
  return { stream, stats };
}

it('canonical ingress cancels overflow at the byte threshold before consent service or SQL entry', async () => {
  const scoped = await import('@/app/api/c/[slug]/[...path]/route');
  const intake = await import('./freezingConsentIntake');
  const slug = 'transaction-tenant-one';
  const issuance = await post({ expectedStateVersion: '1', sourceId: 'sheet' });
  expect(issuance.status).toBe(200);
  const issued = await issuance.json();
  const authenticatedCookie = `${cookie}; ${issuance.headers.get('set-cookie')!.split(';')[0]}`;
  const service = vi.spyOn(intake, 'createFreezingConsentIntake');
  const transaction = vi.spyOn(h, 'runTenantTransaction');
  const connect = vi.spyOn(h.runtimePool, 'connect');
  for (const challenge of [true, false]) for (const authenticated of [true, false]) {
    for (const length of [undefined, '1', '8388608']) for (const chunkSize of [1024, 4097, 65536]) {
      service.mockClear(); transaction.mockClear(); connect.mockClear();
      const path = ['migrations', JOB, 'freezing', 'consent', ...(challenge ? ['challenge'] : [])];
      const { stream, stats } = ingressStream(Array.from({ length: 128 }, () => new Uint8Array(chunkSize)));
      const headers: Record<string, string> = { origin: ORIGIN, 'content-type': 'application/json',
        ...(authenticated ? { cookie: authenticatedCookie, 'x-csrf-token': issued.csrfToken } : {}),
        ...(length === undefined ? {} : { 'content-length': length }) };
      const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body: stream, duplex: 'half' };
      const response = await scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`, init), { params: Promise.resolve({ slug, path }) });
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'Freezing consent refused.' });
      expect(service).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect.soft(connect).not.toHaveBeenCalled();
      expect.soft(stats, JSON.stringify({ challenge, authenticated, length, chunkSize, stats })).toEqual({
        pulls: Math.floor(4096 / chunkSize) + 1,
        bytes: (Math.floor(4096 / chunkSize) + 1) * chunkSize,
        cancelled: true,
      });
    }
  }
  expect(calls).toEqual([]);
});

it('canonical ingress accepts exact 4096-byte streamed challenge and consent bodies without trusting length', async () => {
  const scoped = await import('@/app/api/c/[slug]/[...path]/route');
  const slug = 'transaction-tenant-one';
  let routing = ''; let csrfToken = ''; let challengeId = '';
  for (const challenge of [true, false]) {
    const value = JSON.stringify(challenge ? { expectedStateVersion: '1', sourceId: 'sheet' } : { challengeId });
    const bytes = new TextEncoder().encode(value.padEnd(4096, ' '));
    expect(bytes.byteLength).toBe(4096);
    const { stream, stats } = ingressStream([bytes.slice(0, 1024), bytes.slice(1024)]);
    const path = ['migrations', JOB, 'freezing', 'consent', ...(challenge ? ['challenge'] : [])];
    const init: RequestInit & { duplex: 'half' } = { method: 'POST', duplex: 'half', body: stream,
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'content-length': '1',
        cookie: `${cookie}${routing ? `; ${routing}` : ''}`, ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}) } };
    const response = await scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`, init), { params: Promise.resolve({ slug, path }) });
    expect(response.status).toBe(200);
    expect(stats.bytes).toBe(4096);
    const result = await response.json();
    if (challenge) { challengeId = result.challengeId; csrfToken = result.csrfToken; routing = response.headers.get('set-cookie')!.split(';')[0]; }
    else expect(new URL(result.authorizationUrl).searchParams.get('state')).toBeTruthy();
  }
  expect((await h.database.query('SELECT * FROM migration_consent_confirmations')).rows).toHaveLength(1);
  expect(calls).toEqual([]);
});

it('canonical ingress leaves ordinary login body rewriting and request metadata unchanged', async () => {
  const scoped = await import('@/app/api/c/[slug]/[...path]/route');
  const login = await import('@/app/api/admin/login/route');
  const text = JSON.stringify({ password: 'x'.repeat(8192) });
  const handler = vi.spyOn(login, 'POST').mockImplementation(async request => {
    expect(request.url).toBe(`${ORIGIN}/api/admin/login?ordinary=1`);
    expect(request.headers.get('cookie')).toBe(cookie);
    expect(request.headers.get('origin')).toBe(ORIGIN);
    expect(request.redirect).toBe('manual');
    expect(await request.text()).toBe(text);
    return Response.json({ ordinary: true });
  });
  const { stream, stats } = ingressStream([new TextEncoder().encode(text)]);
  const slug = 'transaction-tenant-one'; const path = ['admin', 'login'];
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half', redirect: 'manual',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } };
  const response = await scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/admin/login?ordinary=1`, init), { params: Promise.resolve({ slug, path }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ordinary: true });
  expect(handler).toHaveBeenCalledOnce();
  expect(stats.bytes).toBe(new TextEncoder().encode(text).byteLength);
});

it('canonical unknown tenant challenge failures are also no-store and generic',async()=>{const scoped=await import('@/app/api/c/[slug]/[...path]/route');const path=['migrations',JOB,'freezing','consent','challenge'];const r=await scoped.POST(new Request(`${ORIGIN}/api/c/unknown/${path.join('/')}`,{method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({expectedStateVersion:'1',sourceId:'sheet'})}),{params:Promise.resolve({slug:'unknown',path})});expect(r.status).toBe(403);expect(r.headers.get('cache-control')).toBe('no-store');expect(await r.json()).toEqual({error:'Freezing consent refused.'});expect(calls).toEqual([]);});
it.each(['csrf','wrong-tenant','duplicate-cookie','cookie-expiry','query','oversized-body'])('begin transport refuses %s before confirmation',async mode=>{const r=await post({expectedStateVersion:'1',sourceId:'sheet'});const b=await r.json();const routing=r.headers.get('set-cookie')!.split(';')[0];let routeCookie=routing;
 if(mode==='duplicate-cookie')routeCookie+=`; ${routing}`;if(mode==='cookie-expiry')vi.spyOn(Date,'now').mockReturnValue(b.expiresAt);
 const headers={cookie:`${cookie}; ${routeCookie}`,'x-csrf-token':mode==='csrf'?'f'.repeat(64):b.csrfToken};let result:Response;
 if(mode==='wrong-tenant'){const scoped=await import('@/app/api/c/[slug]/[...path]/route');const slug='transaction-tenant-two';const path=['migrations',JOB,'freezing','consent'];result=await scoped.POST(new Request(`${ORIGIN}/api/c/${slug}/${path.join('/')}`,{method:'POST',headers:{...headers,origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({challengeId:b.challengeId})}),{params:Promise.resolve({slug,path})});}
 else result=await post({challengeId:mode==='oversized-body'?'a'.repeat(5000):b.challengeId},mode==='query'?'?tenant=bad':'',headers);
 expect(result.status).toBe(403);expect(result.headers.get('cache-control')).toBe('no-store');expect((await h.database.query('SELECT * FROM migration_consent_confirmations')).rows).toHaveLength(0);
});
it.each(['directory-remap','duplicate-state','code-and-error','orphan-error-description','duplicate-code'])('callback refuses %s before provider',async mode=>{const {callback}=await ceremony();const u=new URL(callback.url);if(mode==='directory-remap')await h.database.query("UPDATE tenants SET slug='renamed' WHERE id=$1",[h.tenantOneId]);if(mode==='duplicate-state')u.searchParams.append('state',u.searchParams.get('state')!);if(mode==='code-and-error')u.searchParams.set('error','access_denied');if(mode==='orphan-error-description')u.searchParams.set('error_description','local-code');if(mode==='duplicate-code')u.searchParams.append('code','other');const r=await api().callback(new Request(u,{headers:callback.headers}));expect(r.status).toBe(403);expect(r.headers.get('set-cookie')).toContain('Max-Age=0');expect(calls).toEqual([]);});
it.each(['membership','session-expiry','cleanup'])('handler-to-service post-provider %s never exposes credentials or persists success',async mode=>{const {issued,callback}=await ceremony();if(mode==='cleanup')cleanupFail=true;else providerHook=async()=>{if(mode==='membership')await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[h.tenantOneId]);else vi.spyOn(Date,'now').mockReturnValue(issued.expiresAt+31*86400000);};const r=await api().callback(callback);expect(r.status).toBe(403);expect(await r.text()).toBe(JSON.stringify({error:'Freezing consent refused.'}));expect(calls.some(u=>u.endsWith('/token'))).toBe(true);expect(calls.at(-1)).toContain('/revoke');expect((await h.database.query('SELECT * FROM migration_consent_captures')).rows).toHaveLength(0);for(const client of clients)expect(client.credentials).toEqual({});});
