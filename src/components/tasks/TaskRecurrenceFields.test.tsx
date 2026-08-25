import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_RECURRENCE_FORM } from '../taskRecurrenceEditor';
import { TaskRecurrenceFields, TaskScheduleProjection } from './TaskRecurrenceFields';

describe('TaskRecurrenceFields', () => {
  it('renders conditional recurrence controls and explains short-month clamping', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TaskRecurrenceFields form={EMPTY_RECURRENCE_FORM} onChange={onChange} />);

    expect(screen.queryByLabelText('반복 시간')).toBeNull();
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'MONTHLY' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'MONTHLY' }));

    rerender(<TaskRecurrenceFields form={{ ...EMPTY_RECURRENCE_FORM, type: 'MONTHLY', dayOfMonth: '31' }} onChange={onChange} />);
    expect(screen.getByLabelText('반복 시간')).toBeTruthy();
    expect(screen.getByLabelText('반복 날짜')).toBeTruthy();
    expect(screen.getByText('29/30/31일이 없는 달은 해당 월 말일로 당겨집니다.')).toBeTruthy();
  });

  it('shows the current schedule, next natural boundary, and exact reset targets', () => {
    render(<TaskScheduleProjection task={{
      schedule: {
        ruleVersion: 2,
        effectiveFrom: '2026-08-25T00:00:00.000Z',
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'WEEKLY', weekday: 2, time: '09:00' },
        resetCompletionOnCycle: true,
        resetAssignmentOnCycle: false,
      },
      currentCycle: {
        cycleId: 'cycle-1',
        startsAt: '2026-08-25T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z',
        transition: 'NATURAL_BOUNDARY',
        assignedStudentIds: [],
        completedStudentIds: [],
        students: [],
      },
    }} />);

    expect(screen.getByText(/현재 일정: 매주 화요일 09:00/)).toBeTruthy();
    expect(screen.getByText(/다음 자연 경계:/)).toBeTruthy();
    expect(screen.getByText(/다음 초기화 시각:/)).toBeTruthy();
    expect(screen.getByText(/초기화 대상: 완료 상태 초기화/)).toBeTruthy();
    expect(screen.getByText(/부여 상태 유지/)).toBeTruthy();
  });
});
