import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/HomePage', () => ({ HomePage: () => 'kiosk-page' }));
vi.mock('@/components/AdminGeneratorPage', () => ({ AdminGeneratorPage: () => 'generator-page' }));

describe('root page deployment split', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('renders the generator at / in generator deployments', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    const { default: Home, generateMetadata } = await import('./page');

    expect((Home() as { type: { name?: string } }).type.name).toBe('AdminGeneratorPage');
    expect(generateMetadata()).toEqual({ title: '학급 보상 시스템 생성기' });
  });

  it('renders the kiosk at / in template/system deployments', async () => {
    const { default: Home, generateMetadata } = await import('./page');

    expect((Home() as { type: { name?: string } }).type.name).toBe('HomePage');
    expect(generateMetadata()).toEqual({ title: '학급 매점' });
  });
});
