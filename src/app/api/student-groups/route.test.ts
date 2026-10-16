// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const repo = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), assign: vi.fn() }));
const auth = vi.hoisted(() => ({ ok: true }));
vi.mock('@/server/apiAuth', () => ({
  isAuthorizedAdminRequest: () => auth.ok,
  unauthorizedAdminResponse: () => Response.json({ error: 'unauthorized' }, { status: 401 }),
}));
vi.mock('@/server/legacyDeploymentMode', () => ({ legacyWriteFreezeResponse: () => null }));
vi.mock('@/server/repositories/configuredStudentGroups', () => ({ createConfiguredStudentGroups: async () => repo }));

import { StudentGroupError } from '@/server/repositories/database/studentGroups';
import { GET, POST } from './route';

const GROUPS = [{ id: '11111111-1111-4111-8111-111111111111', name: '1모둠', students: ['S1'] }];
const post = (body: unknown) => POST(new Request('https://class.example/api/student-groups', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));

afterEach(() => { auth.ok = true; for (const mock of Object.values(repo)) mock.mockReset(); vi.restoreAllMocks(); });

describe('/api/student-groups', () => {
  it('lists the groups and answers each change with the groups as they are now', async () => {
    repo.list.mockResolvedValue(GROUPS);
    expect(await (await GET(new Request('https://class.example/api/student-groups'))).json()).toEqual({ groups: GROUPS });
    repo.create.mockResolvedValue({ id: 'g', name: '2모둠', students: [] });
    const created = await post({ action: 'create', name: '2모둠' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ group: { id: 'g', name: '2모둠', students: [] } });
    expect(await (await post({ action: 'rename', groupId: 'g', name: '별빛' })).json()).toEqual({ groups: GROUPS });
    expect(repo.rename).toHaveBeenCalledWith('g', '별빛');
    await post({ action: 'delete', groupId: 'g' });
    expect(repo.remove).toHaveBeenCalledWith('g');
    await post({ action: 'assign', groupId: null, studentIds: ['S1'] });
    expect(repo.assign).toHaveBeenCalledWith(null, ['S1']);
  });

  it('refuses other callers, unknown actions and extra fields, and passes on the reason a change cannot be made', async () => {
    expect((await post({ action: 'rename', groupId: 'g' })).status).toBe(400);
    expect((await post({ action: 'create', name: 'x', extra: 1 })).status).toBe(400);
    expect((await post({ action: 'drop' })).status).toBe(400);
    repo.create.mockRejectedValue(new StudentGroupError('NAME_TAKEN', '같은 이름의 모둠이 있어요.', 409));
    const taken = await post({ action: 'create', name: '1모둠' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: '같은 이름의 모둠이 있어요.', code: 'NAME_TAKEN' });
    auth.ok = false;
    expect((await post({ action: 'create', name: 'x' })).status).toBe(401);
    expect((await GET(new Request('https://class.example/api/student-groups'))).status).toBe(401);
  });
});
