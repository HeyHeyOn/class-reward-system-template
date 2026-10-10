import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const database = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/server/db/client', () => ({ getDatabaseClient: () => ({ pool: database }) }));

import { POST as adminLogout } from '@/app/api/admin/logout/route';
import { POST as googleLogout } from '@/app/api/google/logout/route';

const raw = 'A'.repeat(43), token = `csa1.1.${raw}`;

describe('administrator logout', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CLASS_STORE_STORAGE', 'postgresql'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each([['Google', googleLogout], ['password', adminLogout]] as const)(
    '%s logout revokes a leftover password/QR session and clears every admin cookie including mixed identity', async (_name, logout) => {
      const request = new Request('https://class.example/api/admin/logout', { method: 'POST', headers: {
        cookie: `class_store_tenant_admin=${token}; class_store_google_auth=synthetic; class_store_admin=synthetic; class_store_generator_grant=synthetic`,
      } });
      database.query.mockImplementation(async (_sql: string, params: unknown[]) => {
        expect(params).toEqual([createHash('sha256').update(raw).digest('hex'), 1]);
        return { rows: [] };
      });
      const response = await logout(request);
      expect(response.status).toBe(200);
      expect(database.query).toHaveBeenCalledOnce();
      expect(response.cookies.getAll().map(c => [c.name, c.maxAge])).toEqual(expect.arrayContaining([
        ['class_store_tenant_admin', 0], ['class_store_google_auth', 0], ['class_store_admin', 0], ['class_store_generator_grant', 0],
      ]));
      expect(response.cookies.get('class_store_tenant_admin')).toMatchObject({ path: '/', secure: true, httpOnly: true, sameSite: 'lax' });
    },
  );

  it('does not claim success or discard the retry cookie when server revocation fails', async () => {
    database.query.mockRejectedValue(new Error('synthetic unavailable'));
    const response = await googleLogout(new Request('https://class.example/api/google/logout', {
      method: 'POST', headers: { cookie: `class_store_tenant_admin=${token}` },
    }));
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).not.toContain('synthetic unavailable');
  });

  it.each(['', 'class_store_tenant_admin=malformed', 'class_store_tenant_admin=%ZZ'])(
    'is idempotent for absent or invalid cookies without database access (%s)', async cookie => {
      const response = await adminLogout(new Request('https://class.example/api/admin/logout', { method: 'POST', headers: { cookie } }));
      expect(response.status).toBe(200);
      expect(database.query).not.toHaveBeenCalled();
      expect(response.cookies.get('class_store_tenant_admin')?.maxAge).toBe(0);
    },
  );
});
