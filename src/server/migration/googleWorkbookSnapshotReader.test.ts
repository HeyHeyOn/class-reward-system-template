// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Response as FetchResponse } from 'node-fetch';
import { google } from 'googleapis';
import { captureSheetsSnapshot } from './sheetsSnapshot';
import { createLegacyNormalizationManifest } from './manifest';
import { makeSupportedSheets } from './__fixtures__/normalization';
import { createGoogleWorkbookSnapshotReader } from './googleWorkbookSnapshotReader';
vi.mock('server-only',()=>({}));
const raw='f'.repeat(64);
type Options={change?:'revision'|'values'|'metadata';version?:unknown;mimeType?:string;id?:string;sheetType?:string;oversize?:boolean;contentLength?:string;hang?:boolean;padValues?:boolean;lastVersionChange?:boolean;status?:number};
function io(options:Options={}, transform?:(data:unknown,url:string)=>unknown, wire?:(body:string,url:string)=>string) {
  const source=makeSupportedSheets(3); let revisions=0;let metadata=0;
  const tabs=Object.fromEntries(Object.entries(source.tabs).map(([n,t])=>[n,[t.headers,...t.rows.map(r=>r.cells)]]));
  tabs["Unknown's tab"]=[['one','unknown'],['x','y']];
  tabs['Credentials']=[['secret']];
  const streams: Readable[]=[];
  const calls: Array<{url:string;params?:Readonly<Record<string,unknown>>;signal?:AbortSignal}>=[];
  const auth={getToken:vi.fn(),setCredentials:vi.fn(),revokeToken:vi.fn(),request:vi.fn(async (request:{url:string;params?:Readonly<Record<string,unknown>>;signal?:AbortSignal})=>{
    calls.push(request); let data:unknown;
    if(request.url.includes('/drive/v3/files/')) {revisions++;data={id:options.id??raw,mimeType:options.mimeType??'application/vnd.google-apps.spreadsheet',trashed:false,version:'version' in options?options.version:options.change==='revision'?String(revisions):options.lastVersionChange&&revisions>=3?'43':'42'};}
    else if(request.url.includes('/values/')) {
      const range=decodeURIComponent(request.url.split('/values/')[1]);
      const name=range.slice(1,-1).replace(/''/g,"'");
      data=tabs[name].length?{values:structuredClone(tabs[name])}:{};
      if(options.change==='values'&&metadata===2&&name==='Students') (data as {values:string[][]}).values[1][1]='changed';
    } else {metadata++;data={spreadsheetId:raw,sheets:Object.keys(tabs).map((title,sheetId)=>({properties:{sheetId,title,sheetType:options.sheetType??'GRID',gridProperties:{rowCount:options.change==='metadata'&&metadata===2?999:100,columnCount:50}}}))};}
    let body=JSON.stringify(transform?transform(data,request.url):data)+(options.padValues&&request.url.includes('/values/')?' '.repeat(900_000):'');
    if(wire)body=wire(body,request.url);
    const stream=options.hang?new Readable({read(){}}):Readable.from([options.oversize?'x'.repeat(1_000_001):body]);streams.push(stream);
    return {data:stream,status:options.status??200,headers:new Headers(options.contentLength?{'content-length':options.contentLength}:{})};
  })};
  return {auth,calls,streams,tabs};
}
afterEach(()=>vi.useRealTimers());
async function capture(p:ReturnType<typeof io>){return captureSheetsSnapshot({spreadsheetId:raw,capturedAt:new Date().toISOString(),reader:createGoogleWorkbookSnapshotReader({auth:p.auth,expiresAt:Date.now()+120_000},raw)});}
it('double-pass actual provider responses capture hash-shaped raw Sheet, quoted whole tab and normalize unknown columns',async()=>{
  const p=io();const snapshot=await capture(p);
  expect(snapshot.spreadsheetId).toBe(raw);expect(snapshot.sourceRevision).toBe('42');
  expect(snapshot.tabs["Unknown's tab"].rows[0].cells).toEqual(['x','y']);
  const manifest=createLegacyNormalizationManifest({tenantId:'10000000-0000-4000-8000-000000000001',migrationJobId:'40000000-0000-4000-8000-000000000001',sheets:snapshot});
  expect(manifest).toHaveProperty('status');
  expect(p.calls.every(c=>c.url.includes(raw))).toBe(true);
  expect(p.calls.filter(c=>c.url.includes('/drive/'))).toHaveLength(4);
  expect(p.calls.filter(c=>c.url.includes('/values/'))).toHaveLength((Object.keys(p.tabs).length-1)*2);
  expect(p.calls.some(c=>decodeURIComponent(c.url).includes("'Unknown''s tab'"))).toBe(true);
  expect(p.calls.some(c=>c.url.includes('Credentials'))).toBe(false);
  expect(p.auth.request).toHaveBeenCalledWith(expect.objectContaining({responseType:'stream',timeout:10_000,retry:false,maxRedirects:0}));
  for(const call of p.calls.filter(c=>c.url.includes('/values/'))) expect(call.params).toEqual({majorDimension:'ROWS',valueRenderOption:'FORMATTED_VALUE',dateTimeRenderOption:'FORMATTED_STRING'});
});
it.each(['revision','values','metadata'] as const)('refuses %s drift without retry',async change=>{
  const p=io({change});await expect(capture(p)).rejects.toThrow('Workbook read refused.');
  expect(p.calls.filter(c=>!c.url.includes('/values/')&&!c.url.includes('/drive/')).length).toBeLessThanOrEqual(2);
});
it.each([{version:undefined},{version:'01'},{version:'9223372036854775808'},{version:42},{mimeType:'text/plain'},{id:'other'},{sheetType:'OBJECT'}])('refuses malformed provider identity/revision/metadata %j',async options=>{
  await expect(capture(io(options))).rejects.toThrow('Workbook read refused.');
});
it.each([{}, {contentLength:'1'},{contentLength:'2000000'}])('bounds streamed metadata before JSON parse including forged Content-Length %j',async options=>{
  const p=io({...options,oversize:true});await expect(capture(p)).rejects.toThrow('Workbook read refused.');
  expect(p.streams.every(s=>s.destroyed)).toBe(true);
});
it('times out unfinished body and aborts/destroys the response stream',async()=>{
  vi.useFakeTimers();const p=io({hang:true});const result=capture(p).then(()=>null,error=>error);
  await vi.advanceTimersByTimeAsync(10_001);expect(await result).toEqual(Error('Workbook read refused.'));
  expect(p.streams[0].destroyed).toBe(true);expect(p.calls[0].signal?.aborted).toBe(true);
});
it.each([{lastVersionChange:true},{status:302},{status:403},{padValues:true}])('rejects final version drift, redirects, provider failure and aggregate wire overflow %j',async options=>{
  const p=io(options);await expect(capture(p)).rejects.toThrow('Workbook read refused.');
  expect(p.streams.every(s=>s.destroyed)).toBe(true);
});
it('keeps whole-tab unknown columns, interior blanks and provider-omitted empty tabs',async()=>{
  const p=io();p.tabs["Unknown's tab"]=[['one','two','three'],['a','','c'],[],['d']];p.tabs['Empty']=[];
  const reader=createGoogleWorkbookSnapshotReader({auth:p.auth,expiresAt:Date.now()+120_000},raw);
  expect(await reader.getRows("Unknown's tab")).toEqual(p.tabs["Unknown's tab"]);
  const snapshot=await captureSheetsSnapshot({spreadsheetId:raw,capturedAt:new Date().toISOString(),reader});
  // The existing snapshot redactor pads rows to header width; the provider
  // adapter itself must not invent cells or drop the interior empty row.
  expect(snapshot.tabs["Unknown's tab"].rows.map(r=>r.cells)).toEqual([['a','','c'],['','',''],['d','','']]);
  expect(snapshot.tabs.Empty).toEqual({headers:[],rows:[]});
});
it.each([{rows:[[{object:true}]]},{rows:[null]}])('rejects malformed provider values %j',async ({rows})=>{
  const p=io();p.tabs["Unknown's tab"]=rows as never;
  await expect(capture(p)).rejects.toThrow('Workbook read refused.');
});
it.each(['sheetId','title'])('rejects duplicate metadata %s before reading values',async key=>{
  const p=io({},(data,url)=>{
    if(url.includes('/drive/')||url.includes('/values/'))return data;
    const metadata=data as {sheets:{properties:Record<string,unknown>}[]};
    metadata.sheets[1].properties[key]=metadata.sheets[0].properties[key];return data;
  });
  await expect(capture(p)).rejects.toThrow('Workbook read refused.');expect(p.calls.some(c=>c.url.includes('/values/'))).toBe(false);
});
it.each(['rowCount','columnCount'].flatMap(key=>[0,-1,1.5,Number.MAX_SAFE_INTEGER+1,null,'100'].map(value=>({key,value}))))('rejects invalid grid bound %j',async({key,value})=>{
  const p=io({},(data,url)=>{
    if(url.includes('/drive/')||url.includes('/values/'))return data;
    const metadata=data as {sheets:{properties:{gridProperties:Record<string,unknown>}}[]};
    metadata.sheets[0].properties.gridProperties[key]=value;return data;
  });
  await expect(capture(p)).rejects.toThrow('Workbook read refused.');expect(p.calls.some(c=>c.url.includes('/values/'))).toBe(false);
});
it.each([999_999,1_000_000,1_000_001])('enforces dedicated values wire byte boundary %i',async size=>{
  const q=io({},undefined,(body,url)=>decodeURIComponent(url).endsWith("/values/'Students'")?body+' '.repeat(size-Buffer.byteLength(body)):body);
  if(size<=1_000_000)await expect(capture(q)).resolves.toHaveProperty('sourceRevision','42');
  else {await expect(capture(q)).rejects.toThrow('Workbook read refused.');expect(decodeURIComponent(q.calls.at(-1)!.url).endsWith("/values/'Students'")).toBe(true);}
  expect(q.streams.every(s=>s.destroyed)).toBe(true);
});
it.each(['1000001','1','invalid'])('checks dedicated values Content-Length %s and cancels',async length=>{
  const p=io();const original=p.auth.request.getMockImplementation()!;
  p.auth.request.mockImplementation(async request=>{
    const response=await original(request);
    if(request.url.includes('/values/'))response.headers.set('content-length',length);
    return response;
  });
  await expect(capture(p)).rejects.toThrow('Workbook read refused.');
  expect(p.calls.filter(c=>c.url.includes('/values/'))).toHaveLength(1);expect(p.streams.every(s=>s.destroyed)).toBe(true);
});
it('cancels a response arriving after the header deadline without consuming its body',async()=>{
  vi.useFakeTimers();const p=io();const original=p.auth.request.getMockImplementation()!;
  p.auth.request.mockImplementation(async request=>{await new Promise(resolve=>setTimeout(resolve,10_001));return original(request);});
  const pending=capture(p).then(()=>null,error=>error);
  await vi.advanceTimersByTimeAsync(10_000);expect(await pending).toEqual(Error('Workbook read refused.'));
  await vi.advanceTimersByTimeAsync(1);expect(p.calls).toHaveLength(1);expect(p.calls[0].signal?.aborted).toBe(true);expect(p.streams[0].destroyed).toBe(true);expect(p.streams[0].readableDidRead).toBe(false);
});
it('uses one 60000ms deadline across individually sub-10000ms requests',async()=>{
  vi.useFakeTimers();const p=io();const original=p.auth.request.getMockImplementation()!;const signals:AbortSignal[]=[];
  p.auth.request.mockImplementation(async request=>{signals.push(request.signal!);await new Promise(resolve=>setTimeout(resolve,9_000));return original(request);});
  const pending=capture(p).then(()=>null,error=>error);let settled=false;void pending.then(()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(59_999);expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);expect(await pending).toEqual(Error('Workbook read refused.'));expect(signals).toHaveLength(7);expect(signals.every(s=>s.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(3_000);expect(p.streams.every(s=>s.destroyed)).toBe(true);expect(p.calls).toHaveLength(7);
});
it.each([749_999,750_000,750_001])('preserves original acquisition aggregate budget boundary %i',async budget=>{
  const p=io();p.tabs["Unknown's tab"]=[Array(8).fill('')];
  const reserve=Buffer.byteLength(`adminPasswordHash${'scrypt$16384$8$1$'}${'a'.repeat(32)}$${'b'.repeat(64)}recoveryCodeHash${'c'.repeat(64)}`);
  let used=Buffer.byteLength(raw)+24+2+reserve;
  for(const [name,rows] of Object.entries(p.tabs)) {
    used+=64+Buffer.byteLength(name);if(name==='Credentials')continue;
    for(const row of rows){used+=96;for(const cell of row)used+=3+Buffer.byteLength(String(cell??''));}
  }
  let remaining=budget-used;
  p.tabs["Unknown's tab"][0]=Array.from({length:8},()=>{const count=Math.min(100_000,remaining);remaining-=count;return 'x'.repeat(count);});
  expect(remaining).toBe(0);
  if(budget<=750_000)await expect(capture(p)).resolves.toHaveProperty('sourceRevision','42');
  else {await expect(capture(p)).rejects.toThrow('Workbook read refused.');expect(p.calls.filter(c=>c.url.includes('/drive/'))).toHaveLength(1);}
});
it.each([302,401,403,500])('rejects real SDK error status %i without materializing its body or refreshing',async status=>{
  const client=new google.auth.OAuth2('local-client','local-secret');client.eagerRefreshThresholdMillis=0;
  client.setCredentials({access_token:'local-access',expiry_date:Date.now()+120_000});
  let reads=0;const body=new Readable({read(){reads++;this.push('x'.repeat(128_001));this.push(null);}});
  const fetch=vi.fn(async()=>new FetchResponse(body,{status}));
  client.transporter.defaults.fetchImplementation=fetch as never;
  await expect(createGoogleWorkbookSnapshotReader({auth:client,expiresAt:Date.now()+120_000},raw).getRevision()).rejects.toThrow('Workbook read refused.');
  expect(reads).toBe(0);expect(body.destroyed).toBe(true);expect(fetch).toHaveBeenCalledOnce();
});
it('refuses expired authorization before any I/O',async()=>{
  const p=io();await expect(createGoogleWorkbookSnapshotReader({auth:p.auth,expiresAt:1},raw).getRevision()).rejects.toThrow('Workbook read refused.');
  expect(p.auth.request).not.toHaveBeenCalled();
});
