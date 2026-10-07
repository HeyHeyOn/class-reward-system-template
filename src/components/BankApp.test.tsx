import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BankApp } from './BankApp';
import { contrastRatio, THEME_PALETTES, type ThemeColor } from './uiTheme';

// The camera scanner is replaced by a button that "scans" a fixed value; QrScanner itself is shared.
vi.mock('./QrScanner', () => ({
  QrScanner: ({ onScan }: { onScan: (value: string) => void }) => (
    <button type="button" onClick={() => onScan('csq1.scanned-card')}>테스트 QR 스캔</button>
  ),
}));

const OPERATION_ID = '10000000-0000-4000-8000-000000000001';
const SECOND_OPERATION_ID = '20000000-0000-4000-8000-000000000002';

type Task = {
  taskId: string; title: string; description: string; reward: number; stage: 'PENDING' | 'READY' | 'COMPLETED';
  completable: boolean; blockedReason?: string; dueAt?: string; recurrence?: unknown; prerequisiteTitle?: string;
};

const PROFILE = { student: { studentId: 'S001', name: '김민준', balance: 1200 }, session: { expiresAt: '2026-10-13T00:00:00.000Z' } };
const SETTINGS = { appTitle: '별빛 매점', bankTitle: '별빛 은행', currencyUnit: '원', themeColor: 'green', fontFamily: 'nanum-barun-gothic', qrManualInputEnabled: false };
const TASKS: Task[] = [
  { taskId: 'T1', title: '책 10분 읽기', description: '책을 10분 읽었으면 완료해요.', reward: 5, stage: 'READY', completable: true, dueAt: '2030-01-02T03:30:00.000Z' },
  { taskId: 'T2', title: '독서 감상문', description: '감상문을 써요.', reward: 20, stage: 'READY', completable: false, blockedReason: "먼저 '책 10분 읽기' 과제를 완료해야 해요.", prerequisiteTitle: '책 10분 읽기' },
  { taskId: 'T3', title: '교실 청소', description: '청소 당번 활동', reward: 7, stage: 'PENDING', completable: false },
  { taskId: 'T4', title: '받아쓰기', description: '', reward: 3, stage: 'COMPLETED', completable: false },
];
const TRANSACTIONS = [
  { transactionId: 'X5', occurredAt: '2026-10-06T05:00:00.000Z', kind: 'CANCELLATION', amount: 3, balanceAfter: 1200, cancelled: false },
  { transactionId: 'X4', occurredAt: '2026-10-06T04:00:00.000Z', kind: 'PURCHASE', detail: '지우개', amount: -3, balanceAfter: 1197, cancelled: true, cancelledAt: '2026-10-06T05:00:00.000Z' },
  { transactionId: 'X3', occurredAt: '2026-10-05T03:00:00.000Z', kind: 'TEACHER_DEDUCT', amount: -100, balanceAfter: 1200, cancelled: false },
  { transactionId: 'X2', occurredAt: '2026-10-05T02:00:00.000Z', kind: 'TEACHER_GRANT', amount: 1000, balanceAfter: 1300, cancelled: false },
  { transactionId: 'X1', occurredAt: '2026-10-04T01:00:00.000Z', kind: 'TASK_REWARD', amount: 5, balanceAfter: 300, cancelled: false },
  { transactionId: 'X0', occurredAt: '2026-10-04T00:00:00.000Z', kind: 'PURCHASE', detail: '연필 ×2', amount: -8, balanceAfter: 295, cancelled: false },
];

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

