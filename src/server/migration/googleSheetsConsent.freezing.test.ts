// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import nodeFetch, { Response as FetchResponse, type RequestInit } from 'node-fetch';
import { createServer } from 'node:http';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { Gaxios } from 'gaxios';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { createGoogleWorkbookSnapshotReader } from './googleWorkbookSnapshotReader';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { google } from 'googleapis';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { withVerifiedFreezingAuthorization, createFreezingConsentUrl } from './googleSheetsConsent';
vi.mock('server-only', () => ({}));
const env = { AUTH_SECRET:'local-test-only-secret-value-000000000000', MIGRATION_GOOGLE_CLIENT_ID:'migration.apps.googleusercontent.com', MIGRATION_GOOGLE_CLIENT_SECRET:'local-client-secret', MIGRATION_GOOGLE_OAUTH_ORIGIN:'https://store.example' };
const {privateKey,publicKey} = generateKeyPairSync('rsa',{modulusLength:2048});
const access = 'local-access-token';
export function providerFixture(overrides: Record<string,unknown> = {}, infoOverrides: Record<string,unknown> = {}, tokenOverrides: Record<string,unknown> = {}) {
  const now = Math.floor(Date.now()/1000);
  const claims = {iss:'https://accounts.google.com',aud:env.MIGRATION_GOOGLE_CLIENT_ID,azp:env.MIGRATION_GOOGLE_CLIENT_ID,sub:'owner',email:'owner@example.invalid',email_verified:true,iat:now,exp:now+300,nonce:'nonce-for-freezing-only',at_hash:createHash('sha256').update(access).digest().subarray(0,16).toString('base64url'),...overrides};
  const unsigned = [Buffer.from(JSON.stringify({alg:'RS256',kid:'local-key'})).toString('base64url'),Buffer.from(JSON.stringify(claims)).toString('base64url')].join('.');
  const idToken = `${unsigned}.${sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')}`;
  const client = new google.auth.OAuth2(env.MIGRATION_GOOGLE_CLIENT_ID,env.MIGRATION_GOOGLE_CLIENT_SECRET,'https://store.example/api/migrations/google-sheets/callback');
  const calls: string[] = [];
  const source=makeSupportedSheets(3);
  const transport = vi.fn(async (options: {url: string | URL;headers?:Headers;responseType?:string}) => {
    const url = String(options.url); calls.push(url);
    let data: unknown;
    if(url.includes('/tokeninfo')) data={aud:env.MIGRATION_GOOGLE_CLIENT_ID,sub:'owner',email:'owner@example.invalid',email_verified:'true',expires_in:300,scope:'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.file',...infoOverrides};
    else if(url.endsWith('/token')) data={access_token:access,id_token:idToken,expires_in:300,token_type:'Bearer',...tokenOverrides};
    else if(url.includes('/certs')) data={'local-key':publicKey.export({type:'spki',format:'pem'})};
    else if(url.includes('/revoke')) data={};
    else if(url.includes('/drive/v3/files/')) data={id:'sheet-1',mimeType:'application/vnd.google-apps.spreadsheet',trashed:false,version:'42'};
    else if(url.includes('/values/')) {const name=decodeURIComponent(new URL(url).pathname.split('/values/')[1]).slice(1,-1).replace(/''/g,"'");const tab=source.tabs[name];data={values:[tab.headers,...tab.rows.map(r=>r.cells)]};}
    else if(url.includes('/v4/spreadsheets/sheet-1')) data={spreadsheetId:'sheet-1',sheets:Object.keys(source.tabs).map((title,sheetId)=>({properties:{title,sheetId,sheetType:'GRID',gridProperties:{rowCount:100,columnCount:100}}}))};
    else throw Error('Unexpected Google I/O');
    if(url.includes('/drive/')||url.includes('/v4/')) {expect(options.headers?.get('authorization')).toBe(`Bearer ${access}`);data=Readable.from([JSON.stringify(data)]);}
    if(options.responseType==='stream'&&!(data instanceof Readable))data=Readable.from([JSON.stringify(data)]);
    return {data,headers:new Headers({'cache-control':'max-age=300'}),status:200,statusText:'OK',config:options};
  });
  client.transporter.request = transport as never;
  const clear = vi.spyOn(client,'setCredentials');
  return {client,calls,clear,transport,env};
}
afterEach(() => vi.unstubAllGlobals());
it('fresh consent requests isolated online identity + resource scopes and exact nonce',() => {
  const url=new URL(createFreezingConsentUrl('https://store.example','state-for-freezing','nonce-for-freezing-only',env));
  expect(url.searchParams.get('nonce')).toBe('nonce-for-freezing-only');
  expect(url.searchParams.get('scope')?.split(' ')).toEqual(['https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.file','openid','email']);
  expect(url.searchParams.get('prompt')).toBe('consent');
  expect(url.searchParams.get('access_type')).toBe('online');
  expect(url.searchParams.get('include_granted_scopes')).toBe('false');
});
it('real OAuth exchange/signature verification/tokeninfo reaches capture and revokes then clears',async () => {
  const p=providerFixture(); const capture=vi.fn(async () => 'captured');
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).resolves.toBe('captured');
  expect(capture).toHaveBeenCalledOnce(); expect(p.calls.some(c=>c.includes('/certs'))).toBe(true);
  for(const [options] of p.transport.mock.calls)expect(options).toMatchObject({retry:false,maxRedirects:0,timeout:10_000});
  expect(p.calls.some(c=>c.includes('/revoke'))).toBe(true); expect(p.clear).toHaveBeenLastCalledWith({});
});
it.each([
  ['issuer',{iss:'https://evil.invalid'},{}],['audience',{aud:'login-client'},{}],['authorized party',{azp:'generator-client'},{}],
  ['nonce',{nonce:'other'},{}],['subject',{sub:'other'},{}],['email verification',{email_verified:false},{}],
  ['expiry',{exp:1},{}],['token pair',{at_hash:'unrelated'},{}],['access client',{}, {aud:'generator-client'}],
  ['access subject',{}, {sub:'other'}],['resource scopes',{}, {scope:'openid email'}],['access expiry',{}, {expires_in:0}],
])('refuses wrong %s before capture and cleans exchanged tokens',async (_label,claims,info) => {
  const p=providerFixture(claims,info); const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(capture).not.toHaveBeenCalled(); expect(p.calls.some(c=>c.includes('/revoke'))).toBe(true);expect(p.clear).toHaveBeenLastCalledWith({});
});
it('capture errors are redacted but cleanup still occurs',async () => {
  const p=providerFixture();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},async () => {throw Error('local-access-token secret');},{env,createClient:()=>p.client})).rejects.toThrow(/^Freezing OAuth refused\.$/);
  expect(p.clear).toHaveBeenLastCalledWith({});
});
it('actual verified OAuth client reads the exact Sheet without refreshing even inside the default eager-refresh window',async()=>{
  const p=providerFixture({}, {}, {refresh_token:'local-refresh-token'});
  const snapshot=await withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},async authorization=>{
    expect(p.client.credentials.refresh_token).toBeUndefined();
    return captureSheetsSnapshot({spreadsheetId:'sheet-1',capturedAt:new Date().toISOString(),reader:createGoogleWorkbookSnapshotReader(authorization,'sheet-1')});
  },{env,createClient:()=>p.client});
  expect(createLegacyNormalizationManifest({tenantId:'10000000-0000-4000-8000-000000000001',migrationJobId:'40000000-0000-4000-8000-000000000001',sheets:snapshot}).status).toBe('READY_FOR_IMPORT');
  expect(p.calls.filter(url=>url.endsWith('/token'))).toHaveLength(1);
  expect(p.calls.filter(url=>url.includes('/drive/v3/'))).toHaveLength(4);
  expect(p.calls.at(-1)).toContain('/revoke');expect(p.clear).toHaveBeenLastCalledWith({});
});
it.each([{id_token:undefined},{access_token:undefined},{expires_in:undefined},{expires_in:0}])('missing token material fails closed and clears %j',async tokens=>{
  const p=providerFixture({}, {}, {...tokens,refresh_token:'local-refresh-token'});const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow(/^Freezing OAuth refused\.$/);
  expect(capture).not.toHaveBeenCalled();expect(p.calls.at(-1)).toContain('/revoke');expect(p.clear).toHaveBeenLastCalledWith({});
});
it.each([{expires_in:undefined},{expires_in:'NaN'},{expires_in:Infinity},{azp:'generator-client'}])('rejects malformed used-token expiry or presenter %j',async info=>{
  const p=providerFixture({},info);const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow(/^Freezing OAuth refused\.$/);
  expect(capture).not.toHaveBeenCalled();expect(p.clear).toHaveBeenLastCalledWith({});
});
it('compares canonicalized verified email while preserving exact subject',async()=>{
  const p=providerFixture({email:'Owner@Example.Invalid'});
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},async()=>true,{env,createClient:()=>p.client})).resolves.toBe(true);
});
it.each(['openid', 'email'])('rejects absent identity scope %s despite valid signed identity', async missing => {
  const scope=['openid','email','https://www.googleapis.com/auth/spreadsheets.readonly','https://www.googleapis.com/auth/drive.file'].filter(s=>s!==missing).join(' ');
  const p=providerFixture({}, {scope});const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(capture).not.toHaveBeenCalled();expect(p.calls.at(-1)).toContain('/revoke');expect(p.client.credentials).toEqual({});
});
it('rejects cryptographically corrupted signature before capture',async()=>{
  const p=providerFixture();const transport=p.client.transporter.request.bind(p.client.transporter);
  p.client.transporter.request=(async options=>{
    const response=await transport(options);
    if(String(options?.url).endsWith('/token')) {
      const chunks:Buffer[]=[];for await(const chunk of response.data as Readable)chunks.push(Buffer.from(chunk));
      const data=JSON.parse(Buffer.concat(chunks).toString()) as {id_token:string};const parts=data.id_token.split('.');
      const signature=Buffer.from(parts[2],'base64url');signature[0]^=1;parts[2]=signature.toString('base64url');data.id_token=parts.join('.');response.data=Readable.from([JSON.stringify(data)]);
    }
    return response;
  }) as typeof p.client.transporter.request;
  const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(capture).not.toHaveBeenCalled();expect(p.calls.some(c=>c.includes('/certs'))).toBe(true);expect(p.calls.at(-1)).toContain('/revoke');expect(p.client.credentials).toEqual({});
});
it('rejects authorization expiring during capture rather than returning a successful result',async()=>{
  vi.useFakeTimers();
  try {
    const p=providerFixture();
    await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},async authorization=>{
      vi.setSystemTime(authorization.expiresAt!);return 'must-not-escape';
    },{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
    expect(p.calls.at(-1)).toContain('/revoke');expect(p.client.credentials).toEqual({});
  } finally {vi.useRealTimers();}
});
it.each([128_000,128_001])('bounds real SDK OAuth JSON before materialization at %i bytes',async size=>{
  const p=providerFixture();const streams:Readable[]=[];
  p.client.transporter=new Gaxios({fetchImplementation:(async(url:string|URL,options?:{headers?:Headers})=>{
    const response=await p.transport({url:String(url),headers:options?.headers as Headers});
    let text=JSON.stringify(response.data);
    if(String(url).endsWith('/token'))text+=' '.repeat(size-Buffer.byteLength(text));
    const body=Readable.from([text]);streams.push(body);
    return new FetchResponse(body,{status:200,headers:{'cache-control':'max-age=300','content-type':'application/json'}});
  }) as never});
  const capture=vi.fn(async()=> 'captured');
  const result=withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client});
  if(size===128_000)await expect(result).resolves.toBe('captured');
  else {await expect(result).rejects.toThrow('Freezing OAuth refused.');expect(capture).not.toHaveBeenCalled();}
  expect(streams.every(s=>s.destroyed)).toBe(true);expect(p.client.credentials).toEqual({});
});
it.each([302,401,403,500])('refuses OAuth SDK status %i without retry or buffering error body',async status=>{
  const p=providerFixture();let reads=0;const body=new Readable({read(){reads++;this.push('x'.repeat(128_001));this.push(null);}});
  const fetch=vi.fn(async()=>new FetchResponse(body,{status}));p.client.transporter=new Gaxios({fetchImplementation:fetch as never});
  const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(capture).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledOnce();expect(reads).toBe(0);expect(body.destroyed).toBe(true);expect(p.client.credentials).toEqual({});
});
it.each(['headers','body'])('bounds OAuth SDK %s deadline and cancels late streams',async phase=>{
  vi.useFakeTimers();
  try {
    const p=providerFixture();const body=new Readable({read(){}});let signal:AbortSignal|undefined;
    const fetch=vi.fn(async(_url:unknown,options?:{signal?:AbortSignal})=>{
      signal=options?.signal;if(phase==='headers')await new Promise(resolve=>setTimeout(resolve,10_001));
      return new FetchResponse(body,{status:200});
    });p.client.transporter=new Gaxios({fetchImplementation:fetch as never});
    const capture=vi.fn();
    const pending=withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client}).then(()=>null,error=>error);
    await vi.advanceTimersByTimeAsync(10_000);expect(await pending).toEqual(Error('Freezing OAuth refused.'));
    await vi.advanceTimersByTimeAsync(1);expect(signal?.aborted).toBe(true);expect(body.destroyed).toBe(true);expect(fetch).toHaveBeenCalledOnce();expect(capture).not.toHaveBeenCalled();expect(p.client.credentials).toEqual({});
  } finally {vi.useRealTimers();}
});
it('actual Gaxios fetch responses traverse OAuth, workbook capture, normalization and cleanup',async()=>{
  const p=providerFixture({}, {}, {refresh_token:'local-refresh-token'});const fetch=vi.fn(async(url:string|URL,options?:{headers?:Headers})=>{
    const response=await p.transport({url:String(url),headers:options?.headers});
    return new FetchResponse(response.data instanceof Readable?response.data:JSON.stringify(response.data),{status:200,headers:{'content-type':'application/json','cache-control':'max-age=300'}});
  });p.client.transporter=new Gaxios({fetchImplementation:fetch as never});
  const snapshot=await withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},authorization=>captureSheetsSnapshot({spreadsheetId:'sheet-1',capturedAt:new Date().toISOString(),reader:createGoogleWorkbookSnapshotReader(authorization,'sheet-1')}),{env,createClient:()=>p.client});
  expect(createLegacyNormalizationManifest({tenantId:'10000000-0000-4000-8000-000000000001',migrationJobId:'40000000-0000-4000-8000-000000000001',sheets:snapshot}).status).toBe('READY_FOR_IMPORT');
  expect(p.calls.filter(url=>url.endsWith('/token'))).toHaveLength(1);expect(p.calls.at(-1)).toContain('/revoke');expect(p.client.credentials).toEqual({});
});
it.each(['/certs','/tokeninfo','/revoke'])('bounds OAuth %s responses and clears credentials on overflow',async endpoint=>{
  const p=providerFixture();const transport=p.client.transporter.request.bind(p.client.transporter);let body:Readable|undefined;
  p.client.transporter.request=(async options=>{
    const response=await transport(options);
    if(String(options?.url).includes(endpoint)){(response.data as Readable).destroy();body=Readable.from([' '.repeat(128_001)]);response.data=body;}
    return response;
  }) as typeof p.client.transporter.request;
  const capture=vi.fn(async()=> 'captured');
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(capture).toHaveBeenCalledTimes(endpoint==='/revoke'?1:0);expect(body?.destroyed).toBe(true);expect(p.calls.at(-1)).toContain('/revoke');expect(p.client.credentials).toEqual({});
});
it('does not re-exchange an uncertain code after real Gaxios transport failure',async()=>{
  const p=providerFixture();const fetch=vi.fn(async()=>{throw Error('local uncertain transport failure');});
  p.client.transporter=new Gaxios({fetchImplementation:fetch as never});const capture=vi.fn();
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(fetch).toHaveBeenCalledOnce();expect(capture).not.toHaveBeenCalled();expect(p.client.credentials).toEqual({});
});
it('cleanup rejection cannot escape provider secrets or report workflow success',async()=>{
  const p=providerFixture();vi.spyOn(p.client,'revokeToken').mockRejectedValue(Error('local-access-token local-client-secret'));
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},async()=>true,{env,createClient:()=>p.client})).rejects.toThrow(/^Freezing OAuth refused\.$/);
  expect(p.clear).toHaveBeenLastCalledWith({});
});

