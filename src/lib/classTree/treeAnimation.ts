/*
 * Short pixel animations drawn over the class tree (12 frames a second). Each kind returns, for a
 * frame, the cells to paint on top of the tree picture:
 *   feed     양분 주기 — a nutrient bag tips and pours, the soil glows, sparkles climb the tree, +N
 *            (`big`: the teacher's, two bags pouring from both sides)
 *   grow     the tree reached a new stage — outlines flash and sparkles spread
 *   harvest  ripe apples drop onto the bed and are gathered one by one
 */

export const TREE_ANIMATION_FPS = 12;

type Cell = readonly [number, number, string];
type Out = Cell[];
export type TreeAnimationInfo = Readonly<{
  stage: number;
  amount?: number;
  big?: boolean;
  /** Apple places of the full tree (harvest). */
  applePlaces?: ReadonlyArray<readonly [number, number]>;
}>;
type Frame = (frame: number, info: TreeAnimationInfo, cells: ReadonlyArray<ReadonlyArray<string | null>>) => Out;

function mix(from: string, to: string, t: number): string {
  const a = [1, 3, 5].map((i) => parseInt(from.slice(i, i + 2), 16));
  const b = [1, 3, 5].map((i) => parseInt(to.slice(i, i + 2), 16));
  return `#${a.map((value, i) => Math.round(value + (b[i] - value) * t).toString(16).padStart(2, '0')).join('')}`;
}

/** Colors the animations add to the tree palette: B nutrient bag (fill + outline pair), Xr pale glow. */
export const TREE_ANIMATION_PALETTE: Readonly<Record<string, string>> = (() => {
  const fill = '#ffcc80', outline = '#e65100';
  return { Xr: '#fff59d', Bc: mix(fill, '#ffffff', 0.42), Bb: fill, Bd: mix(fill, outline, 0.45), Ba: outline };
})();

