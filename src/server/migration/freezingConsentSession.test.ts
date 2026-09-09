import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { GOOGLE_AUTH_COOKIE, setGoogleSessionCookie } from '@/server/googleOAuth';
import * as guard from './freezingConsentSession';
vi.mock('server-only', () => ({}));
const ORIGIN = 'https://store.example';
const SECRET = 'synthetic-auth-secret-with-at-least-32-characters';
const NOW = 1_800_000_000_000;
let cookie: string;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW); vi.stubEnv('AUTH_SECRET', SECRET);
  const response = NextResponse.json({});
  setGoogleSessionCookie(response, {subject:'owner',email:'Owner@Example.invalid',issuedAt:NOW});
  cookie = `${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
function request(headers: Record<string,string> = {}, url = `${ORIGIN}/api/migrations/job/freezing/consent`) {
  return new Request(url, {method:'POST',headers:{cookie,origin:ORIGIN,'content-type':'application/json',...headers},body:'{}'});
}
function verify(req: Request, origin: string, digest: string, session = guard.readFreezingConsentSession(request(),ORIGIN)) {
  return guard.verifyFreezingConsentPost(req,origin,digest,session);
}
it('reads the real encrypted Google session and privately binds its exact login instance without exposing cookies', () => {
  expect(typeof guard.readFreezingConsentSession).toBe('function');
  const session = guard.readFreezingConsentSession(request(), ORIGIN);
  expect(session).toMatchObject({subject:'owner',email:'owner@example.invalid',issuedAt:NOW});
  expect(session.sessionBinding).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(session)).not.toContain(cookie);
  expect(JSON.stringify(session)).not.toContain(SECRET);
  const response = NextResponse.json({});
  setGoogleSessionCookie(response,{subject:'owner',email:'Owner@Example.invalid',issuedAt:NOW});
  expect(guard.readFreezingConsentSession(request({cookie:`${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`}), ORIGIN).sessionBinding).not.toBe(session.sessionBinding);
});
it.each(['none','compatibility','tampered','duplicate','weak-secret','foreign-origin'])('refuses %s instead of using an admin or public identity fallback', kind => {
  let req = request();
  if(kind==='none') req=request({cookie:''});
  if(kind==='compatibility') req=request({cookie:'class_store_admin_auth=synthetic-password-session'});
  if(kind==='tampered') req=request({cookie:`${cookie}x`});
  if(kind==='duplicate') req=request({cookie:`${cookie}; ${cookie}`});
  if(kind==='weak-secret') vi.stubEnv('AUTH_SECRET','short');
  if(kind==='foreign-origin') req=request({},'https://other.example/api/migrations/job/freezing/consent');
  expect(() => guard.readFreezingConsentSession(req,ORIGIN)).toThrow('Freezing consent session refused.');
});
it('rechecks the detached real login against wall clock and the final transaction database clock', () => {
  const session=guard.readFreezingConsentSession(request(),ORIGIN);
  expect(guard.revalidateFreezingConsentSession(session,request(),ORIGIN,NOW)).toEqual(session);
  expect(() => guard.revalidateFreezingConsentSession(session,request(),ORIGIN,NOW-1)).toThrow();
  expect(() => guard.revalidateFreezingConsentSession(session,request(),ORIGIN,NOW+30*24*60*60*1000)).toThrow();
  vi.setSystemTime(NOW+30*24*60*60*1000);
  expect(() => guard.revalidateFreezingConsentSession(session,request(),ORIGIN,NOW)).toThrow();
});
it('rejects changed login instances and forged lookalike private session handles', () => {
  const session=guard.readFreezingConsentSession(request(),ORIGIN);
  const response=NextResponse.json({});
  setGoogleSessionCookie(response,{subject:'owner',email:'owner@example.invalid',issuedAt:NOW});
  const replacement=request({cookie:`${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`});
  expect(() => guard.revalidateFreezingConsentSession(session,replacement,ORIGIN,NOW)).toThrow();
  expect(() => guard.revalidateFreezingConsentSession({...session},request(),ORIGIN,NOW)).toThrow();
});
it('refuses transferring a server-issued synchronizer to another encrypted login or a lookalike session', () => {
  const session=guard.readFreezingConsentSession(request(),ORIGIN);
  const synchronizer=guard.issueFreezingConsentSynchronizer();
  const response=NextResponse.json({});
  setGoogleSessionCookie(response,{subject:'owner',email:'owner@example.invalid',issuedAt:NOW});
  const headers={'x-csrf-token':synchronizer.token,cookie:`${GOOGLE_AUTH_COOKIE}=${response.cookies.get(GOOGLE_AUTH_COOKIE)!.value}`};
  expect(() => verify(request(headers),ORIGIN,synchronizer.digest,session)).toThrow('Freezing consent session refused.');
  expect(() => verify(request({'x-csrf-token':synchronizer.token}),ORIGIN,synchronizer.digest,{...session})).toThrow('Freezing consent session refused.');
});
it.each(['?', '#', '#fragment'])('rejects literal URL delimiter %s even when parsed search/hash is empty', suffix => {
  const synchronizer=guard.issueFreezingConsentSynchronizer();
  expect(() => verify(request({'x-csrf-token':synchronizer.token},`${ORIGIN}/api/migrations/job/freezing/consent${suffix}`),ORIGIN,synchronizer.digest)).toThrow('Freezing consent session refused.');
});
it('issues unpredictable synchronizer tokens and validates an explicit same-origin JSON POST against only the server-held digest', () => {
  const a=guard.issueFreezingConsentSynchronizer(); const b=guard.issueFreezingConsentSynchronizer();
  expect(a.token).toMatch(/^[0-9a-f]{64}$/); expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(a.token).not.toBe(b.token); expect(a.digest).not.toBe(a.token);
  expect(verify(request({'x-csrf-token':a.token}),ORIGIN,a.digest)).toBeUndefined();
  const invalidHeaders: Record<string,string>[] = [{'x-csrf-token':b.token},{'x-csrf-token':a.digest},{'x-csrf-token':''},{'x-csrf-token':a.token,origin:'https://evil.example'},{'x-csrf-token':a.token,'sec-fetch-site':'cross-site'},{'x-csrf-token':a.token,'content-type':'text/plain'}];
  for(const headers of invalidHeaders) {
    expect(() => verify(request(headers),ORIGIN,a.digest)).toThrow('Freezing consent session refused.');
  }
  expect(() => verify(request({'x-csrf-token':a.token},`${ORIGIN}/api/migrations/job/freezing/consent?tenant=other`),ORIGIN,a.digest)).toThrow();
  expect(() => verify(new Request(`${ORIGIN}/api/migrations/job/freezing/consent`,{headers:{cookie,origin:ORIGIN,'content-type':'application/json','x-csrf-token':a.token}}),ORIGIN,a.digest)).toThrow();
});
