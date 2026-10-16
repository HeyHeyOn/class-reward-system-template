import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import type { PadletErrorCode, PadletStatusDto } from '@/lib/padletLinkApi';
import { TaskLedgerOverlays, TaskLedgerPanel } from './TaskLedgerPanel';
import { useTaskLedger } from './useTaskLedger';
import { LedgerServer, makeTask, NOW, SLUG, STUDENTS } from './ledgerTestServer';

vi.mock('@/components/QrScanner', () => ({
  QrScanner: ({ onScan }: { onScan: (text: string) => void }) => <button type="button" onClick={() => onScan('qr-S4')}>가짜 카메라 스캔</button>,
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let server: LedgerServer;

function Harness({ qrManual = true }: { qrManual?: boolean }) {
  const ledger = useTaskLedger({ enabled: true });
  const [notices, setNotices] = useState<string[]>([]);
  const notify = (message: string) => setNotices((current) => [...current, message]);
  return (
    <>
      <TaskLedgerPanel ledger={ledger} unit="원" notify={notify} />
      <TaskLedgerOverlays ledger={ledger} students={STUDENTS} unit="원" notify={notify} qrManualInputEnabled={qrManual} />
      <div data-testid="notices">{notices.map((text, index) => <p key={index} role="status">{text}</p>)}</div>
    </>
  );
}

async function renderBoard(options: { qrManual?: boolean } = {}) {
  render(<Harness {...options} />);
  await screen.findByRole('button', { name: '수학 익힘책 과제 편집' });
}

async function openTask(title = '수학 익힘책', tab?: '반복' | '학생 현황') {
  fireEvent.click(screen.getByRole('button', { name: `${title} 과제 편집` }));
  const sheet = await screen.findByRole('dialog', { name: `${title} 과제 편집` });
  if (tab) fireEvent.click(within(sheet).getByRole('tab', { name: new RegExp(`^${tab}`) }));
  return sheet;
}

function pickStage(sheet: HTMLElement, name: string, stage: string) {
  fireEvent.click(within(sheet).getByRole('button', { name: `${name} ${stage}` }));
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', `/c/${SLUG}/admin`);
  server = new LedgerServer([
    makeTask(),
    makeTask({ taskId: 'task-2', title: '독서 기록', reward: 50, sortOrder: 2, isActive: false, stages: { S1: 'PENDING' } }),
  ]);
  server.install();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('task ledger board', () => {
  it('loads the board from the class-scoped ledger route and shows stage counts and status', async () => {
    await renderBoard();
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(`/api/c/${SLUG}/task-ledger`, expect.objectContaining({ cache: 'no-store' }));
    const rows = screen.getAllByTestId('task-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('img', { name: /수학 익힘책 단계: 미완료 1명, 완료 가능 1명, 완료 1명, 미부여 1명/ })).toBeTruthy();
    expect(within(rows[1]).getAllByText('숨김').length).toBeGreaterThan(0);
    fireEvent.click(within(screen.getByRole('group', { name: '과제 공개 상태 필터' })).getByRole('button', { name: /숨김/ }));
    expect(screen.getAllByTestId('task-row')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: '과제 검색' }), { target: { value: '수학' } });
    expect(screen.queryAllByTestId('task-row')).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/회차|완료 기록 초기화/);
  });

  it('re-reads the board every 20 seconds while the page is open', async () => {
    const setInterval = vi.spyOn(window, 'setInterval');
    await renderBoard();
    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 20_000);
    const tick = setInterval.mock.calls.find((call) => call[1] === 20_000)![0] as () => void;
    server.set('task-1', (task) => ({ ...task, title: '수학 익힘책 (새 이름)' }));
    act(() => tick());
    expect(await screen.findByRole('button', { name: '수학 익힘책 (새 이름) 과제 편집' })).toBeTruthy();
  });

  it('shows a failed first load with a retry button', async () => {
    server.fail('GET /', 'network');
    render(<Harness />);
    expect(await screen.findByText('과제를 불러오지 못했어요')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '다시 불러오기' }));
    expect(await screen.findByRole('button', { name: '수학 익힘책 과제 편집' })).toBeTruthy();
  });
});