function hash(x: number, y: number, seed = 0): number {
  let h = Math.imul(x + 1, 374761393) ^ Math.imul(y + 7, 668265263) ^ Math.imul(seed + 3, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* The nutrient bag: an open sack with a sprout on it. */
const BAG = [
  '..aaaaaaa..',
  '.aysysysya.',
  '.aaaaaaaaa.',
  '..acbbbda..',
  '.acbbbbbda.',
  'acbbbbbbbda',
  'acbbLbLbbda',
  'acbbbLbbbda',
  'acbbbLbbdda',
  'acbbbbbbdda',
  '.abbbbbdda.',
  '..aaaaaaa..',
];
const BAG_MAP: Readonly<Record<string, string>> = { a: 'Ba', b: 'Bb', c: 'Bc', d: 'Bd', s: 'Xs', y: 'Xr', L: 'Lb' };
const BAG_CX = 5, BAG_CY = 5.5;
/* A tipped bag: rotated at 8× and brought back by majority per cell (fewer stray dots), edge cells outlined. */
function bagCells(angleDeg: number): Cell[] {
  const S = 8, a = (angleDeg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a), R = 9;
  const grid = new Map<string, string>();
  for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
    const votes = new Map<string, number>();
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const fx = x - 0.5 + (sx + 0.5) / S, fy = y - 0.5 + (sy + 0.5) / S;
      const ch = BAG[Math.round(fx * sin + fy * cos + BAG_CY)]?.[Math.round(fx * cos - fy * sin + BAG_CX)] ?? '.';
      votes.set(ch, (votes.get(ch) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((p, q) => q[1] - p[1])[0][0];
    if (best !== '.') grid.set(`${x},${y}`, best);
  }
  const out: Cell[] = [];
  for (const [key, ch] of grid) {
    const [x, y] = key.split(',').map(Number);
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => !grid.has(`${x + dx},${y + dy}`));
    out.push([x, y, BAG_MAP[edge && ch !== 's' && ch !== 'y' ? 'a' : ch]]);
  }
  return out;
}
const ANGLES = [0, 30, 65] as const;
let bagPoses: Cell[][] | null = null;
const poses = () => (bagPoses ??= ANGLES.map(bagCells));
function mouthOf(angleDeg: number, px: number, py: number): readonly [number, number] {
  const a = (angleDeg * Math.PI) / 180;
  return [px - 6 * Math.sin(a), py - 6 * Math.cos(a)];
}

/* Small 3×5 digits and +, white with a dark outline. */
const GLYPH: Readonly<Record<string, readonly string[]>> = {
  '+': ['...', '.x.', 'xxx', '.x.', '...'], 0: ['xxx', 'x.x', 'x.x', 'x.x', 'xxx'], 1: ['.x.', 'xx.', '.x.', '.x.', 'xxx'],
  2: ['xxx', '..x', 'xxx', 'x..', 'xxx'], 3: ['xxx', '..x', 'xxx', '..x', 'xxx'], 4: ['x.x', 'x.x', 'xxx', '..x', '..x'],
  5: ['xxx', 'x..', 'xxx', '..x', 'xxx'], 6: ['xxx', 'x..', 'xxx', 'x.x', 'xxx'], 7: ['xxx', '..x', '..x', '..x', '..x'],
  8: ['xxx', 'x.x', 'xxx', 'x.x', 'xxx'], 9: ['xxx', 'x.x', 'xxx', '..x', 'xxx'],
};
function text(out: Out, value: string, x: number, y0: number): void {
  const x0 = Math.max(1, Math.min(x, 63 - value.length * 4));
  const cells = new Set<string>();
  [...value].forEach((ch, i) => (GLYPH[ch] ?? []).forEach((row, dy) => [...row].forEach((c, dx) => { if (c === 'x') cells.add(`${x0 + i * 4 + dx},${y0 + dy}`); })));
  for (const key of cells) {
    const [cx, cy] = key.split(',').map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      if (!cells.has(`${cx + dx},${cy + dy}`)) out.push([cx + dx, cy + dy, 'La']);
    }
  }
  for (const key of cells) { const [cx, cy] = key.split(',').map(Number); out.push([cx, cy, 'Xw']); }
}
function sparkle(out: Out, x: number, y: number, size: number, code = 'Xs'): void {
  if (size >= 2) for (const [dx, dy] of [[0, -2], [0, -1], [-2, 0], [-1, 0], [1, 0], [2, 0], [0, 1], [0, 2]]) out.push([x + dx, y + dy, code]);
  else if (size === 1) for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) out.push([x + dx, y + dy, code]);
  out.push([x, y, size >= 1 ? 'Xw' : code]);
}
// The top surface of the grass bed (same ellipse as the tree picture).
const BED = { cx: 32, cy: 55, rx: 21.5, ry: 4.8 };
function groundY(x: number): number {
  const t = (x + 0.5 - BED.cx) / BED.rx;
  return Math.abs(t) >= 1 ? BED.cy : Math.ceil(BED.cy - BED.ry * Math.sqrt(1 - t * t));
}
// Near the top of the tree at each stage (where sparkles end and the +N floats).
const TOP = [48, 44, 33, 22, 14, 5, 5, 5];

