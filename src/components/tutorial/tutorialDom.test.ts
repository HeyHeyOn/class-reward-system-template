import { describe, expect, it } from 'vitest';
import { overlaps, place, unionBox } from './tutorialDom';

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
