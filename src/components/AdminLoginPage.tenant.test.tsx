import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminLoginPage } from '@/components/AdminLoginPage';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('AdminLoginPage tenant mode', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('keeps Google membership login and offers the imported compatibility paths', () => {
    render(<AdminLoginPage tenantScoped />);

    expect(screen.getByRole('link', { name: 'Google 계정으로 로그인' })).toBeTruthy();
    expect(screen.getByLabelText('QR 로그인 값')).toBeTruthy();
    expect(screen.getByLabelText('관리자 비밀번호')).toBeTruthy();
  });

  it('uses tenantFetch with an explicit kind and preserves the QR prefix only in the body', async () => {
    window.history.replaceState({}, '', '/c/alpha-class/admin/login');
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json({ ok: true }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<AdminLoginPage tenantScoped />);
    const credential = 'class-store-admin:secret-value';
    fireEvent.change(screen.getByLabelText('QR 로그인 값'), { target: { value: credential } });
    fireEvent.click(screen.getByRole('button', { name: '적용' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/c/alpha-class/admin/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'qr', value: credential }),
    }));
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain('secret-value');
  });
});
