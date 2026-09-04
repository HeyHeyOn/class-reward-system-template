import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  clearGrant: vi.fn(),
}));

vi.mock('@/server/googleOAuth', () => ({
  clearGoogleSessionCookie: mocks.clearSession,
  clearGeneratorGrantCookie: mocks.clearGrant,
}));

import { POST } from './route';

describe('POST /api/google/logout', () => {
  it('clears both the ordinary identity session and separate generator grant', async () => {
    const response = await POST();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.clearSession).toHaveBeenCalledWith(expect.anything());
    expect(mocks.clearGrant).toHaveBeenCalledWith(expect.anything());
  });
});