function completionSuccess(operationId: string, balance = 1205) {
  return {
    operation: { operationId, state: 'SUCCESS' },
    task: { taskId: 'T1', title: '책 10분 읽기', reward: 5 },
    tasks: [{ ...TASKS[1], completable: true, blockedReason: undefined }, TASKS[2], { ...TASKS[0], stage: 'COMPLETED', completable: false }, TASKS[3]]
      .map((task) => JSON.parse(JSON.stringify(task))),
    student: { name: '김민준', balance },
  };
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;
let state: { loggedIn: boolean; settings: Record<string, unknown>; tasks: Task[]; complete?: Handler; extra?: Handler };

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const custom = state.extra?.(url, init);
    if (custom) return custom;
    if (url === '/api/settings') return json(state.settings);
    if (url === '/api/bank/session' && method === 'GET') {
      return state.loggedIn ? json(PROFILE) : json({ error: '다시 로그인해 주세요.', code: 'BANK_SESSION_REQUIRED' }, 401);
    }
    if (url === '/api/bank/session' && method === 'POST') {
      state.loggedIn = true;
      return json(PROFILE);
    }
    if (url === '/api/bank/session' && method === 'DELETE') {
      state.loggedIn = false;
      return json({ ok: true });
    }
    if (url === '/api/bank/me/tasks') return json({ tasks: state.tasks });
    if (url === '/api/bank/me/transactions') return json({ balance: 1200, transactions: TRANSACTIONS, limit: 100 });
    if (url.startsWith('/api/bank/me/tasks/') && method === 'POST') {
      const custom = state.complete?.(url, init);
      if (custom) return custom;
      return json(completionSuccess(JSON.parse(String(init?.body)).operationId));
    }
    return json({ error: 'not found' }, 404);
  }));
}

function calls(predicate: (url: string, init: RequestInit | undefined) => boolean) {
  return vi.mocked(fetch).mock.calls.filter(([url, init]) => predicate(String(url), init));
}

function completionCalls() {
  return calls((url, init) => url.includes('/complete') && init?.method === 'POST');
}

/** The home '내 과제' menu once the task summary has loaded. */
function tasksMenu() {
  return screen.findByRole('button', { name: /^내 과제, 완료 가능/ });
}

async function renderLoggedIn() {
  state.loggedIn = true;
  const view = render(<BankApp />);
  await screen.findByTestId('bank-balance');
  await tasksMenu();
  return view;
}

/** Opens '내 과제' from the home menu and waits for the list. */
async function openTasks() {
  fireEvent.click(await tasksMenu());
  expect(await screen.findByRole('heading', { name: '내 과제' })).toBeTruthy();
  await screen.findByRole('heading', { name: '책 10분 읽기' });
}

async function renderTasks() {
  const view = await renderLoggedIn();
  await openTasks();
  return view;
}

function readyCard(title: string) {
  return screen.getByRole('article', { name: title });
}

