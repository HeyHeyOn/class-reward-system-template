import { describe, expect, it } from 'vitest';
import { hiddenSide, overlaps, place, revealShift, unionBox } from './tutorialDom';

describe('tutorial geometry', () => {
  it('unites the parts of an understanding unit with room around them', () => {
    expect(unionBox([{ x: 10, y: 20, w: 100, h: 20 }, { x: 10, y: 44, w: 300, h: 40 }], 8)).toEqual({ x: 2, y: 12, w: 316, h: 80 });
  });

  it('puts the arrow outside the lit unit, closest to the control, and the message box clear of both', () => {
    // A wide lit bar with the button inside it: the arrow comes from above the button, not from the bar's far end.
    const area = { x: 300, y: 760, w: 900, h: 60 };
    const button = { x: 900, y: 770, w: 100, h: 40 };
    const { arrow, box } = place(area, button, { w: 360, h: 200 }, 1280, 860);
    expect(arrow.side).toBe('top');
    expect(arrow.x + arrow.w / 2).toBeCloseTo(950, 0);
    // A tall lit menu with the second item picked: the arrow comes from beside it, not from above the first item.
    const menu = place({ x: 4, y: 76, w: 250, h: 408 }, { x: 12, y: 128, w: 224, h: 40 }, { w: 360, h: 180 }, 1280, 860);
    expect(menu.arrow.side).toBe('right');
    expect(menu.arrow.y + menu.arrow.h / 2).toBeCloseTo(148, 0);
    expect(overlaps(box, area, 4)).toBe(false);
    expect(overlaps(box, arrow, 4)).toBe(false);
    expect(box.x >= 8 && box.y >= 8 && box.x + box.w <= 1272 && box.y + box.h <= 852).toBe(true);
  });

  it('puts the box right next to the lit unit when the step has no arrow', () => {
    const area = { x: 300, y: 200, w: 400, h: 100 };
    const target = { x: 320, y: 220, w: 120, h: 40 };
    const looking = place(area, target, { w: 340, h: 150 }, 1280, 860, false);
    expect(overlaps(looking.box, area)).toBe(false);
    const gap = (box: { x: number; y: number; w: number; h: number }) => Math.max(box.y - (area.y + area.h), area.y - (box.y + box.h), box.x - (area.x + area.w), area.x - (box.x + box.w));
    expect(gap(looking.box)).toBeLessThanOrEqual(12);
    // A unit at the very top with its control at the bottom edge: the arrow would come from below,
    // so a pointing box waits past it; with no arrow the box sits right under the unit.
    const top = { x: 300, y: 8, w: 400, h: 100 }, button = { x: 320, y: 70, w: 120, h: 34 };
    const withArrow = place(top, button, { w: 340, h: 150 }, 1280, 860);
    const without = place(top, button, { w: 340, h: 150 }, 1280, 860, false);
    expect(withArrow.arrow.side).toBe('bottom');
    expect(without.box.y).toBeLessThan(withArrow.box.y);
    expect(without.box.y - (top.y + top.h)).toBeLessThanOrEqual(12);
  });

  it('keeps the message box right after the lit unit and its arrow, lined up with the control', () => {
    // A page header lit on a phone, the arrow under its button: the box goes under the arrow, not to a far corner.
    const area = { x: 8, y: 170, w: 374, h: 170 };
    const button = { x: 16, y: 300, w: 100, h: 34 };
    const { arrow, box } = place(area, button, { w: 340, h: 140 }, 390, 844);
    expect(arrow.side).toBe('bottom');
    expect(box.y).toBeGreaterThanOrEqual(arrow.y + arrow.h);
    expect(box.y - (arrow.y + arrow.h)).toBeLessThan(20);
    // A tall form with the control in the middle: the box stays by the control, never on it.
    const tall = place({ x: 0, y: 20, w: 390, h: 800 }, { x: 20, y: 400, w: 350, h: 44 }, { w: 340, h: 140 }, 390, 844);
    expect(overlaps(tall.box, { x: 20, y: 400, w: 350, h: 44 })).toBe(false);
    expect(Math.min(Math.abs(tall.box.y - 444), Math.abs(tall.box.y + tall.box.h - 400))).toBeLessThan(70);
  });

  it('keeps the message box on screen even when the lit unit fills it', () => {
    const area = { x: 0, y: 0, w: 1280, h: 860 };
    const { box } = place(area, { x: 600, y: 400, w: 80, h: 40 }, { w: 360, h: 200 }, 1280, 860);
    expect(box.x >= 0 && box.y >= 0 && box.x + box.w <= 1280 && box.y + box.h <= 860).toBe(true);
  });
});

