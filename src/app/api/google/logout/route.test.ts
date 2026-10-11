import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/server/teacherSession', () => ({ endRequestTeacherSessions: vi.fn(async () => undefined) }));

const mocks = vi.hoisted(() => ({
  clearSession: vi.fn(),
  clearGrant: vi.fn(),
  clearPending: vi.fn(),
}));

vi.mock('@/server/googleOAuth', () => ({
  clearGoogleSessionCookie: mocks.clearSession,
  clearGeneratorGrantCookie: mocks.clearGrant,
  clearPendingAgreementCookie: mocks.clearPending,
}));

import { POST } from './route';

describe('POST /api/google/logout', () => {
  it('clears both the ordinary identity session and separate generator grant', async () => {
    const response = await POST(new Request('https://class.example/api/google/logout', { method: 'POST' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.clearSession).toHaveBeenCalledWith(expect.anything());
    expect(mocks.clearGrant).toHaveBeenCalledWith(expect.anything());
    expect(mocks.clearPending).toHaveBeenCalledWith(expect.anything());
  });
});
