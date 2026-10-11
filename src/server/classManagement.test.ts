// @vitest-environment node
import { randomBytes, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
const execute=vi.hoisted(()=>vi.fn());
vi.mock('@/server/repositories/database/classDashboard',()=>({getProductionClassManagementCommand:()=>({execute})}));
import { POST } from '@/app/api/classes/[slug]/manage/route';
import { setGoogleSessionCookie, GOOGLE_AUTH_COOKIE } from './googleOAuth';
const valid={operationId:randomUUID(),action:'DUPLICATE',name:'새 학급',expectedVersion:'1'};
const binding={accountGeneration:randomUUID(),sessionId:randomUUID()};
function request(body:unknown=valid,mode='valid') {
  vi.stubEnv('AUTH_SECRET',randomBytes(32).toString('hex'));
  const res=new NextResponse(); setGoogleSessionCookie(res,{subject:'synthetic-owner',email:'owner@example.invalid',issuedAt:Date.now(),...binding});
  const headers=new Headers({'content-type':'application/json',origin:'https://class.example','sec-fetch-site':'same-origin',cookie:`${GOOGLE_AUTH_COOKIE}=${res.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`});
  if(mode==='missing')headers.delete('cookie');
  if(mode==='foreign-origin')headers.set('origin','https://foreign.example');
  if(mode==='cross-site')headers.set('sec-fetch-site','cross-site');
  if(mode==='wrong-type')headers.set('content-type','text/plain');
  return new Request('https://class.example/api/classes/my-class/manage',{method:'POST',headers,body:JSON.stringify(body)});
}
const call=(req:Request,slug='my-class')=>POST(req,{params:Promise.resolve({slug})});
afterEach(()=>{vi.unstubAllEnvs();execute.mockReset();});
describe('class management HTTP boundary',()=>{
  it.each([['missing',401],['foreign-origin',403],['cross-site',403],['wrong-type',403]] as const)('rejects %s before SQL',async(mode,status)=>{
    expect((await call(request(valid,mode))).status).toBe(status);expect(execute).not.toHaveBeenCalled();
  });
  it.each(['subject','tenantId','role','lifecycle','deletedAt'])('rejects browser authority %s',async key=>{
    expect((await call(request({...valid,[key]:'foreign'}))).status).toBe(400);expect(execute).not.toHaveBeenCalled();
  });
  it.each([{name:' '},{name:'x'.repeat(81)},{name:'a\u202eb'},{name:'a\n'},{action:'PURGE'},{expectedVersion:'9007199254740992'},{expectedVersion:1},{operationId:'bad'}])('rejects invalid payload %j',async patch=>{
    expect((await call(request({...valid,...patch}))).status).toBe(400);expect(execute).not.toHaveBeenCalled();
  });
  it('binds decrypted subject and canonical route only',async()=>{
    execute.mockResolvedValue({slug:'new-class',action:'DUPLICATE',managementVersion:'1',replayed:false});
    expect((await call(request())).status).toBe(200);
    expect(execute).toHaveBeenCalledExactlyOnceWith({...valid,...binding,subject:'synthetic-owner',slug:'my-class'});
    execute.mockClear();expect((await call(request(),'MY-CLASS')).status).toBe(400);expect(execute).not.toHaveBeenCalled();
  });
  it.each([['28000',401],['42501',403],['23505',409],['22023',400],['08006',503]] as const)('sanitizes SQL error %s',async(code,status)=>{
    execute.mockRejectedValue(Object.assign(new Error('private detail'),{code}));
    const res=await call(request());expect(res.status).toBe(status);expect(res.headers.get('cache-control')).toBe('no-store');expect(await res.text()).not.toContain('private detail');
  });
});
