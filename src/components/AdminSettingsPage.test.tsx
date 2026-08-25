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

  it('submits a changed named IANA timezone with Enter through PATCH only', async () => {
    render(<AdminSettingsPage />);
    expect(await screen.findByDisplayValue('Asia/Seoul')).toBeTruthy();
    expect(screen.getByText(/시간대와 과제 반복 규칙 변경은 즉시 적용/)).toBeTruthy();
    expect(screen.getByText(/직전 완료 상태는 보상 없이 새 회차에 승계/)).toBeTruthy();
    expect(screen.getByText(/다음 경계부터 자연 초기화/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: 'Europe/Paris' } });
    expect(screen.getByText('시간대 변경이 아직 적용되지 않았습니다.')).toBeTruthy();
    fireEvent.submit(screen.getByLabelText('학급 시간대 설정'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ classTimeZone: 'Europe/Paris' }),
    })));
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps a dirty timezone separate when general settings are saved', async () => {
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('Asia/Seoul');
    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: 'Europe/Paris' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));

    expect(await screen.findByText('시스템 설정을 저장했습니다. 학급 시간대 변경은 별도로 적용해야 합니다.')).toBeTruthy();
    expect((screen.getByLabelText('학급 시간대 (IANA)') as HTMLInputElement).value).toBe('Europe/Paris');
    expect(screen.getByText('시간대 변경이 아직 적용되지 않았습니다.')).toBeTruthy();
    const post = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).not.toHaveProperty('classTimeZone');
  });

  it('updates the applied baseline after PATCH success and disables unchanged or invalid drafts', async () => {
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('Asia/Seoul');
    const saveButton = screen.getByRole('button', { name: '학급 시간대 적용' }) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: '+09:00' } });
    expect(screen.getByText('유효한 IANA 시간대 이름을 입력해 주세요.')).toBeTruthy();
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: 'GMT' } });
    expect(saveButton.disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('학급 시간대 (IANA)'), { target: { value: 'Europe/Paris' } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    expect(await screen.findByText('학급 시간대를 적용했습니다.')).toBeTruthy();
    expect((screen.getByLabelText('학급 시간대 (IANA)') as HTMLInputElement).value).toBe('Europe/Paris');
    expect(saveButton.disabled).toBe(true);
    expect(screen.queryByText('시간대 변경이 아직 적용되지 않았습니다.')).toBeNull();
  });
});