// Real loopback HTTP + installed node-fetch + Gaxios: only the test fetch seam
// rewrites transport destinations; production Google URLs remain unchanged.
async function compressedProvider(encoding:string, target='all', fault='none') {
  const p=providerFixture();
  const responses: {url:string;body:Readable;signal:RequestInit['signal'];wire:number;decoded:number}[]=[];
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(req.url!, 'http://127.0.0.1').searchParams.get('source')!;
      const fixture=await p.transport({url,headers:new Headers({authorization:`Bearer ${access}`})});
      let text:string;
      if(fixture.data instanceof Readable){const chunks:Buffer[]=[];for await(const c of fixture.data)chunks.push(Buffer.from(c));text=Buffer.concat(chunks).toString();}
      else text=JSON.stringify(fixture.data);
      const selected=target==='all'||(target==='/token'?new URL(url).pathname==='/token':url.includes(target));
      if(selected&&fault==='bomb')text+=' '.repeat((target==='/values/'?1_000_001:128_001)-Buffer.byteLength(text));
      const decoded=Buffer.from(text);
      const coding=selected?encoding:'identity';
      let wire=coding==='gzip'?gzipSync(decoded):coding==='deflate'?deflateSync(decoded):coding==='br'?brotliCompressSync(decoded):decoded;
      res.writeHead(200,{'content-type':'application/json','cache-control':'max-age=300','content-encoding':coding,'content-length':wire.length,'x-decoded-length':decoded.length});
      if(selected&&fault==='truncated'){
        wire=wire.subarray(0,Math.floor(wire.length/2));res.write(wire);setImmediate(()=>res.destroy());
      }else res.end(wire);
    }catch{res.destroy();}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('loopback bind failed');
  const fetch=vi.fn(async(url:string|URL,options:RequestInit)=>{
    const response=await nodeFetch(`http://127.0.0.1:${address.port}/?source=${encodeURIComponent(String(url))}`,options);
    responses.push({url:String(url),body:response.body as Readable,signal:options.signal,wire:Number(response.headers.get('content-length')),decoded:Number(response.headers.get('x-decoded-length'))});
    return response;
  });
  p.client.transporter=new Gaxios({fetchImplementation:fetch as never});
  const capture=vi.fn(authorization=>captureSheetsSnapshot({spreadsheetId:'sheet-1',capturedAt:new Date().toISOString(),reader:createGoogleWorkbookSnapshotReader(authorization,'sheet-1')}));
  return {...p,responses,fetch,capture,
    run:()=>withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},capture,{env,createClient:()=>p.client}),
    close:()=>new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();})};
}
it.each(['gzip','deflate','br','identity'])('localhost %s survives real decompression across OAuth and workbook',async encoding=>{
  const p=await compressedProvider(encoding);
  try {
    const snapshot=await p.run();
    expect(createLegacyNormalizationManifest({tenantId:'10000000-0000-4000-8000-000000000001',migrationJobId:'40000000-0000-4000-8000-000000000001',sheets:snapshot}).status).toBe('READY_FOR_IMPORT');
    for(const endpoint of ['/token','/certs','/tokeninfo','/revoke','/drive/','/v4/','/values/'])expect(p.responses.some(r=>r.url.includes(endpoint))).toBe(true);
    if(encoding==='identity')expect(p.responses.every(r=>r.wire===r.decoded)).toBe(true);
    else expect(p.responses.some(r=>r.wire!==r.decoded)).toBe(true);
    expect(p.calls.filter(url=>new URL(url).pathname==='/token')).toHaveLength(1);
    expect(p.responses.every(r=>r.body.destroyed&&r.signal?.aborted)).toBe(true);
    expect(p.calls.at(-1)).toContain('/revoke');expect(p.client.credentials).toEqual({});
  }finally{await p.close();}
});
it.each(['gzip','deflate','br'].flatMap(encoding=>['/token','/certs','/tokeninfo','/revoke','/drive/','/v4/','/values/'].map(target=>({encoding,target}))))('localhost decoded bomb aborts $encoding $target',async({encoding,target})=>{
  const p=await compressedProvider(encoding,target,'bomb');
  try {
    await expect(p.run()).rejects.toThrow('Freezing OAuth refused.');
    const selected=p.responses.filter(r=>target==='/token'?new URL(r.url).pathname==='/token':r.url.includes(target));
    expect(selected).toHaveLength(1);expect(selected[0].wire).toBeLessThan(128_000);
    expect(selected[0].body.destroyed).toBe(true);expect(selected[0].signal?.aborted).toBe(true);
    expect(p.calls.filter(url=>new URL(url).pathname==='/token')).toHaveLength(1);
    if(target!=='/token')expect(p.calls.at(-1)).toContain('/revoke');
    expect(p.client.credentials).toEqual({});
  }finally{await p.close();}
});
it.each(['gzip, br','gzip;foo','unknown',''].flatMap(encoding=>['/token','/drive/'].map(target=>({encoding,target}))))('localhost refuses malformed/unsupported encoding $encoding $target',async({encoding,target})=>{
  const p=await compressedProvider(encoding,target);
  try{await expect(p.run()).rejects.toThrow('Freezing OAuth refused.');expect(p.client.credentials).toEqual({});}
  finally{await p.close();}
});
it.each(['gzip','deflate','br','identity'].flatMap(encoding=>['/token','/drive/'].map(target=>({encoding,target}))))('localhost refuses truncated HTTP response $encoding $target',async({encoding,target})=>{
  const p=await compressedProvider(encoding,target,'truncated');
  try{await expect(p.run()).rejects.toThrow('Freezing OAuth refused.');expect(p.calls.filter(url=>new URL(url).pathname==='/token')).toHaveLength(1);expect(p.client.credentials).toEqual({});}
  finally{await p.close();}
});

it.each(['gzip','deflate','br'].flatMap(encoding=>['/certs','/tokeninfo','/revoke','/drive/','/v4/','/values/'].map(target=>({encoding,target}))))('localhost isolated compressed endpoint $encoding $target succeeds',async({encoding,target})=>{
  const p=await compressedProvider(encoding,target);
  try{await expect(p.run()).resolves.toHaveProperty('sourceRevision','42');expect(p.client.credentials).toEqual({});}
  finally{await p.close();}
});
it.each(['1','128001','invalid','-1','01'])('OAuth identity rejects declared length %s before success',async length=>{
  const p=providerFixture();const transport=p.client.transporter.request.bind(p.client.transporter);
  p.client.transporter.request=(async options=>{const response=await transport(options);response.headers.set('content-length',length);return response;}) as typeof p.client.transporter.request;
  await expect(withVerifiedFreezingAuthorization('https://store.example','local-code',{subject:'owner',email:'owner@example.invalid',nonce:'nonce-for-freezing-only'},async()=>true,{env,createClient:()=>p.client})).rejects.toThrow('Freezing OAuth refused.');
  expect(p.calls).toHaveLength(1);expect(p.client.credentials).toEqual({});
});
