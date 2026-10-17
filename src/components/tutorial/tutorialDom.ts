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
export function place(area: Box, target: Box, size: Readonly<{ w: number; h: number }>, vw: number, vh: number, pointing = true): Placement {
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
  // The side whose tip comes closest to the control's edge (a wide lit bar: above the button, not at
  // its far end; a tall menu: beside the item, not above the first one).
  const tip = (arrow: Box & { side: ArrowSide }) => arrow.side === 'left' ? [arrow.x + arrow.w, arrow.y + arrow.h / 2]
    : arrow.side === 'right' ? [arrow.x, arrow.y + arrow.h / 2] : arrow.side === 'top' ? [arrow.x + arrow.w / 2, arrow.y + arrow.h] : [arrow.x + arrow.w / 2, arrow.y];
  const toEdge = (arrow: Box & { side: ArrowSide }) => {
    const [px, py] = tip(arrow);
    const dx = Math.max(target.x - px, 0, px - (target.x + target.w)), dy = Math.max(target.y - py, 0, py - (target.y + target.h));
    return Math.hypot(dx, dy);
  };
  // Even (the control is the whole lit unit): the side nearest its middle — above or below a wide bar.
  const toMiddle = (arrow: Box & { side: ArrowSide }) => { const [px, py] = tip(arrow); return Math.hypot(px - cx, py - cy); };
  const arrow = arrows.filter(inside).sort((a, b) => (Math.abs(toEdge(a) - toEdge(b)) > 4 ? toEdge(a) - toEdge(b) : toMiddle(a) - toMiddle(b)))[0]
    ?? { ...arrows[0], x: clampX(arrows[0].x, ARROW) };

  const sized = (x: number, y: number): Box => ({ x, y, w: size.w, h: size.h });
  const alignedX = clampX(cx - size.w / 2, size.w), alignedY = clampY(cy - size.h / 2, size.h);
  // A step only to look at draws no arrow: the box goes right next to the unit.
  const side = pointing ? arrow.side : null;
  // Just past the unit — and past the arrow when the arrow is on that side.
  const below = Math.max(area.y + area.h, side === 'bottom' ? arrow.y + arrow.h : -Infinity) + GAP;
  const above = Math.min(area.y, side === 'top' ? arrow.y : Infinity) - GAP - size.h;
  const right = Math.max(area.x + area.w, side === 'right' ? arrow.x + arrow.w : -Infinity) + GAP;
  const left = Math.min(area.x, side === 'left' ? arrow.x : Infinity) - GAP - size.w;
  const clearOfArrow = (box: Box) => !pointing || !overlaps(box, arrow, 2);
  const nearest = (boxes: Box[]) => boxes.sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy))[0];
  const around = [sized(alignedX, below), sized(alignedX, above), sized(right, alignedY), sized(left, alignedY)]
    .filter((box) => inside(box) && !overlaps(box, area, 2) && clearOfArrow(box));
  if (around.length) return { arrow, box: nearest(around) };
  // A unit too big to go around (a tall form): stay right by the control, over another part of the
  // unit but never over the control or the arrow.
  const byTarget = [
    sized(alignedX, Math.max(target.y + target.h, side === 'bottom' ? arrow.y + arrow.h : -Infinity) + GAP),
    sized(alignedX, Math.min(target.y, side === 'top' ? arrow.y : Infinity) - GAP - size.h),
  ].filter((box) => inside(box) && !overlaps(box, target, 2) && clearOfArrow(box));
  if (byTarget.length) return { arrow, box: nearest(byTarget) };
  // A small screen (a phone): the top or bottom edge, whichever has the room clear of the control and the
  // arrow; the one farther from the control when both do.
  const edges = [sized(alignedX, 8), sized(alignedX, arrow.y + arrow.h + GAP), sized(alignedX, vh - size.h - 8), sized(alignedX, arrow.y - GAP - size.h)]
    .filter((box) => inside(box) && !overlaps(box, target, 2) && clearOfArrow(box))
    .sort((a, b) => Math.abs(b.y + b.h / 2 - cy) - Math.abs(a.y + a.h / 2 - cy));
  if (edges.length) return { arrow, box: edges[0] };
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

export function intersect(a: Box, b: Box): Box {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/**
 * The part of the screen where `element` can show at all: inside every ancestor that clips its content (a
 * sheet's scrolling body ends above the sheet's bottom bar), within their borders and scrollbars. Null when
 * nothing clips it.
 */
export function clipBox(element: Element): Box | null {
  let clip: Box | null = null;
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const rect = node.getBoundingClientRect();
    const inner = { x: rect.left + node.clientLeft, y: rect.top + node.clientTop, w: node.clientWidth || rect.width, h: node.clientHeight || rect.height };
    clip = clip ? intersect(clip, inner) : inner;
  }
  return clip;
}

/** The closest ancestor that scrolls up and down (a sheet's body), or the page. */
export function scrollerOf(element: Element): Element {
  for (let node = element.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
  }
  return document.scrollingElement ?? document.documentElement;
}

