import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AVATAR_PRESETS } from '@/components/profile/avatar';
import type { LegalRevision } from '@/lib/legalDocuments';
import { LegalAgreementGate } from './LegalAgreementGate';
import { resetLegalNoticeDismissals } from './legalNoticeDismissal';
import { ProfileView, type ProfileViewModel } from './ProfileView';
import { SignupAgreementView } from './SignupAgreementView';

const revision: LegalRevision = { version: '2026-10-08', effectiveAt: '2026-10-08T00:00:00+09:00', effectiveLabel: '2026년 10월 8일', changes: ['이용약관을 새로 마련했어요.'] };
const upcoming: LegalRevision = { version: '2026-12-01', effectiveAt: '2026-12-01T00:00:00+09:00', effectiveLabel: '2026년 12월 1일', changes: ['과제 기록 보관 기간을 바꿔요.'] };
const expectedSessionId = '22222222-2222-4222-8222-222222222222';
const fetchMock = vi.fn();
const assign = vi.fn();
const reload = vi.fn();
const replace = vi.fn();

function reply(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}
function agreeToEverything() {
  fireEvent.click(screen.getByLabelText('아래 내용에 모두 동의해요'));
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { ...window.location, assign, reload, replace }, configurable: true, writable: true });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetLegalNoticeDismissals();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  assign.mockReset();
  reload.mockReset();
  replace.mockReset();
});

describe('SignupAgreementView', () => {
  it('signs up only after the three required items, then goes where the sign-in was headed', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true, redirectTo: '/c/alpha/admin' }));
    render(<SignupAgreementView expectedSessionId={expectedSessionId} mode="signup" email="new@example.com" changes={[revision]} />);
    expect(screen.getByRole('heading', { name: '딴쌤 클래스 가입' })).toBeTruthy();
    const submit = screen.getByRole('button', { name: '동의하고 가입하기' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/만 14세 이상이에요/));
    fireEvent.click(screen.getByLabelText(/이용약관에 동의해요/));
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/개인정보 수집·이용에 동의해요/));
    expect(submit.disabled).toBe(false);
    expect((screen.getByLabelText('아래 내용에 모두 동의해요') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('link', { name: '이용약관 전문 보기 새 탭 열림' }).getAttribute('href')).toBe('/terms');
    fireEvent.click(screen.getByRole('button', { name: '내용 보기' }));
    expect(screen.getByText('회원 탈퇴 시까지 (탈퇴하면 지체 없이 파기)')).toBeTruthy();

    fireEvent.click(submit);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/c/alpha/admin'));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/agreement', expect.objectContaining({ method: 'POST', body: JSON.stringify({ age: true, terms: true, privacy: true, expectedSessionId }) }));
  });

  it('lets a new teacher leave without signing up', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true }));
    render(<SignupAgreementView expectedSessionId={expectedSessionId} mode="signup" email="new@example.com" changes={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '가입하지 않고 돌아가기' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/classes'));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/agreement', expect.objectContaining({ method: 'DELETE' }));
  });

  it('shows an existing teacher what changed and offers withdrawal instead', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true, redirectTo: '/classes?withdrawn=1' }));
    render(<SignupAgreementView expectedSessionId={expectedSessionId} mode="update" email="kim@example.com" changes={[revision]} classNames={['6학년 3반']} />);
    expect(screen.getByText('이용약관을 새로 마련했어요.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '동의하지 않아요' }));
    expect(screen.getByText(/내가 만든 학급 1개/)).toBeTruthy();
    const withdraw = screen.getByRole('button', { name: '탈퇴하기' }) as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('위 내용을 확인했고, 탈퇴에 동의해요.'));
    fireEvent.click(withdraw);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/classes?withdrawn=1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/withdraw', expect.objectContaining({ body: JSON.stringify({ confirm: true, expectedSessionId }) }));
  });

  it('explains an expired sign-up step', async () => {
    fetchMock.mockReturnValueOnce(reply(401, { error: 'x' }));
    render(<SignupAgreementView expectedSessionId={expectedSessionId} mode="signup" email="new@example.com" changes={[]} />);
    agreeToEverything();
    fireEvent.click(screen.getByRole('button', { name: '동의하고 가입하기' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '가입 시간이 지났어요. 메인 화면에서 Google 로그인을 다시 해 주세요.');
  });
});