describe('student stages', () => {
  it('asks about the reward once when students move to 완료 and sends only changed rows', async () => {
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    pickStage(sheet, '김민준', '완료');
    pickStage(sheet, '최하윤', '미완료');
    expect(within(sheet).getAllByText('변경')).toHaveLength(2);
    fireEvent.click(within(sheet).getByRole('button', { name: '2명 저장' }));
    const ask = await screen.findByRole('dialog', { name: '보상 지급 확인' });
    expect(ask.textContent).toContain('완료로 바꾼 학생 1명에게 보상(120원)도 줄까요?');
    fireEvent.click(within(ask).getByRole('button', { name: '보상도 주기' }));
    await waitFor(() => expect(server.writes('POST /stages')).toHaveLength(1));
    const body = server.writes('POST /stages')[0].body!;
    expect(body.operationId).toMatch(UUID);
    expect(body.changes).toEqual([
      { taskId: 'task-1', studentId: 'S1', stage: 'COMPLETED', withReward: true },
      { taskId: 'task-1', studentId: 'S4', stage: 'PENDING' },
    ]);
    await waitFor(() => expect(within(sheet).queryAllByText('변경')).toHaveLength(0));
    expect(within(sheet).getByRole('button', { name: '김민준 완료' }).getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByText(/학생 2명의 단계를 저장했어요/)).toBeTruthy();
  });

  it('can complete without a reward', async () => {
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    pickStage(sheet, '이서연', '완료');
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '보상 지급 확인' })).getByRole('button', { name: '보상 없이 완료' }));
    await waitFor(() => expect(server.writes('POST /stages')).toHaveLength(1));
    expect(server.writes('POST /stages')[0].body!.changes).toEqual([{ taskId: 'task-1', studentId: 'S2', stage: 'COMPLETED' }]);
  });

  it('moves a student back from 완료 with a note about rewards and no reward question', async () => {
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    expect(within(sheet).queryByText(/이미 받은 보상은 그대로 남아요/)).toBeNull();
    pickStage(sheet, '박지후', '완료 가능');
    expect(within(sheet).getByText('완료를 되돌려도 이미 받은 보상은 그대로 남아요. 필요하면 거래 내역에서 취소하세요.')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    await waitFor(() => expect(server.writes('POST /stages')).toHaveLength(1));
    expect(screen.queryByRole('dialog', { name: '보상 지급 확인' })).toBeNull();
    expect(server.writes('POST /stages')[0].body!.changes).toEqual([{ taskId: 'task-1', studentId: 'S3', stage: 'READY' }]);
  });

  it('keeps the unsaved stages after a failure and the same button saves them again', async () => {
    server.fail('POST /stages', { status: 500, body: { error: '잠시 후 다시 눌러 주세요.', code: 'INTERNAL' } }, 'network');
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    pickStage(sheet, '최하윤', '완료 가능');
    const readsBefore = server.reads().length;
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    expect(await within(sheet).findByText('잠시 후 다시 눌러 주세요.')).toBeTruthy();
    expect(within(sheet).getByText('변경')).toBeTruthy();
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(readsBefore));
    const retry = within(sheet).getByRole('button', { name: '1명 저장' }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    expect(await within(sheet).findByText('저장하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.')).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: '최하윤 완료 가능' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    await waitFor(() => expect(within(sheet).queryByText('변경')).toBeNull());
    const sent = server.writes('POST /stages');
    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((call) => call.body!.operationId)).size).toBe(3);
    expect(server.tasks[0].students.find((row) => row.studentId === 'S4')!.stage).toBe('READY');
  });

  it('resets now to the chosen stage for every student who has the task', async () => {
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    fireEvent.click(within(sheet).getByRole('button', { name: '지금 초기화…' }));
    const dialog = await screen.findByRole('dialog', { name: '지금 초기화' });
    expect(dialog.textContent).toContain('미부여가 아닌 학생 3명');
    fireEvent.click(within(within(dialog).getByRole('group', { name: '초기화 단계' })).getByRole('button', { name: '미완료' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '지금 초기화' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '지금 초기화' })).toBeNull());
    expect(server.writes('POST /reset')[0].body).toEqual({ operationId: expect.stringMatching(UUID), taskIds: ['task-1'], stage: 'PENDING' });
    expect(within(sheet).getByRole('button', { name: '김민준 미완료' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByRole('button', { name: '최하윤 미부여' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('does not let a background refresh overwrite unsaved stage changes', async () => {
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    pickStage(sheet, '최하윤', '미완료');
    server.set('task-1', (task) => ({ ...task, students: task.students.map((row) => row.studentId === 'S2' ? { ...row, stage: 'COMPLETED' } : row) }));
    const reads = server.reads().length;
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(server.reads().length).toBeGreaterThan(reads));
    await act(async () => { await Promise.resolve(); });
    expect(within(sheet).getByRole('button', { name: '최하윤 미완료' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByRole('button', { name: '이서연 미완료' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: '되돌리기' }));
    expect(within(sheet).getByRole('button', { name: '이서연 완료' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByRole('button', { name: '최하윤 미부여' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('task details', () => {
  it('saves 기본 정보 with a PATCH and keeps typed text through a refresh and a failure', async () => {
    server.fail('PATCH /tasks/task-1', { status: 409, body: { error: '같은 이름의 과제가 있어요.', code: 'DUPLICATE' } });
    await renderBoard();
    const sheet = await openTask();
    fireEvent.change(within(sheet).getByLabelText('수학 익힘책 과제 이름'), { target: { value: '수학 익힘책 2단원' } });
    server.set('task-1', (task) => ({ ...task, reward: 200 }));
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect((within(sheet).getByLabelText('수학 익힘책 보상') as HTMLInputElement).value).toBe('200'));
    expect((within(sheet).getByLabelText('수학 익힘책 과제 이름') as HTMLInputElement).value).toBe('수학 익힘책 2단원');
    fireEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    expect(await within(sheet).findByText('같은 이름의 과제가 있어요.')).toBeTruthy();
    expect((within(sheet).getByLabelText('수학 익힘책 과제 이름') as HTMLInputElement).value).toBe('수학 익힘책 2단원');
    fireEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    await screen.findByRole('dialog', { name: '수학 익힘책 2단원 과제 편집' });
    const patches = server.writes('PATCH /tasks/task-1');
    expect(patches).toHaveLength(2);
    expect(patches[1].body).toEqual({ operationId: expect.stringMatching(UUID), task: {
      title: '수학 익힘책 2단원', description: '42~45쪽', reward: 200, isActive: true, sortOrder: 1, availableFrom: null, dueAt: null, prerequisiteTaskId: null,
    } });
    expect(patches[0].body!.operationId).not.toBe(patches[1].body!.operationId);
  });

  it('asks for a reset stage on a repeat saved without one (old Sheets data)', async () => {
    server = new LedgerServer([makeTask({ repeat: { recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1] }, resetStage: null, nextResetAt: null, lastResetAt: null } })]);
    server.install();
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '반복');
    const group = within(sheet).getByRole('group', { name: '초기화하면' });
    expect(within(group).getAllByRole('button').every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(within(sheet).getByRole('alert').textContent).toContain('초기화할 단계를 골라 주세요');
    expect((within(sheet).getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(group).getByRole('button', { name: '완료 가능' }));
    fireEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(server.writes('POST /repeat')).toHaveLength(1));
    expect(server.writes('POST /repeat')[0].body!.repeat).toEqual({ recurrence: { type: 'WEEKLY', time: '09:00', weekdays: [1] }, resetStage: 'READY' });
  });

  it('saves the repeat setting with the reset stage', async () => {
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '반복');
    fireEvent.click(within(within(sheet).getByRole('group', { name: '반복 주기' })).getByRole('button', { name: '매주' }));
    fireEvent.click(within(sheet).getByRole('button', { name: '수요일' }));
    fireEvent.change(within(sheet).getByLabelText('반복 시간'), { target: { value: '08:30' } });
    fireEvent.click(within(within(sheet).getByRole('group', { name: '초기화하면' })).getByRole('button', { name: '미완료' }));
    expect(within(within(sheet).getByRole('group', { name: '초기화하면' })).getByRole('button', { name: '미완료' }).getAttribute('aria-pressed')).toBe('true');
    expect(within(sheet).getByText(/저장하면 다음 초기화:/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(server.writes('POST /repeat')).toHaveLength(1));
    expect(server.writes('POST /repeat')[0].body).toEqual({ operationId: expect.stringMatching(UUID), taskIds: ['task-1'],
      repeat: { recurrence: { type: 'WEEKLY', time: '08:30', weekdays: [1, 3] }, resetStage: 'PENDING' } });
    await waitFor(() => expect((within(sheet).getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(sheet).getAllByText('매주 월, 수 오전 8:30, 미완료로 초기화').length).toBeGreaterThan(0);
    expect(within(sheet).queryByText(/저장하면 다음 초기화/)).toBeNull();
  });

  it('shows the history as sentences grouped by day and filters by student', async () => {
    server.history = { taskId: 'task-1', title: '수학 익힘책', truncated: false, entries: [
      { id: 'h3', at: '2026-10-06T00:30:00.000Z', studentId: 'S1', studentName: '김민준', stage: 'COMPLETED', previousStage: 'READY', cause: 'BANK', reward: 120 },
      { id: 'h2', at: '2026-10-05T23:00:00.000Z', studentId: 'S2', studentName: '이서연', stage: 'PENDING', previousStage: 'UNASSIGNED', cause: 'QR', reward: null },
      { id: 'h1', at: '2026-10-04T01:00:00.000Z', studentId: 'S1', studentName: '김민준', stage: 'READY', previousStage: 'UNASSIGNED', cause: 'TEACHER', reward: null },
    ] };
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('button', { name: '수학 익힘책 기록 보기' }));
    const dialog = await screen.findByRole('dialog', { name: '과제 기록' });
    expect(await within(dialog).findByText('김민준, 완료 가능 → 완료, 은행에서 완료 (+120원)')).toBeTruthy();
    expect(await within(dialog).findByText('이서연, 미부여 → 미완료, QR')).toBeTruthy();
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['오늘, 10월 6일(화)', '10월 4일(일)']);
    fireEvent.change(within(dialog).getByLabelText('기록 학생 고르기'), { target: { value: 'S2' } });
    expect(within(dialog).queryByText(/^김민준,/)).toBeNull();
    expect(await within(dialog).findByText('이서연, 미부여 → 미완료, QR')).toBeTruthy();
    expect(server.calls.some((call) => call.method === 'GET' && call.path === '/tasks/task-1/history')).toBe(true);
  });
});

describe('create, bulk and delete', () => {
  it('creates a task with its repeat and starting students', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '새 과제' }));
    const sheet = await screen.findByRole('dialog', { name: '새 과제' });
    fireEvent.change(within(sheet).getByLabelText('새 과제 과제 이름'), { target: { value: '청소 당번' } });
    fireEvent.change(within(sheet).getByLabelText('새 과제 보상'), { target: { value: '30' } });
    fireEvent.click(within(sheet).getByRole('tab', { name: /^반복/ }));
    fireEvent.click(within(within(sheet).getByRole('group', { name: '반복 주기' })).getByRole('button', { name: '매일' }));
    fireEvent.click(within(sheet).getByRole('tab', { name: /^대상 학생/ }));
    fireEvent.click(within(sheet).getByRole('checkbox', { name: '김민준 대상' }));
    // A stage pill picks the student too; 미부여 leaves them out again.
    fireEvent.click(within(sheet).getByRole('button', { name: '이서연 미완료' }));
    expect((within(sheet).getByRole('checkbox', { name: '이서연 대상' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(sheet).getByRole('checkbox', { name: '최하윤 대상' }));
    expect(within(sheet).getByRole('button', { name: '최하윤 완료 가능' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(sheet).getByRole('button', { name: '최하윤 미부여' }));
    expect((within(sheet).getByRole('checkbox', { name: '최하윤 대상' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(sheet).getByRole('button', { name: '과제 만들기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 과제' })).toBeNull());
    expect(server.writes('POST /tasks')[0].body).toEqual({
      operationId: expect.stringMatching(UUID),
      task: { title: '청소 당번', description: '', reward: 30, isActive: true, sortOrder: 3, availableFrom: null, dueAt: null, prerequisiteTaskId: null },
      repeat: { recurrence: { type: 'DAILY', time: '09:00' }, resetStage: 'READY' },
      students: [{ studentId: 'S1', stage: 'READY' }, { studentId: 'S2', stage: 'PENDING' }],
    });
    expect(await screen.findByRole('button', { name: '청소 당번 과제 편집' })).toBeTruthy();
  });

  it('keeps the new task draft when creating fails', async () => {
    server.fail('POST /tasks', 'network');
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: '새 과제' }));
    const sheet = await screen.findByRole('dialog', { name: '새 과제' });
    fireEvent.click(within(sheet).getByRole('button', { name: '과제 만들기' }));
    expect(await within(sheet).findByText('과제 이름을 입력해 주세요.')).toBeTruthy();
    expect(server.writes('POST /tasks')).toHaveLength(0);
    fireEvent.change(within(sheet).getByLabelText('새 과제 과제 이름'), { target: { value: '받아쓰기' } });
    fireEvent.click(within(sheet).getByRole('button', { name: '과제 만들기' }));
    expect(await within(sheet).findByText('저장하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.')).toBeTruthy();
    expect((within(sheet).getByLabelText('새 과제 과제 이름') as HTMLInputElement).value).toBe('받아쓰기');
    fireEvent.click(within(sheet).getByRole('button', { name: '과제 만들기' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '새 과제' })).toBeNull());
    expect(server.tasks.map((task) => task.title)).toContain('받아쓰기');
  });

  it('changes stages for picked students across the selected tasks', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('checkbox', { name: '수학 익힘책 선택' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '독서 기록 선택' }));
    expect(screen.getByRole('columnheader', { name: '완료 단계' })).toBeTruthy();
    expect(within(screen.getByRole('toolbar', { name: '선택 항목 작업' })).getByRole('button', { name: '선택 과제 완료 단계' }).textContent).toBe('완료 단계');
    fireEvent.click(within(screen.getByRole('toolbar', { name: '선택 항목 작업' })).getByRole('button', { name: '선택 과제 완료 단계' }));
    const dialog = await screen.findByRole('dialog', { name: '선택 과제 완료 단계' });
    fireEvent.click(within(within(dialog).getByRole('group', { name: '바꿀 단계' })).getByRole('button', { name: '미완료' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '김민준 고르기' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '최하윤 고르기' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '선택 과제 완료 단계' })).toBeNull());
    // 독서 기록 already has 김민준 at 미완료, so only the real changes are sent.
    expect(server.writes('POST /stages')[0].body!.changes).toEqual([
      { taskId: 'task-1', studentId: 'S1', stage: 'PENDING' },
      { taskId: 'task-1', studentId: 'S4', stage: 'PENDING' },
      { taskId: 'task-2', studentId: 'S4', stage: 'PENDING' },
    ]);
  });

  it('saves one repeat setting for the selected tasks', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('checkbox', { name: '전체 과제 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 반복 설정' }));
    const dialog = await screen.findByRole('dialog', { name: '선택 과제 반복 설정' });
    expect((within(dialog).getByRole('button', { name: '저장' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(within(dialog).getByRole('group', { name: '반복 주기' })).getByRole('button', { name: '매월' }));
    fireEvent.change(within(dialog).getByLabelText('반복 날짜'), { target: { value: '15' } });
    const resetGroup = within(dialog).getByRole('group', { name: '초기화하면' });
    expect(within(resetGroup).getAllByRole('button').map((button) => button.textContent)).toEqual(['미부여', '미완료', '완료 가능', '완료']);
    fireEvent.click(within(resetGroup).getByRole('button', { name: '미부여' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(server.writes('POST /repeat')).toHaveLength(1));
    expect(server.writes('POST /repeat')[0].body).toEqual({ operationId: expect.stringMatching(UUID), taskIds: ['task-1', 'task-2'],
      repeat: { recurrence: { type: 'MONTHLY', time: '09:00', dayOfMonth: 15 }, resetStage: 'UNASSIGNED' } });
  });

  it('deletes the selected tasks after confirming', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('checkbox', { name: '독서 기록 선택' }));
    fireEvent.click(screen.getByRole('button', { name: '선택 과제 삭제' }));
    const dialog = await screen.findByRole('dialog', { name: '과제 삭제 확인' });
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '독서 기록 과제 편집' })).toBeNull());
    expect(server.writes('POST /tasks/delete')[0].body).toEqual({ operationId: expect.stringMatching(UUID), taskIds: ['task-2'] });
    expect(screen.queryByRole('toolbar', { name: '선택 항목 작업' })).toBeNull();
  });

  it('deletes from the task sheet and closes it', async () => {
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('button', { name: '수학 익힘책 과제 삭제' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '과제 삭제 확인' })).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '수학 익힘책 과제 편집' })).toBeNull());
    expect(screen.queryByRole('button', { name: '수학 익힘책 과제 편집' })).toBeNull();
  });
});