beforeEach(() => {
  state = { loggedIn: false, settings: { ...SETTINGS }, tasks: TASKS.map((task) => ({ ...task })) };
  let next = 0;
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: vi.fn(() => [OPERATION_ID, SECOND_OPERATION_ID][next++] ?? SECOND_OPERATION_ID) });
  window.sessionStorage.clear();
  installFetch();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('BankApp login', () => {
  it('shows only the QR login page before login and loads no personal data', async () => {
    render(<BankApp />);
    expect(await screen.findByRole('heading', { name: '내 QR 코드로 로그인해요' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '별빛 은행' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'QR 코드 찍기' })).toBeTruthy();
    expect(screen.queryByLabelText('QR 코드 값 직접 입력')).toBeNull();
    expect(screen.queryByTestId('bank-balance')).toBeNull();
    expect(screen.queryByRole('heading', { name: '내 과제' })).toBeNull();
    expect(calls((url) => url.startsWith('/api/bank/me/'))).toHaveLength(0);
  });

  it('logs in with the scanned QR sent only in a POST body, then shows name and balance', async () => {
    render(<BankApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'QR 코드 찍기' }));
    fireEvent.click(screen.getByRole('button', { name: '테스트 QR 스캔' }));

    expect(await screen.findByText('김민준님, 안녕하세요!')).toBeTruthy();
    expect(screen.getByTestId('bank-balance').textContent).toBe('1,200원');
    expect(calls((url, init) => url === '/api/bank/session' && init?.method === 'POST')).toEqual([['/api/bank/session', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentQr: 'csq1.scanned-card' }),
    })]]);
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes('csq1'))).toBe(true);
    // After login no request carries the QR or a student ID: the server uses the session cookie.
    await openTasks();
    for (const [url, init] of calls((url) => url.startsWith('/api/bank/me/'))) {
      expect(url).not.toContain('S001');
      expect(String(init?.body ?? '')).not.toContain('S001');
    }
  });

  it('offers manual QR entry only when the class allows it', async () => {
    state.settings = { ...SETTINGS, qrManualInputEnabled: true };
    render(<BankApp />);
    const input = await screen.findByLabelText('QR 코드 값 직접 입력');
    fireEvent.change(input, { target: { value: '  S001 ' } });
    fireEvent.click(screen.getByRole('button', { name: '로그인' }));
    expect(await screen.findByTestId('bank-balance')).toBeTruthy();
    expect(calls((url, init) => url === '/api/bank/session' && init?.method === 'POST')[0][1]?.body).toBe(JSON.stringify({ studentQr: 'S001' }));
  });

  it('shows a friendly error when the QR cannot be checked and lets the same card be scanned again', async () => {
    let attempts = 0;
    state.extra = (url, init) => {
      if (url !== '/api/bank/session' || init?.method !== 'POST') return undefined;
      attempts += 1;
      if (attempts === 1) return json({ error: 'QR을 확인할 수 없어요. 선생님께 알려 주세요.', code: 'QR_UNAVAILABLE' }, 503);
      state.loggedIn = true;
      return json(PROFILE);
    };
    render(<BankApp />);
    fireEvent.click(await screen.findByRole('button', { name: 'QR 코드 찍기' }));
    fireEvent.click(screen.getByRole('button', { name: '테스트 QR 스캔' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('QR을 확인할 수 없어요. 선생님께 알려 주세요.');
    expect(screen.queryByTestId('bank-balance')).toBeNull();

    fireEvent.click(await screen.findByRole('button', { name: '테스트 QR 스캔' }));
    expect(await screen.findByTestId('bank-balance')).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it('restores a saved session on reload without asking for the QR again', async () => {
    state.loggedIn = true;
    render(<BankApp />);
    expect(await screen.findByText('김민준님, 안녕하세요!')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '내 QR 코드로 로그인해요' })).toBeNull();
    expect(calls((url, init) => url === '/api/bank/session' && init?.method === 'POST')).toHaveLength(0);
  });

  it('offers a retry instead of the login page when the bank cannot be reached', async () => {
    state.extra = (url, init) => (url === '/api/bank/session' && (init?.method ?? 'GET') === 'GET' && !state.loggedIn
      ? json({ error: 'down', code: 'BANK_DATA_UNAVAILABLE' }, 503) : undefined);
    render(<BankApp />);
    expect(await screen.findByText('은행에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.')).toBeTruthy();
    state.loggedIn = true;
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByTestId('bank-balance')).toBeTruthy();
  });
});

