import { describe, expect, it } from 'vitest';
import { buildStudentTaskChains } from './studentTaskChains';

type BankTask = {
  taskId: string;
  sortOrder: number;
  prerequisiteTaskId?: string;
  completed?: boolean;
  title: string;
};

const task = (taskId: string, sortOrder: number, overrides: Partial<BankTask> = {}): BankTask => ({
  taskId,
  sortOrder,
  title: taskId,
  ...overrides,
});

describe('buildStudentTaskChains', () => {
  it('groups visible prerequisite edges and topologically orders parents before dependents', () => {
    const input = [
      task('child-b', 2, { prerequisiteTaskId: 'root' }),
      task('standalone', 0),
      task('child-a', 1, { prerequisiteTaskId: 'root' }),
      task('root', 9),
    ];

    const chains = buildStudentTaskChains(input);

    expect(chains.map((chain) => chain.tasks.map((item) => item.taskId))).toEqual([
      ['standalone'],
      ['root', 'child-a', 'child-b'],
    ]);
  });

  it('uses sortOrder then taskId for deterministic roots and siblings regardless of input order', () => {
    const input = [
      task('z-child', 3, { prerequisiteTaskId: 'root-b' }),
      task('root-b', 2),
      task('a-child', 3, { prerequisiteTaskId: 'root-a' }),
      task('root-a', 2),
    ];

    const chains = buildStudentTaskChains(input);

    expect(chains).toHaveLength(2);
    expect(chains.map((chain) => chain.tasks.map((item) => item.taskId))).toEqual([
      ['root-a', 'a-child'],
      ['root-b', 'z-child'],
    ]);
  });

  it('ignores missing and self edges and terminates cycles in deterministic order', () => {
    const input = [
      task('missing', 0, { prerequisiteTaskId: 'not-visible' }),
      task('self', 1, { prerequisiteTaskId: 'self' }),
      task('cycle-b', 3, { prerequisiteTaskId: 'cycle-a' }),
      task('cycle-a', 2, { prerequisiteTaskId: 'cycle-b' }),
    ];

    const chains = buildStudentTaskChains(input);

    expect(chains.map((chain) => chain.tasks.map((item) => item.taskId))).toEqual([
      ['missing'],
      ['self'],
      ['cycle-a', 'cycle-b'],
    ]);
  });

  it('selects the first not-complete task and the last task when every task is complete', () => {
    const chains = buildStudentTaskChains([
      task('root', 0, { completed: true }),
      task('middle', 1, { prerequisiteTaskId: 'root' }),
      task('last', 2, { prerequisiteTaskId: 'middle', completed: true }),
      task('done-a', 3, { completed: true }),
      task('done-b', 4, { prerequisiteTaskId: 'done-a', completed: true }),
    ]);

    expect(chains[0]).toMatchObject({ initialIndex: 1, allCompleted: false });
    expect(chains[1]).toMatchObject({ initialIndex: 1, allCompleted: true });
  });

  it('stable-partitions incomplete chains before complete chains and treats undefined as incomplete', () => {
    const chains = buildStudentTaskChains([
      task('complete-first', 0, { completed: true }),
      task('incomplete-middle', 1),
      task('complete-last', 2, { completed: true }),
    ]);

    expect(chains.map((chain) => chain.tasks[0].taskId)).toEqual([
      'incomplete-middle',
      'complete-first',
      'complete-last',
    ]);
    expect(chains.map((chain) => chain.allCompleted)).toEqual([false, true, true]);
  });

  it('accepts a completion selector for DTOs with nested student status', () => {
    const input = [
      { taskId: 'nested-a', sortOrder: 0, studentStatus: { completed: true } },
      { taskId: 'nested-b', sortOrder: 1, prerequisiteTaskId: 'nested-a', studentStatus: { completed: false } },
    ];

    const [chain] = buildStudentTaskChains(input, (item) => item.studentStatus.completed);

    expect(chain).toMatchObject({ initialIndex: 1, allCompleted: false });
    expect(chain.tasks).toEqual(input);
  });

  it('does not mutate the input array or task objects', () => {
    const input = [
      task('child', 1, { prerequisiteTaskId: 'root' }),
      task('root', 0),
    ];
    const snapshot = structuredClone(input);

    buildStudentTaskChains(input);

    expect(input).toEqual(snapshot);
    expect(input.map((item) => item.taskId)).toEqual(['child', 'root']);
  });
});