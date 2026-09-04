import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getGrant: vi.fn(),
}));

vi.mock('@/server/deploymentMode', () => ({
  isGeneratorDeployment: vi.fn(() => true),
}));

vi.mock('@/server/googleOAuth', () => ({
  getGoogleSessionFromRequest: mocks.getSession,
  getGeneratorGrantFromRequest: mocks.getGrant,
}));

import { GET } from './route';

const session = {
  subject: 'google-subject-123',
  email: 'teacher@example.com',
  issuedAt: Date.now(),
};

const grant = {
  purpose: 'generator' as const,
  subject: session.subject,
  email: session.email,
  refreshToken: 'user-refresh-token',
  issuedAt: Date.now(),
};

describe('GET /api/generator/grant', () => {
  beforeEach(() => {
    mocks.getSession.mockReset().mockReturnValue(session);
    mocks.getGrant.mockReset().mockReturnValue(grant);
  });

  it('reports readiness only for a grant bound to the current identity session', async () => {
    const request = new Request('https://generator.example/api/generator/grant');

    const response = await GET(request);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ready: true });
    expect(mocks.getGrant).toHaveBeenCalledWith(request, session);
  });

  it('fails closed when the identity session or matching grant is absent', async () => {
    mocks.getSession.mockReturnValueOnce(null);
    const unauthenticated = await GET(new Request('https://generator.example/api/generator/grant'));
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toEqual({ ready: false });

    mocks.getGrant.mockReturnValueOnce(null);
    const missingGrant = await GET(new Request('https://generator.example/api/generator/grant'));
    expect(missingGrant.status).toBe(200);
    await expect(missingGrant.json()).resolves.toEqual({ ready: false });
  });
});
