import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLASS_TREE_SETTINGS,
  classTreeEstimateDays,
  classTreeLook,
  classTreeStageProgress,
  classTreeSuggestedGoal,
  parseClassTreeSettings,
} from './classTree';

describe('class tree goal and estimate', () => {
  it('suggests about four weeks of daily waterings and a task a day for a class that has not set a goal', () => {
    expect(classTreeSuggestedGoal(DEFAULT_CLASS_TREE_SETTINGS, 25)).toBe(25 * 3 * 5 * 4);
    expect(classTreeSuggestedGoal({ waterDailyLimit: 0, taskDrops: 0 }, 10)).toBe(10 * 1 * 5 * 4);
    expect(classTreeSuggestedGoal(DEFAULT_CLASS_TREE_SETTINGS, 0)).toBe(60);
  });

  it('estimates the school days from the waterings and the tasks a student completes a week', () => {
    // Task drops come on top of the waterings: 25 students × (2 waterings + 1 task) = 75 drops a day
    expect(classTreeEstimateDays({ goal: 1500, tasksPerWeek: 5, waterDailyLimit: 2, taskDrops: 1 }, 25)).toBe(20);
    // Tasks give 3 drops each: 25 × (2 + 3) = 125 a day
    expect(classTreeEstimateDays({ goal: 1500, tasksPerWeek: 5, waterDailyLimit: 2, taskDrops: 3 }, 25)).toBe(12);
    // No tasks: 25 × 2 = 50 a day
    expect(classTreeEstimateDays({ goal: 1500, tasksPerWeek: 0, waterDailyLimit: 2, taskDrops: 1 }, 25)).toBe(30);
    expect(classTreeEstimateDays({ goal: 1500, tasksPerWeek: 5, waterDailyLimit: 2, taskDrops: 1 }, 25, 1475)).toBe(1);
    expect(classTreeEstimateDays({ goal: 100, tasksPerWeek: 0, waterDailyLimit: 0, taskDrops: 1 }, 25)).toBeNull();
    expect(classTreeEstimateDays({ goal: 100, tasksPerWeek: 5, waterDailyLimit: 1, taskDrops: 1 }, 0)).toBeNull();
  });

  it('shows students only the way to the next stage', () => {
    expect(classTreeStageProgress(0, 100)).toEqual({ stage: 0, next: 1, fraction: 0, done: 0, need: 5 });
    expect(classTreeStageProgress(10, 100)).toEqual({ stage: 1, next: 2, fraction: 0.5, done: 5, need: 10 });
    expect(classTreeStageProgress(92, 100)).toEqual({ stage: 7, next: null, fraction: 0.5, done: 8, need: 16 });
    // The stage's start is the same whole number classTreeLook uses (15% of 100 is 15, not 16).
    expect(classTreeStageProgress(15, 100)).toMatchObject({ stage: 2, done: 0, need: 13 });
  });
});

describe('class tree look', () => {
  it('moves through the stages and ripens one apple per student at the end', () => {
    expect(classTreeLook(0, 100, 25)).toMatchObject({ stage: 0, ready: false });
    expect(classTreeLook(5, 100, 25).stage).toBe(1);
    expect(classTreeLook(72, 100, 25)).toMatchObject({ stage: 6, flowers: 12 });
    expect(classTreeLook(84, 100, 25)).toMatchObject({ stage: 7, ripe: 0 });
    expect(classTreeLook(92, 100, 25)).toMatchObject({ stage: 7, ripe: 12 });
    expect(classTreeLook(100, 100, 25)).toMatchObject({ stage: 7, ripe: 25, ready: true });
    expect(classTreeLook(130, 100, 25)).toMatchObject({ progress: 1, ready: true });
  });
});

describe('class tree settings from the teacher', () => {
  const valid = { ...DEFAULT_CLASS_TREE_SETTINGS, enabled: true, rewardProductId: 'P003' };

  it('accepts whole numbers in range and a reward product (or none)', () => {
    expect(parseClassTreeSettings(valid)).toEqual({ ok: true, settings: valid });
    expect(parseClassTreeSettings({ ...valid, rewardProductId: null })).toEqual({ ok: true, settings: { ...valid, rewardProductId: null } });
    expect(parseClassTreeSettings({ ...valid, treeName: '  햇살   나무 ' })).toEqual({ ok: true, settings: { ...valid, treeName: '햇살 나무' } });
  });

  it('refuses out-of-range or non-integer values with a Korean reason', () => {
    for (const patch of [{ waterPrice: -1 }, { waterDailyLimit: 11 }, { taskDrops: 1.5 }, { goal: 0 }, { goal: null }, { tasksPerWeek: -1 },
      { rewardAmount: '100' }, { rewardProductId: '' }, { rewardProductId: ' P003' }, { rewardProductId: 3 }, { enabled: 'yes' },
      { treeName: '' }, { treeName: '   ' }, { treeName: '가'.repeat(13) }, { treeName: 3 }]) {
      const result = parseClassTreeSettings({ ...valid, ...patch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/[가-힣]/u);
    }
  });
});
