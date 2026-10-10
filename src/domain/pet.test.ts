import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PET_SETTINGS,
  cleanPetName,
  koreaClock,
  normalizePetDecor,
  parsePetSettings,
  petDecorItem,
  petEstimateDays,
  petHoursOpen,
  petNextOpen,
  petShopForSale,
  petStageFor,
  petStageProgress,
  petStageStarts,
} from './pet';
import { schoolDaysLabel } from './schoolDays';

const valid = { ...DEFAULT_PET_SETTINGS, enabled: true };

describe('pet growth', () => {
  it('estimates the school days to grow up from warming, the daily feedings and the tasks a week', () => {
    // goal 40: the egg hatches at 4 (warm 1 + task 1 a day → 2 days), then 2 feedings + 1 task a day (36 more → 12 days)
    expect(petEstimateDays(DEFAULT_PET_SETTINGS)).toBe(14);
    expect(petEstimateDays({ ...DEFAULT_PET_SETTINGS, tasksPerWeek: 0 })).toBe(4 + 18);
    expect(petEstimateDays({ ...DEFAULT_PET_SETTINGS, careGrowth: 0, taskGrowth: 0 })).toBeNull();
    expect(petEstimateDays({ ...DEFAULT_PET_SETTINGS, feedDailyLimit: 0, tasksPerWeek: 0 })).toBeNull();
    expect([3, 14, 22, 52].map(schoolDaysLabel)).toEqual(['약 3일', '약 3주', '약 4.5주', '약 10.5주']);
  });

  it('shows students only the way to the next stage', () => {
    expect(petStageProgress(2, 40, 0)).toEqual({ next: 1, fraction: 0.5 });
    expect(petStageProgress(11, 40, 1)).toEqual({ next: 2, fraction: 0.5 });
    expect(petStageProgress(40, 40, 3)).toEqual({ next: null, fraction: 1 });
    // A cancelled growth never shrinks a stage: the bar just starts empty.
    expect(petStageProgress(2, 40, 1)).toEqual({ next: 2, fraction: 0 });
  });

  it('hatches at a tenth of the goal, is young from 45% and grown at the goal', () => {
    expect(petStageStarts(40)).toEqual({ hatch: 4, young: 18, adult: 40 });
    expect([0, 3, 4, 17, 18, 39, 40, 99].map((growth) => petStageFor(growth, 40))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });
});

describe('opening hours', () => {
  const hours = [{ start: '08:00', end: '09:00' }, { start: '14:30', end: '21:00' }];
  it('is always open while off; on with no spans it never is', () => {
    expect(petHoursOpen({ hoursEnabled: false, hours: [] }, '03:00')).toBe(true);
    expect(petHoursOpen({ hoursEnabled: true, hours: [] }, '12:00')).toBe(false);
    expect(petNextOpen({ hoursEnabled: true, hours: [] }, '12:00')).toBeNull();
  });

  it('is open inside a span (end excluded) and tells the next opening', () => {
    expect(['07:59', '08:00', '08:59', '09:00', '15:00', '21:00'].map((clock) => petHoursOpen({ hoursEnabled: true, hours }, clock)))
      .toEqual([false, true, true, false, true, false]);
    expect(petNextOpen({ hoursEnabled: true, hours }, '10:05')).toBe('14:30');
    expect(petNextOpen({ hoursEnabled: true, hours }, '22:00')).toBe('내일 08:00');
  });

  it('reads the clock in Korea time', () => {
    expect(koreaClock(new Date('2026-10-12T03:05:00Z'))).toBe('12:05');
    expect(koreaClock(new Date('2026-10-12T15:30:00Z'))).toBe('00:30');
  });
});

describe('settings parsing', () => {
  it('accepts valid settings, sorting the spans and leaving unset prices out', () => {
    const parsed = parsePetSettings({
      ...valid,
      hours: [{ start: '14:30', end: '21:00' }, { start: '08:00', end: '09:00' }],
      shopPrices: { 'wall:mint': { price: 30, sell: true }, 'rug:blue': { price: null, sell: false }, 'bed:cloud': { price: 0, sell: false } },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.hours.map((span) => span.start)).toEqual(['08:00', '14:30']);
    expect(parsed.settings.shopPrices).toEqual({ 'wall:mint': { price: 30, sell: true }, 'bed:cloud': { price: 0, sell: false } });
    expect(petShopForSale(parsed.settings).map((item) => [item.key, item.price])).toEqual([['wall:mint', 30]]);
  });

  it('refuses spans that end before they start, unknown or base items and out-of-range numbers', () => {
    expect(parsePetSettings({ ...valid, hours: [{ start: '09:00', end: '08:00' }] })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, hours: [{ start: '9:00', end: '10:00' }] })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, shopPrices: { 'wall:cream': { price: 10, sell: true } } })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, shopPrices: { 'wall:gold': { price: 10, sell: true } } })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, feedDailyLimit: 4 })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, goal: 0 })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, tasksPerWeek: 101 })).toMatchObject({ ok: false });
    expect(parsePetSettings({ ...valid, enabled: 'yes' })).toMatchObject({ ok: false });
  });
});

describe('names and decor', () => {
  it('trims names to 1–8 characters without control characters', () => {
    expect(cleanPetName('  초코  칩 ')).toBe('초코 칩');
    expect(cleanPetName('')).toBeNull();
    expect(cleanPetName('아홉글자이름입니다')).toBeNull();
    expect(cleanPetName('<b>')).toBeNull();
  });

  it('knows decor keys and fills an incomplete room with the base items', () => {
    expect(petDecorItem('wall:mint')).toMatchObject({ slot: 'wall', id: 'mint', base: false });
    expect(petDecorItem('toy:none')).toMatchObject({ base: true });
    expect(petDecorItem('acc:ribbon')).toMatchObject({ slot: 'acc', id: 'ribbon', base: false });
    expect(petDecorItem('acc:none')).toMatchObject({ base: true });
    expect(petDecorItem('acc:wings')).toBeNull();
    expect(petDecorItem('wall:mint:x')).toBeNull();
    expect(normalizePetDecor({ wall: 'night', rug: 'gold' })).toEqual({ wall: 'night', rug: 'pink', bed: 'basic', plant: 'pot', frame: 'tree', toy: 'none' });
  });
});
