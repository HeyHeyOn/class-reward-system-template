import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationFreezingPage } from './MigrationFreezingPage';

const tenantId = '20000000-0000-4000-8000-000000000001';
const challengeId = '30000000-0000-4000-8000-000000000001';
const digest = 'a'.repeat(64);
function issued() {
  const common = { tenantId, migrationJobId: 'job/exact', sourceId: 'source-1', spreadsheetId: 'a'.repeat(64), expectedStateVersion: '7', jobSemanticFingerprint: 'b'.repeat(64), sourceAcquisitionDigest: 'c'.repeat(64), preflightSnapshotId: 'preflight-1', preflightDigest: 'd'.repeat(64), expiresAt: Date.now() + 300_000 };
  return { ...common, challengeId, csrfToken: 'e'.repeat(64), startIntentDigest: digest, startDisplay: { ...common, action: 'DISABLE_LOCAL_WRITER_AND_START_FREEZING', automaticEnable: false, ceremonyId: challengeId, consentChallengeId: challengeId, deploymentId: 'deployment-1', registrationVersion: '2', registrationDigest: 'f'.repeat(64) } };
}
const transport = vi.fn();
const props = { slug: 'alpha', tenantId, sessionKey: 'login-1' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function mount() { return render(<MigrationFreezingPage {...props} />); }
function job() { fireEvent.change(screen.getByLabelText('jobId'), { target: { value: 'job/exact' } }); }
async function challenge() { job(); fireEvent.click(screen.getByRole('button', { name: '확인 정보 발급' })); await screen.findByLabelText('서버 확인 정보'); }
function confirm() { fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: '확인한 작업 시작' })); }
function oauth() { const u = new URL('https://accounts.google.com/o/oauth2/v2/auth'); u.searchParams.set('redirect_uri', `${window.location.origin}/api/migrations/google-sheets/callback`); u.searchParams.set('state', `${challengeId}.synthetic`); return u.href; }
beforeEach(() => { transport.mockReset(); vi.stubGlobal('fetch', transport); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('freezing confirmation UI (synthetic transport, not live E2E)', () => {
  it('does not issue on mount and displays every exact server binding only after a deliberate click', async () => {
    const data = issued(); transport.mockResolvedValue(response(data)); mount(); expect(transport).not.toHaveBeenCalled(); await challenge();
    expect(transport).toHaveBeenCalledWith('/api/c/alpha/migrations/job%2Fexact/freezing/start/challenge', expect.objectContaining({ method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    expect(JSON.parse(screen.getByLabelText('서버 확인 정보').textContent!)).toEqual(data.startDisplay);
    expect((screen.getByRole('button', { name: '확인한 작업 시작' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/NOT_PROVEN/)).toBeTruthy();
  });
  it('posts exact display and synchronizer once, then offers only a validated deliberate Google launch', async () => {
    const data = issued(); transport.mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response({ authorizationUrl: oauth() })); mount(); await challenge();
    const start = screen.getByRole('button', { name: '확인한 작업 시작' });
    fireEvent.click(screen.getByRole('checkbox'));
    act(() => { fireEvent.click(start); fireEvent.click(start); });
    const link = await screen.findByRole('button', { name: 'Google 동의 열기 (새 탭)' });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]).toEqual(['/api/c/alpha/migrations/job%2Fexact/freezing/start', expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrfToken }, body: JSON.stringify({ challengeId, display: data.startDisplay }), credentials: 'same-origin', redirect: 'error' })]);
    expect(link.getAttribute('href')).toBeNull();
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it.each(['https://evil.test/', '//evil.test/', 'javascript:alert(1)', 'https://accounts.google.com.evil.test/o/oauth2/v2/auth', 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://evil.test'])('refuses unsafe authorization URL %s', async authorizationUrl => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    transport.mockResolvedValueOnce(response(issued())).mockResolvedValueOnce(response({ authorizationUrl })); mount(); await challenge(); confirm(); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: /Google 동의/ })).toBeNull(); expect(transport).toHaveBeenCalledTimes(2);
    expect(open).not.toHaveBeenCalled();
  });
  it.each(['tenantId', 'migrationJobId', 'spreadsheetId', 'sourceId', 'jobSemanticFingerprint', 'sourceAcquisitionDigest', 'preflightDigest', 'expectedStateVersion'])('refuses mixed %s without POST', async field => {
    const data = issued(); Object.assign(data.startDisplay, { [field]: 'wrong' }); transport.mockResolvedValue(response(data)); mount(); job(); fireEvent.click(screen.getByText('확인 정보 발급')); await screen.findByRole('alert'); expect(screen.queryByRole('checkbox')).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('drops delayed challenge after job change', async () => {
    let resolve!: (r: Response) => void; transport.mockReturnValue(new Promise(r => { resolve = r; })); mount(); job(); fireEvent.click(screen.getByText('확인 정보 발급')); fireEvent.change(screen.getByLabelText('jobId'), { target: { value: 'other-job' } }); await act(async () => resolve(response(issued()))); expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('clears challenge on session/tenant changes', async () => {
    transport.mockResolvedValue(response(issued())); const view = mount(); await challenge(); view.rerender(<MigrationFreezingPage {...props} sessionKey="login-2" />); expect(screen.queryByRole('checkbox')).toBeNull(); view.rerender(<MigrationFreezingPage {...props} slug="beta" tenantId="other" />); expect(screen.queryByRole('checkbox')).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('expires without reminting and clears on pagehide', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const data = issued(); transport.mockResolvedValue(response(data)); mount(); job();
    await act(async () => { fireEvent.click(screen.getByText('확인 정보 발급')); });
    expect(screen.getByRole('checkbox')).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(300_000); });
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('clears on pagehide and ignores outstanding requests', async () => {
    transport.mockResolvedValue(response(issued())); mount(); await challenge(); fireEvent(window, new Event('pagehide')); expect(screen.queryByRole('checkbox')).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps uncertain POST terminal, never retries or enables', async () => {
    transport.mockResolvedValueOnce(response(issued())).mockRejectedValueOnce(Error('secret upstream')); mount(); await challenge(); confirm(); expect((await screen.findByRole('alert')).textContent).toContain('UNKNOWN'); expect(screen.queryByRole('checkbox')).toBeNull(); expect(transport).toHaveBeenCalledTimes(2); expect(screen.queryByText('secret upstream')).toBeNull();
  });
  it('expires an unused OAuth launch without a second POST', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const data = issued();
    transport.mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response({ authorizationUrl: oauth() }));
    mount(); job();
    await act(async () => { fireEvent.click(screen.getByText('확인 정보 발급')); });
    await act(async () => { confirm(); });
    expect(screen.getByRole('button', { name: /Google 동의/ })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(300_000); });
    expect(screen.queryByRole('button', { name: /Google 동의/ })).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([1, 0])('one-use launch dispatches validated URL once for rapid click detail=%s', async detail => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    transport.mockResolvedValueOnce(response(issued())).mockResolvedValueOnce(response({ authorizationUrl: oauth() }));
    mount(); await challenge(); confirm(); const launch = await screen.findByText('Google 동의 열기 (새 탭)');
    // detail=0 is the native click produced by keyboard activation. Keep both
    // dispatches in one React batch so removal alone cannot enforce one-use.
    launch.addEventListener('click', e => e.preventDefault());
    open.mockImplementation(() => { fireEvent.click(launch, { detail }); return null; });
    act(() => { fireEvent.click(launch, { detail }); fireEvent.click(launch, { detail }); });
    expect(open).toHaveBeenCalledExactlyOnceWith(oauth(), '_blank', 'noopener,noreferrer');
    expect(screen.queryByText('Google 동의 열기 (새 탭)')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull(); // noopener null is not evidence of blocking
    expect(screen.getByText(/팝업이 열리지/)).toBeTruthy();
    expect(screen.getByText(challengeId, { exact: false })).toBeTruthy();
    expect((screen.getByText('확인 정보 발급') as HTMLButtonElement).disabled).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('one-use launch has no auxiliary navigation target and leaves primary launch available', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    transport.mockResolvedValueOnce(response(issued())).mockResolvedValueOnce(response({ authorizationUrl: oauth() }));
    mount(); await challenge(); confirm(); const launch = await screen.findByText('Google 동의 열기 (새 탭)');
    fireEvent(launch, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent(launch, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(open).not.toHaveBeenCalled();
    expect(launch.closest('a[href]')).toBeNull(); // jsdom cannot dispatch native anchor tabs
    expect(launch.tagName).toBe('BUTTON');
    fireEvent.click(launch);
    expect(open).toHaveBeenCalledExactlyOnceWith(oauth(), '_blank', 'noopener,noreferrer');
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('one-use launch refuses expiry at dispatch even before the expiry timer runs', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const data = issued();
    transport.mockResolvedValueOnce(response(data)).mockResolvedValueOnce(response({ authorizationUrl: oauth() }));
    mount(); await challenge(); confirm(); const launch = await screen.findByText('Google 동의 열기 (새 탭)');
    vi.spyOn(Date, 'now').mockReturnValue(data.expiresAt);
    fireEvent.click(launch);
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByText('Google 동의 열기 (새 탭)')).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('shows loading, refuses challenge HTTP errors, and never auto-renews', async () => {
    let finish!: (r: Response) => void;
    transport.mockReturnValue(new Promise(r => { finish = r; })); mount(); job();
    const issue = screen.getByRole('button', { name: '확인 정보 발급' });
    act(() => { fireEvent.click(issue); fireEvent.click(issue); });
    expect(screen.getByRole('status').textContent).toContain('처리 중');
    expect((issue as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish(response({ error: 'do not reflect' }, 403)));
    await screen.findByRole('alert'); expect(transport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByText('do not reflect')).toBeNull();
  });
  it('refuses cross-job archival status and never treats it as success', async () => {
    transport.mockResolvedValueOnce(response(issued())).mockResolvedValueOnce(response({ authorizationUrl: oauth() })).mockResolvedValueOnce(response({ scope: 'ARCHIVAL_ONLY', status: 'STARTED', jobStatus: 'FREEZING', ceremonyId: challengeId, migrationJobId: 'other', executionDigest: digest, exclusion: 'NOT_PROVEN' }));
    mount(); await challenge(); confirm(); await screen.findByRole('button', { name: /Google 동의/ });
    fireEvent.click(screen.getByText('보관 상태 조회')); await screen.findByRole('alert');
    expect(screen.queryByLabelText('보관 상태')).toBeNull(); expect(transport).toHaveBeenCalledTimes(3);
  });
  it.each(['ABSENT', 'STARTED'])('manually reads exact archival references: %s', async status => {
    transport.mockResolvedValueOnce(response(issued())).mockResolvedValueOnce(response({ authorizationUrl: oauth() })).mockResolvedValueOnce(response(status === 'ABSENT' ? { scope: 'ARCHIVAL_ONLY', status } : { scope: 'ARCHIVAL_ONLY', status, jobStatus: 'FREEZING', ceremonyId: challengeId, migrationJobId: 'job/exact', executionDigest: digest, exclusion: 'NOT_PROVEN' }));
    mount(); await challenge(); confirm(); await screen.findByRole('button', { name: /Google 동의/ }); expect(transport).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '보관 상태 조회' })); await screen.findByLabelText('보관 상태');
    expect(transport.mock.calls[2]).toEqual([`/api/c/alpha/migrations/job%2Fexact/freezing/start/${challengeId}`, expect.objectContaining({ method: 'GET', headers: { 'x-start-intent-digest': digest } })]);
    expect(screen.getByLabelText('보관 상태').textContent).toContain(status === 'ABSENT' ? 'UNKNOWN' : 'STARTED'); expect(screen.getByLabelText('보관 상태').textContent).toContain('ARCHIVAL_ONLY');
  });
});
