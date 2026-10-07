import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskCycleHistoryEvent } from '@/domain/taskCycleHistory';
import type { TaskHistoryDetailDto } from '@/domain/taskHistoryDtos';
import { PENDING_ASSIGNMENT_NOTE } from '@/domain/taskStage';
import { TaskHistoryDialog, type TaskHistoryDialogState } from './TaskHistoryDialog';
import { THEME_PALETTES } from '../uiTheme';

const NOW = '2026-10-06T05:00:00.000Z';
const LAST_WEEK = {
  cycleId: 'v1|I1|r1|2026-09-27T15:00:00Z', cycleStartsAt: '2026-09-27T15:00:00.000Z',
  cycleEndsAt: '2026-10-04T15:00:00.000Z', ruleVersion: 1, timeZone: 'Asia/Seoul',
};
const THIS_WEEK = {
  cycleId: 'v1|I1|r1|2026-10-04T15:00:00Z', cycleStartsAt: '2026-10-04T15:00:00.000Z',
  cycleEndsAt: '2026-10-11T15:00:00.000Z', ruleVersion: 1, timeZone: 'Asia/Seoul',
};

const base = { taskId: 'T001', taskInstanceId: 'I1', note: '' };
const events: TaskCycleHistoryEvent[] = [
  { ...base, ...LAST_WEEK, eventType: 'ASSIGNMENT', eventId: 'old-a1', occurredAt: '2026-09-28T00:05:00.000Z', studentId: 'S001', assignmentStatus: 'ASSIGNED', assignmentSource: 'ADMIN' },
  { ...base, ...LAST_WEEK, eventType: 'COMPLETION', eventId: 'old-c1', occurredAt: '2026-09-29T01:00:00.000Z', studentId: 'S001', studentName: '김민준', completionStatus: 'SUCCESS', completionSource: 'BANK', reward: 120, balanceBefore: 0, balanceAfter: 120, note: 'bank-self-completion' },
  { ...base, ...THIS_WEEK, eventType: 'ASSIGNMENT', eventId: 'carry-1', occurredAt: '2026-10-05T00:00:00.000Z', studentId: 'S001', assignmentStatus: 'ASSIGNED', assignmentSource: 'CARRY_FORWARD' },
  ...['S002', 'S003', 'S004', 'S005'].map((studentId, index): TaskCycleHistoryEvent => ({
    ...base, ...THIS_WEEK, eventType: 'ASSIGNMENT', eventId: `batch-${index}`, occurredAt: '2026-10-05T00:12:00.000Z',
    studentId, assignmentStatus: 'ASSIGNED', assignmentSource: 'ADMIN', note: PENDING_ASSIGNMENT_NOTE,
  })),
  { ...base, ...THIS_WEEK, eventType: 'ASSIGNMENT', eventId: 'ready-1', occurredAt: '2026-10-06T00:12:00.000Z', studentId: 'S002', assignmentStatus: 'ASSIGNED', assignmentSource: 'QR' },
  { ...base, ...THIS_WEEK, eventType: 'COMPLETION', eventId: 'c1', occurredAt: '2026-10-06T01:30:00.000Z', studentId: 'S002', studentName: '이서연', completionStatus: 'SUCCESS', completionSource: 'BANK', reward: 120, balanceBefore: 10, balanceAfter: 130, note: 'bank-self-completion' },
  { ...base, ...THIS_WEEK, eventType: 'COMPLETION', eventId: 'c2', occurredAt: '2026-10-06T02:00:00.000Z', studentId: 'S003', studentName: '박도윤', completionStatus: 'SUCCESS', completionSource: 'ADMIN', reward: 0, balanceBefore: 0, balanceAfter: 0, note: 'admin-completion' },
  { ...base, ...THIS_WEEK, eventType: 'COMPLETION', eventId: 'c3', occurredAt: '2026-10-06T03:00:00.000Z', studentId: 'S003', studentName: '박도윤', completionStatus: 'RESET', completionSource: 'ADMIN_RESET', reward: 0, balanceBefore: 0, balanceAfter: 0, note: 'admin-completion-reset' },
];

const detail: TaskHistoryDetailDto = {
  taskId: 'T001',
  requestedTaskInstanceId: null,
  currentLifecycle: {
    taskDefinitionExists: true,
    taskInstanceId: 'I1',
    currentCycleStatus: {
      cycleId: THIS_WEEK.cycleId, startsAt: THIS_WEEK.cycleStartsAt, endsAt: THIS_WEEK.cycleEndsAt, transition: 'NATURAL_BOUNDARY',
      assignedStudentIds: ['S001', 'S002', 'S003', 'S004', 'S005'], pendingStudentIds: ['S003', 'S004', 'S005'], readyStudentIds: ['S001'],
      completedStudentIds: ['S002'], students: [],
    },
  },
  cumulativeHistory: {
    eventCount: events.length,
    lifecycles: [{
      taskInstanceId: 'I1', isCurrentLifecycle: true, eventCount: events.length,
      firstOccurredAt: events[0].occurredAt, lastOccurredAt: events.at(-1)!.occurredAt, events,
    }],
  },
  students: [
    { studentId: 'S001', name: '김민준', deleted: false },
    { studentId: 'S002', name: '이서연', deleted: false },
    { studentId: 'S003', name: '박도윤', deleted: false },
    { studentId: 'S004', name: '최하은', deleted: false },
    { studentId: 'S005', name: '정우진', deleted: true },
  ],
};

