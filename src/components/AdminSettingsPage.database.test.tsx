import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AdminSettingsPage } from './AdminSettingsPage';

const settings = { source: 'database', settingsVersion: 1, currencyUnit: '원', appTitle: '학급 매점',
  bankTitle: '학급 은행', themeColor: 'white', fontFamily: 'default', qrManualInputEnabled: false };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const SAVED_STATUS = '모든 변경 사항이 저장되어 있습니다.';
const saveButton = () => screen.getByRole('button', { name: '설정 저장' }) as HTMLButtonElement;

it('saves central display settings without asking for Sheets or administrator passwords', async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { ...settings, currencyUnit: '별', settingsVersion: 2 } : settings));
  vi.stubGlobal('fetch', fetcher);
  render(<AdminSettingsPage />);
  await screen.findByText(SAVED_STATUS);
  expect(screen.queryByLabelText('Google Sheets 주소 또는 시트 ID')).toBeNull();
  expect(screen.queryByLabelText('관리자 암호 설정')).toBeNull();
  expect((screen.getByRole('radio', { name: '파랑' }) as HTMLInputElement).checked).toBe(true);
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('학급 화폐 단위'), { target: { value: '별' } });
  fireEvent.click(screen.getByRole('radio', { name: '남색' }));
  fireEvent.click(screen.getByRole('switch', { name: 'QR 값 직접 입력 허용' }));
  expect((screen.getByRole('radio', { name: '남색' }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText('저장하지 않은 변경 사항이 있습니다.')).toBeTruthy();
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await screen.findByText('학급 설정을 저장했습니다.');
  const input = JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body));
  expect(input).toEqual({ operationId: expect.any(String), expectedSettingsVersion: 1, currencyUnit: '별',
    appTitle: '학급 매점', bankTitle: '학급 은행', themeColor: 'navy', fontFamily: 'default', qrManualInputEnabled: true });
});

it('locks edits after an uncertain response and resends the exact request', async () => {
  let posts = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (init?.method !== 'POST') return Response.json(settings);
    if (++posts === 1) throw new TypeError('response lost after commit');
    return Response.json({ ...settings, settingsVersion: 2 });
  });
  vi.stubGlobal('fetch', fetcher); render(<AdminSettingsPage />);
  await screen.findByText(SAVED_STATUS);
  fireEvent.change(screen.getByLabelText('은행 제목'), { target: { value: '우리 은행' } });
  fireEvent.click(saveButton());
  await screen.findByRole('button', { name: '같은 요청으로 다시 확인' });
  expect(screen.getByLabelText('학급 화폐 단위').closest('fieldset')!.disabled).toBe(true);
  expect((screen.getByRole('button', { name: '같은 요청으로 다시 확인' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '같은 요청으로 다시 확인' }));
  await screen.findByText('학급 설정을 저장했습니다.');
  const calls = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(calls).toHaveLength(2); expect(calls[0]).toEqual(calls[1]);
  expect(JSON.parse(String(calls[0][1]!.body))).toMatchObject({ expectedSettingsVersion: 1, bankTitle: '우리 은행' });
});

it('retains conflicting drafts and requires an explicit reload before a new save', async () => {
  let reads = 0;
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: '다른 화면에서 설정을 변경했습니다.' }, { status: 409 })
    : Response.json(++reads === 1 ? settings : { ...settings, appTitle: '다른 교사의 수정', settingsVersion: 2 }));
  vi.stubGlobal('fetch', fetcher); render(<AdminSettingsPage />);
  await screen.findByText(SAVED_STATUS);
  fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '내 입력 유지' } });
  fireEvent.click(saveButton());
  await screen.findByText('다른 화면에서 설정을 변경했습니다.');
  expect((screen.getByLabelText('매점 제목') as HTMLInputElement).value).toBe('내 입력 유지');
  expect(saveButton().disabled).toBe(true);
  // Further edits do not unlock saving until the latest version has been reloaded.
  fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '내 입력 유지 2' } });
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '설정 다시 불러오기' }));
  await waitFor(() => expect((screen.getByLabelText('매점 제목') as HTMLInputElement).value).toBe('다른 교사의 수정'));
  expect(screen.queryByRole('button', { name: '설정 다시 불러오기' })).toBeNull();
  fireEvent.change(screen.getByLabelText('매점 제목'), { target: { value: '다시 저장' } });
  expect(saveButton().disabled).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2));
  const retry = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')[1];
  expect(JSON.parse(String(retry[1]!.body))).toMatchObject({ expectedSettingsVersion: 2, appTitle: '다시 저장' });
});
