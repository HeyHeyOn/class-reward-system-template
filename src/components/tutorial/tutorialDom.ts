import type { TutorialArea, TutorialStep } from './tutorials';

/* Finding a tutorial step's elements on the live page, and the rectangles to draw around them. */

export type Box = Readonly<{ x: number; y: number; w: number; h: number }>;

export function isShown(element: Element): boolean {
  if (!(element instanceof HTMLElement) && !(element instanceof SVGElement)) return false;
  if (element.closest('[hidden]')) return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

/** The first shown element matching any of the selectors, in order. */
export function firstShown(selectors: string | readonly string[], root: ParentNode = document): HTMLElement | null {
  for (const selector of typeof selectors === 'string' ? [selectors] : selectors) {
    let matches: Element[];
    try { matches = Array.from(root.querySelectorAll(selector)); } catch { continue; }
    const hit = matches.find(isShown);
    if (hit) return hit as HTMLElement;
  }
  return null;
}

function areaPart(part: TutorialArea, target: HTMLElement): Element | null {
  if (typeof part === 'object') return target.closest(part.closest);
  switch (part) {
    case '@target': return target;
    case '@field': return target.closest('[data-field]');
    case '@header': return target.closest('[data-page-header]');
    case '@footer': return target.closest('footer');
    case '@parent': return target.parentElement;
    default: return firstShown(part);
  }
}

/** The elements of the step's understanding unit; by default the target's field, or the target. */
export function areaElements(step: TutorialStep, target: HTMLElement): HTMLElement[] {
  const parts = step.area ?? ['@field'];
  const found = parts.map((part) => areaPart(part, target)).filter((element): element is HTMLElement => element instanceof HTMLElement && isShown(element));
  if (!found.length) return [target];
  // The target always belongs to the lit unit.
  return found.some((element) => element === target || element.contains(target)) ? found : [...found, target];
}

export function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
}

export function unionBox(boxes: readonly Box[], pad = 0): Box {
  const x0 = Math.min(...boxes.map((box) => box.x)) - pad, y0 = Math.min(...boxes.map((box) => box.y)) - pad;
  const x1 = Math.max(...boxes.map((box) => box.x + box.w)) + pad, y1 = Math.max(...boxes.map((box) => box.y + box.h)) + pad;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function overlaps(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin;
}

export type ArrowSide = 'left' | 'top' | 'bottom' | 'right';
export type Placement = Readonly<{ arrow: Box & { side: ArrowSide }; box: Box }>;

const ARROW = 46;
const GAP = 10;

/**
 * Where the arrow (outside the lit area, pointing at the target from its nearest side) and the
 * message box go, inside a viewport of `vw`×`vh`. The box sits right next to the lit unit and its
 * arrow, lined up with the target — never over the target, the arrow or (when there is room) the
 * unit — so the eye stays on one spot.
 */
export function place(area: Box, target: Box, size: Readonly<{ w: number; h: number }>, vw: number, vh: number): Placement {
  const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
  const clampX = (x: number, w: number) => Math.max(8, Math.min(vw - w - 8, x));
  const clampY = (y: number, h: number) => Math.max(8, Math.min(vh - h - 8, y));
  const arrows: Array<Box & { side: ArrowSide }> = [
    { side: 'left', x: area.x - ARROW - GAP, y: clampY(cy - ARROW / 2, ARROW), w: ARROW, h: ARROW },
    { side: 'top', x: clampX(cx - ARROW / 2, ARROW), y: area.y - ARROW - GAP, w: ARROW, h: ARROW },
    { side: 'bottom', x: clampX(cx - ARROW / 2, ARROW), y: area.y + area.h + GAP, w: ARROW, h: ARROW },
    { side: 'right', x: area.x + area.w + GAP, y: clampY(cy - ARROW / 2, ARROW), w: ARROW, h: ARROW },
  ];
  const inside = (box: Box) => box.x >= 4 && box.y >= 4 && box.x + box.w <= vw - 4 && box.y + box.h <= vh - 4;
  // The side whose tip comes closest to the control (a wide lit bar: above the button, not at its far end).
  const tip = (arrow: Box & { side: ArrowSide }) => arrow.side === 'left' ? [arrow.x + arrow.w, arrow.y + arrow.h / 2]
    : arrow.side === 'right' ? [arrow.x, arrow.y + arrow.h / 2] : arrow.side === 'top' ? [arrow.x + arrow.w / 2, arrow.y + arrow.h] : [arrow.x + arrow.w / 2, arrow.y];
  const distance = (arrow: Box & { side: ArrowSide }) => { const [px, py] = tip(arrow); return Math.hypot(px - cx, py - cy); };
  const arrow = arrows.filter(inside).sort((a, b) => distance(a) - distance(b))[0] ?? { ...arrows[0], x: clampX(arrows[0].x, ARROW) };

  const sized = (x: number, y: number): Box => ({ x, y, w: size.w, h: size.h });
  const alignedX = clampX(cx - size.w / 2, size.w), alignedY = clampY(cy - size.h / 2, size.h);
  // Just past the unit — and past the arrow when the arrow is on that side.
  const below = Math.max(area.y + area.h, arrow.side === 'bottom' ? arrow.y + arrow.h : -Infinity) + GAP;
  const above = Math.min(area.y, arrow.side === 'top' ? arrow.y : Infinity) - GAP - size.h;
  const right = Math.max(area.x + area.w, arrow.side === 'right' ? arrow.x + arrow.w : -Infinity) + GAP;
  const left = Math.min(area.x, arrow.side === 'left' ? arrow.x : Infinity) - GAP - size.w;
  const nearest = (boxes: Box[]) => boxes.sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy))[0];
  const around = [sized(alignedX, below), sized(alignedX, above), sized(right, alignedY), sized(left, alignedY)]
    .filter((box) => inside(box) && !overlaps(box, area, 2) && !overlaps(box, arrow, 2));
  if (around.length) return { arrow, box: nearest(around) };
  // A unit too big to go around (a tall form): stay right by the control, over another part of the
  // unit but never over the control or the arrow.
  const byTarget = [
    sized(alignedX, Math.max(target.y + target.h, arrow.side === 'bottom' ? arrow.y + arrow.h : -Infinity) + GAP),
    sized(alignedX, Math.min(target.y, arrow.side === 'top' ? arrow.y : Infinity) - GAP - size.h),
  ].filter((box) => inside(box) && !overlaps(box, target, 2) && !overlaps(box, arrow, 2));
  if (byTarget.length) return { arrow, box: nearest(byTarget) };
  return { arrow, box: sized(alignedX, clampY(below, size.h)) };
}

/**
 * True when the element sits in a layer that stays put while the page scrolls (a dialog or panel,
 * a sticky bar, the side menu). The tutorial then stays put with it; otherwise it scrolls with the page.
 */
export function inFixedLayer(element: Element): boolean {
  for (let node: Element | null = element; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const position = getComputedStyle(node).position;
    if (position === 'fixed' || position === 'sticky') return true;
  }
  return false;
}
