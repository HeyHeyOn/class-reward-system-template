// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const store = vi.hoisted(() => ({ classes: vi.fn(), roster: vi.fn(), cardStudent: vi.fn() }));
vi.mock('@/server/ddanssaem/linkRoute', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/server/ddanssaem/linkRoute')>(),
  getProductionLinkStore: () => store,
}));

import { POST as classes } from './classes/route';
import { POST as roster } from './roster/route';
import { POST as verifyCard } from './verify-card/route';

const SECRET = 'l'.repeat(40);
const CLASS = '40000000-0000-4000-8000-000000000001';
const iat = () => Math.floor(Date.now() / 1000);
const call = (route: (request: Request) => Promise<Response>, payload: unknown, secret = SECRET) => {
  const body = JSON.stringify(payload);
  return route(new Request('https://class.example/api/ddanssaem/link/x', {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'x-ddanssaem-signature': createHmac('sha256', secret).update(body).digest('hex') },
  }));
};

beforeEach(() => {
  vi.stubEnv('DDANSSAEM_LINK_SECRET', SECRET);
  vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql');
  vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const mock of Object.values(store)) mock.mockReset();
});

describe('app-links routes', () => {
  it('list the teacher\'s classes, give a roster and check a card', async () => {
    store.classes.mockResolvedValue([{ id: CLASS, name: '5학년 1반', students: 2 }]);
    store.roster.mockResolvedValue({ class: { id: CLASS, name: '5학년 1반' }, students: [{ id: '01', number: 1, name: '가람' }], groups: [], version: 'v1' });
    store.cardStudent.mockResolvedValue({ id: '01', number: 1, name: '가람' });
    expect(await (await call(classes, { iat: iat(), sub: 'teacher' })).json()).toEqual({ classes: [{ id: CLASS, name: '5학년 1반', students: 2 }] });
    expect(await (await call(roster, { iat: iat(), sub: 'teacher', classId: CLASS })).json()).toMatchObject({ groups: [], version: 'v1' });
    expect(store.roster).toHaveBeenCalledWith('teacher', CLASS);
    expect(await (await call(verifyCard, { iat: iat(), sub: 'teacher', classId: CLASS, card: 'DS1:ABC' })).json()).toEqual({ student: { id: '01', number: 1, name: '가람' } });
    expect(store.cardStudent).toHaveBeenCalledWith('teacher', CLASS, 'DS1:ABC', expect.any(Function));
  });

  it('answer 401 to a wrong signature or an old request, 400 to a malformed one and 404 to another teacher\'s class or a card that does not count', async () => {
    expect((await call(classes, { iat: iat(), sub: 'teacher' }, 'w'.repeat(40))).status).toBe(401);
    expect((await call(classes, { iat: iat() - 600, sub: 'teacher' })).status).toBe(401);
    expect((await call(roster, { iat: iat(), sub: 'teacher', classId: 'slug' })).status).toBe(400);
    store.roster.mockResolvedValue(null);
    expect((await call(roster, { iat: iat(), sub: 'teacher', classId: CLASS })).status).toBe(404);
    store.cardStudent.mockResolvedValue(null);
    expect((await call(verifyCard, { iat: iat(), sub: 'teacher', classId: CLASS, card: 'DS1:OLD' })).status).toBe(404);
    store.classes.mockRejectedValue(new Error('down'));
    expect((await call(classes, { iat: iat(), sub: 'teacher' })).status).toBe(503);
  });

  it('stay closed without the link secret', async () => {
    vi.stubEnv('DDANSSAEM_LINK_SECRET', '');
    expect((await call(classes, { iat: iat(), sub: 'teacher' })).status).toBe(404);
    expect(store.classes).not.toHaveBeenCalled();
  });
});
