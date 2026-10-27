// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { setGoogleSessionCookie } from '@/server/googleOAuth';
import { handleClassCreation } from './classCreation';
import { handleClassManagement } from './classManagement';

// 교사 인증 (account-protocol 10-4): new classes, duplicates too, wait for the verification; the rest goes on.
const binding = { accountGeneration: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
const day = 86_400_000;
const BLOCKED = { verifiedUntil: null, requiredFrom: new Date(Date.now() - day).toISOString() };
const GRACE = { verifiedUntil: null, requiredFrom: new Date(Date.now() + 20 * day).toISOString() };
const VERIFIED = { verifiedUntil: new Date(Date.now() + 300 * day).toISOString(), requiredFrom: BLOCKED.requiredFrom };
const EXPIRED = { verifiedUntil: new Date(Date.now() - 2 * day).toISOString(), requiredFrom: BLOCKED.requiredFrom };

function request(path: string, body: unknown) {
  const response = new NextResponse();
  setGoogleSessionCookie(response, { ...binding, subject: 'synthetic-subject', email: 'teacher@example.invalid', name: 'Teacher', issuedAt: Date.now() });
  const headers = new Headers({ 'content-type': 'application/json', origin: 'https://class.example', 'sec-fetch-site': 'same-origin',
    cookie: `class_store_google_auth=${response.cookies.get('class_store_google_auth')!.value}` });
  return new Request(`https://class.example${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
const create = vi.fn(async () => ({ replayed: false, slug: 'new-class' }));
const execute = vi.fn(async () => ({ action: 'RENAME' }));
const creation = (verification: unknown) => handleClassCreation(request('/api/classes', { operationId: '50000000-0000-4000-8000-000000000001', displayName: '새 학급' }),
  { create } as never, async () => verification as never);
const manage = (action: string, verification: unknown) => handleClassManagement(request('/api/classes/my-class/manage',
  { operationId: '50000000-0000-4000-8000-000000000002', action, name: '우리 반 복사본', expectedVersion: '1' }), 'my-class', { execute } as never, async () => verification as never);

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
  vi.stubEnv('DDANSSAEM_LOGIN', '1');
  vi.stubEnv('DDANSSAEM_HUB_URL', 'https://ddanssaem.com');
  vi.stubEnv('DDANSSAEM_CLIENT_SECRET', 's'.repeat(40));
});
afterEach(() => { vi.unstubAllEnvs(); create.mockClear(); execute.mockClear(); });

describe('making a new class waits for 교사 인증', () => {
  it('refuses with the reason and where to verify once the grace ended unverified, or the verification ended', async () => {
    for (const verification of [BLOCKED, EXPIRED]) {
      const response = await creation(verification);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: '교사 인증을 하면 새 학급을 만들 수 있어요.', code: 'TEACHER_VERIFICATION_REQUIRED',
        verifyUrl: 'https://ddanssaem.com/account?verify=1' });
    }
    expect(create).not.toHaveBeenCalled();
  });

  it('lets it through during the grace, when verified, and when nothing is known', async () => {
    for (const verification of [GRACE, VERIFIED, null]) expect((await creation(verification)).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('refuses a duplicate the same way, and leaves renaming, the trash and restoring alone', async () => {
    const duplicate = await manage('DUPLICATE', BLOCKED);
    expect(duplicate.status).toBe(403);
    expect(await duplicate.json()).toMatchObject({ code: 'TEACHER_VERIFICATION_REQUIRED' });
    expect(execute).not.toHaveBeenCalled();
    for (const action of ['RENAME', 'DELETE', 'RESTORE']) expect((await manage(action, BLOCKED)).status).toBe(200);
    expect((await manage('DUPLICATE', VERIFIED)).status).toBe(200);
  });
});
