import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';

describe('HomePage deployment modes', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('renders the generator choice page at the root for the separate generator deployment domain', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ enabled: true, authenticated: false }),
    }));

    render(<HomePage />);

    expect(screen.getByRole('heading', { name: '학급 보상 시스템 생성기' })).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('heading', { name: '학급 보상 시스템 만들기' })).toBeTruthy());
    expect(screen.getByRole('button', { name: '새 시스템 생성하기' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '기존 시스템 업데이트하기' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Google로 시작하기' })).toBeNull();
    expect(screen.queryByText('상품을 골라 담아주세요')).toBeNull();
    expect(screen.queryByTestId('generator-preview')).toBeNull();
  });
});