describe('QR stage changes', () => {
  it('scans students one after another and shows each result, also failures', async () => {
    await renderBoard();
    fireEvent.click(screen.getByRole('button', { name: 'QR로 단계 바꾸기' }));
    const dialog = await screen.findByRole('dialog', { name: 'QR로 단계 바꾸기' });
    fireEvent.click(within(dialog).getByRole('button', { name: '수학 익힘책 과제 선택' }));
    expect(within(within(dialog).getByRole('group', { name: '바꿀 단계' })).getByRole('button', { name: '미완료' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'QR 찍기 시작' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '가짜 카메라 스캔' }));
    const log = within(dialog).getByRole('log', { name: 'QR 결과' });
    expect(await within(log).findByText('최하윤: 미부여 → 미완료')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('학생 QR 직접 입력'), { target: { value: 'qr-S4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '적용' }));
    expect(await within(log).findByText('최하윤: 이미 미완료예요')).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('학생 QR 직접 입력'), { target: { value: 'qr-unknown' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '적용' }));
    expect(await within(log).findByText('등록되지 않은 QR이에요.')).toBeTruthy();
    expect(within(dialog).getByLabelText('학생 QR 직접 입력')).toBeTruthy();
    const sent = server.writes('POST /qr').map((call) => call.body);
    expect(sent[0]).toEqual({ operationId: expect.stringMatching(UUID), taskId: 'task-1', studentQr: 'qr-S4', stage: 'PENDING' });
    expect(sent).toHaveLength(3);
    await waitFor(() => expect(within(screen.getAllByTestId('task-row')[0]).getByRole('img').getAttribute('aria-label')).toContain('미완료 2명'));
  });

  it('sends withReward only when 완료 and 보상도 주기 are chosen, and hides manual input when it is off', async () => {
    await renderBoard({ qrManual: false });
    fireEvent.click(screen.getByRole('button', { name: 'QR로 단계 바꾸기' }));
    const dialog = await screen.findByRole('dialog', { name: 'QR로 단계 바꾸기' });
    fireEvent.click(within(dialog).getByRole('button', { name: '수학 익힘책 과제 선택' }));
    fireEvent.click(within(within(dialog).getByRole('group', { name: '바꿀 단계' })).getByRole('button', { name: '완료' }));
    fireEvent.click(within(dialog).getByRole('switch', { name: '보상도 주기' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'QR 찍기 시작' }));
    expect(within(dialog).queryByLabelText('학생 QR 직접 입력')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '가짜 카메라 스캔' }));
    expect(await within(dialog).findByText('최하윤: 미부여 → 완료 (보상 120원)')).toBeTruthy();
    expect(server.writes('POST /qr')[0].body).toEqual({ operationId: expect.stringMatching(UUID), taskId: 'task-1', studentQr: 'qr-S4', stage: 'COMPLETED', withReward: true });
  });
});

