import { describe, expect, it } from 'vitest';
import { createTaskDialogTarget, taskTargetSummary } from './taskTargetSummary';

describe('taskTargetSummary', () => {
  it('labels new and single task contexts', () => {
    expect(taskTargetSummary(createTaskDialogTarget('new'))).toEqual({ short: '새 과제', full: '새 과제', count: 0 });
    expect(taskTargetSummary(createTaskDialogTarget('single', [{ taskId: 'T1', title: '책 읽기' }]))).toEqual({ short: '책 읽기', full: '책 읽기', count: 1 });
  });

  it('shows the first three bulk titles and exposes the full immutable snapshot', () => {
    const rows = [
      { taskId: 'T1', title: '첫째' },
      { taskId: 'T2', title: '둘째' },
      { taskId: 'T3', title: '셋째' },
      { taskId: 'T4', title: '넷째' },
      { taskId: 'T5', title: '다섯째' },
    ];
    const target = createTaskDialogTarget('bulk', rows);
    rows[0].title = '바뀐 제목';

    expect(taskTargetSummary(target)).toEqual({
      short: '첫째, 둘째, 셋째 외 2개',
      full: '첫째, 둘째, 셋째, 넷째, 다섯째',
      count: 5,
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(Object.isFrozen(target.tasks)).toBe(true);
  });
});
