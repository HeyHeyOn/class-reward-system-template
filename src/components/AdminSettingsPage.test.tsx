import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSettingsPage } from './AdminSettingsPage';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('AdminSettingsPage Seoul-only policy', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:admin-qr'), revokeObjectURL: vi.fn() });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/qrcode')) return new Response('<svg/>', { headers: { 'Content-Type': 'image/svg+xml' } });
      if (init?.method === 'POST') return response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
      return response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('does not expose a configurable classroom timezone or PATCH path', async () => {
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('sheet');

    expect(screen.queryByLabelText('학급 시간대 (IANA)')).toBeNull();
    expect(screen.queryByRole('button', { name: '학급 시간대 적용' })).toBeNull();
    expect(screen.queryByText(/시간대 변경이 아직 적용되지 않았습니다/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('POSTs the admin credential in an exact JSON body and revokes its blob URL', async () => {
    const view = render(<AdminSettingsPage />);
    await screen.findByDisplayValue('sheet');
    fireEvent.change(screen.getByLabelText('관리자 암호 설정'), { target: { value: 'top-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    const image = await screen.findByRole('img', { name: '관리자 로그인 QR' });
    await waitFor(() => expect(image.getAttribute('src')).toBe('blob:admin-qr'));
    expect(fetch).toHaveBeenCalledWith('/api/qrcode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'admin', password: 'top-secret' }), signal: expect.any(AbortSignal),
    });
    expect(vi.mocked(fetch).mock.calls.every(([input]) => !String(input).includes('?value='))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.every(([input]) => !String(input).includes('class-store-admin:'))).toBe(true);
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:admin-qr');
  });

  it('keeps general settings saves free of timezone fields and PATCH requests', async () => {
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('sheet');
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'POST' })));
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('classTimeZone');
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });
});
