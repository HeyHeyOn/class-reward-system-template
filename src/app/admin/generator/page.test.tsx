import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/AdminGeneratorPage', () => ({
  AdminGeneratorPage: () => 'generator-page',
}));

const notFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({ notFound }));

describe('/admin/generator page', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    notFound.mockClear();
  });

  it('is unavailable inside self-deployed system apps', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'system');
    const { default: Page } = await import('./page');

    expect(() => Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('is unavailable inside template/system apps even without a refresh token', async () => {
    const { default: Page } = await import('./page');

    expect(() => Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('stays available on the generator web page even when the generator owns a Sheets refresh token', async () => {
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'generator-refresh-token');
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    const { default: Page } = await import('./page');

    expect(() => Page()).not.toThrow();
    expect(notFound).not.toHaveBeenCalled();
  });
});
