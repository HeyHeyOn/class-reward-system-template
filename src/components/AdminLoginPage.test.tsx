import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginPage } from './AdminLoginPage';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function deferredResponse(payload: unknown) {
  let resolve!: () => void;
  const gate = new Promise<void>((res) => { resolve = res; });
  return {
    resolve,
    response: gate.then(() => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  };
}

describe('AdminLoginPage', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('uses the default white theme shell instead of the old blue background', () => {
    const { container } = render(<AdminLoginPage googleLoginEnabled />);

    expect(container.querySelector('main')?.className).toContain('bg-slate-100');
    expect(container.querySelector('main')?.className).not.toContain('bg-[#dbeaf6]');
  });

  it('hides Google login when the deployed app already uses a stored Sheets refresh token', () => {
    render(<AdminLoginPage googleLoginEnabled={false} />);

    expect(screen.queryByRole('link', { name: 'Google 계정으로 로그인' })).toBeNull();
    expect(screen.getAllByText(/Recovery 탭의 recoveryCode/).length).toBeGreaterThan(0);
    expect(screen.getByText(/비밀번호가 틀리거나 기억나지 않으면/)).toBeTruthy();
    expect(screen.getByText(/Google Drive에서 학급 보상 시스템 스프레드시트를 열고/)).toBeTruthy();
    expect(screen.getByLabelText('관리자 비밀번호')).toHaveProperty('placeholder', '비밀번호 또는 복구 코드');
  });

  it('shows Google login when explicit Google login is enabled', () => {
    render(<AdminLoginPage googleLoginEnabled />);

    expect(screen.getByRole('link', { name: 'Google 계정으로 로그인' }).getAttribute('href')).toBe('/api/google/login');
  });

  it('shows a loading dialog after applying a pasted admin QR login value', async () => {
    const loginRequest = deferredResponse({});
    vi.stubGlobal('fetch', vi.fn(async () => loginRequest.response));

    render(<AdminLoginPage googleLoginEnabled={false} />);
    fireEvent.change(screen.getByLabelText('QR 로그인 값'), { target: { value: 'class-store-admin:secret' } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));

    expect(await screen.findByRole('dialog', { name: '관리자 로그인 확인 중' })).toBeTruthy();
    expect(document.body.textContent).toContain('QR을 인식했습니다. 관리자 권한을 확인하는 중입니다.');
    loginRequest.resolve();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/admin/login', expect.objectContaining({ method: 'POST' })));
  });
});