describe('a target under a bar or past a scrolling body', () => {
  // A phone (375×667): a sheet whose scrolling body ends at 560, above its bottom bar.
  const screenBox = { x: 0, y: 0, w: 375, h: 667 };
  const body = { x: 0, y: 120, w: 375, h: 440 };

  it('scrolls a target cut off at the bottom of a sheet body up into it, clear of the edge', () => {
    const target = { x: 20, y: 600, w: 120, h: 40 };
    expect(hiddenSide(target, body, [])).toBe('down');
    expect(revealShift(target, body, [])).toBe(640 - (560 - 12));
    const after = { ...target, y: target.y - revealShift(target, body, []) };
    expect(hiddenSide(after, body, [])).toBeNull();
    expect(revealShift(after, body, [])).toBe(0);
  });

  it('keeps a target clear of a bar that stays at the bottom of the screen and of a sticky header', () => {
    const selectionBar = { x: 0, y: 603, w: 375, h: 48 };
    const target = { x: 20, y: 580, w: 120, h: 40 };
    expect(hiddenSide(target, screenBox, [selectionBar])).toBe('down');
    expect(revealShift(target, screenBox, [selectionBar])).toBe(620 - (603 - 12));
    // A target wholly under the bar (past it) still scrolls up above it.
    const past = { x: 20, y: 640, w: 120, h: 40 };
    expect(hiddenSide(past, screenBox, [selectionBar])).toBe('down');
    expect(revealShift(past, screenBox, [selectionBar])).toBe(680 - (603 - 12));
    // A bar beside the target, not over it, does not count.
    expect(revealShift(target, screenBox, [{ ...selectionBar, x: 200, w: 100 }])).toBe(0);
    const header = { x: 0, y: 0, w: 375, h: 64 };
    const under = { x: 20, y: 40, w: 120, h: 40 };
    expect(hiddenSide(under, screenBox, [header])).toBe('up');
    expect(revealShift(under, screenBox, [header])).toBe(40 - (64 + 12));
  });

  it('tells an open window over the target apart from a bar: scrolling never clears it', () => {
    const target = { x: 270, y: 613, w: 92, h: 32 };
    const dialog = { x: 0, y: 0, w: 375, h: 667 };
    expect(hiddenSide(target, screenBox, [dialog])).toBe('covered');
    expect(revealShift(target, screenBox, [dialog])).toBe(0);
  });

  it('leaves alone a target that only just fits where it is (a tab in a sticky bar)', () => {
    const bar = { x: 0, y: 104, w: 375, h: 46 };
    expect(revealShift({ x: 90, y: 108, w: 80, h: 38 }, bar, [])).toBe(0);
    expect(revealShift({ x: 90, y: 104, w: 80, h: 46 }, bar, [])).toBe(0);
  });

  it('lines up the top of a target taller than the room, and calls it hidden only when almost none shows', () => {
    const tall = { x: 0, y: 300, w: 375, h: 900 };
    expect(revealShift(tall, body, [])).toBe(300 - (120 + 12));
    expect(hiddenSide(tall, body, [])).toBeNull();
    expect(hiddenSide({ ...tall, y: 540 }, body, [])).toBe('down');
  });

  it('puts the message box on the free top or bottom of a phone screen, never over the control', () => {
    const area = { x: 0, y: 60, w: 375, h: 580 };
    const button = { x: 20, y: 520, w: 335, h: 44 };
    const { box, arrow } = place(area, button, { w: 340, h: 220 }, 375, 667);
    expect(overlaps(box, button, 2)).toBe(false);
    expect(overlaps(box, arrow, 2)).toBe(false);
    expect(box.y >= 4 && box.y + box.h <= 663).toBe(true);
  });
});
