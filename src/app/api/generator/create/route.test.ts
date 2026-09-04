import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSpreadsheet: vi.fn(async () => ({
    spreadsheetId: 'sheet-123',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
    title: '4학년 1반 - 학급 보상 시스템',
    initializedSheets: ['Students', 'Products'],
    authMode: 'google-login',
  })),
  getSession: vi.fn(() => ({
    subject: 'google-subject-123',
    email: 'teacher@example.com',
    issuedAt: Date.now(),
  })),
  getGrant: vi.fn(() => ({
    purpose: 'generator' as const,
    subject: 'google-subject-123',
    email: 'teacher@example.com',
    refreshToken: 'consenting-user-refresh-token',
    grantId: 'grant-id-that-is-at-least-thirty-two-characters',
    expiresAt: Date.now() + 600_000,
    clientFingerprint: 'a'.repeat(64),
    issuedAt: Date.now(),
  })),
  clearGrant: vi.fn(),
  revokeGrant: vi.fn(async () => undefined),
  claimGrant: vi.fn(async () => true),
}));

vi.mock('@/generator/createSpreadsheet', () => ({
  createClassRewardSpreadsheet: mocks.createSpreadsheet,
}));

vi.mock('@/server/googleOAuth', () => ({
  getGoogleSessionFromRequest: mocks.getSession,
  getGeneratorGrantFromRequest: mocks.getGrant,
  clearGeneratorGrantCookie: mocks.clearGrant,
  revokeGeneratorGrant: mocks.revokeGrant,
}));

vi.mock('@/server/repositories/configuredGeneratorGrantClaims', () => ({
  claimGeneratorGrant: mocks.claimGrant,
}));

import { POST } from './route';

function createRequest() {
  return new Request('https://class-store-generator.vercel.app/api/generator/create', {
    method: 'POST',
    body: JSON.stringify({ selfServiceAcknowledged: true, className: '4학년 1반', adminPasswordConfigured: true }),
  });
}

describe('POST /api/generator/create deployment env', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'client-id-123.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'ordinary-legacy-secret');
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_ID', 'generator-client-id.apps.googleusercontent.com');
    vi.stubEnv('GENERATOR_GOOGLE_CLIENT_SECRET', 'generator-client-secret-123');
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'central-deployment-refresh-token');
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_TEMPLATE_REPO', 'https://github.com/HeyHeyOn/class-reward-system-template');
    mocks.createSpreadsheet.mockClear();
    mocks.getSession.mockClear();
    mocks.getGrant.mockClear();
    mocks.clearGrant.mockClear();
    mocks.revokeGrant.mockClear();
    mocks.claimGrant.mockReset();
    mocks.claimGrant.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses and returns only the consenting user grant, never the central deployment token', async () => {
    const request = createRequest();

    const response = await POST(request);
    const data = await response.json();
    const envByName = Object.fromEntries(data.requiredVercelEnv.map((item: { name: string; value: string; secret: boolean }) => [item.name, item]));

    expect(response.status).toBe(200);
    expect(mocks.createSpreadsheet).toHaveBeenCalledWith(expect.any(Object), request, expect.objectContaining({
      refreshToken: 'consenting-user-refresh-token',
      subject: 'google-subject-123',
    }));
    expect(mocks.claimGrant).toHaveBeenCalledWith(expect.objectContaining({
      grantId: 'grant-id-that-is-at-least-thirty-two-characters',
    }));
    expect(envByName.GOOGLE_REFRESH_TOKEN.value).toBe('consenting-user-refresh-token');
    expect(envByName.GOOGLE_CLIENT_ID.value).toBe('generator-client-id.apps.googleusercontent.com');
    expect(envByName.GOOGLE_CLIENT_SECRET.value).toBe('generator-client-secret-123');
    expect(JSON.stringify(data)).not.toContain('client-id-123.apps.googleusercontent.com');
    expect(JSON.stringify(data)).not.toContain('ordinary-legacy-secret');
    expect(JSON.stringify(data)).not.toContain('central-deployment-refresh-token');
    expect(envByName.ADMIN_PASSWORD.value).toBe('teacher@example.com');
    expect(envByName.AUTH_SECRET.value).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(data.deploymentGuide.vercelImportUrl).toContain('env=GOOGLE_SHEET_ID%2CGOOGLE_CLIENT_ID%2CGOOGLE_CLIENT_SECRET%2CGOOGLE_REFRESH_TOKEN%2CADMIN_PASSWORD%2CAUTH_SECRET');
    expect(mocks.clearGrant).toHaveBeenCalledOnce();
    expect(mocks.revokeGrant).not.toHaveBeenCalled();
  });

  it('rejects creation unless both the ordinary identity session and matching generator grant exist', async () => {
    mocks.getGrant.mockReturnValueOnce(null as never);

    const response = await POST(createRequest());
    const data = await response.json();

    expect(response.status).toBe(401);
    expect(data.error).toMatch(/Google.*권한/);
    expect(mocks.createSpreadsheet).not.toHaveBeenCalled();
    expect(mocks.clearGrant).toHaveBeenCalledOnce();
  });

  it('revokes the user grant and clears its cookie when spreadsheet creation fails', async () => {
    mocks.createSpreadsheet.mockRejectedValueOnce(new Error('Sheets create failed'));

    const response = await POST(createRequest());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Sheets create failed');
    expect(mocks.revokeGrant).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: 'consenting-user-refresh-token' }));
    expect(mocks.clearGrant).toHaveBeenCalledOnce();
  });

  it('fails closed without revoking the winner token when a grant was already claimed', async () => {
    mocks.claimGrant.mockResolvedValueOnce(false);

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(mocks.createSpreadsheet).not.toHaveBeenCalled();
    expect(mocks.revokeGrant).not.toHaveBeenCalled();
    expect(mocks.clearGrant).toHaveBeenCalledOnce();
  });

  it('fails closed and revokes before side effects when durable claim storage is unavailable', async () => {
    mocks.claimGrant.mockRejectedValueOnce(new Error('DATABASE_URL is required'));

    const response = await POST(createRequest());
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toMatch(/DATABASE_URL/);
    expect(mocks.createSpreadsheet).not.toHaveBeenCalled();
    expect(mocks.revokeGrant).toHaveBeenCalledOnce();
    expect(mocks.clearGrant).toHaveBeenCalledOnce();
  });
});
