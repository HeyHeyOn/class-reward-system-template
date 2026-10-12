import { describe, expect, it } from 'vitest';
import { overlaps, place, unionBox } from './tutorialDom';

describe('tutorial geometry', () => {
  it('unites the parts of an understanding unit with room around them', () => {
    expect(unionBox([{ x: 10, y: 20, w: 100, h: 20 }, { x: 10, y: 44, w: 300, h: 40 }], 8)).toEqual({ x: 2, y: 12, w: 316, h: 80 });
  });

  it('puts the arrow outside the lit unit, closest to the control, and the message box clear of both', () => {
    // A wide lit bar with the button at its right end: the arrow comes from above the button.
    const area = { x: 300, y: 760, w: 900, h: 60 };
    const button = { x: 1100, y: 770, w: 100, h: 40 };
    const { arrow, box } = place(area, button, { w: 360, h: 200 }, 1280, 860);
    expect(arrow.side).toBe('top');
    expect(arrow.x + arrow.w / 2).toBeCloseTo(1150, 0);
    expect(overlaps(box, area, 4)).toBe(false);
    expect(overlaps(box, arrow, 4)).toBe(false);
    expect(box.x >= 8 && box.y >= 8 && box.x + box.w <= 1272 && box.y + box.h <= 852).toBe(true);
  });

  it('keeps the message box on screen even when the lit unit fills it', () => {
    const area = { x: 0, y: 0, w: 1280, h: 860 };
    const { box } = place(area, { x: 600, y: 400, w: 80, h: 40 }, { w: 360, h: 200 }, 1280, 860);
    expect(box.x >= 0 && box.y >= 0 && box.x + box.w <= 1280 && box.y + box.h <= 860).toBe(true);
  });
});
