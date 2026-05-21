import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginPage } from './AdminLoginPage';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('AdminLoginPage', () => {
  afterEach(() => cleanup());

  it('hides Google login when the deployed app already uses a stored Sheets refresh token', () => {
    render(<AdminLoginPage googleLoginEnabled={false} />);

    expect(screen.queryByRole('link', { name: 'Google 계정으로 로그인' })).toBeNull();
    expect(screen.getByText(/이 배포 앱은 생성 시 연결된 Google Sheets 권한으로 동작합니다/)).toBeTruthy();
    expect(screen.getByLabelText('관리자 비밀번호')).toBeTruthy();
  });

  it('shows Google login when explicit Google login is enabled', () => {
    render(<AdminLoginPage googleLoginEnabled />);

    expect(screen.getByRole('link', { name: 'Google 계정으로 로그인' }).getAttribute('href')).toBe('/api/google/login');
  });
});
