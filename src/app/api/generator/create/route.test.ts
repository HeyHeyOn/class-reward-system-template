import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/generator/createSpreadsheet', () => ({
  createClassRewardSpreadsheet: vi.fn(async () => ({
    spreadsheetId: 'sheet-123',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-123/edit',
    title: '4학년 1반 - 학급 보상 시스템',
    initializedSheets: ['Students', 'Products'],
    authMode: 'google-login',
  })),
}));

vi.mock('@/server/googleOAuth', () => ({
  getGoogleSessionFromRequest: vi.fn(() => ({
    email: 'teacher@example.com',
    refreshToken: 'refresh-token-123',
    issuedAt: 1,
  })),
}));

import { POST } from './route';

describe('POST /api/generator/create deployment env', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'client-id-123.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'client-secret-123';
    process.env.NEXT_PUBLIC_CLASS_STORE_TEMPLATE_REPO = 'https://github.com/HeyHeyOn/class-reward-system-template';
  });

  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.NEXT_PUBLIC_CLASS_STORE_TEMPLATE_REPO;
  });

  it('returns all Vercel env vars needed for a self-deployed app to access the generated sheet', async () => {
    const request = new Request('https://class-store-generator.vercel.app/api/generator/create', {
      method: 'POST',
      body: JSON.stringify({ selfServiceAcknowledged: true, className: '4학년 1반', adminPasswordConfigured: true }),
    });

    const response = await POST(request);
    const data = await response.json();
    const envByName = Object.fromEntries(data.requiredVercelEnv.map((item: { name: string; value: string; secret: boolean }) => [item.name, item]));

    expect(response.status).toBe(200);
    expect(envByName.GOOGLE_SHEET_ID.value).toBe('sheet-123');
    expect(envByName.GOOGLE_CLIENT_ID.value).toBe('client-id-123.apps.googleusercontent.com');
    expect(envByName.GOOGLE_CLIENT_SECRET.value).toBe('client-secret-123');
    expect(envByName.GOOGLE_REFRESH_TOKEN.value).toBe('refresh-token-123');
    expect(envByName.ADMIN_PASSWORD.value).toBe('teacher@example.com');
    expect(envByName.ADMIN_PASSWORD.secret).toBe(true);
    expect(envByName.AUTH_SECRET.value).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(envByName.AUTH_SECRET.secret).toBe(true);
    expect(data.deploymentGuide.vercelImportUrl).toContain('env=GOOGLE_SHEET_ID%2CGOOGLE_CLIENT_ID%2CGOOGLE_CLIENT_SECRET%2CGOOGLE_REFRESH_TOKEN%2CADMIN_PASSWORD%2CAUTH_SECRET');
    expect(data.deploymentGuide.checklist).toContain('GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN도 함께 입력해야 운영 앱이 시트를 읽고 쓸 수 있습니다.');
  });
});
