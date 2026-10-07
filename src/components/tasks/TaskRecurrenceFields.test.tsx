import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_RECURRENCE_FORM } from '../taskRecurrenceEditor';
import { TaskRecurrenceFields, TaskScheduleProjection } from './TaskRecurrenceFields';

function definitionFor(container: HTMLElement, term: string) {
  const dt = within(container).getByText(term, { selector: 'dt' });
  return dt.nextElementSibling?.textContent ?? '';
}

describe('TaskRecurrenceFields', () => {
  afterEach(cleanup);

  it('toggles multiple weekdays as accessible buttons in ISO order and keeps one selected', () => {
    const onChange = vi.fn();
    const form = { ...EMPTY_RECURRENCE_FORM, type: 'WEEKLY' as const, weekdays: ['4', '1'] };
    render(<TaskRecurrenceFields form={form} onChange={onChange} />);

    const group = screen.getByRole('group', { name: '반복 요일' });
    const monday = screen.getByRole('button', { name: '월요일' });
    const thursday = screen.getByRole('button', { name: '목요일' });
    expect(monday.getAttribute('aria-pressed')).toBe('true');
    expect(thursday.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '화요일' }).getAttribute('aria-pressed')).toBe('false');
    // Buttons are laid out in ISO order (Monday first).
    expect(within(group).getAllByRole('button').map((button) => button.getAttribute('aria-label')))
      .toEqual(['월요일', '화요일', '수요일', '목요일', '금요일', '토요일', '일요일']);
    expect(screen.getByText(/미리보기: 매주 월, 목 09:00/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '화요일' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: ['1', '2', '4'] }));
    fireEvent.click(monday);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ weekdays: ['4'] }));

    onChange.mockClear();
    cleanup();
    render(<TaskRecurrenceFields form={{ ...form, weekdays: ['1'] }} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '월요일' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('switches recurrence type through the segmented control and renders conditional controls without a per-task timezone', () => {
    const onChange = vi.fn();
    const { rerender } = render(<TaskRecurrenceFields form={EMPTY_RECURRENCE_FORM} onChange={onChange} />);

    const typeGroup = screen.getByRole('group', { name: '반복 주기' });
    expect(within(typeGroup).getAllByRole('button').map((button) => button.textContent)).toEqual(['반복 없음', '매일', '매주', '매월']);
    expect(within(typeGroup).getByRole('button', { name: '반복 없음' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByLabelText('반복 시간')).toBeNull();
    expect(screen.queryByLabelText('과제 시간대')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();

    fireEvent.click(within(typeGroup).getByRole('button', { name: '매월' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'MONTHLY', dayOfMonth: '1', time: '09:00' }));
    fireEvent.click(within(typeGroup).getByRole('button', { name: '매주' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'WEEKLY', weekdays: ['1'], time: '09:00' }));

    const monthly = { ...EMPTY_RECURRENCE_FORM, type: 'MONTHLY' as const, dayOfMonth: '31', time: '08:30' };
    rerender(<TaskRecurrenceFields form={monthly} onChange={onChange} />);
    expect(screen.getByRole('button', { name: '매월' }).getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('반복 시간') as HTMLInputElement).value).toBe('08:30');
    expect((screen.getByLabelText('반복 날짜') as HTMLInputElement).value).toBe('31');
    expect(screen.getByText(/29~31일이 없는 달은 그 달 마지막 날로 바뀝니다/)).toBeTruthy();
    expect(screen.getByText(/미리보기: 매월 31일 08:30/)).toBeTruthy();
    expect(screen.queryByLabelText('과제 시간대')).toBeNull();

    fireEvent.change(screen.getByLabelText('반복 날짜'), { target: { value: '15' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ dayOfMonth: '15' }));
    fireEvent.change(screen.getByLabelText('반복 시간'), { target: { value: '07:00' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ time: '07:00' }));
  });

  it('reports cycle reset switches as form flags', () => {
    const onChange = vi.fn();
    const form = { ...EMPTY_RECURRENCE_FORM, type: 'DAILY' as const, time: '09:00', resetCompletionOnCycle: false, resetAssignmentOnCycle: true };
    render(<TaskRecurrenceFields form={form} onChange={onChange} />);

    const completion = screen.getByRole('switch', { name: '회차마다 완료 초기화' }) as HTMLInputElement;
    const assignment = screen.getByRole('switch', { name: '회차마다 부여 초기화' }) as HTMLInputElement;
    expect(completion.checked).toBe(false);
    expect(assignment.checked).toBe(true);

    fireEvent.click(completion);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ resetCompletionOnCycle: true, resetAssignmentOnCycle: true }));
    fireEvent.click(assignment);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ resetCompletionOnCycle: false, resetAssignmentOnCycle: false }));
  });

  it('leaves the type unselected when unset is allowed', () => {
    const onChange = vi.fn();
    render(<TaskRecurrenceFields form={{ ...EMPTY_RECURRENCE_FORM, type: '' as never }} onChange={onChange} allowUnset />);
    const typeGroup = screen.getByRole('group', { name: '반복 주기' });
    expect(within(typeGroup).getAllByRole('button').every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(screen.queryByText(/미리보기:/)).toBeNull();
  });

  it('shows the current schedule, next cycle start, and exact reset targets', () => {
    const { container } = render(<TaskScheduleProjection task={{
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

    expect(definitionFor(container, '현재 일정')).toBe('매주 화 09:00');
    expect(definitionFor(container, '현재 회차')).toContain('~');
    expect(definitionFor(container, '다음 회차 시작')).not.toMatch(/없음|정보 없음/);
    expect(definitionFor(container, '새 회차 처리')).toBe('완료 지움 · 부여 유지');
  });

  it('describes a permanent task without a next cycle', () => {
    const { container } = render(<TaskScheduleProjection task={{}} />);
    expect(definitionFor(container, '현재 일정')).toBe('반복 없음');
    expect(definitionFor(container, '현재 회차')).toBe('상시');
    expect(definitionFor(container, '다음 회차 시작')).toBe('없음 (상시 과제)');
    expect(definitionFor(container, '새 회차 처리')).toBe('완료 유지 · 부여 유지');
  });
});