describe('no request journal', () => {
  it('never writes to sessionStorage while editing, failing and saving tasks', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    server.fail('POST /stages', 'network');
    await renderBoard();
    const sheet = await openTask('수학 익힘책', '학생 현황');
    pickStage(sheet, '최하윤', '완료 가능');
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    await within(sheet).findByText('저장하지 못했어요. 인터넷 연결을 확인하고 다시 눌러 주세요.');
    fireEvent.click(within(sheet).getByRole('button', { name: '1명 저장' }));
    await waitFor(() => expect(within(sheet).queryByText('변경')).toBeNull());
    expect(setItem).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });
});

describe('Padlet links', () => {
  const ADDRESS = 'https://padlet.com/t/5-6-mvbij1byfal6f0ik';

  function linkedWithError(error: PadletErrorCode, retryAt: string | null = null) {
    server.padletKey = { saved: true, hint: '9876', readable: true };
    server.set('task-1', (task) => ({ ...task, padlet: { boardId: 'mvbij1byfal6f0ik', boardTitle: '5-6 칭찬 게시판', boardUrl: ADDRESS,
      sectionId: null, sectionTitle: null, lastReadAt: '2026-10-05T23:59:00.000Z', error, checking: false, retryAt } }));
  }

  function padletStatus(now = NOW): PadletStatusDto {
    const link = server.tasks[0].padlet!;
    return { now, key: server.padletKey, boards: [{ boardId: link.boardId, title: link.boardTitle, url: link.boardUrl,
      taskIds: ['task-1'], checkedAt: now, succeededAt: link.lastReadAt, error: link.error as PadletErrorCode | null,
      checking: link.checking, retryAt: link.retryAt, posts: [] }] };
  }

  function servePadletStatus() {
    const handle = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((input, init) => String(input).endsWith('/padlet')
      ? Promise.resolve(Response.json(padletStatus())) : handle(input, init));
  }

  it('keeps the last successful check beside the timeout reason in the list and linked tab', async () => {
    linkedWithError('TIMEOUT');
    servePadletStatus();
    await renderBoard();
    const row = screen.getAllByTestId('task-row')[0];
    expect(within(row).getByText('패들렛: 응답 시간 초과')).toBeTruthy();
    expect(within(row).getByText('마지막 확인 성공 10월 6일(화) 오전 8:59')).toBeTruthy();
    expect(within(row).queryByText('패들렛을 읽지 못함')).toBeNull();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    expect(await within(sheet).findByText('Padlet 응답 시간이 초과됐어요. 잠시 뒤에 다시 확인해 주세요.')).toBeTruthy();
    expect(within(sheet).getByText('마지막 확인 성공 10월 6일(화) 오전 8:59')).toBeTruthy();
    expect(within(sheet).getByText(/이 학급의 모든 연결 게시판을 확인해요/)).toBeTruthy();
  });

  it.each([
    ['NOT_ADMIN', '게시판 관리 권한 필요', '이 게시판을 관리하는 계정의 API 키가 필요해요.'],
    ['RATE_LIMITED', '요청 제한', 'Padlet 요청 한도에 걸렸어요. 대기 후 다시 확인해 주세요.'],
  ] as const)('explains %s without hiding the last success or rate-limit wait', async (code, label, message) => {
    linkedWithError(code, code === 'RATE_LIMITED' ? '2026-10-06T00:01:00.000Z' : null);
    servePadletStatus();
    await renderBoard();
    expect(within(screen.getAllByTestId('task-row')[0]).getByText(`패들렛: ${label}`)).toBeTruthy();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    expect(await within(sheet).findByText(message)).toBeTruthy();
    expect(within(sheet).getByText(/마지막 확인 성공/)).toBeTruthy();
    if (code === 'RATE_LIMITED') {
      expect(within(sheet).getByText('10월 6일(화) 오전 9:01 이후 다시 확인할 수 있어요.')).toBeTruthy();
      expect(within(screen.getAllByTestId('task-row')[0]).getByText('10월 6일(화) 오전 9:01 이후 재확인')).toBeTruthy();
    }
  });

  it('labels an old error while checking and lets a newer board poll clear the cached checking state', async () => {
    linkedWithError('TIMEOUT');
    const setInterval = vi.spyOn(window, 'setInterval');
    const handle = vi.mocked(fetch).getMockImplementation()!;
    let now = NOW;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/padlet/sync')) {
        await waiting;
        server.set('task-1', (task) => ({ ...task, padlet: { ...task.padlet!, checking: true } }));
        return Response.json(padletStatus(now));
      }
      if (path.endsWith('/padlet')) return Response.json(padletStatus(now));
      if (path.endsWith('/task-ledger') && (!init?.method || init.method === 'GET')) return Response.json({ now, tasks: server.tasks });
      return handle(input, init);
    });
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    await within(sheet).findByTestId('padlet-linked');
    fireEvent.click(within(sheet).getByRole('button', { name: '지금 확인' }));
    expect(within(sheet).getByText('패들렛 확인 중이에요. 결과를 기다려 주세요.')).toBeTruthy();
    expect(within(sheet).getByText(/^이전 확인: Padlet 응답 시간이 초과/)).toBeTruthy();
    await act(async () => release());
    expect(await within(screen.getByTestId('notices')).findByText('패들렛을 확인 중이에요. 결과를 기다려 주세요.')).toBeTruthy();
    expect(within(screen.getByTestId('notices')).queryByText(/^패들렛을 확인했어요/)).toBeNull();
    expect(within(screen.getAllByTestId('task-row')[0]).getByText('패들렛 확인 중')).toBeTruthy();

    now = '2026-10-06T00:00:20.000Z';
    server.set('task-1', (task) => ({ ...task, padlet: { ...task.padlet!, checking: false, error: null, lastReadAt: now } }));
    const tick = setInterval.mock.calls.find((call) => call[1] === 20_000)![0] as () => void;
    act(() => tick());
    await waitFor(() => expect(within(sheet).queryByText('패들렛 확인 중이에요. 결과를 기다려 주세요.')).toBeNull());
    expect(within(sheet).queryByText(/^이전 확인:/)).toBeNull();
    expect(within(sheet).getByText('마지막 확인 성공 10월 6일(화) 오전 9:00')).toBeTruthy();
  });

  it('asks for the key, loads the board, links one task to a section and shows what posts did', async () => {
    server.padletMoves = ['S2'];
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    const keyInput = await within(sheet).findByLabelText('Padlet API 키');
    expect(keyInput.getAttribute('type')).toBe('password');
    expect(within(sheet).getByRole('link', { name: /Padlet에서 API 키 보기/ }).getAttribute('href')).toBe('https://padlet.com/dashboard/settings/developers');
    expect(within(sheet).queryByLabelText('패들렛 게시판 주소')).toBeNull();
    fireEvent.change(keyInput, { target: { value: 'pdltp_secret_key_1234' } });
    fireEvent.click(within(sheet).getByRole('button', { name: '키 저장' }));
    expect(await within(sheet).findByText('끝자리 1234')).toBeTruthy();
    expect(server.writes('POST /padlet/key')[0].body).toEqual({ apiKey: 'pdltp_secret_key_1234' });

    fireEvent.change(within(sheet).getByLabelText('패들렛 게시판 주소'), { target: { value: ADDRESS } });
    fireEvent.click(within(sheet).getByRole('button', { name: '불러오기' }));
    expect(await within(sheet).findByText('5-6 칭찬 게시판')).toBeTruthy();
    fireEvent.click(within(within(sheet).getByRole('radiogroup', { name: '글을 셀 섹션' })).getByRole('radio', { name: '우리 반' }));
    fireEvent.click(within(sheet).getByRole('button', { name: '이 게시판에 연결' }));
    await within(sheet).findByTestId('padlet-linked');
    expect(server.writes('POST /padlet/links')[0].body).toEqual({ taskIds: ['task-1'], address: ADDRESS, sectionId: 'sec_class' });
    expect(screen.getByText('패들렛 ‘5-6 칭찬 게시판’에 연결했어요. 이미 올라온 글로 1명이 완료 가능이 됐어요.')).toBeTruthy();
    expect(within(sheet).getByText('‘우리 반’ 칸에 올린 글만 세요.')).toBeTruthy();
    expect(within(screen.getAllByTestId('task-row')[0]).getByText('패들렛: 5-6 칭찬 게시판, 우리 반')).toBeTruthy();
  });

  it('lists recent posts and gives a task to a student who posted without having it', async () => {
    server.padletKey = { saved: true, hint: '9876', readable: true };
    server.set('task-1', (task) => ({ ...task, padlet: { boardId: 'mvbij1byfal6f0ik', boardTitle: '5-6 칭찬 게시판', boardUrl: ADDRESS,
      sectionId: null, sectionTitle: null, lastReadAt: '2026-10-05T23:59:00.000Z', error: null } }));
    server.padletPosts = [
      { postId: 'post_4', at: '2026-10-05T23:58:00.000Z', author: '최하윤', subject: '', url: 'https://padlet.com/t/p/post_4', studentId: 'S4', studentName: '최하윤', match: 'AUTHOR', issue: null, results: { 'task-1': 'NOT_ASSIGNED' } },
      { postId: 'post_x', at: '2026-10-05T23:57:00.000Z', author: '', subject: '익명 글', url: null, studentId: null, studentName: null, match: null, issue: 'UNKNOWN', results: {} },
      { postId: 'post_2', at: '2026-10-05T23:56:00.000Z', author: '이서연', subject: '', url: null, studentId: 'S2', studentName: '이서연', match: 'AUTHOR', issue: null, results: { 'task-1': 'MOVED' } },
    ];
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    const posts = await within(sheet).findAllByTestId('padlet-post');
    expect(posts.map((post) => post.textContent)).toEqual([
      expect.stringContaining('과제 없는 학생(미부여)'), expect.stringContaining('학생 이름을 못 찾음'), expect.stringContaining('완료 가능으로 바꿈'),
    ]);
    fireEvent.click(within(sheet).getByRole('button', { name: '최하윤 완료 가능으로 바꾸기' }));
    await waitFor(() => expect(within(sheet).queryByRole('button', { name: '최하윤 완료 가능으로 바꾸기' })).toBeNull());
    expect(server.writes('POST /stages')[0].body!.changes).toEqual([{ taskId: 'task-1', studentId: 'S4', stage: 'READY' }]);

    fireEvent.click(within(sheet).getByRole('button', { name: '지금 확인' }));
    await waitFor(() => expect(server.writes('POST /padlet/sync')).toHaveLength(1));
    fireEvent.click(within(sheet).getByRole('button', { name: '연결 끊기' }));
    fireEvent.click(within(sheet).getByRole('button', { name: '연결 끊기' }));
    await within(sheet).findByTestId('padlet-link-form');
    expect(server.writes('POST /padlet/unlink')[0].body).toEqual({ taskIds: ['task-1'] });
  });

  it('links the selected tasks to one board and explains chained tasks', async () => {
    server.padletKey = { saved: true, hint: '9876', readable: true };
    server.set('task-2', (task) => ({ ...task, prerequisiteTaskId: 'task-1' }));
    await renderBoard();
    fireEvent.click(screen.getByRole('checkbox', { name: '수학 익힘책 선택' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '독서 기록 선택' }));
    fireEvent.click(within(screen.getByRole('toolbar', { name: '선택 항목 작업' })).getByRole('button', { name: '선택 과제 연결' }));
    const dialog = await screen.findByRole('dialog', { name: '선택 과제 연결' });
    expect(within(dialog).getByText(/수학 익힘책 → 독서 기록/)).toBeTruthy();
    fireEvent.change(await within(dialog).findByLabelText('패들렛 게시판 주소'), { target: { value: ADDRESS } });
    fireEvent.click(within(dialog).getByRole('button', { name: '불러오기' }));
    await within(dialog).findByTestId('padlet-board-preview');
    fireEvent.click(within(dialog).getByRole('button', { name: '2개 연결' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '선택 과제 연결' })).toBeNull());
    expect(server.writes('POST /padlet/links')[0].body).toEqual({ taskIds: ['task-1', 'task-2'], address: ADDRESS, sectionId: null });
    expect(screen.getAllByText(/^패들렛: 5-6 칭찬 게시판$/)).toHaveLength(2);
  });
});