describe('LegalAgreementGate', () => {
  it('asks for agreement with a dialog that cannot be dismissed, then reloads', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true }));
    render(<LegalAgreementGate notice={{ required: { current: revision, changes: [revision] }, upcoming: null, expectedSessionId }} />);
    const dialog = screen.getByRole('dialog', { name: '약관 동의가 필요해요' });
    // Rendered outside any themed page, the dialog still has its own surface colours.
    expect(dialog.closest('[style*="--theme-surface"]')).not.toBeNull();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: '닫기' }) as HTMLButtonElement).disabled).toBe(true);
    agreeToEverything();
    fireEvent.click(within(dialog).getByRole('button', { name: '동의하고 계속하기' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).expectedSessionId).toBe(expectedSessionId);
  });

  it('switches to withdrawal when the teacher does not agree, and back', () => {
    render(<LegalAgreementGate notice={{ required: { current: revision, changes: [revision] }, upcoming: null, expectedSessionId }} />);
    fireEvent.click(screen.getByRole('button', { name: '동의하지 않아요' }));
    expect(screen.getByRole('dialog', { name: '회원 탈퇴' })).toBeTruthy();
    expect(screen.getByText('내가 만든 학급이 모두 바로 닫혀요.', { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '돌아가서 동의하기' }));
    expect(screen.getByRole('dialog', { name: '약관 동의가 필요해요' })).toBeTruthy();
  });

  it('announces a coming revision without blocking, and shows nothing when all is agreed', () => {
    const { rerender } = render(<LegalAgreementGate notice={{ required: null, upcoming }} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('2026년 12월 1일부터 이용약관과 개인정보처리방침이 바뀌어요.');
    fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<LegalAgreementGate notice={{ required: null, upcoming: null }} />);
    expect(document.body.textContent).toBe('');
    cleanup();
    resetLegalNoticeDismissals();
    window.sessionStorage.clear();
    render(<LegalAgreementGate notice={{ required: null, upcoming }} />);
    expect(screen.getByRole('status').closest('[style*="--theme-surface"]')).not.toBeNull();
  });

  it('keeps a closed notice away on the next page of this tab, and a refused one away for good', () => {
    render(<LegalAgreementGate notice={{ required: null, upcoming }} />);
    fireEvent.click(screen.getByRole('button', { name: '안내 닫기' }));
    cleanup();
    resetLegalNoticeDismissals();
    render(<LegalAgreementGate notice={{ required: null, upcoming }} />);
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    // A new tab forgets the closed notice, but not '다시 보지 않기'.
    window.sessionStorage.clear();
    resetLegalNoticeDismissals();
    render(<LegalAgreementGate notice={{ required: null, upcoming }} />);
    fireEvent.click(screen.getByRole('button', { name: '다시 보지 않기' }));
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    window.sessionStorage.clear();
    resetLegalNoticeDismissals();
    render(<LegalAgreementGate notice={{ required: null, upcoming }} />);
    expect(screen.queryByRole('status')).toBeNull();

    // A later revision is announced again.
    cleanup();
    render(<LegalAgreementGate notice={{ required: null, upcoming: { ...upcoming, version: '2027-01-01', effectiveLabel: '2027년 1월 1일' } }} />);
    expect(screen.getByRole('status').textContent).toContain('2027년 1월 1일부터');
  });
});

describe('ProfileView', () => {
  const model: ProfileViewModel = {
    email: 'kim@example.com',
    profile: { nickname: '김선생', avatar: AVATAR_PRESETS[0].config },
    agreement: { effectiveLabel: '2026년 10월 8일', agreedAtLabel: '2026년 10월 8일 12:00' },
    classNames: ['6학년 3반', '방과후반'],
    notice: { required: null, upcoming: null, expectedSessionId },
  };

  it('saves the nickname and the avatar', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true }));
    render(<ProfileView model={model} />);
    const save = screen.getByRole('button', { name: '저장하기' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('닉네임'), { target: { value: ' 햇살쌤 ' } });
    fireEvent.click(screen.getByRole('button', { name: `추천 조합: ${AVATAR_PRESETS[2].label}` }));
    fireEvent.click(save);
    expect(await screen.findByText('프로필을 저장했어요.')).toBeTruthy();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ nickname: '햇살쌤', avatar: AVATAR_PRESETS[2].config, expectedSessionId });
    expect(screen.getByRole('heading', { level: 1, name: '햇살쌤' })).toBeTruthy();
  });

  it('refuses an empty or too long nickname', () => {
    render(<ProfileView model={model} />);
    fireEvent.change(screen.getByLabelText('닉네임'), { target: { value: '   ' } });
    expect(screen.getByText('닉네임은 1~20자로 써 주세요.')).toBeTruthy();
    expect((screen.getByRole('button', { name: '저장하기' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the agreement record and withdraws from a confirmation dialog listing the classes', async () => {
    fetchMock.mockReturnValueOnce(reply(200, { ok: true, redirectTo: '/classes?withdrawn=1' }));
    render(<ProfileView model={model} />);
    expect(screen.getByText(/2026년 10월 8일 시행 이용약관과 개인정보처리방침/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '탈퇴하기' }));
    const dialog = screen.getByRole('dialog', { name: '정말 탈퇴할까요?' });
    expect(within(dialog).getByText('6학년 3반, 방과후반')).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText('위 내용을 확인했고, 탈퇴에 동의해요.'));
    fireEvent.click(within(dialog).getByRole('button', { name: '탈퇴하기' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/classes?withdrawn=1'));
  });
});
