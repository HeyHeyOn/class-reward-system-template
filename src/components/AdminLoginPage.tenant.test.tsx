import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginPage } from '@/components/AdminLoginPage';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('AdminLoginPage tenant mode', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('offers only Google sign-in for a class: no password or QR login, and sends nothing to the old login route', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminLoginPage tenantSlug="alpha-class" />);

    const google = screen.getByRole('link', { name: 'Google 계정으로 로그인' });
    expect(google.getAttribute('href')).toBe(`/api/google/login?returnTo=${encodeURIComponent('/c/alpha-class/admin')}`);
    expect(screen.getByText('이 학급을 만든 Google 계정으로 로그인해 주세요.')).toBeTruthy();
    expect(screen.queryByLabelText('QR 로그인 값')).toBeNull();
    expect(screen.queryByLabelText('관리자 비밀번호')).toBeNull();
    expect(screen.queryByRole('button', { name: 'QR로 로그인' })).toBeNull();
    expect(screen.getByRole('link', { name: '메인 화면으로' }).getAttribute('href')).toBe('/classes');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
