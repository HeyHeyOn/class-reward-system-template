import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';

describe('HomePage deployment modes', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('renders the generator page at the root for the separate generator deployment domain', () => {
    vi.stubEnv('NEXT_PUBLIC_CLASS_STORE_DEPLOYMENT', 'generator');

    render(<HomePage />);

    expect(screen.getByRole('heading', { name: '시스템 생성기' })).toBeTruthy();
    expect(screen.getByTestId('generator-preview').textContent).toContain('0.4.0-phase3');
    expect(screen.queryByText('상품을 골라 담아주세요')).toBeNull();
  });
});
