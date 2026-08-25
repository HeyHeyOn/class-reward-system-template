import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSettingsPage } from './AdminSettingsPage';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('AdminSettingsPage classroom timezone', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PATCH') return response({ classTimeZone: 'Europe/Paris', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
      if (init?.method === 'POST') return response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
      return response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it('warns immediately and saves a named IANA timezone through PATCH separately from legacy POST', async () => {
    render(<AdminSettingsPage />);
    expect(await screen.findByDisplayValue('Asia/Seoul')).toBeTruthy();
    expect(screen.getByText(/시간대와 과제 반복 규칙 변경은 즉시 적용/)).toBeTruthy();
    expect(screen.getByText(/직전 완료 상태는 보상 없이 새 회차에 승계/)).toBeTruthy();
    expect(screen.getByText(/다음 경계부터 자연 초기화/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: 'Europe/Paris' } });
    fireEvent.click(screen.getByRole('button', { name: '학급 시간대 저장' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'Europe/Paris' }),
    })));

    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));
    await waitFor(() => {
      const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('classTimeZone');
    });
  });

  it('shows invalid timezone API errors and keeps the controlled value', async () => {
    vi.mocked(fetch).mockImplementation(async (_input, init) => init?.method === 'PATCH'
      ? response({ error: '유효한 IANA 시간대를 입력해 주세요.' }, 400)
      : response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' }));
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('Asia/Seoul');
    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: '+09:00' } });
    fireEvent.click(screen.getByRole('button', { name: '학급 시간대 저장' }));
    expect(await screen.findByText('유효한 IANA 시간대를 입력해 주세요.')).toBeTruthy();
    expect((screen.getByLabelText('학급 시간대 (IANA)') as HTMLInputElement).value).toBe('+09:00');
  });
});
