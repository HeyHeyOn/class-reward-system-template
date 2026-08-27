import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_RECURRENCE_FORM } from '../taskRecurrenceEditor';
import { TaskRecurrenceFields, TaskScheduleProjection } from './TaskRecurrenceFields';

describe('TaskRecurrenceFields', () => {
  it('toggles multiple weekdays as accessible circular buttons in ISO order and keeps one selected', () => {
    const onChange = vi.fn();
    const form = { ...EMPTY_RECURRENCE_FORM, type: 'WEEKLY' as const, weekdays: ['4', '1'] };
    render(<TaskRecurrenceFields form={form} onChange={onChange} />);

    const group = screen.getByRole('group', { name: '반복 요일' });
    const monday = screen.getByRole('button', { name: '월요일' });
    const thursday = screen.getByRole('button', { name: '목요일' });
    expect(monday.getAttribute('aria-pressed')).toBe('true');
    expect(thursday.getAttribute('aria-pressed')).toBe('true');
    expect(monday.className).toContain('h-11');
    expect(monday.className).toContain('w-11');
    expect(group.textContent).toContain('일월화수목금토');
    expect(screen.getByText('미리보기: 매주 월, 목 09:00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '화요일' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: ['1', '2', '4'] }));
    fireEvent.click(monday);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: ['4'] }));

    onChange.mockClear();
    cleanup();
    const { rerender } = render(<TaskRecurrenceFields form={{ ...form, weekdays: ['1'] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '월요일' }));
    expect(onChange).not.toHaveBeenCalled();
    rerender(<></>);
  });
  it('renders conditional recurrence controls without a per-task timezone and uses supplied theme tokens', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(<TaskRecurrenceFields
      form={EMPTY_RECURRENCE_FORM}
      onChange={onChange}
      styles={{ detail: 'theme-detail', preview: 'theme-preview' }}
    />);

    expect(screen.queryByLabelText('반복 시간')).toBeNull();
    expect(screen.queryByLabelText('과제 시간대')).toBeNull();
    fireEvent.change(screen.getByLabelText('반복 주기'), { target: { value: 'MONTHLY' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'MONTHLY' }));

    rerender(<TaskRecurrenceFields form={{ ...EMPTY_RECURRENCE_FORM, type: 'MONTHLY', dayOfMonth: '31' }} onChange={onChange} styles={{ detail: 'theme-detail', preview: 'theme-preview' }} />);
    expect(screen.getByLabelText('반복 시간')).toBeTruthy();
    expect(screen.getByLabelText('반복 날짜')).toBeTruthy();
    expect(screen.getByText('29/30/31일이 없는 달은 해당 월 말일로 당겨집니다.').className).toContain('theme-detail');
    expect(screen.getByText(/미리보기:/).className).toContain('theme-preview');
    expect(container.innerHTML).not.toContain('violet-');
  });

  it('shows the current schedule, next natural boundary, and exact reset targets', () => {
    render(<TaskScheduleProjection task={{
      schedule: {
        ruleVersion: 2,
        effectiveFrom: '2026-08-25T00:00:00.000Z',
        timeZone: 'Asia/Seoul',
        recurrence: { type: 'WEEKLY', weekdays: [2], time: '09:00' },
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

    expect(screen.getByText(/현재 일정: 매주 화 09:00/)).toBeTruthy();
    expect(screen.getByText(/다음 자연 경계:/)).toBeTruthy();
    expect(screen.getByText(/다음 초기화 시각:/)).toBeTruthy();
    expect(screen.getByText(/초기화 대상: 완료 상태 초기화/)).toBeTruthy();
    expect(screen.getByText(/부여 상태 유지/)).toBeTruthy();
  });
});