const loadingHistory: TaskHistoryDialogState = {
  taskId: 'T001',
  title: '책 읽기',
  loading: true,
  error: '',
  detail: null,
};

function renderDetail(props: Partial<Parameters<typeof TaskHistoryDialog>[0]> = {}) {
  const onClose = vi.fn();
  render(<TaskHistoryDialog history={{ taskId: 'T001', title: '책 읽기', loading: false, error: '', detail }} onClose={onClose} now={NOW} {...props} />);
  return { onClose, dialog: screen.getByRole('dialog', { name: '과제 기록' }) };
}

const entryTexts = (container: HTMLElement) => within(container).queryAllByTestId('task-history-entry')
  .map((entry) => entry.querySelector('p')?.textContent);

describe('TaskHistoryDialog', () => {
  afterEach(cleanup);

  it('reads as plain sentences with student names, without technical details', () => {
    const { dialog, onClose } = renderDetail();

    const summary = within(dialog).getByRole('region', { name: '이번 회차 요약' });
    expect(summary.textContent).toContain('이번 회차 · 10월 5일(월) ~ 10월 11일(일)');
    expect(summary.textContent).toContain('부여5명');
    expect(summary.textContent).toContain('완료1명');
    expect(summary.textContent).toContain('미완료3명');

    const current = within(dialog).getByRole('button', { name: /이번 회차/ });
    expect(current.getAttribute('aria-expanded')).toBe('true');
    expect(current.textContent).toContain('10월 5일(월) ~ 10월 11일(일)');
    expect(entryTexts(dialog)).toEqual([
      '박도윤 학생의 완료 기록을 초기화했어요',
      '선생님이 박도윤 학생을 완료 처리했어요(보상 없음)',
      '이서연 학생이 완료해서 보상 120원을 받았어요',
      '이서연 학생을 완료 가능으로 바꿨어요',
      '이서연, 박도윤, 최하은 학생 외 1명에게 과제를 미완료로 부여했어요',
    ]);
    expect(within(dialog).getByText('오늘 · 10월 6일(화)')).toBeTruthy();
    expect(within(dialog).getByText('어제 · 10월 5일(월)')).toBeTruthy();
    expect(within(dialog).getAllByText('오전 9:12').length).toBe(2);
    expect(within(dialog).getByText('지난 회차에서 이어진 학생 1명')).toBeTruthy();

    expect(dialog.textContent).not.toMatch(/v1\||cycle|CARRY|ADMIN|BANK|QR|LEGACY|S00[1-5]|생애|이월|bank-self/);
    expect(screen.queryByRole('button', { name: /삭제/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps earlier cycles folded until opened and lists every student of a merged line', () => {
    const { dialog } = renderDetail({ currencyUnit: '별' });

    const previous = within(dialog).getByRole('button', { name: /지난 회차/ });
    expect(previous.getAttribute('aria-expanded')).toBe('false');
    expect(previous.textContent).toContain('9월 28일(월) ~ 10월 4일(일)');
    expect(within(dialog).queryByText(/김민준 학생이 완료해서/)).toBeNull();
    fireEvent.click(previous);
    expect(previous.getAttribute('aria-expanded')).toBe('true');
    expect(entryTexts(dialog)).toContain('김민준 학생이 완료해서 보상 120별을 받았어요');
    expect(entryTexts(dialog)).toContain('김민준 학생에게 과제를 부여했어요');

    const showAll = within(dialog).getByRole('button', { name: '4명 모두 보기' });
    fireEvent.click(showAll);
    expect(showAll.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(showAll.getAttribute('aria-controls')!)?.textContent).toBe('이서연, 박도윤, 최하은, 정우진(삭제됨)');

    const carried = within(dialog).getByRole('button', { name: '명단 보기' });
    fireEvent.click(carried);
    expect(carried.textContent).toBe('명단 접기');
    expect(document.getElementById(carried.getAttribute('aria-controls')!)?.textContent).toBe('김민준');
    fireEvent.click(within(dialog).getByRole('button', { name: /이번 회차/ }));
    expect(within(dialog).getByRole('button', { name: /이번 회차/ }).getAttribute('aria-expanded')).toBe('false');
  });

  it('filters by kind and finds a student by name across cycles', () => {
    const { dialog } = renderDetail();
    const filters = within(dialog).getByRole('group', { name: '기록 종류' });
    expect(within(filters).getByRole('button', { name: /^전체/ }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(filters).getByRole('button', { name: /^초기화·취소/ }));
    expect(entryTexts(dialog)).toEqual(['박도윤 학생의 완료 기록을 초기화했어요']);
    expect(within(dialog).queryByText(/이어진 학생/)).toBeNull();

    fireEvent.click(within(filters).getByRole('button', { name: /^완료/ }));
    expect(entryTexts(dialog)).toEqual([
      '선생님이 박도윤 학생을 완료 처리했어요(보상 없음)',
      '이서연 학생이 완료해서 보상 120원을 받았어요',
      '김민준 학생이 완료해서 보상 120원을 받았어요',
    ]);

    fireEvent.click(within(filters).getByRole('button', { name: /^전체/ }));
    fireEvent.change(within(dialog).getByRole('searchbox', { name: '학생 이름 검색' }), { target: { value: '민준' } });
    expect(within(dialog).getByRole('button', { name: /지난 회차/ }).getAttribute('aria-expanded')).toBe('true');
    expect(entryTexts(dialog)).toEqual(['김민준 학생이 완료해서 보상 120원을 받았어요', '김민준 학생에게 과제를 부여했어요']);

    fireEvent.change(within(dialog).getByRole('searchbox', { name: '학생 이름 검색' }), { target: { value: '없는 학생' } });
    expect(within(dialog).getByRole('status').textContent).toBe('조건에 맞는 기록이 없어요.');
  });

  it('shows a friendly empty state with the current summary when nothing happened yet', () => {
    const empty: TaskHistoryDetailDto = { ...detail, cumulativeHistory: { eventCount: 0, lifecycles: [] }, students: [] };
    render(<TaskHistoryDialog history={{ taskId: 'T001', title: '책 읽기', loading: false, error: '', detail: empty }} onClose={() => undefined} now={NOW} />);
    const dialog = screen.getByRole('dialog', { name: '과제 기록' });
    expect(dialog.textContent).toContain('아직 기록이 없어요');
    expect(within(dialog).getByRole('region', { name: '이번 회차 요약' })).toBeTruthy();
    expect(within(dialog).queryByRole('group', { name: '기록 종류' })).toBeNull();
  });

  it('renders loading and error states', () => {
    const { rerender } = render(<TaskHistoryDialog history={loadingHistory} onClose={() => undefined} />);
    expect(screen.getByRole('status', { name: '과제 기록 불러오는 중' })).toBeTruthy();
    rerender(<TaskHistoryDialog history={{ taskId: 'T001', title: '책 읽기', loading: false, error: '기록 서버 오류', detail: null }} onClose={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('기록 서버 오류');
  });

  it('focuses the loading close control, traps tabbing, closes on Escape, and restores the opener', () => {
    const onClose = vi.fn();
    const opener = document.createElement('button');
    opener.textContent = '기록 열기';
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(<TaskHistoryDialog history={loadingHistory} onClose={onClose} opener={opener} />);
    const close = screen.getByRole('button', { name: '닫기' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('keeps Tab inside the loaded history and closes on Escape from the search box', () => {
    const { dialog, onClose } = renderDetail();
    const close = within(dialog).getByRole('button', { name: '닫기' });
    const buttons = within(dialog).getAllByRole('button');
    const last = buttons[buttons.length - 1];
    expect(document.activeElement).toBe(close);
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(within(dialog).getByRole('searchbox', { name: '학생 이름 검색' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ...(['white', 'black', 'navy'] as const).map((name) => [name, THEME_PALETTES[name].surface, THEME_PALETTES[name].border, THEME_PALETTES[name].text] as const),
  ] as const)('uses semantic %s theme surfaces, boundaries, and text', (themeColor, surface, border, text) => {
    const onClose = vi.fn();
    render(<TaskHistoryDialog history={loadingHistory} onClose={onClose} themeColor={themeColor} />);

    const dialog = screen.getByRole('dialog', { name: '과제 기록' });
    const loading = screen.getByRole('status', { name: '과제 기록 불러오는 중' });
    const close = screen.getByRole('button', { name: '닫기' });

    expect(dialog.style.getPropertyValue('--theme-surface')).toBe(surface);
    expect(dialog.style.getPropertyValue('--theme-border')).toBe(border);
    expect(dialog.style.getPropertyValue('--theme-text')).toBe(text);
    expect(dialog.className).toContain('border-[var(--theme-border)]');
    expect(dialog.className).toContain('bg-[var(--theme-surface)]');
    expect(dialog.className).toContain('text-[var(--theme-text)]');
    expect(loading.className).toContain('bg-[var(--theme-surface-raised)]');
    expect(loading.className).toContain('text-[var(--theme-muted-text)]');
    expect(close.className).toContain('focus:ring-[var(--theme-focus-ring)]');
    expect(`${dialog.className} ${dialog.innerHTML}`).not.toMatch(/bg-white|bg-slate-|text-slate-|border-slate-/);

    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('colours the loaded history only with theme and status tokens', () => {
    const { dialog } = renderDetail({ themeColor: 'navy' });
    expect(dialog.innerHTML).not.toMatch(/bg-white|bg-slate-|text-slate-|border-slate-|#[0-9a-fA-F]{3,6}\b/);
    const kinds = within(dialog).getAllByTestId('task-history-entry').map((entry) => entry.getAttribute('data-kind'));
    expect(kinds).toEqual(['reset', 'adminComplete', 'complete', 'toReady', 'assignPending']);
  });
});
