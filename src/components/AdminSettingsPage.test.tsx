import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSettingsPage } from './AdminSettingsPage';

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('AdminSettingsPage Seoul-only policy', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
      return response({ classTimeZone: 'Asia/Seoul', spreadsheetId: 'sheet', currencyUnit: '별', appTitle: '매점', bankTitle: '은행', themeColor: 'blue', fontFamily: 'default', qrManualInputEnabled: false, source: 'runtime' });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it.each([
    [503, { error: '설정을 일시적으로 불러오지 못했습니다.', code: 'SETTINGS_UNAVAILABLE' }],
    [503, {}],
    [200, { error: '설정을 일시적으로 불러오지 못했습니다.' }],
  ])('shows a load error without overwriting entered values for status %s and %j', async (status, body) => {
    let finish!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
    render(<AdminSettingsPage />);
    fireEvent.change(screen.getByLabelText('Google Sheets 주소 또는 시트 ID'), { target: { value: 'sheet-123' } });
    fireEvent.change(screen.getByLabelText('학급 화폐 단위'), { target: { value: '별' } });
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '우리 매점' } });
    finish(response(body, status));

    expect(await screen.findByText('현재 설정을 불러오지 못했습니다.')).toBeTruthy();
    expect(screen.getByLabelText('Google Sheets 주소 또는 시트 ID')).toHaveProperty('value', 'sheet-123');
    expect(screen.getByLabelText('학급 화폐 단위')).toHaveProperty('value', '별');
    expect(screen.getByLabelText('매점 제목')).toHaveProperty('value', '우리 매점');
  });

  it('blocks direct form submission until the initial GET succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<AdminSettingsPage />);
    fireEvent.submit(container.querySelector('form')!);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '시스템 설정 저장' })).toHaveProperty('disabled', true);
  });

  it('disables all editing while the initial GET is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(<AdminSettingsPage />);
    for (const control of container.querySelectorAll('input, select')) {
      expect(control.matches(':disabled')).toBe(true);
    }
  });

  it.each(['http', 'network', 'json'])('blocks saves after a %s load failure and recovers through retry', async (failure) => {
    const settings = { spreadsheetId: 'existing-sheet', currencyUnit: '별', appTitle: '기존 매점', bankTitle: '기존 은행', themeColor: 'pink', fontFamily: 'default', qrManualInputEnabled: true, source: 'runtime' };
    let finish!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(async () => {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'json') return new Response('invalid json');
        return response({ error: 'unavailable' }, 503);
      })
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(settings));
    vi.stubGlobal('fetch', fetchSpy);
    const onSettingsSaved = vi.fn();
    const { container } = render(<AdminSettingsPage onSettingsSaved={onSettingsSaved} />);
    await screen.findByText('현재 설정을 불러오지 못했습니다.');
    fireEvent.submit(container.querySelector('form')!);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '시스템 설정 저장' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '설정 다시 불러오기' }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    fireEvent.submit(container.querySelector('form')!);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('매점 제목').matches(':disabled')).toBe(true);
    finish(response(settings));
    await screen.findByDisplayValue('existing-sheet');
    expect(screen.queryByText('현재 설정을 불러오지 못했습니다.')).toBeNull();
    expect(screen.getByLabelText('매점 제목').matches(':disabled')).toBe(false);
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '수정 매점' } });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));
    await waitFor(() => expect(onSettingsSaved).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchSpy.mock.calls[2][1].body)).toMatchObject({ spreadsheetIdOrUrl: 'existing-sheet', appTitle: '수정 매점', currencyUnit: '별' });
  });

  it.each(['http', 'network', 'json'])('preserves edits when a %s save fails', async (failure) => {
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('sheet');
    fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '수정 매점' } });
    fireEvent.change(screen.getByLabelText('관리자 암호 설정'), { target: { value: 'new-password' } });
    vi.mocked(fetch).mockImplementationOnce(async () => {
      if (failure === 'network') throw new Error('offline');
      if (failure === 'json') return new Response('invalid json');
      return response({ error: 'save unavailable' }, 503);
    });
    fireEvent.click(screen.getByRole('button', { name: '시스템 설정 저장' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '시스템 설정 저장' })).toHaveProperty('disabled', false));
    expect(screen.getByLabelText('매점 제목')).toHaveProperty('value', '수정 매점');
    expect(screen.getByLabelText('관리자 암호 설정')).toHaveProperty('value', 'new-password');
  });

  it('does not expose a configurable classroom timezone or PATCH path', async () => {
    render(<AdminSettingsPage />);
    await screen.findByDisplayValue('sheet');

    expect(screen.queryByLabelText('학급 시간대 (IANA)')).toBeNull();
    expect(screen.queryByRole('button', { name: '학급 시간대 적용' })).toBeNull();
    expect(screen.queryByText(/시간대 변경이 아직 적용되지 않았습니다/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
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
