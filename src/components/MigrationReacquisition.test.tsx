import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MigrationFreezingPage } from './MigrationFreezingPage';

const tenantId = '20000000-0000-4000-8000-000000000001';
const jobId = '30000000-0000-4000-8000-000000000001';
const challengeId = '40000000-0000-4000-8000-000000000001';
const h = 'a'.repeat(64), bootstrapToken = 'b'.repeat(64), confirmToken = 'c'.repeat(64);
const props = { slug: 'alpha', tenantId, sessionKey: 'session-1' };
const base = `/api/c/alpha/migrations/${jobId}/freezing/reacquisition`;
const transport = vi.fn();
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function bootstrap() { return { csrfToken: bootstrapToken, expiresAt: Date.now() + 60_000, scope: 'NONEXECUTING_BOOTSTRAP' }; }
function issued() {
  return { challengeId, intentDigest: h, csrfToken: confirmToken, display: {
    purpose: 'CLASS_STORE_FREEZING_REACQUISITION', bindingVersion: 1, expectedStatus: 'FREEZING', challengeId, tenantId, migrationJobId: jobId,
    expectedStateVersion: '3', sourceId: 'source-1', spreadsheetIdDigest: h, jobSemanticFingerprint: h, sourceAcquisitionDigest: h,
    deploymentId: 'deployment-1', actorUserId: tenantId, actorSubject: 'synthetic-subject', sessionBinding: h, startCeremonyId: jobId,
    executionDigest: h, preflightSnapshotId: `import:${h}`, preflightSnapshotDigest: h, registrationDigest: h, registrationVersion: '1',
    issuedAt: Date.now(), expiresAt: Date.now() + 60_000, action: 'READ_REGISTERED_SOURCE_AND_RECORD_CANDIDATE', spreadsheetId: 'synthetic-sheet',
    authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', finalImportEligible: false, automaticRetry: false, automaticEnable: false,
  } };
}
function candidate(archival = false) { return {
  purpose: 'CLASS_STORE_FREEZING_REACQUISITION', tenantId, challengeId, authority: 'NONAUTHORITY', exclusion: 'NOT_PROVEN', finalImportEligible: false,
  intentDigest: h, candidateDigest: h, auditEventId: `freezing-candidate:${challengeId}:${h}`, nonceDigest: h, executionDigest: h,
  envelopeDigest: h, sheetsDigest: h, redisDigest: h, normalizationDigest: h, observationDigest: h,
  status: 'AUTHENTIC_FREEZING_ACQUISITION', automaticRetry: false, automaticEnable: false, ...(archival ? { scope: 'ARCHIVAL_ONLY' } : {}),
}; }
function mount() { const view = render(<MigrationFreezingPage {...props} />); changeJob(jobId); return view; }
function changeJob(value: string) { fireEvent.change(screen.getByLabelText('jobId'), { target: { value } }); }
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
async function prepare(data = issued()) {
  transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(data));
  click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' });
  click('진단 확인 정보 받기'); await screen.findByLabelText('진단 서버 원본');
}
function confirm() { fireEvent.click(screen.getByLabelText('위 대상의 진단용 읽기에 동의합니다.')); click('진단용 읽기 실행'); }
function hide() { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); fireEvent(document, new Event('visibilitychange')); }
function deferred() { let resolve!: (r: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { transport.mockReset(); vi.stubGlobal('fetch', transport); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('manual diagnostic reacquisition — actual UI, synthetic canonical transport', () => {
  it('mounts without requests and preserves the distinct existing start control', () => {
    mount(); expect(transport).not.toHaveBeenCalled(); expect(screen.getByRole('button', { name: '확인 정보 발급' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '진단 준비' })).toBeTruthy(); expect(screen.getByText(/진단 전용/)).toBeTruthy();
  });
  it('requires a literal canonical UUID and never normalizes invalid input', () => {
    mount(); for (const value of ['job/exact', ` ${jobId}`, jobId.toUpperCase().replace('300', 'ABC'), '..']) {
      changeJob(value); expect((screen.getByRole('button', { name: '진단 준비' }) as HTMLButtonElement).disabled).toBe(true);
    } expect(transport).not.toHaveBeenCalled();
  });
  it('uses separate deliberate bootstrap/challenge/confirm and original-reference archival requests', async () => {
    const data = issued(); mount(); await prepare(data);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(screen.getByLabelText('진단 서버 원본').textContent!)).toEqual(data.display);
    expect((screen.getByRole('button', { name: '진단용 읽기 실행' }) as HTMLButtonElement).disabled).toBe(true);
    transport.mockResolvedValueOnce(response(candidate())); confirm(); await screen.findByLabelText('진단 결과');
    transport.mockResolvedValueOnce(response(candidate(true))); click('진단 보관 상태 조회'); await screen.findByLabelText('진단 보관 결과');
    expect(transport.mock.calls.map(([url]) => url)).toEqual([`${base}/bootstrap`, `${base}/challenge`, base, `${base}/${challengeId}`]);
    for (const [, init] of transport.mock.calls) expect(init).toEqual(expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' }));
    expect(transport.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'GET' }));
    expect(transport.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': bootstrapToken }, body: '{}' }));
    expect(transport.mock.calls[2][1]).toEqual(expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': confirmToken }, body: JSON.stringify({ challengeId, display: data.display }) }));
    expect(transport.mock.calls[3][1]).toEqual(expect.objectContaining({ method: 'GET', headers: { 'x-reacquisition-intent-digest': h } }));
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
    expect(window.location.search).toBe(''); expect(document.body.textContent).not.toContain(confirmToken); expect(document.body.textContent).not.toContain(bootstrapToken);
    for (const [, init] of transport.mock.calls) for (const key of Object.keys(init.headers ?? {})) expect(key).not.toMatch(/cookie|authorization|origin|sec-fetch/i);
    expect(screen.queryByRole('button', { name: /Google 동의/ })).toBeNull();
  });
  it.each([0, 1])('consumes all one-shot actions synchronously for keyboard/mouse detail=%s', async detail => {
    mount(); const first = deferred(); transport.mockReturnValueOnce(first.promise);
    const begin = screen.getByRole('button', { name: '진단 준비' }); act(() => { fireEvent.click(begin, { detail }); fireEvent.click(begin, { detail }); });
    expect(transport).toHaveBeenCalledTimes(1); await act(async () => first.resolve(response(bootstrap())));
    const second = deferred(); transport.mockReturnValueOnce(second.promise); const issue = screen.getByRole('button', { name: '진단 확인 정보 받기' });
    act(() => { fireEvent.click(issue, { detail }); fireEvent.click(issue, { detail }); }); expect(transport).toHaveBeenCalledTimes(2);
    await act(async () => second.resolve(response(issued()))); fireEvent.click(screen.getByLabelText('위 대상의 진단용 읽기에 동의합니다.'));
    const third = deferred(); transport.mockReturnValueOnce(third.promise); const send = screen.getByRole('button', { name: '진단용 읽기 실행' });
    act(() => { fireEvent.click(send, { detail }); fireEvent.click(send, { detail }); }); expect(transport).toHaveBeenCalledTimes(3);
    await act(async () => third.resolve(response(candidate()))); expect(screen.queryByRole('button', { name: '진단용 읽기 실행' })).toBeNull();
  });
  it.each(['scope', 'csrfToken', 'expiresAt', 'extra'])('rejects malformed bootstrap %s without challenge', async field => {
    mount(); transport.mockResolvedValueOnce(response({ ...bootstrap(), [field]: 'invalid' })); click('진단 준비');
    await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: '진단 확인 정보 받기' })).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(['tenantId', 'migrationJobId', 'challengeId', 'purpose', 'action', 'bindingVersion', 'expectedStatus', 'expectedStateVersion', 'registrationVersion',
    'actorUserId', 'startCeremonyId', 'sessionBinding', 'spreadsheetId', 'sourceId', 'deploymentId', 'actorSubject', 'preflightSnapshotId', 'executionDigest',
    'authority', 'exclusion', 'finalImportEligible', 'automaticRetry', 'automaticEnable', 'issuedAt', 'expiresAt', 'extra'])('rejects malformed/cross-bound display %s', async field => {
    mount(); const data = issued(); Object.assign(data.display, { [field]: ['spreadsheetId', 'sourceId', 'deploymentId', 'actorSubject', 'preflightSnapshotId'].includes(field) ? ' invalid ' : 'invalid' });
    transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(data)); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기');
    await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 서버 원본')).toBeNull(); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['csrfToken', 'intentDigest', 'challengeId', 'extra'])('rejects malformed challenge envelope %s', async field => {
    mount(); transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response({ ...issued(), [field]: 'invalid' }));
    click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기'); await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 서버 원본')).toBeNull();
  });
  it('refuses bootstrap synchronizer reused as confirmation synchronizer', async () => {
    mount(); transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response({ ...issued(), csrfToken: bootstrapToken }));
    click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기'); await screen.findByRole('alert'); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['network', 'UNKNOWN', 'refused'])('keeps ambiguous confirmation terminal (%s) and permits manual original-reference status only', async kind => {
    mount(); await prepare();
    if (kind === 'network') transport.mockRejectedValueOnce(Error('DO NOT REFLECT SECRET'));
    else transport.mockResolvedValueOnce(response(kind === 'UNKNOWN' ? { status: 'UNKNOWN', externalEffect: 'UNKNOWN', automaticRetry: false, automaticEnable: false } : { status: 'REFUSED' }, kind === 'UNKNOWN' ? 202 : 403));
    confirm(); await screen.findByRole('alert'); expect(screen.getByRole('alert').textContent).toContain('UNKNOWN');
    expect(screen.queryByRole('button', { name: '진단용 읽기 실행' })).toBeNull(); expect((screen.getByRole('button', { name: '진단 준비' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain('DO NOT REFLECT SECRET'); expect(screen.getByText(/새로고침하면/)).toBeTruthy();
    transport.mockResolvedValueOnce(response({ scope: 'ARCHIVAL_ONLY', status: 'UNKNOWN', automaticRetry: false, automaticEnable: false }));
    click('진단 보관 상태 조회'); expect((await screen.findByLabelText('진단 보관 결과')).textContent).toContain('UNKNOWN'); expect(transport).toHaveBeenCalledTimes(4);
    expect(transport.mock.calls[3][0]).toBe(`${base}/${challengeId}`);
  });
  it.each(['tenantId', 'challengeId', 'intentDigest', 'executionDigest', 'candidateDigest', 'auditEventId', 'authority', 'exclusion', 'finalImportEligible', 'automaticRetry', 'purpose', 'extra'])('rejects malformed/cross-bound candidate %s and retains only archival reference', async field => {
    mount(); await prepare(); transport.mockResolvedValueOnce(response({ ...candidate(), [field]: 'invalid' })); confirm(); await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 결과')).toBeNull(); expect(screen.getByRole('button', { name: '진단 보관 상태 조회' })).toBeTruthy();
  });
  it.each(['tenantId', 'challengeId', 'intentDigest', 'executionDigest', 'scope'])('rejects cross-bound archival response %s', async field => {
    mount(); await prepare(); transport.mockResolvedValueOnce(response(candidate())); confirm(); await screen.findByLabelText('진단 결과');
    transport.mockResolvedValueOnce(response({ ...candidate(true), [field]: 'invalid' })); click('진단 보관 상태 조회'); await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 보관 결과')).toBeNull();
  });
  it('checks bootstrap expiry immediately before challenge POST', async () => {
    mount(); const b = bootstrap(); transport.mockResolvedValueOnce(response(b)); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' });
    vi.spyOn(Date, 'now').mockReturnValue(b.expiresAt); click('진단 확인 정보 받기'); await screen.findByRole('alert'); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('checks confirmation expiry immediately before POST and preserves archival reference', async () => {
    mount(); const data = issued(); await prepare(data); vi.spyOn(Date, 'now').mockReturnValue(data.display.expiresAt); confirm(); await screen.findByRole('alert'); expect(transport).toHaveBeenCalledTimes(2); expect(screen.getByRole('button', { name: '진단 보관 상태 조회' })).toBeTruthy();
  });
  it('rejects late challenge even when its own lifetime is fresh but bootstrap expired', async () => {
    mount(); const b = bootstrap(); const wait = deferred(); transport.mockResolvedValueOnce(response(b)).mockReturnValueOnce(wait.promise);
    click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기');
    vi.spyOn(Date, 'now').mockReturnValue(b.expiresAt); await act(async () => wait.resolve(response(issued()))); await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 서버 원본')).toBeNull();
  });
  it('rejects late successful confirmation after approval expires', async () => {
    mount(); const data = issued(); await prepare(data); const wait = deferred(); transport.mockReturnValueOnce(wait.promise); confirm();
    vi.spyOn(Date, 'now').mockReturnValue(data.display.expiresAt); await act(async () => wait.resolve(response(candidate()))); await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 결과')).toBeNull();
  });
  it('timer expires approval without auto-remint or external actions', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); mount(); transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(issued()));
    await act(async () => click('진단 준비')); await act(async () => click('진단 확인 정보 받기'));
    await act(async () => vi.advanceTimersByTime(60_000)); expect(screen.queryByLabelText('진단 서버 원본')).toBeNull(); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['hidden', 'pagehide'])('discards approval on %s but retains original archival reference in same scope', async event => {
    mount(); await prepare(); act(() => { if (event === 'hidden') hide(); else fireEvent(window, new Event('pagehide')); });
    expect(screen.queryByLabelText('진단 서버 원본')).toBeNull(); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    transport.mockResolvedValueOnce(response(candidate(true))); click('진단 보관 상태 조회'); await screen.findByLabelText('진단 보관 결과'); expect(transport.mock.calls[2][0]).toBe(`${base}/${challengeId}`); expect(transport).toHaveBeenCalledTimes(3);
  });
  it.each(['bootstrap', 'challenge', 'confirm'])('hidden invalidates delayed %s without resurrecting one-shot controls', async phase => {
    mount(); const wait = deferred();
    if (phase === 'confirm') { await prepare(); transport.mockReturnValueOnce(wait.promise); confirm(); }
    else {
      if (phase === 'challenge') { transport.mockResolvedValueOnce(response(bootstrap())); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); }
      transport.mockReturnValueOnce(wait.promise); click(phase === 'bootstrap' ? '진단 준비' : '진단 확인 정보 받기');
    }
    act(hide); await act(async () => wait.resolve(response(phase === 'bootstrap' ? bootstrap() : phase === 'challenge' ? issued() : candidate())));
    expect(screen.queryByLabelText('진단 서버 원본')).toBeNull(); expect(screen.queryByLabelText('진단 결과')).toBeNull(); expect((screen.getByRole('button', { name: '진단 준비' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(['job', 'tenant', 'session', 'unmount'])('clears all references on %s change and ignores old confirmation', async scope => {
    const view = mount(); await prepare(); const wait = deferred(); transport.mockReturnValueOnce(wait.promise); confirm();
    if (scope === 'job') changeJob(challengeId);
    if (scope === 'tenant') view.rerender(<MigrationFreezingPage {...props} slug="beta" tenantId={challengeId} />);
    if (scope === 'session') view.rerender(<MigrationFreezingPage {...props} sessionKey="session-2" />);
    if (scope === 'unmount') view.unmount();
    await act(async () => wait.resolve(response(candidate()))); expect(screen.queryByLabelText('진단 결과')).toBeNull(); expect(screen.queryByRole('button', { name: '진단 보관 상태 조회' })).toBeNull(); expect(transport).toHaveBeenCalledTimes(3);
  });
  it('ignores out-of-order bootstrap from a prior job without unlocking the newer pending request', async () => {
    mount(); const old = deferred(), fresh = deferred(); transport.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    click('진단 준비'); changeJob(challengeId); click('진단 준비'); await act(async () => old.resolve(response(bootstrap())));
    expect(screen.queryByRole('button', { name: '진단 확인 정보 받기' })).toBeNull(); expect((screen.getByRole('button', { name: '진단 준비' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fresh.resolve(response(bootstrap()))); expect(screen.getByRole('button', { name: '진단 확인 정보 받기' })).toBeTruthy(); expect(transport).toHaveBeenCalledTimes(2);
  });
  it('does not consume an untouched diagnostic action just by hiding the tab', () => {
    mount(); act(hide); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    expect((screen.getByRole('button', { name: '진단 준비' }) as HTMLButtonElement).disabled).toBe(false); expect(transport).not.toHaveBeenCalled();
  });
  it.each(['bootstrap', 'challenge', 'confirm'])('times out stalled %s without retry or remint', async phase => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); mount();
    if (phase !== 'bootstrap') { transport.mockResolvedValueOnce(response(bootstrap())); await act(async () => click('진단 준비')); }
    if (phase === 'confirm') { transport.mockResolvedValueOnce(response(issued())); await act(async () => click('진단 확인 정보 받기')); }
    transport.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { if (phase === 'confirm') confirm(); else click(phase === 'bootstrap' ? '진단 준비' : '진단 확인 정보 받기'); });
    const before = transport.mock.calls.length; await act(async () => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('alert').textContent).toContain('UNKNOWN'); expect(transport).toHaveBeenCalledTimes(before);
    expect((screen.getByRole('button', { name: '진단 준비' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('cancels an oversized streaming body before JSON parsing', async () => {
    mount(); const cancel = vi.fn(); let pull = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { pull++; controller.enqueue(new Uint8Array(8192).fill(32)); }, cancel });
    transport.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'application/json' } })); click('진단 준비'); await screen.findByRole('alert');
    expect(cancel).toHaveBeenCalledTimes(1); expect(pull).toBeLessThanOrEqual(4); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('cancels a stalled body at its deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); mount(); const cancel = vi.fn();
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }));
    await act(async () => click('진단 준비')); await act(async () => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('alert')).toBeTruthy(); expect(cancel).toHaveBeenCalledTimes(1); expect(transport).toHaveBeenCalledTimes(1);
  });
  it('consumes a manual archival click synchronously and ignores its late result after scope change', async () => {
    mount(); await prepare(); transport.mockResolvedValueOnce(response(candidate())); confirm(); await screen.findByLabelText('진단 결과');
    const wait = deferred(); transport.mockReturnValueOnce(wait.promise); const read = screen.getByRole('button', { name: '진단 보관 상태 조회' });
    act(() => { fireEvent.click(read); fireEvent.click(read, { detail: 0 }); }); expect(transport).toHaveBeenCalledTimes(4);
    changeJob(challengeId); await act(async () => wait.resolve(response(candidate(true)))); expect(screen.queryByLabelText('진단 보관 결과')).toBeNull();
  });
  it.each(['tenantId', 'migrationJobId', 'challengeId', 'actorUserId', 'startCeremonyId'])('rejects invalid UUID shape in %s before approval', async field => {
    mount(); const data = issued(); Object.assign(data.display, { [field]: '20000000-0000-0000-0000-000000000001' });
    transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(data)); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기'); await screen.findByRole('alert');
    expect(screen.queryByLabelText('진단 서버 원본')).toBeNull();
  });
  it.each(['jobSemanticFingerprint', 'sourceAcquisitionDigest', 'spreadsheetIdDigest', 'preflightSnapshotDigest', 'registrationDigest'])('rejects invalid digest in %s', async field => {
    mount(); const data = issued(); Object.assign(data.display, { [field]: 'invalid' });
    transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(data)); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기'); await screen.findByRole('alert');
  });
  it.each(['tenantId', 'migrationJobId', 'challengeId'])('rejects a well-formed but foreign challenge binding: %s', async field => {
    mount(); const data = issued(); Object.assign(data.display, { [field]: '90000000-0000-4000-8000-000000000001' });
    transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(data)); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기'); await screen.findByRole('alert');
    expect(screen.queryByLabelText('진단 서버 원본')).toBeNull(); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(['tenantId', 'challengeId', 'intentDigest', 'executionDigest'])('rejects a well-formed foreign archival binding: %s', async field => {
    mount(); await prepare(); transport.mockResolvedValueOnce(response(candidate())); confirm(); await screen.findByLabelText('진단 결과');
    transport.mockResolvedValueOnce(response({ ...candidate(true), [field]: field.endsWith('Id') ? '90000000-0000-4000-8000-000000000001' : 'd'.repeat(64) }));
    click('진단 보관 상태 조회'); await screen.findByRole('alert'); expect(screen.queryByLabelText('진단 보관 결과')).toBeNull();
  });
  it.each(['expired', 'future', 'fractional', 'wrong-lifetime'])('rejects numeric challenge lifetime defect: %s', async kind => {
    mount(); const data = issued();
    if (kind === 'expired') { data.display.issuedAt -= 60_000; data.display.expiresAt -= 60_000; }
    if (kind === 'future') { data.display.issuedAt += 30_000; data.display.expiresAt += 30_000; }
    if (kind === 'fractional') { data.display.issuedAt += 0.5; data.display.expiresAt += 0.5; }
    if (kind === 'wrong-lifetime') data.display.expiresAt += 1;
    transport.mockResolvedValueOnce(response(bootstrap())).mockResolvedValueOnce(response(data)); click('진단 준비'); await screen.findByRole('button', { name: '진단 확인 정보 받기' }); click('진단 확인 정보 받기'); await screen.findByRole('alert');
    expect(screen.queryByLabelText('진단 서버 원본')).toBeNull();
  });
  it('accepts maximum bounded text fields while keeping the exact confirmation within canonical POST budget', async () => {
    mount(); const data = issued(); data.display.sourceId = '가'.repeat(512); data.display.deploymentId = '가'.repeat(512);
    data.display.preflightSnapshotId = '가'.repeat(512); data.display.actorSubject = '가'.repeat(255); data.display.spreadsheetId = 's'.repeat(512);
    data.display.expectedStateVersion = String(Number.MAX_SAFE_INTEGER); data.display.registrationVersion = String(Number.MAX_SAFE_INTEGER);
    const outgoing = JSON.stringify({ challengeId, display: data.display });
    expect(new TextEncoder().encode(outgoing).byteLength).toBeLessThanOrEqual(8192);
    await prepare(data); transport.mockResolvedValueOnce(response(candidate())); confirm(); await screen.findByLabelText('진단 결과');
    expect(transport.mock.calls[2][1].body).toBe(outgoing);
  });
  it.each(['oversized', 'redirect', 'content-type', 'invalid-json'])('bounds and refuses hostile response %s', async kind => {
    mount(); let r = response(bootstrap());
    if (kind === 'oversized') r = response({ padding: 'x'.repeat(20_000) });
    if (kind === 'redirect') Object.defineProperty(r, 'redirected', { value: true });
    if (kind === 'content-type') r = new Response(JSON.stringify(bootstrap()), { headers: { 'content-type': 'text/html' } });
    if (kind === 'invalid-json') r = new Response('{', { headers: { 'content-type': 'application/json' } });
    transport.mockResolvedValueOnce(r); click('진단 준비'); await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: '진단 확인 정보 받기' })).toBeNull(); expect(transport).toHaveBeenCalledTimes(1);
  });
});
