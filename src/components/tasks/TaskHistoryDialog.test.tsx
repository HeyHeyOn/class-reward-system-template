import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskHistoryDialog, type TaskHistoryDialogState } from './TaskHistoryDialog';

const detail = {
  taskId: 'T001',
  requestedTaskInstanceId: null,
  currentLifecycle: { taskDefinitionExists: true, taskInstanceId: 'i1', currentCycleStatus: { cycleId: 'cycle-2' } },
  cumulativeHistory: {
    eventCount: 2,
    lifecycles: [{
      taskInstanceId: 'i1', isCurrentLifecycle: true, eventCount: 2,
      firstOccurredAt: '2026-08-25T01:00:00Z', lastOccurredAt: '2026-08-25T02:00:00Z',
      events: [
        { eventType: 'ASSIGNMENT', eventId: 'a1', occurredAt: '2026-08-25T01:00:00Z', taskId: 'T001', taskInstanceId: 'i1', cycleId: 'cycle-1', ruleVersion: 1, studentId: 'S001', assignmentStatus: 'ASSIGNED', assignmentSource: 'ADMIN', note: '' },
        { eventType: 'COMPLETION', eventId: 'c1', occurredAt: '2026-08-25T02:00:00Z', taskId: 'T001', taskInstanceId: 'i1', cycleId: 'cycle-2', ruleVersion: 2, studentId: 'S001', studentName: '민준', completionStatus: 'SUCCESS', completionSource: 'BANK', reward: 5, balanceBefore: 10, balanceAfter: 15, note: '' },
      ],
    }],
  },
} as never;

const loadingHistory: TaskHistoryDialogState = {
  taskId: 'T001',
  title: '책 읽기',
  loading: true,
  error: '',
  detail: null,
};

describe('TaskHistoryDialog', () => {
  afterEach(cleanup);

  it('renders lifecycle/cycle history and delegates close without deletion UI', () => {
    const onClose = vi.fn();
    render(<TaskHistoryDialog history={{ taskId: 'T001', title: '책 읽기', loading: false, error: '', detail }} onClose={onClose} />);

    expect(screen.getByRole('dialog', { name: '과제 기록' })).toBeTruthy();
    expect(screen.getByText('현재 과제 생애')).toBeTruthy();
    expect(screen.getByText(/현재 회차 · cycle-2 · 반복 규칙 변경/)).toBeTruthy();
    expect(screen.getByText(/완료 · 은행 · 보상 5/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /삭제/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    expect(onClose).toHaveBeenCalledOnce();
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

  it.each([
    ['white', '#FFFFFF', '#8A8A8A', '#1F1F1F'],
    ['black', '#2B2B2B', '#818181', '#FCFCFC'],
    ['navy', '#1B2945', '#7184A6', '#F7FAFF'],
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
});