/**
 * What stays put over the target where the teacher would look at it (a bar fixed to the screen's bottom, the
 * notices, a sticky header or save bar): for each, the box of the whole thing on top (the part of its tree
 * that is not also the target's). Only fixed or sticky things count: a control's own styled parts drawn over
 * it do not, and a sheet's bottom bar clips the target (clipBox) rather than covering it. `own` tells the
 * tutorial's own layers.
 */
export function coversOf(target: HTMLElement, own: (element: Element) => boolean, probe: Box = boxOf(target),
  remembered?: Set<Element>): Box[] {
  if (typeof document.elementsFromPoint !== 'function') return [];
  const box = boxOf(target);
  const x = Math.min(Math.max(box.x + box.w / 2, 1), window.innerWidth - 1);
  const covers = new Map<Element, Box>();
  // Down the target and, when given, the lit unit around it (whose ring must not run under a bar either).
  const ys = [box.y + Math.min(4, box.h / 4), box.y + box.h / 2, box.y + box.h - Math.min(4, box.h / 4)];
  if (probe !== box) ys.push(probe.y + Math.min(6, probe.h / 4), probe.y + probe.h - Math.min(6, probe.h / 4));
  for (const y of ys) {
    if (y < 0 || y > window.innerHeight) continue;
    const top = document.elementsFromPoint(x, y).find((element) => !own(element));
    if (!top || target === top || target.contains(top) || top.contains(target)) continue;
    let cover: Element = top;
    let stays = ['fixed', 'sticky'].includes(getComputedStyle(cover).position);
    while (cover.parentElement && !cover.parentElement.contains(target)) {
      cover = cover.parentElement;
      stays ||= ['fixed', 'sticky'].includes(getComputedStyle(cover).position);
    }
    if (stays) covers.set(cover, boxOf(cover));
  }
  // What covered the target once in this step (a sticky header) still bounds where it can be seen after a
  // scroll moved the target clear of it; otherwise the next try would scroll it back under.
  if (remembered) {
    for (const element of covers.keys()) remembered.add(element);
    for (const element of remembered) if (!covers.has(element) && element.isConnected && isShown(element)) covers.set(element, boxOf(element));
  }
  return [...covers.values()];
}

/**
 * The band of the screen (top, bottom) where the target can be seen: `seen`, less what covers it from above
 * (things in the upper half, a sticky header) and from below (things in the lower half, a bottom bar), even
 * when the target sits wholly past one.
 */
/** A cover as tall as most of the screen is an open window over the page, not a bar: scrolling never clears it. */
const isWindow = (cover: Box, seen: Box) => cover.h > seen.h * 0.6;

export function freeBand(target: Box, seen: Box, covers: readonly Box[]): Readonly<{ top: number; bottom: number }> {
  let top = seen.y, bottom = seen.y + seen.h;
  const middle = seen.y + seen.h / 2;
  for (const cover of covers) {
    if (cover.x >= target.x + target.w || cover.x + cover.w <= target.x || isWindow(cover, seen)) continue;
    if (cover.y + cover.h / 2 > middle) bottom = Math.min(bottom, cover.y);
    else top = Math.max(top, cover.y + cover.h);
  }
  return { top, bottom };
}

/**
 * How far the target must scroll up (positive) or down (negative) to be seen whole, `margin` clear of the
 * edges of where it can be seen (`seen`) and of whatever is drawn over it there. 0 when it is seen whole
 * already. Taller than the room left: its top is lined up.
 */
export function revealShift(target: Box, seen: Box, covers: readonly Box[], margin = 12): number {
  const { top, bottom } = freeBand(target, seen, covers);
  const band = bottom - top;
  if (target.h > band) return target.y - (top + margin);
  // A target that only just fits where it is (a tab in a bar) needs no room around it.
  const edge = Math.min(margin, (band - target.h) / 2);
  if (edge < margin && target.y >= top && target.y + target.h <= bottom) return 0;
  if (target.y < top + edge) return target.y - (top + edge);
  if (target.y + target.h > bottom - edge) return target.y + target.h - (bottom - edge);
  return 0;
}

/**
 * Whether the target is out of sight, and which way to scroll to find it: part of it is under a bar or past
 * an edge (a target taller than the room: almost none of it shows). 'covered': an open window is over it.
 */
export function hiddenSide(target: Box, seen: Box, covers: readonly Box[]): 'down' | 'up' | 'covered' | null {
  if (covers.some((cover) => isWindow(cover, seen) && overlaps(cover, target))) return 'covered';
  const { top, bottom } = freeBand(target, seen, covers);
  if (target.h > bottom - top) {
    if (target.y > bottom - 40) return 'down';
    if (target.y + target.h < top + 40) return 'up';
    return null;
  }
  if (target.y + target.h > bottom + 1) return 'down';
  if (target.y < top - 1) return 'up';
  return null;
}
