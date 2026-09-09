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
it('adds production consent relations and matching schema exports',async()=>{
 for(const t of tables)expect((await h.database.query<{name:string|null}>('SELECT to_regclass($1) AS name',[t])).rows[0]?.name).toBe(t);
 const schema=await import('@/server/db/schema');for(const key of ['migrationConsentChallenges','migrationConsentConfirmations','migrationConsentAttempts','migrationConsentCaptures'])expect(key in schema).toBe(true);
});
it('real signed OAuth, exact workbook capture, cleanup, final commit and private consent without lifecycle mutation',async()=>{
 const preserved=['tenants','migration_jobs','migration_sources','migration_snapshots','users','tenant_memberships','operations','transactions','adjustments','padlet_claim_digest_registry','padlet_claim_digest_tombstones'];
 const original=await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)));
 const before=await h.database.query('SELECT * FROM migration_jobs');const {callback}=await begin();
 const handle=await service().complete(callback);const result=intake.readVerifiedFreezingConsent(handle);
 expect(result).toMatchObject({tenantId:h.tenantOneId,migrationJobId:JOB,sourceId:'sheet',scope:'CONSENT_AND_SHEET_CAPTURE_ONLY'});
 expect(()=>intake.readVerifiedFreezingConsent({...handle})).toThrow();expect(await counts()).toEqual([1,1,1,1]);
 expect(calls.filter(u=>u.endsWith('/token'))).toHaveLength(1);expect(calls.at(-1)).toContain('/revoke');
 expect(await h.database.query('SELECT * FROM migration_jobs')).toEqual(before);
 expect(await Promise.all(preserved.map(t=>h.database.query(`SELECT * FROM ${t}`)))).toEqual(original);
 for(const client of clients)expect(client.credentials).toEqual({});
 await expect(service().complete(callback)).rejects.toThrow('Freezing consent intake refused.');
 expect(calls.filter(u=>u.endsWith('/token'))).toHaveLength(1);
});
it.each(['csrf','origin','session','extra','membership','email','source','semantic','acquisition','preflight','version'])('refuses forged or stale %s before authorization',async kind=>{
 const s=service();const b=await s.issueChallenge(request(),intent());let req=request(b.csrfToken);let input:unknown={challengeId:b.challengeId};
 if(kind==='csrf')req=request('a'.repeat(64));if(kind==='origin')req=request(b.csrfToken,{origin:'https://evil.invalid'});
 if(kind==='session')req=request(b.csrfToken,{cookie:''});if(kind==='extra')input={challengeId:b.challengeId,authorized:true};
 if(kind==='membership')await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[h.tenantOneId]);
 if(kind==='email')await h.database.query("UPDATE users SET canonical_email='other@example.invalid' WHERE id=$1",[USER]);
 if(kind==='source')await h.database.query("UPDATE migration_sources SET external_source_id=$1 WHERE tenant_id=$2",[digest('other'),h.tenantOneId]);
 if(kind==='semantic')await h.database.query('UPDATE migration_jobs SET source_fingerprint=$1 WHERE tenant_id=$2',[digest('other'),h.tenantOneId]);
 if(kind==='acquisition')await h.database.query('UPDATE migration_sources SET source_fingerprint=$1 WHERE tenant_id=$2',[digest('other'),h.tenantOneId]);
 if(kind==='preflight')await h.database.query("INSERT INTO migration_snapshots(tenant_id,job_id,source_id,snapshot_id,phase,artifact_digest,redacted_manifest,row_count) VALUES($1,$2,'sheet','other','PREFLIGHT',$3,'{}',0)",[h.tenantOneId,JOB,digest('other')]);
 if(kind==='version')await h.database.query("UPDATE migration_jobs SET status='FREEZING',state_version=2 WHERE tenant_id=$1",[h.tenantOneId]);
 await expect(s.begin(req,input)).rejects.toThrow();expect(await counts()).toEqual([1,0,0,0]);expect(calls).toEqual([]);
});
it.each(['reservation-insert','reservation-readback','capture-insert','capture-readback','cleanup','post-provider-membership','reservation-ack','final-ack','postlock-ttl'])('fails closed at %s with durable replay tombstone semantics',async kind=>{
 const {issued,callback}=await begin();let commits=0;const visited:string[]=[];
 if(kind==='cleanup')cleanupFail=true;
 if(kind==='post-provider-membership')providerHook=async()=>{await h.database.query('DELETE FROM tenant_memberships WHERE tenant_id=$1',[h.tenantOneId]);};
 let clocks=0;
 const run=runner(text=>{
  visited.push(text);
  if(kind==='reservation-insert'&&text.includes('INSERT INTO migration_consent_attempts'))return{rows:[]};
  if(kind==='reservation-readback'&&text.includes('SELECT binding FROM migration_consent_attempts'))return{rows:[]};
  if(kind==='capture-insert'&&text.includes('INSERT INTO migration_consent_captures'))return{rows:[]};
  if(kind==='capture-readback'&&text.includes('SELECT binding FROM migration_consent_captures'))return{rows:[]};
  if(kind==='postlock-ttl'&&text.includes('clock_timestamp')&&++clocks===2)return{rows:[{ms:String(issued.expiresAt)}]};
 });
 const uncertain:TenantImportTransactionRunner=async(t,cb)=>{const result=await run(t,cb);if(++commits===(kind==='reservation-ack'?1:2))throw Error('ACK lost');return result;};
 await expect(service(kind.endsWith('-ack')?uncertain:run).complete(callback)).rejects.toThrow('Freezing consent intake refused.');
 const expectedAttempt=['reservation-insert','reservation-readback','postlock-ttl'].includes(kind)?0:1;
 expect(await counts()).toEqual([1,1,expectedAttempt,kind==='final-ack'?1:0]);
 if(kind.startsWith('reservation')||kind==='postlock-ttl')expect(calls).toEqual([]);
 if(kind==='capture-insert')expect(visited.some(t=>t.includes('INSERT INTO migration_consent_captures'))).toBe(true);
 if(kind==='capture-readback')expect(visited.some(t=>t.includes('SELECT binding FROM migration_consent_captures'))).toBe(true);
 if(kind==='cleanup')for(const client of clients)expect(client.credentials).toEqual({});
 if(expectedAttempt)await expect(service().complete(callback)).rejects.toThrow();
 expect('recover' in service()).toBe(false);
});
it('enforces forced RLS and immutable update/delete/truncate on retained consent rows',async()=>{
 const {callback}=await begin();await service().complete(callback);
 for(const t of tables){
  const flags=(await h.database.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname=$1',[t])).rows;
  expect(flags).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
  await h.runTenantTransaction(h.tenantTwoId,async tx=>expect((await tx.execute(sql.raw(`SELECT * FROM ${t}`))).rows).toEqual([]));
  for(const statement of [`UPDATE ${t} SET binding=binding`,`DELETE FROM ${t}`,`TRUNCATE ${t}`])await expect(h.database.exec(statement)).rejects.toThrow();
 }
});

it('refuses unsupported retained Settings aliases rather than storing credential-bearing ambiguous acquisition',async()=>{
 const {callback}=await begin();extraTab=' settings ';
 await expect(service().complete(callback)).rejects.toThrow('Freezing consent intake refused.');
 expect(calls.at(-1)).toContain('/revoke');expect(await counts()).toEqual([1,1,1,0]);
});
it.each(['state','extra-query','wrong-tenant','wrong-login','missing-consent'])('rejects callback %s before provider exchange',async kind=>{
 const {issued,callback}=await begin();const url=new URL(callback.url);let headers={cookie};
 if(kind==='state')url.searchParams.set('state',`${issued.challengeId}.${'a'.repeat(64)}`);
 if(kind==='extra-query')url.searchParams.set('tenantId',h.tenantOneId);
 if(kind==='wrong-login'){const r=NextResponse.json({});setGoogleSessionCookie(r,{subject:'owner',email:'owner@example.invalid',issuedAt:Date.now()-1000});headers={cookie:`${GOOGLE_AUTH_COOKIE}=${r.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`};}
 if(kind==='missing-consent'){const b=await service().issueChallenge(request(),intent());url.searchParams.set('state',`${b.challengeId}.${'a'.repeat(64)}`);}
 await expect(service(runner(),kind==='wrong-tenant'?h.tenantTwoId:h.tenantOneId).complete(new Request(url,{headers}))).rejects.toThrow();
 expect(calls).toEqual([]);expect((await counts()).slice(2)).toEqual([0,0]);
});
it.each(['repeatable read','serializable'])('rejects actual unsupported isolation %s before durable issuance',async level=>{
 await h.database.query("SELECT set_config('default_transaction_isolation',$1,false)",[level]);
 const statements:string[]=[];
 await expect(service(runner(t=>{statements.push(t);})).issueChallenge(request(),intent())).rejects.toThrow();
 expect(statements).toHaveLength(1);expect(statements[0]).toContain('transaction_isolation');expect(await counts()).toEqual([0,0,0,0]);
});
it.each(['post-reservation-readback','final-prelock','final-postlock','final-readback','session-final-readback'])('rechecks exact DB TTL/session at %s without minting or final rows',async mode=>{
 const {issued,callback}=await begin();let clocks=0;
 const limit=({'post-reservation-readback':3,'final-prelock':4,'final-postlock':5,'final-readback':6,'session-final-readback':6} as Record<string,number>)[mode];
 await expect(service(runner(t=>t.includes('clock_timestamp')&&++clocks===limit?{rows:[{ms:String(mode==='session-final-readback'?Date.now()+30*24*60*60*1000:issued.expiresAt)}]}:undefined)).complete(callback)).rejects.toThrow();
 expect(clocks).toBe(limit);expect(await counts()).toEqual([1,1,limit===3?0:1,0]);
});
it('detaches scalar intent and actual request headers before the first transaction await; refuses getters',async()=>{
 const input=intent();const req=request();let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});const delayed:TenantImportTransactionRunner=async(t,cb)=>{await gate;return runner()(t,cb);};
 const pending=service(delayed).issueChallenge(req,input);input.sourceId='forged';req.headers.set('cookie','');release();
 expect((await pending).sourceId).toBe('sheet');
 const getter=vi.fn(()=>JOB);const forged={...intent()};Object.defineProperty(forged,'migrationJobId',{enumerable:true,get:getter});
 await expect(service().issueChallenge(request(),forged)).rejects.toThrow();expect(getter).not.toHaveBeenCalled();
});
it('two instances cannot exchange the same callback while the winner is at the provider',async()=>{
 const {callback}=await begin();let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});providerHook=async()=>{entered();await gate;};
 const first=service().complete(callback);await started;
 try{await expect(service().complete(callback)).rejects.toThrow();expect(calls.filter(u=>u.endsWith('/token'))).toHaveLength(1);}finally{release();}
 await first;expect(await counts()).toEqual([1,1,1,1]);
});

