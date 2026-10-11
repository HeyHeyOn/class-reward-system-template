// @vitest-environment node
import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const create = vi.hoisted(() => vi.fn());
vi.mock('@/server/repositories/database/classCreation', () => ({
  getProductionClassCreationCommand: () => ({ create }),
}));
import { POST } from './route';
import { setGoogleSessionCookie } from '@/server/googleOAuth';

const binding = { accountGeneration: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
const operationId = '50000000-0000-4000-8000-000000000001';
function request(body: unknown = { operationId, displayName: '새 학급' }, mode = 'valid') {
  vi.stubEnv('AUTH_SECRET', randomBytes(32).toString('hex'));
  const response = new NextResponse();
  setGoogleSessionCookie(response, {
    ...binding, subject: 'synthetic-subject', email: 'teacher@example.invalid', name: 'Teacher',
    issuedAt: mode === 'expired' ? 1 : Date.now(),
  });
  let cookie = response.cookies.get('class_store_google_auth')!.value;
  if (mode === 'tampered') cookie = cookie.slice(0, -5) + 'AAAAA';
  const headers = new Headers({ 'content-type': 'application/json', origin: 'https://class.example', 'sec-fetch-site': 'same-origin' });
  if (mode !== 'missing') headers.set('cookie', `class_store_google_auth=${cookie}`);
  if (mode === 'foreign-origin') headers.set('origin', 'https://foreign.example');
  if (mode === 'no-origin') headers.delete('origin');
  if (mode === 'cross-site') headers.set('sec-fetch-site', 'cross-site');
  if (mode === 'wrong-type') headers.set('content-type', 'text/plain');
  return new Request('https://class.example/api/classes', { method: 'POST', headers, body: JSON.stringify(body) });
}
afterEach(() => { vi.unstubAllEnvs(); create.mockReset(); });
describe('POST /api/classes', () => {
  it.each(['missing', 'expired', 'tampered'])('rejects %s ordinary identity without SQL', async mode => {
    const response = await POST(request(undefined, mode));
    expect(response.status).toBe(401);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['foreign-origin', 'no-origin', 'cross-site', 'wrong-type'])('rejects %s boundary without SQL', async mode => {
    expect((await POST(request(undefined, mode))).status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['subject', 'email', 'user_id', 'tenant_id', 'role', 'lifecycle', 'slug'])('rejects browser authority field %s', async key => {
    expect((await POST(request({ operationId, displayName: '학급', [key]: 'foreign' }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['', ' ', 'x'.repeat(81), 'a\nb', 'a\u202eb'])('rejects invalid name', async displayName => {
    expect((await POST(request({ operationId, displayName }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('bounds streamed bytes even without content-length', async () => {
    expect((await POST(request({ operationId, displayName: 'x'.repeat(9000) }))).status).toBe(413);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects invalid operation IDs', async () => {
    expect((await POST(request({ operationId: '../foreign', displayName: '학급' }))).status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
  it('binds only the decrypted identity and returns the DRAFT result', async () => {
    create.mockResolvedValue({ slug: 'class-50000000-0000-4000-8000-000000000002', displayName: '새 학급', lifecycle: 'DRAFT', role: 'OWNER', replayed: false });
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(create).toHaveBeenCalledExactlyOnceWith({ operationId, displayName: '새 학급', subject: 'synthetic-subject', email: 'teacher@example.invalid', ...binding });
    expect((await response.json()).lifecycle).toBe('DRAFT');
  });
  it('sanitizes an uncertain database failure and does not retry', async () => {
    create.mockRejectedValue(new Error('private database detail'));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('private database detail');
    expect(create).toHaveBeenCalledOnce();
  });
  it.each(['127.0.0.1', '[::1]'])('accepts the exact %s browser origin after Next normalizes the URL to localhost', async host => {
    const original = request();
    const headers = new Headers(original.headers);
    headers.set('host', `${host}:3100`);
    headers.set('origin', `http://${host}:3100`);
    create.mockResolvedValue({ slug: 'class-50000000-0000-4000-8000-000000000002', displayName: '새 학급', lifecycle: 'DRAFT', role: 'OWNER', replayed: false });
    const response = await POST(new Request('http://localhost:3100/api/classes', {
      method: 'POST', headers, body: await original.text(),
    }));
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledOnce();
  });
  it.each([
    ['foreign.example:3100', 'http://foreign.example:3100', 'same-origin'],
    ['127.0.0.1:3101', 'http://127.0.0.1:3101', 'same-origin'],
    ['127.0.0.1:3100', 'http://localhost:3100', 'same-origin'],
    ['127.0.0.1:3100', 'https://127.0.0.1:3100', 'same-origin'],
    ['127.0.0.1:3100', 'http://127.0.0.1:3100', 'cross-site'],
    ['foreign.example@127.0.0.1:3100', 'http://127.0.0.1:3100', 'same-origin'],
  ])('rejects mismatched loopback authority %s / %s / %s without SQL', async (host, origin, site) => {
    const original = request();
    const headers = new Headers(original.headers);
    headers.set('host', host);
    headers.set('origin', origin);
    headers.set('sec-fetch-site', site);
    headers.set('x-forwarded-host', '127.0.0.1:3100');
    const response = await POST(new Request('http://localhost:3100/api/classes', {
      method: 'POST', headers, body: await original.text(),
    }));
    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
});
