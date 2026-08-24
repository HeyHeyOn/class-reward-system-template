import { describe, expect, it } from 'vitest';
import { evaluateTaskCompletion } from './taskCompletionPolicy';

const task = {
  taskId: 'T001',
  reward: 5,
  createdAt: '2026-05-21T00:00:00.000Z',
};

const student = {
  studentId: 'S001',
  balance: 10,
};

const success = {
  taskId: 'T001',
  studentId: 'S001',
  status: 'SUCCESS',
  timestamp: '2026-05-21T01:00:00.000Z',
};

describe('task completion policy', () => {
  it('allows completion when the current task instance has no success and applies the reward', () => {
    expect(evaluateTaskCompletion({ task, student, completions: [] })).toEqual({
      ok: true,
      balanceAfter: 15,
    });
  });

  it('allows completion when only a deleted previous task instance was completed', () => {
    expect(evaluateTaskCompletion({
      task,
      student,
      completions: [{ ...success, timestamp: '2026-05-20T23:59:59.999Z' }],
    })).toEqual({ ok: true, balanceAfter: 15 });
  });

  it('rejects a second SUCCESS for the current task instance with the fixed message', () => {
    expect(evaluateTaskCompletion({ task, student, completions: [success] })).toEqual({
      ok: false,
      message: '이미 완료한 과제입니다.',
    });
  });

  it('ignores legacy maxCompletionsPerStudent', () => {
    const legacyTask = { ...task, maxCompletionsPerStudent: 99 };

    expect(evaluateTaskCompletion({ task: legacyTask, student, completions: [success] })).toEqual({
      ok: false,
      message: '이미 완료한 과제입니다.',
    });
  });

  it('applies the reward directly to a negative student balance', () => {
    expect(evaluateTaskCompletion({
      task: { ...task, reward: 2 },
      student: { ...student, balance: -3 },
      completions: [],
    })).toEqual({ ok: true, balanceAfter: -1 });
  });

  it.each([
    ['missing task createdAt', { taskId: 'T001', reward: 5 }, success],
    ['malformed task createdAt', { ...task, createdAt: '5630' }, success],
    ['missing completion timestamp', task, { taskId: 'T001', studentId: 'S001', status: 'SUCCESS' }],
    ['malformed completion timestamp', task, { ...success, timestamp: 'not-a-date' }],
  ])('preserves the legacy current-instance heuristic for %s', (_case, currentTask, completion) => {
    expect(evaluateTaskCompletion({ task: currentTask, student, completions: [completion] })).toEqual({
      ok: false,
      message: '이미 완료한 과제입니다.',
    });
  });

  it('ignores non-SUCCESS, other-student, and other-task completions', () => {
    expect(evaluateTaskCompletion({
      task,
      student,
      completions: [
        { ...success, status: 'FAILED' },
        { ...success, studentId: 'S002' },
        { ...success, taskId: 'T002' },
      ],
    })).toEqual({ ok: true, balanceAfter: 15 });
  });
});