describe('딴쌤 보드 in a task\'s 연결 tab', () => {
  const BOARDS = { enabled: true, boards: [
    { id: 'b1', code: 'f48ggq', title: '점검 그룹', format: 'group', groups: [{ id: 'g1', name: '그룹 1' }], linkedClassId: null, linkedHere: false, selectable: true },
    { id: 'b2', code: 'other1', title: '다른 반 보드', format: 'mini', groups: [], linkedClassId: 'other-class', linkedHere: false, selectable: false },
  ] };

  function serveBoards(sent: unknown[]) {
    const handle = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith('/task-ledger/board')) return Response.json(BOARDS);
      if (path.endsWith('/task-ledger/board/links')) {
        sent.push(JSON.parse(String(init?.body)));
        server.set('task-1', (task) => ({ ...task, padlet: null, board: { boardId: 'b1', boardCode: 'f48ggq', boardTitle: '점검 그룹', boardFormat: 'group',
          groupId: 'g1', groupName: '그룹 1', lastReadAt: null, error: null } }));
        return Response.json({ tasks: [server.tasks.find((task) => task.taskId === 'task-1')] });
      }
      return handle(input, init);
    });
  }

  it('picks one of the teacher\'s boards (another class\'s greyed out), a group, and links its roster to the class', async () => {
    const sent: unknown[] = [];
    serveBoards(sent);
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    await within(sheet).findByTestId('board-link-form');
    expect((within(sheet).getByRole('radio', { name: /다른 반 보드/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(sheet).getByRole('radio', { name: /점검 그룹/ }));
    fireEvent.change(within(sheet).getByLabelText('글을 셀 그룹'), { target: { value: 'g1' } });
    expect(within(sheet).getByText('이 보드 명단을 이 학급과 연결해요')).toBeTruthy();
    fireEvent.click(within(sheet).getByRole('button', { name: '이 보드에 연결' }));
    await within(sheet).findByTestId('board-linked');
    expect(sent).toEqual([{ taskIds: ['task-1'], boardId: 'b1', groupId: 'g1' }]);
    expect(within(sheet).getByText('‘그룹 1’ 그룹에서 학생이 글을 올리면 완료 가능이 돼요.')).toBeTruthy();
    expect(within(screen.getAllByTestId('task-row')[0]).getByText('딴쌤 보드: 점검 그룹, 그룹 1')).toBeTruthy();
    expect(await within(screen.getByTestId('notices')).findByText('딴쌤 보드 ‘점검 그룹’에 연결했어요.')).toBeTruthy();
  });

  it('keeps the Padlet way when the class cannot link boards', async () => {
    await renderBoard();
    const sheet = await openTask();
    fireEvent.click(within(sheet).getByRole('tab', { name: '연결' }));
    await within(sheet).findByTestId('padlet-link-form');
    expect(within(sheet).queryByRole('radiogroup', { name: '연결할 곳' })).toBeNull();
  });
});