it('actual normalizer/importer/READY producer composes with the signed OAuth durable intake',async()=>{
 const {createLegacyNormalizationManifest}=await import('./manifest');
 const {importLegacyNormalizationManifest}=await import('./importer');
 const {prepareLegacyImportReady}=await import('./reconcile');
 const tenantId=h.tenantTwoId;const jobId='40000000-0000-4000-8000-000000000029';
 // The synthetic other-tenant setup must not already own this producer's Sheet.
 await h.database.query('UPDATE migration_sources SET external_source_id=$1 WHERE tenant_id=$2',[digest('unrelated-synthetic-sheet'),h.tenantOneId]);
 await h.database.query("INSERT INTO tenant_memberships(tenant_id,user_id,role) VALUES($1,$2,'OWNER')",[tenantId,USER]);
 await h.database.query("INSERT INTO migration_jobs(tenant_id,job_id,status) VALUES($1,$2,'VALIDATED')",[tenantId,jobId]);
 const manifest=createLegacyNormalizationManifest({tenantId,migrationJobId:jobId,sheets:makeSupportedSheets(3)});
 await importLegacyNormalizationManifest({tenantId,migrationJobId:jobId,manifest,runTransaction:h.runTenantTransaction});
 const ready=await prepareLegacyImportReady({tenantId,migrationJobId:jobId,manifest,currentManifest:manifest,comparisonInstant:'2026-08-31T03:00:00.000Z',runTransaction:h.runTenantTransaction});
 expect(ready.readiness,JSON.stringify(ready.report)).toBe('READY');
 const rows=(await h.database.query<{source_id:string;version:string}>(`SELECT s.source_id,j.state_version::text AS version FROM migration_jobs j JOIN migration_sources s USING(tenant_id,job_id) WHERE j.job_id=$1 AND s.provider='GOOGLE_SHEETS'`,[jobId])).rows;
 expect(rows).toHaveLength(1);
 const s=intake.createFreezingConsentIntake({tenantId,origin:ORIGIN,env,runTransaction:runner(),registeredSheets:[{tenantId,sourceId:rows[0].source_id,spreadsheetId:'sheet-1'}],oauth:{createClient:provider}});
 const issued=await s.issueChallenge(request(),{migrationJobId:jobId,expectedStateVersion:rows[0].version,sourceId:rows[0].source_id});
 expect(issued.jobSemanticFingerprint).toBe(manifest.sourceFingerprint);expect(issued.sourceAcquisitionDigest).toBe(manifest.sourceArtifacts.sheets.digest);
 expect(issued.jobSemanticFingerprint).not.toBe(issued.sourceAcquisitionDigest);
 const url=new URL(await s.begin(request(issued.csrfToken),{challengeId:issued.challengeId}));nonce=url.searchParams.get('nonce')!;
 const before=(await h.database.query('SELECT * FROM migration_snapshots')).rows;
 const handle=await s.complete(new Request(`${ORIGIN}/api/migrations/google-sheets/callback?state=${encodeURIComponent(url.searchParams.get('state')!)}&code=local-code`,{headers:{cookie}}));
 const result=intake.readVerifiedFreezingConsent(handle);expect(result.tenantId).toBe(tenantId);
 const stored=(await h.database.query<{binding:unknown;capture:{sheets:{digest:string};normalization:{manifestDigest:string}}}>('SELECT binding,capture FROM migration_consent_captures WHERE tenant_id=$1',[tenantId])).rows;
 expect(stored).toHaveLength(1);expect(stored[0].binding).toEqual(result);
 expect(stored[0].capture.sheets.digest).toBe(result.acquisitionDigest);expect(stored[0].capture.normalization.manifestDigest).toBe(result.normalizationDigest);
 expect(result.acquisitionDigest).not.toBe(issued.sourceAcquisitionDigest);
 expect((await h.database.query('SELECT * FROM migration_snapshots')).rows).toEqual(before);
},60000);
it('SQL and Drizzle agree on column domains, named constraints, checks and foreign-key targets/actions',async()=>{
 const schema=await import('@/server/db/schema/freezingConsent');const {getTableConfig}=await import('drizzle-orm/pg-core');
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

it.each(['receipt','acquisition'])('rejects corrupted persisted %s readback and rolls back successful consumption',async kind=>{
 const {callback}=await begin();let hit=false;
 const run=runner(text=>{
  if((kind==='receipt'&&text.includes('SELECT binding FROM migration_consent_captures'))||(kind==='acquisition'&&text.includes('SELECT capture FROM migration_consent_captures'))){hit=true;return{rows:[{binding:{forged:true},capture:{forged:true}}]};}
 });
 await expect(service(run).complete(callback)).rejects.toThrow();expect(hit).toBe(true);expect(await counts()).toEqual([1,1,1,0]);
});
it('retains blocked acquisition diagnostics without making them freeze/import authority or leaking hashes in the receipt',async()=>{
 const {callback}=await begin();blockedCapture=true;
 const result=intake.readVerifiedFreezingConsent(await service().complete(callback));
 expect(result.scope).toBe('CONSENT_AND_SHEET_CAPTURE_ONLY');expect(result.status).toBe('BLOCKED');
 expect(JSON.stringify(result)).not.toContain('d'.repeat(64));
 const rows=(await h.database.query<{capture:{normalization:{status:string;blockingConflicts:unknown[];quarantines:unknown[]}}}>('SELECT capture FROM migration_consent_captures')).rows;
 expect(rows[0].capture.normalization.status).toBe('BLOCKED');
 expect(rows[0].capture.normalization.blockingConflicts.length+rows[0].capture.normalization.quarantines.length).toBeGreaterThan(0);
 expect((await h.database.query<{status:string}>("SELECT status FROM migration_jobs WHERE tenant_id=$1",[h.tenantOneId])).rows[0].status).toBe('READY');
});
it('database refuses JSON null/binding identity mismatches and successful rows without an acknowledged attempt',async()=>{
 const b=await service().issueChallenge(request(),intent());
 const original=(await h.database.query<{binding:Record<string,unknown>}>('SELECT binding FROM migration_consent_challenges')).rows[0].binding;
 const id='50000000-0000-4000-8000-000000000019';
 for(const binding of [null,{}, {...original,challengeId:id,sessionBinding:null},{...original,challengeId:id,tenantId:null}]){
  await expect(h.database.query('INSERT INTO migration_consent_challenges(tenant_id,challenge_id,job_id,source_id,actor_user_id,binding) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[h.tenantOneId,id,JOB,'sheet',USER,JSON.stringify(binding)])).rejects.toThrow();
 }
 await expect(h.database.query("INSERT INTO migration_consent_captures(tenant_id,challenge_id,binding,capture) VALUES($1,$2,$3::jsonb,'{}')",[h.tenantOneId,b.challengeId,JSON.stringify({purpose:'CLASS_STORE_FREEZING_CONSENT_V1',tenantId:h.tenantOneId,challengeId:b.challengeId,scope:'CONSENT_AND_SHEET_CAPTURE_ONLY',captureDigest:digest('forged')})])).rejects.toThrow();
 expect(await counts()).toEqual([1,0,0,0]);
});
