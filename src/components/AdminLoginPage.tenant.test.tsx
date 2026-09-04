import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AdminLoginPage } from '@/components/AdminLoginPage';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('AdminLoginPage tenant membership mode', () => {
  it('offers only ordinary Google identity login returning to class selection', () => {
    render(<AdminLoginPage membershipOnly />);

    expect(screen.getByRole('link', { name: 'Google 계정으로 로그인' }).getAttribute('href'))
      .toBe('/api/google/login?returnTo=%2Fclasses');
    expect(screen.queryByLabelText('QR 로그인 값')).toBeNull();
    expect(screen.queryByLabelText('관리자 암호')).toBeNull();
  });
});
