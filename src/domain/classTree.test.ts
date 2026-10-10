import { describe, expect, it } from 'vitest';
import { DEFAULT_CLASS_TREE_SETTINGS, classTreeGoal, classTreeLook, parseClassTreeSettings } from './classTree';

describe('class tree goal', () => {
  it('is students × (daily waterings + one task) × 5 school days × weeks, unless typed in', () => {
    expect(classTreeGoal(DEFAULT_CLASS_TREE_SETTINGS, 25)).toBe(25 * 3 * 5 * 4);
    expect(classTreeGoal({ ...DEFAULT_CLASS_TREE_SETTINGS, waterDailyLimit: 0, taskDrops: 0 }, 10)).toBe(10 * 1 * 5 * 4);
    expect(classTreeGoal({ ...DEFAULT_CLASS_TREE_SETTINGS, goalOverride: 333 }, 25)).toBe(333);
    expect(classTreeGoal(DEFAULT_CLASS_TREE_SETTINGS, 0)).toBe(60);
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
    for (const patch of [{ waterPrice: -1 }, { waterDailyLimit: 11 }, { taskDrops: 1.5 }, { targetWeeks: 0 }, { goalOverride: 0 },
      { rewardAmount: '100' }, { rewardProductId: '' }, { rewardProductId: ' P003' }, { rewardProductId: 3 }, { enabled: 'yes' },
      { treeName: '' }, { treeName: '   ' }, { treeName: '가'.repeat(13) }, { treeName: 3 }]) {
      const result = parseClassTreeSettings({ ...valid, ...patch });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/[가-힣]/u);
    }
  });
});
