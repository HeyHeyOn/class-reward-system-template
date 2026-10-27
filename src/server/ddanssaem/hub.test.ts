// @vitest-environment node
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  exchangeHubCode,
  hubConnected,
  hubLoginEnabled,
  hubLogoutUrl,
  openHubLogin,
  parseHubEvent,
  parseHubProfile,
  parseSummaryRequest,
  safeNextPath,
  startHubLogin,
  verifyHubSignature,
  hubAvatarUrl, parseHubIcon,
  parseTeacherVerification,
} from './hub';

vi.mock('server-only', () => ({}));

const env = {
  DDANSSAEM_LOGIN: '1',
  DDANSSAEM_HUB_URL: 'https://beta.ddanssaem.com',
  DDANSSAEM_CLIENT_SECRET: 's'.repeat(40),
  AUTH_SECRET: 'a'.repeat(40),
};
const origin = 'https://class-beta.example';
const profile = { sub: '1234567890', account_id: 'acc', email: 'teacher@example.com', name: '별빛쌤', terms_version: '2026-12-05', sid: 'hub-sid-1' };
const sign = (body: string) => createHmac('sha256', env.DDANSSAEM_CLIENT_SECRET).update(body).digest('hex');

describe('signing in through the hub', () => {
  it('sends the browser to /authorize with the state and an S256 challenge of the verifier it keeps', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    const { authorizeUrl, cookie } = startHubLogin(origin, '/c/alpha/admin', env, now);
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://beta.ddanssaem.com/authorize');
    expect(url.searchParams.get('client_id')).toBe('class');
    expect(url.searchParams.get('redirect_uri')).toBe(`${origin}/api/auth/ddanssaem/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const login = openHubLogin(cookie, env, now + 1000)!;
    expect(login.state).toBe(url.searchParams.get('state'));
    expect(login.next).toBe('/c/alpha/admin');
    expect(createHash('sha256').update(login.verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(cookie).not.toContain(login.verifier);
    expect(login.silent).toBe(false);
    expect(url.searchParams.has('prompt')).toBe(false);
    const quiet = startHubLogin(origin, '/classes', env, now, { silent: true });
    expect(new URL(quiet.authorizeUrl).searchParams.get('prompt')).toBe('none');
    expect(openHubLogin(quiet.cookie, env, now)?.silent).toBe(true);
  });

  it('forgets a login cookie that is altered, from another secret or older than ten minutes', () => {
    const now = Date.parse('2026-10-15T10:00:00Z');
    const { cookie } = startHubLogin(origin, '/classes', env, now);
    expect(openHubLogin(cookie, env, now + 600_001)).toBeNull();
    expect(openHubLogin(`${cookie.slice(0, -2)}AA`, env, now)).toBeNull();
    expect(openHubLogin(cookie, { ...env, AUTH_SECRET: 'b'.repeat(40) }, now)).toBeNull();
    expect(openHubLogin(undefined, env, now)).toBeNull();
  });

  it('only returns to a path inside the app', () => {
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil', 'classes', '', null]) expect(safeNextPath(bad)).toBe('/classes');
    expect(safeNextPath('/c/alpha/admin')).toBe('/c/alpha/admin');
  });

  it('trades the code server to server with the secret and the verifier, and reads the teacher', async () => {
    const fetchImpl = vi.fn(async () => Response.json(profile));
    await expect(exchangeHubCode({ origin, code: 'code-1', verifier: 'verifier-1' }, env, fetchImpl as never)).resolves.toEqual({
      sub: '1234567890', email: 'teacher@example.com', name: '별빛쌤', termsVersion: '2026-12-05', sid: 'hub-sid-1', icon: null, verification: null,
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://beta.ddanssaem.com/api/token');
    const form = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'authorization_code', code: 'code-1', redirect_uri: `${origin}/api/auth/ddanssaem/callback`,
      client_id: 'class', client_secret: env.DDANSSAEM_CLIENT_SECRET, code_verifier: 'verifier-1',
    });
  });

  it('keeps a second edition of the same day as the hub gives it', () => {
    expect(parseHubProfile({ ...profile, terms_version: '2026-10-27.2' })?.termsVersion).toBe('2026-10-27.2');
  });

  it('refuses a refused code, a hub that does not answer and an incomplete profile', async () => {
    await expect(exchangeHubCode({ origin, code: 'c', verifier: 'v' }, env, (async () => Response.json({ error: 'invalid_grant' }, { status: 400 })) as never))
      .rejects.toMatchObject({ code: 'INVALID_GRANT' });
    await expect(exchangeHubCode({ origin, code: 'c', verifier: 'v' }, env, (async () => { throw new Error('down'); }) as never))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(parseHubProfile({ ...profile, terms_version: '12/05' })).toBeNull();
    expect(parseHubProfile({ ...profile, terms_version: '2026-10-27.x' })).toBeNull();
    expect(parseHubProfile({ ...profile, sid: '' })).toBeNull();
    expect(parseHubProfile({ ...profile, sub: 'withdrawn:x' })).toBeNull();
  });

  it('answers the hub once connected, signs in through it only with DDANSSAEM_LOGIN=1, and signs out through it', () => {
    expect(hubLoginEnabled({})).toBe(false);
    expect(hubLoginEnabled(env)).toBe(true);
    expect(hubLoginEnabled({ ...env, DDANSSAEM_CLIENT_SECRET: '' })).toBe(false);
    expect(hubConnected({ ...env, DDANSSAEM_LOGIN: '' })).toBe(true);
    expect(hubConnected({ DDANSSAEM_HUB_URL: env.DDANSSAEM_HUB_URL })).toBe(false);
    expect(hubLogoutUrl(origin, env)).toBe('https://beta.ddanssaem.com/logout?client_id=class&return_to=https%3A%2F%2Fclass-beta.example%2Fclasses');
    expect(() => startHubLogin(origin, '/classes', { ...env, DDANSSAEM_HUB_URL: 'http://beta.ddanssaem.com' })).toThrow();
  });
});

describe('the hub signed calls', () => {
  const now = Date.parse('2026-10-15T10:00:00Z');
  const iat = Math.floor(now / 1000);

  it('accepts only the HMAC of the exact body with the shared secret', () => {
    const body = JSON.stringify({ type: 'logout', sid: 'hub-sid-1', iat });
    expect(verifyHubSignature(body, sign(body), env)).toBe(true);
    expect(verifyHubSignature(`${body} `, sign(body), env)).toBe(false);
    expect(verifyHubSignature(body, sign(body).toUpperCase(), env)).toBe(true);
    expect(verifyHubSignature(body, null, env)).toBe(false);
    expect(verifyHubSignature(body, 'abc', env)).toBe(false);
  });

  it('reads logout and account_deleted events less than five minutes old', () => {
    expect(parseHubEvent(JSON.stringify({ type: 'logout', sid: 'hub-sid-1', iat }), now)).toEqual({ type: 'logout', sid: 'hub-sid-1' });
    expect(parseHubEvent(JSON.stringify({ type: 'account_deleted', sub: '1234567890', iat: iat - 299 }), now)).toEqual({ type: 'account_deleted', sub: '1234567890' });
    expect(parseHubEvent(JSON.stringify({ type: 'logout', sid: 'hub-sid-1', iat: iat - 301 }), now)).toBeNull();
    expect(parseHubEvent(JSON.stringify({ type: 'other', iat }), now)).toBeNull();
    expect(parseHubEvent('not json', now)).toBeNull();
  });

  it('reads whose summary is asked for', () => {
    expect(parseSummaryRequest(JSON.stringify({ sub: '1234567890', iat }), now)).toEqual({ sub: '1234567890' });
    expect(parseSummaryRequest(JSON.stringify({ sub: '1234567890', iat: iat + 400 }), now)).toBeNull();
  });
});

describe('the 딴쌤 account icon (9)', () => {
  const icon = { v: 1, background: 'mint', face: 'cat', eyes: 'basic', mouth: 'smile', accessory: 'none' };
  it('reads the icon value and its picture address, and refuses anything else', () => {
    const url = 'https://ddanssaem.com/api/avatar/mint.cat.basic.smile.none.svg';
    expect(parseHubIcon(JSON.stringify(icon), url)).toEqual({ avatar: icon, avatarUrl: url });
    expect(parseHubIcon(JSON.stringify({ ...icon, face: 'dragon' }), url)).toBeNull();
    expect(parseHubIcon(JSON.stringify(icon), 'javascript:alert(1)')).toBeNull();
    expect(parseHubIcon(JSON.stringify(icon), 'https://x.example/"onerror="a.svg')).toBeNull();
    expect(parseHubIcon(icon, url)).toBeNull();
  });
  it('builds the hub picture address for an icon the hub sent none for, or none without a hub', () => {
    expect(hubAvatarUrl(icon as never, { DDANSSAEM_HUB_URL: 'https://beta.ddanssaem.com/' })).toBe('https://beta.ddanssaem.com/api/avatar/mint.cat.basic.smile.none.svg');
    expect(hubAvatarUrl(icon as never, {})).toBeNull();
  });
});

describe('the 교사 인증 values (10-2, 10-3)', () => {
  it('reads when the verification ends and from when it is required, and refuses anything else', () => {
    expect(parseTeacherVerification({ verified_until: '2027-10-27T03:00:00Z', required: false, required_from: '2026-11-25T15:00:00.000Z' }))
      .toEqual({ verifiedUntil: '2027-10-27T03:00:00.000Z', requiredFrom: '2026-11-25T15:00:00.000Z' });
    expect(parseTeacherVerification({ verified_until: null, required: true, required_from: '2026-10-27T00:00:00+09:00' }))
      .toEqual({ verifiedUntil: null, requiredFrom: '2026-10-26T15:00:00.000Z' });
    expect(parseTeacherVerification({ verified_until: 'soon', required_from: null })).toBeNull();
    expect(parseTeacherVerification(undefined)).toBeNull();
  });

  it('takes a signed verification_updated event', () => {
    const iat = Math.floor(Date.now() / 1000);
    expect(parseHubEvent(JSON.stringify({ type: 'verification_updated', sub: '123', account_id: 'a',
      teacher_verification: { verified_until: '2027-10-27T03:00:00.000Z', required: false, required_from: null }, iat })))
      .toEqual({ type: 'verification_updated', sub: '123', verification: { verifiedUntil: '2027-10-27T03:00:00.000Z', requiredFrom: null } });
    expect(parseHubEvent(JSON.stringify({ type: 'verification_updated', sub: '123', iat }))).toBeNull();
  });
});