const feed: Frame = (frame, info) => {
  const out: Out = [];
  const sides = info.big ? [1, -1] : [1];
  const pose = frame < 3 ? 0 : frame < 4 ? 1 : frame < 11 ? 2 : frame < 12 ? 1 : 0;
  const bob = frame < 3 ? [-4, -1, 0][frame] : frame >= 4 && frame < 11 ? frame % 2 : 0;
  for (const side of sides) {
    const px = side > 0 ? 47 : 17, py = 38;
    if (frame < 13) for (const [x, y, c] of poses()[pose]) out.push([px + x * side, py + y + bob, c]);
    if (frame === 13) { sparkle(out, px, py, 2, 'Xw'); sparkle(out, px - 4 * side, py + 3, 1, 'Xs'); }
    const [m0, my] = mouthOf(ANGLES[2], px, py);
    const mx = px + (m0 - px) * side;
    for (let i = 0; i < 22; i++) {
      const t = frame - (4 + i * 0.32);
      if (t < 0) continue;
      const seed = side > 0 ? i : i + 40;
      const vx = (-0.35 - hash(seed, 3) * 0.75) * side, vy = 0.3 + hash(seed, 5) * 0.5;
      const at = (tt: number) => [Math.round(mx - side + vx * tt), Math.round(my + vy * tt + 0.5 * tt * tt)] as const;
      const [x, y] = at(t), [x0, y0] = at(Math.max(0, t - 0.6));
      if (y < groundY(x)) { out.push([x0, y0, 'Xr']); out.push([x, y, i % 3 ? 'Xs' : 'Xw']); }
    }
  }
  if (frame >= 10 && frame <= 15) {
    const k = frame - 10, rx = 3 + k * (info.big ? 3.4 : 2.6), ry = 0.8 + k * (info.big ? 0.7 : 0.55);
    for (let x = Math.floor(32 - rx); x <= Math.ceil(32 + rx); x++) for (let y = 50; y <= 59; y++) {
      const d = Math.hypot((x + 0.5 - 32) / rx, (y + 0.5 - 55) / ry);
      if (d > 0.82 && d < 1.12 && y >= groundY(x)) out.push([x, y, k < 4 ? 'Xr' : 'Xs']);
    }
  }
  const top = TOP[info.stage] ?? 5;
  const xs = info.big ? [-5, 5, -2, 8, -9, 2, -13, 12, -7, 10] : [-5, 5, -2, 8, -9, 2];
  xs.forEach((dx, i) => {
    const t = frame - 12 - i * (info.big ? 0.9 : 1.5);
    if (t < 0 || t > 8) return;
    sparkle(out, 32 + dx, Math.round(52 - (52 - top - 4) * (t / 8)), t % 3 === 2 ? 0 : t < 7 ? 2 : 1, i % 2 ? 'Xs' : 'Xr');
  });
  if (frame >= 15) text(out, `+${info.amount ?? 1}`, info.big ? 40 : 44, Math.max(1, top - 2 - Math.min(5, frame - 15)));
  return out;
};

const grow: Frame = (frame, info, cells) => {
  const out: Out = [];
  if (frame < 3) cells.forEach((row, y) => row.forEach((v, x) => {
    if (v && v[1] === 'a' && v[0] !== 'E' && v[0] !== 'G') out.push([x, y, frame === 1 ? 'Xr' : 'Xw']);
  }));
  const cy = Math.max(10, ((TOP[info.stage] ?? 5) + 50) / 2), r = 6 + frame * 2.2;
  if (frame >= 1) for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    sparkle(out, Math.round(32 + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * 0.8), frame > 10 ? 0 : frame % 3 === 0 ? 1 : 2, i % 2 ? 'Xs' : 'Xw');
  }
  return out;
};

const APPLE = ['.T..', 'awba', 'abda', '.aa.'];
const APPLE_MAP: Readonly<Record<string, string>> = { T: 'Wa', a: 'Ra', b: 'Rb', d: 'Rd', w: 'Xw' };
const harvest: Frame = (frame, info) => {
  const out: Out = [];
  const apples = info.applePlaces ?? [];
  const n = Math.max(1, apples.length);
  apples.forEach(([ax, ay], i) => {
    const tx = Math.round(14 + ((ax - 8) / 48) * 30 + (hash(i, 9) - 0.5) * 4);
    const ty = Math.min(56, groundY(tx + 1) + 1 + Math.floor(hash(i, 11) * 4)) - 3;
    const pick = 26 + Math.floor((i * 14) / n);
    if (frame >= pick + 2) return;
    if (frame >= pick) { sparkle(out, tx + 1, ty + 1, frame === pick ? 2 : 1, i % 2 ? 'Xs' : 'Xw'); return; }
    const t = frame - Math.floor((i * 20) / n);
    let x = ax, y = ay;
    if (t > 0) {
      const fallTime = Math.max(1, Math.sqrt((2 * Math.max(1, ty - ay)) / 0.9));
      const p = Math.min(1, t / fallTime);
      x = Math.round(ax + (tx - ax) * p);
      y = p < 1 ? ay + 0.45 * t * t : ty - (t - fallTime < 3 ? Math.round(2 * Math.sin(((t - fallTime) / 3) * Math.PI)) : 0);
    }
    APPLE.forEach((row, dy) => [...row].forEach((ch, dx) => { if (ch !== '.') out.push([x + dx, Math.round(y) + dy, APPLE_MAP[ch]]); }));
  });
  return out;
};

export type TreeAnimationKind = 'feed' | 'grow' | 'harvest';
export const TREE_ANIMATIONS: Readonly<Record<TreeAnimationKind, readonly [number, Frame]>> = {
  feed: [24, feed],
  grow: [14, grow],
  harvest: [44, harvest],
};
