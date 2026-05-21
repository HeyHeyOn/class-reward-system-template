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

  it('is unavailable inside self-deployed class store apps', async () => {
    vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'teacher-refresh-token');
    const { default: Page } = await import('./page');

    expect(() => Page()).toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });
});
