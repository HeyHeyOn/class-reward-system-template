// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { hubSignInState, hubStartPath, readCookie, teacherScreenRedirect } from './teacherGate';

const HUB = { DDANSSAEM_LOGIN: '1', DDANSSAEM_HUB_URL: 'https://ddanssaem.com', DDANSSAEM_CLIENT_SECRET: 's'.repeat(40) };
const PROD = { ...HUB, DDANSSAEM_HINT_COOKIE: 'dd_hub' };
const session = { hubSid: 'sid-1' };
const go = (cookieHeader: string, withSession: boolean, env: Record<string, string> = PROD) =>
  teacherScreenRedirect({ path: '/c/alpha/admin', session: withSession ? session : null, cookieHeader }, env);
const START = '/api/auth/ddanssaem/start?next=%2Fc%2Falpha%2Fadmin';
const QUIET = '/api/auth/ddanssaem/start?prompt=none&next=%2Fc%2Falpha%2Fadmin';

describe('teacher screens follow the hub sign-in (account protocol 8-3)', () => {
  it('follows the table when the hub hint cookie is named', () => {
    expect(go('dd_hub=sid-1', false)).toBe(QUIET);
    expect(go('', false)).toBe(START);
    expect(go('other=1', true)).toBe(START);
    expect(go('dd_hub=sid-2', true)).toBe(QUIET);
    expect(go('dd_hub=sid-1', true)).toBeNull();
  });

  it('asks quietly only once a minute, so a hint that does not match never sends the browser round', () => {
    expect(go('dd_hub=sid-1; class_store_dd_tried=1', false)).toBe(START);
    expect(go('dd_hub=sid-2; class_store_dd_tried=1', true)).toBeNull();
    expect(go('class_store_dd_tried=1', true)).toBe(START);
  });

  it('sends a signed-out teacher to the hub on a preview that cannot read the hint, and leaves a session alone', () => {
    expect(go('dd_hub=sid-9', false, HUB)).toBe(START);
    expect(go('dd_hub=sid-9', true, HUB)).toBeNull();
    expect(hubSignInState(session, 'dd_hub=sid-9', HUB)).toBe('UNKNOWN');
  });

  it('does nothing until the hub signs teachers in', () => {
    expect(go('', false, { ...PROD, DDANSSAEM_LOGIN: '' })).toBeNull();
    expect(go('', true, { DDANSSAEM_HINT_COOKIE: 'dd_hub' })).toBeNull();
  });

  it('keeps the way back inside the app and reads cookies exactly', () => {
    expect(hubStartPath('https://evil.example')).toBe('/api/auth/ddanssaem/start?next=%2Fclasses');
    expect(hubStartPath('/classes', { silent: true })).toBe('/api/auth/ddanssaem/start?prompt=none&next=%2Fclasses');
    expect(readCookie('xdd_hub=1; dd_hub=a%20b', 'dd_hub')).toBe('a b');
    expect(readCookie('dd_hub=%E0%A4%A', 'dd_hub')).toBeUndefined();
    expect(hubSignInState(session, 'dd_hub=sid-1', { ...PROD, DDANSSAEM_HINT_COOKIE: 'bad name;' })).toBe('UNKNOWN');
  });
});