describe('BankApp home and history', () => {
  it('applies the class theme, font and title to the bank shell', async () => {
    const { container } = await renderLoggedIn();
    const shell = container.querySelector('[data-testid="bank-shell"]');
    expect(shell?.getAttribute('data-theme')).toBe('green');
    const style = shell?.getAttribute('style') ?? '';
    expect(style).toContain(`--theme-shell: ${THEME_PALETTES.green.shell}`);
    expect(style).toContain(`--theme-accent-solid: ${THEME_PALETTES.green.accentSolid}`);
    expect(style).toContain('NanumBarunGothic');
    expect(shell?.className).toContain('bg-[var(--theme-shell)]');
    expect(screen.getByRole('heading', { name: '별빛 은행' })).toBeTruthy();
    const balanceButton = screen.getByRole('button', { name: '내 잔액 1,200원, 거래 내역 보기' });
    expect(balanceButton.className).toContain('bg-[var(--theme-accent-solid)]');
    expect(balanceButton.className).not.toMatch(/\b(bg|text|border)-\[#[0-9A-Fa-f]{6}\]/);
  });

  it.each(Object.keys(THEME_PALETTES) as ThemeColor[])('keeps the %s balance card readable', (themeColor) => {
    const palette = THEME_PALETTES[themeColor];
    expect(contrastRatio(palette.accentOnSolid, palette.accentSolid)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.mutedText, palette.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('opens a detailed, newest-first history from the balance and returns home', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByRole('button', { name: '내 잔액 1,200원, 거래 내역 보기' }));
    expect(await screen.findByRole('heading', { name: '거래 내역' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: '거래 목록' });
    const rows = within(list).getAllByTestId(/^bank-transaction-X\d$/);
    expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual(TRANSACTIONS.map((row) => `bank-transaction-${row.transactionId}`));
    expect(within(rows[0]).getByText('거래 취소')).toBeTruthy();
    expect(within(rows[1]).getByText('매점 구매')).toBeTruthy();
    expect(within(rows[1]).getByText('취소됨')).toBeTruthy();
    expect(screen.getByTestId('bank-transaction-amount-X4').className).toContain('line-through');
    expect(within(rows[2]).getByText('선생님 회수')).toBeTruthy();
    expect(within(rows[3]).getByText('선생님 지급')).toBeTruthy();
    expect(within(rows[4]).getByText('과제 보상')).toBeTruthy();
    expect(screen.getByTestId('bank-transaction-amount-X2').textContent).toBe('+1,000원');
    expect(screen.getByTestId('bank-transaction-amount-X0').textContent).toBe('-8원');
    expect(rows[5].textContent).toContain('연필 ×2');
    expect(rows[5].textContent).toContain('잔액 295원');
    expect(calls((url) => url === '/api/bank/me/transactions')).toHaveLength(1);

    fireEvent.click(screen.getByRole('group', { name: '거래 필터' }).querySelectorAll('button')[1]);
    expect(within(screen.getByRole('list', { name: '거래 목록' })).getAllByTestId(/^bank-transaction-X\d$/).map((row) => row.getAttribute('data-testid')))
      .toEqual(['bank-transaction-X5', 'bank-transaction-X2', 'bank-transaction-X1']);

    fireEvent.click(screen.getByRole('button', { name: '홈으로 돌아가기' }));
    expect(await screen.findByTestId('bank-balance')).toBeTruthy();
  });

  it('shows the empty history state', async () => {
    state.extra = (url) => (url === '/api/bank/me/transactions' ? json({ balance: 0, transactions: [], limit: 100 }) : undefined);
    await renderLoggedIn();
    fireEvent.click(screen.getByRole('button', { name: /거래 내역 보기/ }));
    expect(await screen.findByText('아직 거래 내역이 없어요')).toBeTruthy();
  });

  it('logs out and returns to the login page', async () => {
    await renderLoggedIn();
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByRole('heading', { name: '내 QR 코드로 로그인해요' })).toBeTruthy();
    expect(screen.getByText('로그아웃했어요. 다음에 또 만나요!')).toBeTruthy();
    expect(calls((url, init) => url === '/api/bank/session' && init?.method === 'DELETE')).toHaveLength(1);
    expect(screen.queryByTestId('bank-balance')).toBeNull();
  });

  it('stays logged in and says so when logout fails', async () => {
    state.extra = (url, init) => (url === '/api/bank/session' && init?.method === 'DELETE' ? json({ error: 'x' }, 500) : undefined);
    await renderLoggedIn();
    fireEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(await screen.findByText('로그아웃하지 못했어요. 다시 눌러 주세요.')).toBeTruthy();
    expect(screen.getByTestId('bank-balance')).toBeTruthy();
  });

  it('shows only a 내 과제 menu with a stage summary on home and opens the list from it', async () => {
    await renderLoggedIn();
    const menu = screen.getByRole('button', { name: '내 과제, 완료 가능 1개 · 미완료 2개 · 완료 1개' });
    expect(menu.textContent).toContain('지금 완료하고 보상을 받을 수 있는 과제가 1개 있어요!');
    expect(screen.queryByRole('heading', { name: '책 10분 읽기' })).toBeNull();

    await openTasks();
    expect(screen.queryByTestId('bank-balance')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '홈으로 돌아가기' }));
    expect(await screen.findByTestId('bank-balance')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '책 10분 읽기' })).toBeNull();
  });

  it('returns to the login page when the session has expired', async () => {
    state.loggedIn = true;
    state.extra = (url) => (url === '/api/bank/me/tasks' ? json({ error: '다시 로그인해 주세요.', code: 'BANK_SESSION_REQUIRED' }, 401) : undefined);
    render(<BankApp />);
    expect(await screen.findByText('로그인 시간이 끝났어요. 다시 로그인해 주세요.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '내 QR 코드로 로그인해요' })).toBeTruthy();
  });
});

describe('BankApp 내 과제', () => {
  it('groups tasks 완료 가능 → 미완료 → 완료 and shows each stage differently', async () => {
    await renderTasks();
    const groups = screen.getAllByTestId(/^bank-task-group-/).map((group) => group.getAttribute('data-testid'));
    expect(groups).toEqual(['bank-task-group-READY', 'bank-task-group-PENDING', 'bank-task-group-COMPLETED']);

    const ready = readyCard('책 10분 읽기');
    expect(within(ready).getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' })).toBeTruthy();
    expect(ready.textContent).toContain('5원');
    expect(ready.textContent).toContain('기한:');

    const locked = readyCard('독서 감상문');
    expect(within(locked).queryByRole('button', { name: /완료하고 보상 받기/ })).toBeNull();
    expect(locked.textContent).toContain("먼저 '책 10분 읽기' 과제를 완료해야 해요.");

    const pending = readyCard('교실 청소');
    expect(within(screen.getByTestId('bank-task-group-PENDING')).getByRole('article', { name: '교실 청소' })).toBe(pending);
    expect(pending.textContent).toContain('선생님이 확인하면 완료할 수 있어요');
    expect(within(pending).queryByRole('button', { name: /완료/ })).toBeNull();

    const done = readyCard('받아쓰기');
    expect(within(screen.getByTestId('bank-task-group-COMPLETED')).getByRole('article', { name: '받아쓰기' })).toBe(done);
    expect(done.textContent).toContain('보상 3원 받았어요');
  });

  it('shows an empty state for every group', async () => {
    state.tasks = [];
    state.loggedIn = true;
    render(<BankApp />);
    fireEvent.click(await screen.findByRole('button', { name: '내 과제, 완료 가능 0개 · 미완료 0개 · 완료 0개' }));
    expect(await screen.findByText('지금 완료할 수 있는 과제가 없어요.')).toBeTruthy();
    expect(screen.getByText('기다리는 과제가 없어요.')).toBeTruthy();
    expect(screen.getByText('아직 완료한 과제가 없어요.')).toBeTruthy();
  });

  it('completes with only an operation ID, pays the reward and updates balance and tasks', async () => {
    await renderTasks();
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));

    const dialog = await screen.findByRole('dialog', { name: '보상을 받았어요!' });
    expect(dialog.textContent).toContain('+5원');
    expect(dialog.textContent).toContain('지금 잔액 1,205원');
    expect(completionCalls()).toEqual([['/api/bank/me/tasks/T1/complete', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: OPERATION_ID }),
    })]]);
    fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));
    expect(within(screen.getByTestId('bank-task-group-COMPLETED')).getByRole('article', { name: '책 10분 읽기' })).toBeTruthy();
    expect(within(readyCard('독서 감상문')).getByRole('button', { name: '독서 감상문 완료하고 보상 받기' })).toBeTruthy();
    expect(window.sessionStorage.length).toBe(0);
    await waitFor(() => expect(screen.getByTestId('bank-announcer').textContent).toBe('보상 5원 받았어요.'));

    fireEvent.click(screen.getByRole('button', { name: '홈으로 돌아가기' }));
    expect((await screen.findByTestId('bank-balance')).textContent).toBe('1,205원');
    expect(screen.getByRole('button', { name: '내 과제, 완료 가능 1개 · 미완료 1개 · 완료 2개' })).toBeTruthy();
  });

  it('sends one request while a completion is still pending', async () => {
    let release!: () => void;
    state.complete = (_url, init) => new Promise<Response>((resolve) => {
      release = () => resolve(json(completionSuccess(JSON.parse(String(init?.body)).operationId)));
    }) as unknown as Response;
    await renderTasks();
    const button = screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(await screen.findByRole('dialog', { name: '과제 완료 처리 중' })).toBeTruthy();
    expect(completionCalls()).toHaveLength(1);
    await act(async () => { release(); });
    expect(await screen.findByRole('dialog', { name: '보상을 받았어요!' })).toBeTruthy();
    expect(completionCalls()).toHaveLength(1);
  });

  it('maps a not-ready refusal to a kind message and refreshes the task list', async () => {
    state.complete = () => json({ error: '아직 완료할 수 없는 과제예요. 선생님이 확인하면 완료할 수 있어요.', code: 'NOT_READY', operationId: OPERATION_ID }, 409);
    await renderTasks();
    const before = calls((url) => url === '/api/bank/me/tasks').length;
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));
    const dialog = await screen.findByRole('dialog', { name: '아직 완료할 수 없어요' });
    expect(dialog.textContent).toContain('아직 완료할 수 없는 과제예요. 선생님이 확인하면 완료할 수 있어요.');
    expect(completionCalls()).toHaveLength(1);
    await waitFor(() => expect(calls((url) => url === '/api/bank/me/tasks').length).toBe(before + 1));
    expect(window.sessionStorage.length).toBe(0);
  });

  it('retries an unknown outcome with the same operation ID, never holds other tasks back, and re-checks after a reload', async () => {
    state.complete = () => json({ error: '완료 결과를 확인하고 있어요.', code: 'COMPLETION_STATUS_UNKNOWN', retryable: true }, 503);
    state.tasks.push({ taskId: 'T5', title: '줄넘기', description: '줄넘기 100번', reward: 4, stage: 'READY', completable: true });
    const first = await renderTasks();
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));
    expect(await screen.findByRole('dialog', { name: '완료 결과를 확인하지 못했어요' }, { timeout: 5000 })).toBeTruthy();
    expect(completionCalls().map(([, init]) => init?.body)).toEqual(Array(3).fill(JSON.stringify({ operationId: OPERATION_ID })));
    expect(JSON.parse(window.sessionStorage.getItem(window.sessionStorage.key(0)!)!)).toMatchObject({ operationId: OPERATION_ID, taskId: 'T1', studentId: 'S001' });

    // The uncertain task waits for its own re-check; every other task can still be completed.
    fireEvent.click(screen.getByRole('button', { name: '나중에 확인' }));
    expect(screen.getByText('확인 중인 과제 완료가 있어요')).toBeTruthy();
    expect((screen.getByRole('button', { name: '줄넘기 완료하고 보상 받기' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('다른 과제의 완료 결과를 먼저 확인해 주세요.')).toBeNull();

    // Reload the page: the journal survives, home points to it, and the re-check uses the SAME operation ID.
    first.unmount();
    state.complete = undefined;
    render(<BankApp />);
    expect(await screen.findByText('확인 중인 과제 완료가 있어요. 눌러서 확인해 주세요.')).toBeTruthy();
    await openTasks();
    expect(screen.getByText('확인 중인 과제 완료가 있어요')).toBeTruthy();
    const card = await screen.findByRole('article', { name: '책 10분 읽기' });
    expect(within(card).getByRole('button', { name: '책 10분 읽기 완료 상태 다시 확인' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다시 확인' }));
    expect(await screen.findByRole('dialog', { name: '보상을 받았어요!' })).toBeTruthy();
    expect(completionCalls().map(([, init]) => init?.body)).toEqual(Array(4).fill(JSON.stringify({ operationId: OPERATION_ID })));
    expect(window.sessionStorage.length).toBe(0);
  });

  it('forgets an uncertain completion once the task list shows that task completed', async () => {
    state.complete = () => json({ error: '완료 결과를 확인하고 있어요.', code: 'COMPLETION_STATUS_UNKNOWN', retryable: true }, 503);
    const first = await renderTasks();
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));
    expect(await screen.findByRole('dialog', { name: '완료 결과를 확인하지 못했어요' }, { timeout: 5000 })).toBeTruthy();
    expect(window.sessionStorage.length).toBe(1);

    // The completion was in fact recorded: the next list shows it at 완료, which settles the journal.
    first.unmount();
    state.tasks = state.tasks.map((task) => task.taskId === 'T1' ? { ...task, stage: 'COMPLETED', completable: false } : task);
    render(<BankApp />);
    await screen.findByTestId('bank-balance');
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
    expect(screen.queryByText('확인 중인 과제 완료가 있어요. 눌러서 확인해 주세요.')).toBeNull();
    expect(completionCalls()).toHaveLength(3);
  });

  it('re-reads the task list when a finished completion comes back without one', async () => {
    state.complete = (_url, init) => json({ ...completionSuccess(JSON.parse(String(init?.body)).operationId), tasks: [] });
    await renderTasks();
    const before = calls((url) => url === '/api/bank/me/tasks').length;
    state.tasks = state.tasks.map((task) => task.taskId === 'T1' ? { ...task, stage: 'COMPLETED', completable: false } : task);
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));
    expect(await screen.findByRole('dialog', { name: '보상을 받았어요!' })).toBeTruthy();
    await waitFor(() => expect(calls((url) => url === '/api/bank/me/tasks').length).toBe(before + 1));
    expect(await screen.findByRole('article', { name: '책 10분 읽기' })).toBeTruthy();
    expect(screen.getByTestId('bank-task-group-COMPLETED').textContent).toContain('책 10분 읽기');
  });

  it('reports an operation conflict without blocking further completions', async () => {
    state.complete = () => json({ error: '같은 완료 요청의 내용이 맞지 않아요. 선생님께 알려 주세요.', code: 'COMPLETION_OPERATION_CONFLICT', operationId: OPERATION_ID }, 409);
    await renderTasks();
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));
    const dialog = await screen.findByRole('dialog', { name: '완료 요청을 확인해야 해요' });
    fireEvent.click(within(dialog).getByRole('button', { name: '확인' }));
    expect(screen.queryByText('선생님 확인이 필요해요')).toBeNull();
    expect((screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }) as HTMLButtonElement).disabled).toBe(false);
    expect(completionCalls()).toHaveLength(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('keeps the uncertain operation when the session expires mid-completion', async () => {
    state.complete = () => json({ error: '다시 로그인해 주세요.', code: 'BANK_SESSION_REQUIRED' }, 401);
    await renderTasks();
    fireEvent.click(screen.getByRole('button', { name: '책 10분 읽기 완료하고 보상 받기' }));
    expect(await screen.findByRole('heading', { name: '내 QR 코드로 로그인해요' })).toBeTruthy();
    expect(JSON.parse(window.sessionStorage.getItem(window.sessionStorage.key(0)!)!)).toMatchObject({ operationId: OPERATION_ID });
  });
});
