import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskHistoryDialog } from './TaskHistoryDialog';

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

describe('TaskHistoryDialog', () => {
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
    const { rerender } = render(<TaskHistoryDialog history={{ taskId: 'T001', title: '책 읽기', loading: true, error: '', detail: null }} onClose={() => undefined} />);
    expect(screen.getByRole('status', { name: '과제 기록 불러오는 중' })).toBeTruthy();
    rerender(<TaskHistoryDialog history={{ taskId: 'T001', title: '책 읽기', loading: false, error: '기록 서버 오류', detail: null }} onClose={() => undefined} />);
    expect(screen.getByRole('alert').textContent).toContain('기록 서버 오류');
  });
});
